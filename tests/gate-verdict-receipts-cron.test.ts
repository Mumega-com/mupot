// tests/gate-verdict-receipts-cron.test.ts — seed B4: the reconcile sweep is wired into the existing maintenance cron
// (no new trigger), on its own slot, and a sweep error never escapes the scheduled handler.

import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { maintenanceSlot } from '../src/scheduled/slots'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() { throw new Error('outer OAuth provider is not used by this test') }
  },
}))

const sweep = vi.hoisted(() => vi.fn(async () => ({ verdicts_healed: 0, reversals_healed: 0, failed: 0 })))
vi.mock('../src/tasks/verdict-binding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/tasks/verdict-binding')>()),
  reconcileGateVerdictReceipts: sweep,
}))

const { default: worker } = await import('../src/index')

const MAINTENANCE_CRON = '0-9,15-24,30-39,45-54 * * * *'
const HEARTBEATS = 17 // the receipts sweep is the second to last (index 15); repo-key-heal is index 16
// the minutes MAINTENANCE_CRON fires on (0-9, 15-24, 30-39, 45-54)
const FIRING_MINUTES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54]

async function tick(minute: number): Promise<void> {
  const work: Promise<unknown>[] = []
  await worker.scheduled(
    { scheduledTime: Date.UTC(2026, 9, 22, 3, minute), cron: MAINTENANCE_CRON } as ScheduledController,
    {} as Env,
    { waitUntil: (p: Promise<unknown>) => { work.push(p) } } as ExecutionContext,
  )
  await Promise.all(work)
}

describe('gate-verdict-receipts maintenance heartbeat', () => {
  it('is reachable: some firing minute selects its slot, and ticking there runs the sweep exactly once', async () => {
    const slotMinute = FIRING_MINUTES.find((m) => maintenanceSlot(m, HEARTBEATS) === HEARTBEATS - 2)
    expect(slotMinute).toBeDefined()
    sweep.mockClear()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await tick(slotMinute ?? -1)
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('does not run on the other slots, and a failing sweep is contained', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    sweep.mockClear()
    await tick(0)
    expect(sweep).not.toHaveBeenCalled()
    sweep.mockRejectedValueOnce(new Error('boom'))
    const slotMinute = FIRING_MINUTES.find((m) => maintenanceSlot(m, HEARTBEATS) === HEARTBEATS - 2) ?? -1
    await expect(tick(slotMinute)).resolves.toBeUndefined()
    expect(err).toHaveBeenCalledWith('[scheduled:gate-verdict-receipts]', expect.any(Error))
  })
})
