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

async function scheduledFanout(minute: number, cron: string): Promise<number> {
  const work: Promise<unknown>[] = []
  const context = {
    waitUntil(promise: Promise<unknown>) {
      work.push(promise)
    },
  }
  const controller = {
    scheduledTime: Date.UTC(2026, 6, 27, 16, minute),
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

  it('fails closed for unrecognized or legacy cron triggers', async () => {
    expect(await scheduledFanout(0, '*/15 * * * *')).toBe(0)
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
})
