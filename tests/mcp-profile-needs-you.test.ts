// tests/mcp-profile-needs-you.test.ts — the curated READ-ONLY ChatGPT profile at
// POST /mcp/profile/needs-you (src/mcp/profile-needs-you.ts).
//
// Drives the REAL mcpApp + REAL TOOLS registry through the same header seam the
// OAuthProvider -> McpOAuthApiHandler hop uses (see tests/oauth-dual-auth.test.ts). The 401 +
// resource_metadata contract lives in tests/composition/ (it needs the real wrapper).
import { describe, expect, it } from 'vitest'
import { mcpApp, TOOLS } from '../src/mcp'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { NEEDS_YOU_PROFILE, NEEDS_YOU_PROFILE_PATH, profileEntry } from '../src/mcp/profile-needs-you'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'

const TENANT = 'mumega'
const ADMIN_MEMBER = 'mbr-admin'

function makeEnv(grants: CapabilityGrant[] = []): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Mumega',
    OAUTH_PROVIDER: 'google',
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return {
              async first() {
                return null
              },
              async all() {
                if (sql.includes('FROM capabilities') || sql.includes('FROM channel_capability_grants')) {
                  return { results: grants }
                }
                return { results: [] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
}

const ADMIN_GRANTS: CapabilityGrant[] = [
  { member_id: ADMIN_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' },
]

function header(overrides: Partial<AuthContext> = {}): Record<string, string> {
  const auth: AuthContext = {
    userId: ADMIN_MEMBER,
    email: 'a@example.com',
    role: 'member',
    tenant: TENANT,
    memberId: ADMIN_MEMBER,
    channel: 'workspace',
    capabilities: [],
    boundAgentId: null,
    ...overrides,
  }
  return { [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) }
}

const DIRECTORY_UNBOUND = header({ userId: 'mbr-dir', memberId: 'mbr-dir', channel: 'directory' })

async function rpc(path: string, method: string, params: unknown, headers: Record<string, string>, env: Env) {
  const res = await mcpApp.request(
    `https://pot.example${path}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    env,
  )
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : null } // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only JSON probe
}

const PROFILE = '/profile/needs-you'
const EXPECTED_NAMES = [
  'boot_context', 'needs_you_list', 'orient', 'project_get', 'project_list', 'project_wiki', 'task_board', 'task_list',
]

describe('profile tools/list', () => {
  it('returns exactly the profile allowlist, each with read-only annotations', async () => {
    const { status, json } = await rpc(PROFILE, 'tools/list', undefined, header(), makeEnv())
    expect(status).toBe(200)
    const tools = json!.result.tools as Array<{ name: string; annotations?: Record<string, unknown>; inputSchema: unknown }>
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_NAMES)
    expect(tools.map((t) => t.name).sort()).toEqual(NEEDS_YOU_PROFILE.map((e) => e.name).sort())
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false })
      expect(typeof t.annotations?.title, t.name).toBe('string')
      expect(t.inputSchema, t.name).toBeTruthy()
    }
  })

  it('requires authentication (the profile never discloses even its own list anonymously)', async () => {
    const { status, json } = await rpc(PROFILE, 'tools/list', undefined, {}, makeEnv())
    expect(status).toBe(401)
    expect(json!.error.code).toBe(-32001)
  })

  it('rejects a non-JSON-RPC body (no legacy {tool,args} shape on the profile)', async () => {
    const res = await mcpApp.request(
      `https://pot.example${PROFILE}`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...header() }, body: JSON.stringify({ tool: 'status', args: {} }) },
      makeEnv(),
    )
    expect(res.status).toBe(400)
  })
})

describe('/mcp is unchanged (regression guard)', () => {
  it('tools/list on /mcp returns the FULL registry with no annotations', async () => {
    const { json } = await rpc('/', 'tools/list', undefined, {}, makeEnv())
    const tools = json!.result.tools as Array<{ name: string; annotations?: unknown }>
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name))
    expect(tools.length).toBeGreaterThan(NEEDS_YOU_PROFILE.length * 5)
    expect(tools.some((t) => 'annotations' in t)).toBe(false)
    // Keys of every /mcp entry are exactly the pre-profile shape.
    for (const t of tools) expect(Object.keys(t).sort()).toEqual(['description', 'inputSchema', 'name'])
  })

  it('/mcp tools/call still reaches non-profile tools (a floor refusal, not tool_not_in_profile)', async () => {
    const { json } = await rpc('/', 'tools/call', { name: 'grant_agent_capability', arguments: {} }, header(), makeEnv(ADMIN_GRANTS))
    expect(json!.error.message).not.toBe('tool_not_in_profile')
  })
})

describe('profile tools/call', () => {
  it('an allowed tool works under the same auth as /mcp and returns the same result', async () => {
    const env = makeEnv(ADMIN_GRANTS)
    const viaProfile = await rpc(PROFILE, 'tools/call', { name: 'boot_context', arguments: {} }, header(), env)
    const viaMcp = await rpc('/', 'tools/call', { name: 'boot_context', arguments: {} }, header(), env)
    expect(viaProfile.status).toBe(200)
    expect(viaMcp.status).toBe(200)
    expect(viaProfile.json!.result.structuredContent.identity_status).toBe(viaMcp.json!.result.structuredContent.identity_status)
    expect(viaProfile.json!.result.structuredContent.identity).toEqual(viaMcp.json!.result.structuredContent.identity)
  })

  it('an unauthenticated tools/call is 401, not a probe of the allowlist', async () => {
    const allowed = await rpc(PROFILE, 'tools/call', { name: 'boot_context', arguments: {} }, {}, makeEnv())
    const denied = await rpc(PROFILE, 'tools/call', { name: 'send', arguments: {} }, {}, makeEnv())
    expect(allowed.status).toBe(401)
    expect(denied.status).toBe(401)
  })

  for (const name of ['send', 'task_create', 'task_verdict', 'task_update', 'grant_agent_capability', 'mint_agent_token', 'remember', 'status']) {
    it(`refuses non-allowlisted ${name} even for an org-admin caller`, async () => {
      const env = makeEnv(ADMIN_GRANTS)
      const p = await rpc(PROFILE, 'tools/call', { name, arguments: {} }, header(), env)
      expect(p.status).toBe(403)
      expect(p.json!.error.message).toBe('tool_not_in_profile')
      expect(p.json!.result).toBeUndefined()
    })
  }

  it('refuses prototype-shaped / non-string / missing names', async () => {
    for (const name of ['constructor', '__proto__', 'toString', 42, null, undefined, '']) {
      const p = await rpc(PROFILE, 'tools/call', { name, arguments: {} }, header(), makeEnv(ADMIN_GRANTS))
      expect(p.status, String(name)).toBe(403)
      expect(p.json!.error.message).toBe('tool_not_in_profile')
    }
  })

  it('an unbound directory session (capabilities []) gets the SAME B1 behaviour as /mcp on allowed tools', async () => {
    const env = makeEnv(ADMIN_GRANTS) // grants exist for another member; the directory session must not inherit them
    const bootP = await rpc(PROFILE, 'tools/call', { name: 'boot_context', arguments: {} }, DIRECTORY_UNBOUND, env)
    expect(bootP.status).toBe(200)
    // task_list needs 'member': a zero-capability directory session is refused at the floor on BOTH doors.
    for (const path of [PROFILE, '/']) {
      const r = await rpc(path, 'tools/call', { name: 'task_list', arguments: {} }, DIRECTORY_UNBOUND, env)
      expect(r.status, path).toBe(403)
      expect(r.json!.error.message, path).toBe('forbidden')
      expect(r.json!.error.data, path).toEqual({ need: 'member' })
    }
  })
})

describe('profile allowlist file', () => {
  it('profileEntry only resolves names that are listed', () => {
    expect(profileEntry('orient')?.name).toBe('orient')
    expect(profileEntry('send')).toBeUndefined()
    expect(profileEntry('constructor')).toBeUndefined()
  })

  it('every profile name is a real registry tool at member tier or below', () => {
    const byName = new Map(TOOLS.map((t) => [t.name, t]))
    for (const e of NEEDS_YOU_PROFILE) {
      const spec = byName.get(e.name)
      expect(spec, e.name).toBeTruthy()
      expect(['authenticated', 'observer', 'member']).toContain(spec!.min)
    }
  })
})

describe('OAuthProvider -> mcpApp re-root (mcpInternalRequest)', () => {
  const auth: AuthContext = {
    userId: 'm', email: null, role: 'member', tenant: TENANT, memberId: 'm', channel: 'directory', capabilities: [], boundAgentId: null,
  }
  const rerooted = (path: string) => new URL(mcpInternalRequest(new Request(`https://pot.example${path}`, { method: 'POST', body: '{}' }), auth).url).pathname

  it('keeps the profile sub-path so mcpApp can route it', () => {
    expect(rerooted(NEEDS_YOU_PROFILE_PATH)).toBe('/profile/needs-you')
  })

  it('every other /mcp* path still re-roots to / (unchanged), including lookalikes', () => {
    for (const p of ['/mcp', '/mcp/', '/mcp/tools', '/mcp/profile/needs-you/', '/mcp/profile/needs-you/x', '/mcp/profile', '/mcp/profile/other']) {
      expect(rerooted(p), p).toBe('/')
    }
  })
})
