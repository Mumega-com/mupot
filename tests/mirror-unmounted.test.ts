import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {}, BackupWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({ OAuthProvider: class {} }))

const { app } = await import('../src/index')

const requests = [
  ['GET', ''],
  ['POST', ''],
  ['GET', '/search'],
  ['POST', '/search'],
  ['GET', '/health'],
  ['POST', '/rrf-search'],
  ['POST', '/engrams'],
  ['POST', '/memory/store'],
  ['POST', '/memory/search'],
  ['POST', '/memory/forget'],
  ['DELETE', '/memory/forget'],
  ['DELETE', '/memory/entry-1'],
  ['GET', '/memory/entry-1'],
  ['GET', '/memory'],
] as const

describe.each(['MIRROR_SECRET', 'MIRROR_TOKEN'] as const)('unmounted Mirror with %s configured', (binding) => {
  describe.each(['/api/mirror', '/api/addons/mirror'])('%s', (prefix) => {
    it.each(requests)('returns 404 for %s %s', async (method, suffix) => {
      const env = { [binding]: 'mirror-route-test', TENANT_SLUG: 'test' } as Env
      const response = await app.request(`https://pot.test${prefix}${suffix}`, {
        method,
        headers: {
          authorization: 'Bearer mirror-route-test',
          'x-mirror-secret': 'mirror-route-test',
          'content-type': 'application/json',
          origin: 'https://pot.test',
        },
        ...(method === 'POST' ? { body: JSON.stringify({ query: 'test', text: 'test', id: 'entry-1' }) } : {}),
      }, env)

      expect(response.status).toBe(404)
      expect(await response.text()).toBe('404 Not Found')
    })
  })
})
