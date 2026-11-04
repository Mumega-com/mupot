// The Hono app behind the OAuth provider decodes the path; the provider matches the raw path. These
// tests drive the guard directly and through the root Hono app (the layer that does the decoding).
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { isNonCanonicalProviderPath, lenientPath, providerOwnsPath, refuseNonCanonicalPath } from '../src/oauth-canonical-path'

vi.mock('../src/agents/agent-do', () => ({ AgentDO: class {} }))
vi.mock('../src/agents/squad-do', () => ({ SquadCoordinatorDO: class {} }))
vi.mock('../src/registry/presence-channel-do', () => ({ PresenceChannelDO: class {} }))
vi.mock('../src/agents/seat-events-do', () => ({ SeatEventsDO: class {} }))
vi.mock('../src/workflows/task-workflow', () => ({ TaskWorkflow: class {}, BackupWorkflow: class {} }))
vi.mock('../src/mcp/oauth-api-handler', () => ({ McpOAuthApiHandler: class {} }))
vi.mock('@cloudflare/workers-oauth-provider', () => ({ OAuthProvider: class {} }))

const { app } = await import('../src/index')

const NON_CANONICAL = [
  '/%6dcp', '/%6Dcp', '/m%63p', '/mc%70', '/%6d%63%70', '/%256dcp', '/%25256dcp', '/MCP', '/Mcp', '//mcp', '/%2fmcp',
  '/%6dcp/profile/needs-you', '/%6dcp/tools', '/%6dcp/health', '/;x/mcp', '/a/../%6dcp', '/%5cmcp',
  '/t/mumega/%6dcp', '/t/%6dumega/mcp', '/t/mumega//mcp', '/t/mumega%2fmcp', '/%74/mumega/mcp', '/t/other/%6dcp',
  '/%74oken', '/regist%65r', '/.well-known/oauth-%61uthorization-server', '/.%77ell-known/oauth-protected-resource/mcp',
]
const CANONICAL = [
  '/mcp', '/mcp/', '/mcp/tools', '/mcp/profile/needs-you', '/t/mumega/mcp', '/T/Mumega/mcp', '/t/other/mcp',
  '/token', '/register', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp',
  '/health', '/api/tasks', '/authorize', '/mcp%2fprofile', '/api%2Fhealth', '/%61pi/health', '/dashboard/m%63p-notes',
]

describe('non-canonical path forms are treated like the canonical path', () => {
  it.each(NON_CANONICAL)('guard flags %s', (path) => {
    expect(isNonCanonicalProviderPath(path)).toBe(true)
    const res = refuseNonCanonicalPath(new Request(`https://pot.test${path}`))
    expect(res?.status).toBe(400)
  })

  it.each(CANONICAL.filter((p) => !p.startsWith('/mcp%2f')))('guard leaves %s alone', (path) => {
    expect(isNonCanonicalProviderPath(path)).toBe(false)
    expect(refuseNonCanonicalPath(new Request(`https://pot.test${path}`))).toBeNull()
  })

  it('a path the provider itself still owns is never refused (it is gated by the provider)', () => {
    expect(providerOwnsPath('/mcp%2fprofile')).toBe(true)
    expect(isNonCanonicalProviderPath('/mcp%2fprofile')).toBe(false)
  })

  it('lenientPath folds the spellings a router could read', () => {
    expect(lenientPath('/%256DCP/./x/..')).toBe('/mcp')
    expect(lenientPath('/t/Mumega/%6dcp')).toBe('/mcp')
  })

  it.each(NON_CANONICAL)('the root app (the decoding layer) refuses %s on its own', async (path) => {
    for (const method of ['GET', 'POST']) {
      const res = await app.request(`https://pot.test${path}`, { method }, { TENANT_SLUG: 'mumega' } as Env)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'non_canonical_path' })
    }
  })

  it('the root app still serves ordinary paths', async () => {
    const res = await app.request('https://pot.test/health', {}, { TENANT_SLUG: 'mumega' } as Env)
    expect(res.status).toBe(200)
  })
})
