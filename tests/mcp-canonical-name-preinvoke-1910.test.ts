// tests/mcp-canonical-name-preinvoke-1910.test.ts — mupot#1910 P2-4: the pre-invoke checks in tools/call key on the
// CANONICAL tool name, so an alias (office_health) cannot slip past a list that names the dotted tool.
// No current profile / elicitation list names an office tool, so the lists are stood in for by partial mocks that
// DO name 'office.health'. MUTATIONS proven: see the PR body.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const seen = vi.hoisted(() => ({ profile: [] as unknown[], elicit: [] as string[] }))

vi.mock('../src/mcp/profile-needs-you', async (orig) => {
  const actual = await orig<typeof import('../src/mcp/profile-needs-you')>()
  return {
    ...actual,
    profileEntry: (name: unknown) => {
      seen.profile.push(name)
      return name === 'office.health' ? { name: 'office.health' } : actual.profileEntry(name)
    },
  }
})
vi.mock('../src/mcp/url-elicitation', async (orig) => {
  const actual = await orig<typeof import('../src/mcp/url-elicitation')>()
  return {
    ...actual,
    urlElicitationActive: () => true,
    URL_ELICITATION_TOOLS: new Map([...actual.URL_ELICITATION_TOOLS, ['office.health', 'elevation' as const]]),
    prepareUrlElicitation: async (_e: unknown, _a: unknown, input: { toolName: string }) => { seen.elicit.push(input.toolName); return null },
  }
})

import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seedLiveToken } from './helpers/live-token'
import type { AuthContext, Env } from '../src/types'

const auth = { userId: 'm', memberId: 'm', email: null, role: 'member', tenant: 'mumega', capabilities: [], boundAgentId: null, channel: 'directory', tokenId: 'tok-live-m' } as unknown as AuthContext
let h: SqliteD1Harness
let env: Env
beforeEach(() => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  seedLiveToken(h.sqlite, { memberId: 'm', tenant: 'mumega', channel: 'directory' })
  env = { TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test', DB: h.db, SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined }, OAUTH_KV: { get: async () => null, put: async () => undefined } } as unknown as Env
})
afterEach(() => h.close())

async function call(path: string, name: string): Promise<{ error?: { message: string } }> {
  const req = new Request(`https://pot.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } }) })
  try {
    return (await (await mcpApp.fetch(mcpInternalRequest(req, auth), env)).json()) as { error?: { message: string } }
  } catch {
    return {} // the tool body needs a real DB; reaching it is the point, not its result
  }
}

describe('pre-invoke checks use the canonical name (#1910 P2-4)', () => {
  it('profile door: the alias is looked up as the dotted name (admitted by a dotted entry, never tool_not_in_profile)', async () => {
    seen.profile.length = 0
    const r = await call('/mcp/profile/needs-you', 'office_health')
    expect(seen.profile).toContain('office.health')
    expect(seen.profile).not.toContain('office_health')
    expect(r.error?.message).not.toBe('tool_not_in_profile')
  })

  it('url-elicitation trigger list: the alias triggers the dotted entry (prepare sees the canonical name)', async () => {
    seen.elicit.length = 0
    await call('/mcp', 'office_health')
    expect(seen.elicit).toEqual(['office.health'])
  })

  it('a non-alias name is passed through unchanged', async () => {
    seen.elicit.length = 0
    await call('/mcp', 'request_elevation')
    expect(seen.elicit).toEqual(['request_elevation'])
  })
})
