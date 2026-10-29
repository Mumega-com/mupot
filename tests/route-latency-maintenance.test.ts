import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { BOARD_LATENCY_ROUTE, RETENTION_MS } from '../src/telemetry/route-latency'
import * as latency from '../src/telemetry/route-latency'
import * as agentConnections from '../src/members/agent-connection'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() { throw new Error('outer OAuth provider is not used by latency retention tests') }
  },
}))

const { default: worker } = await import('../src/index')

const MAINTENANCE_CRON = '0-9,15-24,30-39,45-54 * * * *'

describe('route latency scheduled retention', () => {
  it('latency retention has its own scheduled label and does not invoke agent-connection retention', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const other = vi.spyOn(agentConnections, 'sweepAgentConnectionRetention').mockRejectedValue(new Error('must-not-run'))
    const prune = vi.spyOn(latency, 'pruneRouteLatency').mockResolvedValue(undefined)
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const work: Promise<unknown>[] = []
      await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 29, 14, 23), cron: MAINTENANCE_CRON } as ScheduledController,
        { DB: h.db, TENANT_SLUG: 'retention-cron' } as Env,
        { waitUntil(p: Promise<unknown>) { work.push(p) } } as ExecutionContext)
      await Promise.all(work)
      expect(prune).toHaveBeenCalledOnce()
      expect(other).not.toHaveBeenCalled()
      expect(info.mock.calls.some(([tag, data]) => tag === '[scheduled:dispatch]' && (data as { route: string }).route === 'board-latency-retention')).toBe(true)
    } finally { other.mockRestore(); prune.mockRestore(); info.mockRestore(); h.close() }
  })

  it('the existing retention heartbeat physically deletes expired latency data during inactivity', async () => {
    const h = createSqliteD1()
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      applyAllMigrations(h.sqlite)
      const expired = Date.now() - RETENTION_MS - 86_400_000
      h.sqlite.prepare(`INSERT INTO route_latency_samples (id, tenant, route, observed_at_ms, duration_ms)
        VALUES ('expired-cron', 'retention-cron', ?, ?, 10)`).run(BOARD_LATENCY_ROUTE, expired)
      h.sqlite.prepare(`INSERT INTO route_latency_requests (tenant, route, bucket_ms, total_requests)
        VALUES ('retention-cron', ?, ?, 1)`).run(BOARD_LATENCY_ROUTE, expired)
      const work: Promise<unknown>[] = []
      await worker.scheduled({
        scheduledTime: Date.UTC(2026, 9, 29, 13, 23), cron: MAINTENANCE_CRON,
      } as ScheduledController, { DB: h.db, TENANT_SLUG: 'retention-cron' } as Env, {
        waitUntil(promise: Promise<unknown>) { work.push(promise) },
      } as ExecutionContext)
      await Promise.all(work)
      expect(work).toHaveLength(1)
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_samples').get()?.n).toBe(0)
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_requests').get()?.n).toBe(0)
    } finally {
      info.mockRestore()
      h.close()
    }
  })

})
