import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../src/types'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() { throw new Error('outer OAuth provider is not used by scheduled budget tests') }
  },
}))

const { default: worker } = await import('../src/index')

const ROUTINE_CRON = '* * * * *'
const MAINTENANCE_CRON = '0-9,15-24,30-39,45-54 * * * *'

async function scheduledFanout(
  minute: number,
  cron: string,
  hour = 16,
): Promise<number> {
  const work: Promise<unknown>[] = []
  const context = {
    waitUntil(promise: Promise<unknown>) {
      work.push(promise)
    },
  }
  const controller = {
    scheduledTime: Date.UTC(2026, 6, 27, hour, minute),
    cron,
  }

  await worker.scheduled(
    controller as ScheduledController,
    {} as Env,
    context as ExecutionContext,
  )
  await Promise.all(work)
  return work.length
}

describe('scheduled invocation budget', () => {
  it('isolates Routine and maintenance work in separate cron invocations', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(await scheduledFanout(0, ROUTINE_CRON)).toBe(1)
      expect(await scheduledFanout(0, MAINTENANCE_CRON)).toBe(1)
    } finally {
      error.mockRestore()
    }
  })

  it('fails closed and bounds warnings for unrecognized or legacy cron triggers', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(await scheduledFanout(0, '*/15 * * * *')).toBe(0)
      expect(await scheduledFanout(1, 'unexpected-value')).toBe(0)
      expect(await scheduledFanout(0, 'another-unexpected-value', 17)).toBe(0)
      expect(await scheduledFanout(2, 'delayed-unexpected-value', 16)).toBe(0)
      expect(await scheduledFanout(1, 'repeated-unexpected-value', 17)).toBe(0)
      expect(warning).toHaveBeenCalledTimes(2)
      expect(warning.mock.calls).toEqual([
        ['[scheduled:unmatched-cron]', {
          kind: 'unmatched_cron',
          scheduled_time: '2026-07-27T16:00:00.000Z',
          expected_trigger_count: 2,
        }],
        ['[scheduled:unmatched-cron]', {
          kind: 'unmatched_cron',
          scheduled_time: '2026-07-27T17:00:00.000Z',
          expected_trigger_count: 2,
        }],
      ])
      expect(JSON.stringify(warning.mock.calls)).not.toContain('*/15 * * * *')
      expect(JSON.stringify(warning.mock.calls)).not.toContain('unexpected-value')
    } finally {
      warning.mockRestore()
    }
  })

  it('emits one bounded dispatch marker for each scheduled route per isolate', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      expect(await scheduledFanout(0, ROUTINE_CRON, 17)).toBe(1)
      expect(await scheduledFanout(1, ROUTINE_CRON, 17)).toBe(1)
      for (const minute of Array.from({ length: 10 }, (_, index) => index)) {
        expect(await scheduledFanout(minute, MAINTENANCE_CRON, 17)).toBe(1)
      }

      const markers = info.mock.calls.filter(
        ([label]) => label === '[scheduled:dispatch]',
      )
      expect(markers).toHaveLength(11)
      expect(markers.map(([, payload]) => payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'scheduled_dispatch',
            route: 'project-routines',
          }),
          ...[
            'membership',
            'metabolism',
            'loops',
            'github-project',
            'growth',
            'cro',
            'flight-outbox',
            'concierge',
            'project-loop',
            'agent-connection-retention',
          ].map((route) => expect.objectContaining({
            kind: 'scheduled_dispatch',
            route,
          })),
        ]),
      )
      expect(JSON.stringify(markers)).not.toContain(ROUTINE_CRON)
      expect(JSON.stringify(markers)).not.toContain(MAINTENANCE_CRON)
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })

  it('preserves all ten maintenance heartbeats within each fifteen-minute window', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const fanout = await Promise.all(
        [
          ...Array.from(
            { length: 15 },
            (_, minute) => scheduledFanout(minute, ROUTINE_CRON),
          ),
          ...Array.from(
            { length: 10 },
            (_, minute) => scheduledFanout(minute, MAINTENANCE_CRON),
          ),
        ],
      )
      expect(fanout.reduce((total, count) => total + count, 0)).toBe(25)
    } finally {
      error.mockRestore()
    }
  })

  it('the LIVE handler routes minute 15 to token-expiry-warning, not membership', async () => {
    // Loom's follow-up on the slot-reachability fix, and the assertion that closes the real gap.
    //
    // Every other case here drives minutes 0-9 only. Under the OLD `% 15` selector minute 15 maps
    // to slot 0 (`membership`), so a fan-out COUNT at minute 15 is identical under bug and fix and
    // proves nothing — the count is 1 either way. The route name is the only thing that separates
    // them.
    //
    // This exercises the real scheduled() handler rather than the pure slots.ts function, so the
    // wiring itself is under test: token-expiry-warning (slot 10) was unreachable in production
    // and this is the assertion that would have caught it.
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // A distinct hour per assertion: reportScheduledDispatch buckets observations per hour, so
      // reusing one hour would silently suppress the second emission and pass vacuously.
      await scheduledFanout(15, MAINTENANCE_CRON, 3)

      const routes = info.mock.calls
        .filter(([tag]) => tag === '[scheduled:dispatch]')
        .map(([, payload]) => (payload as { route?: string }).route)

      expect(routes).toContain('token-expiry-warning')
      expect(routes).not.toContain('membership')
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })

  it('the LIVE handler routes minute 16 to flight-watchdog, and minute 15 still reaches token-expiry-warning', async () => {
    // The wiring assertion for the twelfth heartbeat. Same reasoning as the minute-15 case above:
    // a fan-out COUNT at minute 16 is 1 whether or not flight-watchdog is in the array, because
    // SOME heartbeat always fires. Only the route NAME distinguishes wired from not-wired.
    //
    // Minute 16 is the slot-11 minute for a twelve-entry array: maintenanceSlot(16, 12) =
    // (1*10 + 1) % 12 = 11. If the entry is dropped, appended in the wrong position, or the array
    // changes length, this route disappears and the test fails.
    //
    // The second assertion is the regression guard that actually matters: appending a twelfth
    // heartbeat SHIFTS the modulus. token-expiry-warning (#1146, slot 10) was dead in production
    // once already, and re-breaking it by appending below it would otherwise be silent.
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      // Distinct hours: reportScheduledDispatch buckets observations per hour, so reusing an
      // hour already driven above would suppress the emission and pass vacuously.
      await scheduledFanout(16, MAINTENANCE_CRON, 5)
      const watchdogRoutes = info.mock.calls
        .filter(([tag]) => tag === '[scheduled:dispatch]')
        .map(([, payload]) => (payload as { route?: string }).route)
      expect(watchdogRoutes).toContain('flight-watchdog')

      info.mockClear()
      await scheduledFanout(15, MAINTENANCE_CRON, 7)
      const expiryRoutes = info.mock.calls
        .filter(([tag]) => tag === '[scheduled:dispatch]')
        .map(([, payload]) => (payload as { route?: string }).route)
      expect(expiryRoutes).toContain('token-expiry-warning')
      expect(expiryRoutes).not.toContain('flight-watchdog')
    } finally {
      info.mockRestore()
      error.mockRestore()
    }
  })
})
