import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../src/types'
import { mcpApp } from '../src/mcp'

// Keep the scheduled assertion at the Worker boundary while replacing only the
// internal loop-driver seam. The driver itself is covered by loop-driver.test.ts;
// this test proves the Worker still dispatches to it and does not expose it.
vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('../src/loops/driver', () => ({
  runLoopsTick: vi.fn(async () => ({ ok: true, ran: 0, acted: 0, gated: 0, paused: 0, errors: 0 })),
}))
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: class {
    fetch() { throw new Error('outer OAuth provider is not used by boundary tests') }
  },
}))

const { app, default: worker } = await import('../src/index')
const { runLoopsTick } = await import('../src/loops/driver')

const ENV = { TENANT_SLUG: 'tenant-a' } as Env
const MAINTENANCE_CRON = '0-9,15-24,30-39,45-54 * * * *'

describe('loop driver public boundary', () => {
  it('does not advertise loop_driver_tick through actual MCP tool discovery', async () => {
    const response = await mcpApp.request(
      'https://pot.test/',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      ENV,
    )

    expect(response.status).toBe(200)
    const body = await response.json() as { result: { tools: Array<{ name: string }> } }
    expect(body.result.tools.map((tool) => tool.name)).not.toContain('loop_driver_tick')
  })

  it('does not mount a loop-driver REST tick route on the root app', async () => {
    // Hono exposes the mounted route table, so this checks the actual root
    // registration instead of searching src/index.ts for a path string.
    const mountedTickRoutes = app.routes.filter((route) => (
      route.method === 'POST' && /loop[-/]?.*tick|tick.*loop[-/]?/i.test(route.path)
    ))
    expect(mountedTickRoutes).toEqual([])

    // Also drive the root request path: an unauthenticated caller cannot reach
    // a public driver handler (the existing loops surface returns 401).
    const response = await app.request(
      'https://pot.test/api/loops/tick',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      ENV,
    )
    expect(response.status).toBe(401)
  })

  it('keeps scheduled loop execution on the internal runLoopsTick seam', async () => {
    vi.mocked(runLoopsTick).mockClear()
    const work: Promise<unknown>[] = []
    const context = {
      waitUntil(promise: Promise<unknown>) {
        work.push(promise)
      },
    }

    await worker.scheduled(
      {
        scheduledTime: Date.UTC(2026, 7, 29, 3, 2),
        cron: MAINTENANCE_CRON,
      } as ScheduledController,
      ENV,
      context as ExecutionContext,
    )
    await Promise.all(work)

    expect(runLoopsTick).toHaveBeenCalledTimes(1)
    expect(runLoopsTick).toHaveBeenCalledWith(ENV)
  })
})
