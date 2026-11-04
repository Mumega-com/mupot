import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext, Env } from '../src/types'
import { requireAuth, requireRole } from '../src/auth'
import { authApp } from '../src/auth'
import { BEARER_READ_ROUTES, bearerReadEligible, resolveBearerReadAuth } from '../src/auth/bearer-read'
import { TASK_GET_FIELDS } from '../src/tasks/task-get-fields'
import { authenticateMember } from '../src/mcp'
import { tasksApp, gatesApp } from '../src/tasks'
import { projectsApp } from '../src/projects'
import { orgApp } from '../src/org'
import { agentsApp } from '../src/agents'
import { dashboardApp } from '../src/dashboard'
import { hashMemberToken } from '../src/auth/member-bearer'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { mcpRequest } from './helpers/mcp-call'

// #2308 — a member bearer that /mcp accepts must be accepted on the cookie-era GET /api routes, with the
// SAME ceiling, and on nothing else. Real D1 schema (migrations), real routers, real requireAuth.

const TENANT = 'test'
let h: SqliteD1Harness
let env: Env

interface Fixture {
  raw: string
  memberId: string
  channel: 'workspace' | 'im' | 'dashboard' | 'directory'
  /** grants, e.g. org admin, or a squad-scoped observer; none = zero-standing member */
  grants?: Array<{ scope: 'org' | 'squad'; cap: 'owner' | 'admin' | 'lead' | 'member' | 'observer' }>
  agent?: string
  status?: 'active' | 'suspended'
  revoked?: boolean
  expired?: boolean
  otherTenant?: boolean
}

const ORG_ADMIN = [{ scope: 'org', cap: 'admin' }] as const

const FIXTURES: Record<string, Fixture> = {
  admin: { raw: 'mupot_admin', memberId: 'm-admin', channel: 'workspace', grants: [...ORG_ADMIN] },
  plain: { raw: 'mupot_plain', memberId: 'm-plain', channel: 'workspace' },
  member: { raw: 'mupot_member', memberId: 'm-member', channel: 'workspace', grants: [{ scope: 'org', cap: 'member' }] },
  observer: { raw: 'mupot_observer', memberId: 'm-observer', channel: 'workspace', grants: [{ scope: 'org', cap: 'observer' }] },
  squadMember: { raw: 'mupot_sqmember', memberId: 'm-sqmember', channel: 'workspace', grants: [{ scope: 'squad', cap: 'member' }] },
  squadObserver: { raw: 'mupot_sqobs', memberId: 'm-sqobs', channel: 'workspace', grants: [{ scope: 'squad', cap: 'observer' }] },
  // the gate's W1/W3 scenario: an agent-bound token whose member only observes squad-a
  agentObserver: { raw: 'mupot_agentobs', memberId: 'm-agentobs', channel: 'workspace', grants: [{ scope: 'squad', cap: 'observer' }], agent: 'agent-b' },
  im: { raw: 'mupot_im', memberId: 'm-im', channel: 'im', grants: [...ORG_ADMIN] },
  // the pot's seeded admin key (src/pots/service.ts) is a dashboard-channel key; MCP accepts it with its real grants
  dashboardToken: { raw: 'mupot_dash', memberId: 'm-dash', channel: 'dashboard', grants: [...ORG_ADMIN] },
  directoryUnbound: { raw: 'mupot_dir', memberId: 'm-dir', channel: 'directory', grants: [...ORG_ADMIN] },
  agentBound: { raw: 'mupot_agent', memberId: 'm-agent', channel: 'workspace', grants: [...ORG_ADMIN], agent: 'agent-a' },
  suspended: { raw: 'mupot_susp', memberId: 'm-susp', channel: 'workspace', grants: [...ORG_ADMIN], status: 'suspended' },
  revoked: { raw: 'mupot_rev', memberId: 'm-rev', channel: 'workspace', grants: [...ORG_ADMIN], revoked: true },
  expired: { raw: 'mupot_exp', memberId: 'm-exp', channel: 'workspace', grants: [...ORG_ADMIN], expired: true },
  foreignTenant: { raw: 'mupot_foreign', memberId: 'm-foreign', channel: 'workspace', grants: [...ORG_ADMIN], otherTenant: true },
}

async function seed(): Promise<void> {
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES('dept-a','delivery','Delivery');
    INSERT INTO squads(id,department_id,slug,name) VALUES('squad-a','dept-a','alpha','Alpha'),('squad-b','dept-a','beta','Beta');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES
      ('agent-a','squad-a','agent-a','Agent A','member','m','active'),
      ('agent-b','squad-b','agent-b','Agent B','member','m','active');
  `)
  for (const f of Object.values(FIXTURES)) {
    const tenant = f.otherTenant ? 'foreign' : TENANT
    h.sqlite.prepare(`INSERT INTO members(id,email,display_name,status,tenant) VALUES(?,?,?,?,?)`)
      .run(f.memberId, `${f.memberId}@example.test`, f.memberId, f.status ?? 'active', tenant)
    if (f.agent) h.sqlite.prepare(`INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES(?,?,?,datetime('now'))`).run(tenant, f.agent, f.memberId)
    h.sqlite.prepare(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,revoked_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(`tok-${f.memberId}`, f.memberId, await hashMemberToken(f.raw), 'fx', f.channel, f.agent ?? null, tenant,
        f.revoked ? "2020-01-01 00:00:00" : null, f.expired ? '2020-01-01 00:00:00' : null)
    for (const g of f.grants ?? []) {
      h.sqlite.prepare(`INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES(?,?,?,?,?)`)
        .run(`cap-${f.memberId}-${g.scope}`, f.memberId, g.scope, g.scope === 'org' ? null : 'squad-a', g.cap)
    }
  }
  h.sqlite.exec(`
    INSERT INTO tasks(id,squad_id,title,done_when,status) VALUES('t-live','squad-a','Live task','done','open'),('t-arch','squad-a','Archived task','done','open');
    INSERT INTO tasks_archive_state(task_id,archived_at,archived_reason,archived_by_member_id,prior_status) VALUES('t-arch',datetime('now'),'test','m-admin','open');
  `)
}

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  await seed()
})
afterEach(() => h.close())

// The real routers, mounted the way src/index.ts mounts them.
function prodShape(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.route('/api/tasks', tasksApp)
  app.route('/api/gates', gatesApp)
  app.route('/api/projects', projectsApp)
  app.route('/api/org', orgApp)
  app.route('/api/agents', agentsApp)
  app.route('/', dashboardApp)
  return app
}

const bearer = (raw: string): Record<string, string> => ({ authorization: `Bearer ${raw}` })

interface McpOutcome { status: number; ok: boolean; payload: unknown }
async function mcpTool(raw: string, name: string, args: Record<string, unknown> = {}): Promise<McpOutcome> {
  const res = await mcpRequest('https://t.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(raw) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }, env)
  const body = (await res.clone().json().catch(() => null)) as { result?: { isError?: boolean; structuredContent?: unknown }; error?: unknown } | null
  return { status: res.status, ok: res.status === 200 && !body?.error && body?.result?.isError !== true, payload: body?.result?.structuredContent ?? null }
}

describe('principal parity with MCP authenticateMember', () => {
  it.each(Object.keys(FIXTURES))('%s: HTTP is never wider than MCP, and equals it for workspace/im/dashboard keys', async (name) => {
    const f = FIXTURES[name]
    const header = (n: string): string | undefined => (n === 'authorization' ? `Bearer ${f.raw}` : undefined)
    const mcp = await authenticateMember({ req: { header }, env })
    const http = await resolveBearerReadAuth(env, `Bearer ${f.raw}`)
    if (!http) return // refused: always allowed to be narrower
    expect(mcp).not.toBeNull()
    expect(http.memberId).toBe(mcp?.memberId)
    expect(http.tenant).toBe(TENANT)
    expect(http.role).toBe('member')
    // a dashboard-channel key keeps its grants but never claims the human web-session channel
    expect(http.channel).toBe(mcp?.channel === 'dashboard' ? 'workspace' : mcp?.channel)
    expect(http.boundAgentId ?? null).toBe(mcp?.boundAgentId ?? null)
    expect(http.tokenId).toBe(mcp?.tokenId)
    expect(JSON.stringify(http.capabilities)).toBe(JSON.stringify(mcp?.capabilities))
  })

  it('accepts exactly live workspace, im and dashboard member keys that hold at least one grant', async () => {
    const allowed: string[] = []
    for (const [name, f] of Object.entries(FIXTURES)) if (await resolveBearerReadAuth(env, `Bearer ${f.raw}`)) allowed.push(name)
    expect(allowed.sort()).toEqual(['admin', 'agentBound', 'agentObserver', 'dashboardToken', 'im', 'member', 'observer', 'squadMember', 'squadObserver'])
  })

  it('DASHBOARD-CHANNEL DECISION: MCP accepts the pot-seeded dashboard admin key with its real grants, so HTTP does too', async () => {
    const f = FIXTURES.dashboardToken
    const header = (n: string): string | undefined => (n === 'authorization' ? `Bearer ${f.raw}` : undefined)
    const mcp = await authenticateMember({ req: { header }, env })
    expect(mcp?.channel).toBe('dashboard')
    expect(mcp?.capabilities?.length).toBeGreaterThan(0)
    const res = await prodShape().request('/api/gates/grants', { headers: bearer(f.raw) }, env)
    expect(res.status).toBe(200)
  })

  it('refuses a directory (OAuth-door / harness) credential even though MCP accepts it', async () => {
    const header = (n: string): string | undefined => (n === 'authorization' ? `Bearer ${FIXTURES.directoryUnbound.raw}` : undefined)
    expect(await authenticateMember({ req: { header }, env })).not.toBeNull()
    expect(await resolveBearerReadAuth(env, `Bearer ${FIXTURES.directoryUnbound.raw}`)).toBeNull()
  })

  it('fails closed on malformed headers and on a lookup error', async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error('d1 down') } } } as unknown as Env
    expect(await resolveBearerReadAuth(broken, `Bearer ${FIXTURES.admin.raw}`)).toBeNull()
    expect(await resolveBearerReadAuth(env, undefined)).toBeNull()
    expect(await resolveBearerReadAuth(env, 'Basic abc')).toBeNull()
    expect(await resolveBearerReadAuth(env, 'Bearer ')).toBeNull()
    expect(await resolveBearerReadAuth(env, 'Bearer nope')).toBeNull()
  })

  it('a failure AFTER the token resolved (the grants read) is "no principal", not an exception', async () => {
    const realPrepare = h.db.prepare.bind(h.db)
    const flaky = { ...env, DB: { ...h.db, prepare: (sql: string) => {
      if (/\bFROM\s+capabilities\b/i.test(sql)) throw new Error('capabilities read failed')
      return realPrepare(sql)
    } } } as unknown as Env
    await expect(resolveBearerReadAuth(flaky, `Bearer ${FIXTURES.admin.raw}`)).resolves.toBeNull()
  })

  it('refuses an observed or held seat agent (VIP floor) that MCP floors to a tool allowlist', async () => {
    h.sqlite.exec(`INSERT INTO harnesses(id,tenant,member_id,oauth_client_id) VALUES('hx','test','m-agent','client');
      INSERT INTO agent_seats(id,tenant,member_id,harness_id,key_hash,agent_id,max_live,admission_status)
      VALUES('seat-x','test','m-agent','hx','${'a'.repeat(64)}','agent-a',16,'observed');`)
    const vip = { ...env, VIP_LANE: '1' } as Env
    expect(await resolveBearerReadAuth(vip, `Bearer ${FIXTURES.agentBound.raw}`)).toBeNull()
    expect(await resolveBearerReadAuth(env, `Bearer ${FIXTURES.agentBound.raw}`)).not.toBeNull()
  })
})

describe('route parity with the MCP twin (real routers, real requireAuth, real mcpApp)', () => {
  interface Twin { http: string; tool: string; args?: Record<string, unknown>; dropped?: boolean; bothDenyForAdmin?: boolean }
  const TWINS: Twin[] = [
    { http: '/api/tasks?squad_id=squad-a', tool: 'task_list', args: { squad_id: 'squad-a' } },
    { http: '/api/projects', tool: 'project_list' },
    { http: '/api/gates/grants', tool: 'grant_list_gate_capabilities' },
    { http: '/api/kanban/board', tool: 'kanban_board' },
    { http: '/api/tasks/t-live', tool: 'task_get', args: { task_id: 't-live' } },
    { http: '/api/tasks/t-arch', tool: 'task_get', args: { task_id: 't-arch' }, bothDenyForAdmin: true },
    // Dropped from the allowlist: the HTTP handler has no twin-equivalent gate, so a bearer must be REFUSED outright.
    { http: '/api/org/squads/squad-a/agents', tool: 'peers', args: { squad_id: 'squad-a' }, dropped: true },
    { http: '/api/agents/agent-a/status', tool: 'fleet_agent_get', args: { agent_id: 'agent-a' }, dropped: true },
  ]

  for (const twin of TWINS) {
    it.each(Object.keys(FIXTURES))(`${twin.http} vs ${twin.tool}: %s`, async (name) => {
      const f = FIXTURES[name]
      const res = await prodShape().request(twin.http, { headers: bearer(f.raw) }, env)
      const httpAllowed = res.status === 200
      const mcp = await mcpTool(f.raw, twin.tool, twin.args)
      if (twin.dropped) {
        // cookie-only: a bearer is answered 401 whatever it holds, and never gets data MCP would withhold
        expect(res.status).toBe(401)
        return
      }
      if (name === 'admin') {
        // Not vacuous: the admin key must be served (or, for the archived row, be denied by BOTH).
        expect({ status: res.status, mcp: mcp.ok }).toEqual(twin.bothDenyForAdmin ? { status: 404, mcp: false } : { status: 200, mcp: true })
      }
      // Never wider: whatever HTTP serves, MCP serves the same token.
      if (httpAllowed) expect(mcp.ok).toBe(true)
      // Wherever MCP refuses the token, HTTP refuses it.
      if (!mcp.ok) expect(httpAllowed).toBe(false)
      // Same decision for every key kind that maps onto HTTP (workspace, im, dashboard).
      if (f.channel !== 'directory') expect({ name, httpAllowed }).toEqual({ name, httpAllowed: mcp.ok })
      // Credentials the ceiling excludes are answered 401, never a 200/403/404 that could leak existence.
      if (['directoryUnbound', 'suspended', 'revoked', 'expired', 'foreignTenant', 'plain'].includes(name)) expect(res.status).toBe(401)
    })
  }

  it('narrower ceilings are honoured: org member 403 on the admin-only route, observer 403 where MCP needs member', async () => {
    const get = (path: string, who: string) => prodShape().request(path, { headers: bearer(FIXTURES[who].raw) }, env)
    expect((await get('/api/gates/grants', 'member')).status).toBe(403)
    expect((await get('/api/gates/grants', 'admin')).status).toBe(200)
    for (const who of ['observer', 'squadObserver', 'agentObserver']) {
      expect((await get('/api/kanban/board', who)).status, `kanban ${who}`).toBe(403)
      expect((await get('/api/tasks?squad_id=squad-a', who)).status, `tasks ${who}`).toBe(403)
      expect((await get('/api/tasks/t-live', who)).status, `task_get ${who}`).toBe(403)
      expect((await get('/api/projects', who)).status, `projects ${who}`).toBe(200) // project_list needs only observer
    }
    for (const who of ['member', 'squadMember']) {
      expect((await get('/api/kanban/board', who)).status, `kanban ${who}`).toBe(200)
      expect((await get('/api/tasks/t-live', who)).status, `task_get ${who}`).toBe(200)
    }
  })

  it('/api/tasks/:id for a bearer returns exactly task_get\'s column set, and hides the receipt id from a non-viewer', async () => {
    const http = (await (await prodShape().request('/api/tasks/t-live', { headers: bearer(FIXTURES.member.raw) }, env)).json()) as { task: Record<string, unknown> }
    expect(Object.keys(http.task).sort()).toEqual([...TASK_GET_FIELDS].sort())
    expect(http.task.execution_receipt_id).toBeNull()
    const mcp = await mcpTool(FIXTURES.member.raw, 'task_get', { task_id: 't-live' })
    const mcpTask = (mcp.payload as { task?: Record<string, unknown> } | null)?.task
    expect(Object.keys(mcpTask ?? {}).sort()).toEqual(Object.keys(http.task).sort())
    // archived: 404 like task_get, not the 200 history read a cookie session gets
    const arch = await prodShape().request('/api/tasks/t-arch', { headers: bearer(FIXTURES.admin.raw) }, env)
    expect(arch.status).toBe(404)
    expect(await arch.json()).toEqual({ error: 'task_not_found' })
  })

  it('a cookie session\'s task read is unchanged (archived still readable, full column set)', async () => {
    const sessions = new Map<string, string>([['sess:cookie-admin', JSON.stringify({ userId: 'u-admin', email: null, role: 'admin', createdAt: new Date().toISOString() })]])
    const cookieEnv = { ...env, SESSIONS: { get: async (k: string) => sessions.get(k) ?? null, put: async () => undefined, delete: async () => undefined } } as unknown as Env
    const res = await prodShape().request('/api/tasks/t-arch', { headers: { cookie: 'mupot_session=cookie-admin' } }, cookieEnv)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { task: Record<string, unknown> }
    expect(Object.keys(body.task)).toContain('priority')
    expect(Object.keys(body.task)).not.toContain('execution_receipt_id')
  })

  it('cookie precedence: a low-privilege cookie session plus an ADMIN bearer is still 403 on /api/gates/grants', async () => {
    const sessions = new Map<string, string>([['sess:low', JSON.stringify({ userId: 'u-low', email: 'nobody@example.test', role: 'member', createdAt: new Date().toISOString() })]])
    const cookieEnv = { ...env, SESSIONS: { get: async (k: string) => sessions.get(k) ?? null, put: async () => undefined, delete: async () => undefined } } as unknown as Env
    const both = await prodShape().request('/api/gates/grants', { headers: { cookie: 'mupot_session=low', ...bearer(FIXTURES.admin.raw) } }, cookieEnv)
    expect(both.status).toBe(403)
    const bearerOnly = await prodShape().request('/api/gates/grants', { headers: bearer(FIXTURES.admin.raw) }, cookieEnv)
    expect(bearerOnly.status).toBe(200)
  })
})

describe('the allowlist and the method check', () => {
  const probe = (): Hono<{ Bindings: Env; Variables: { auth: AuthContext } }> => {
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
    app.use('*', requireAuth)
    app.all('*', (c) => c.json({ member: c.get('auth').memberId }))
    return app
  }
  const SAMPLES = [
    '/api/tasks', '/api/tasks/audit', '/api/tasks/t-1', '/api/gates/grants', '/api/projects', '/api/projects/p-1',
    '/api/projects/p-1/activity', '/api/projects/p-1/squads',
    '/api/kanban/board', '/api/telemetry/board-latency', '/api/pots',
  ]
  it('has a sample for every allowlist entry', () => {
    for (const r of BEARER_READ_ROUTES) expect(SAMPLES.some((s) => r.re.test(s)), String(r.re)).toBe(true)
    expect(SAMPLES.length).toBe(BEARER_READ_ROUTES.length)
  })
  it.each(SAMPLES)('GET and HEAD %s accept a valid admin bearer', async (path) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await probe().request(path, { method, headers: bearer(FIXTURES.admin.raw) }, env)
      expect(res.status, `${method} ${path}`).toBe(200)
    }
  })
  it.each(SAMPLES)('POST, PUT, PATCH, DELETE, OPTIONS %s are unchanged (bearer refused)', async (path) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const res = await probe().request(path, { method, headers: bearer(FIXTURES.admin.raw) }, env)
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
  it('eligibility is anchored at both ends and method-exact', () => {
    for (const m of ['OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'get', 'Head']) expect(bearerReadEligible(m, '/api/tasks'), m).toBe(false)
    for (const m of ['GET', 'HEAD']) expect(bearerReadEligible(m, '/api/tasks'), m).toBe(true)
    // unanchored regexes would match these
    for (const path of ['/x/api/tasks', '/prefix/api/kanban/board', 'https://evil.test/api/tasks', '/api/tasksX', '/api/tasks/audit/x', '/api/pots/x', '//api/tasks']) {
      expect(bearerReadEligible('GET', path), path).toBe(false)
    }
  })
  it('dotted and encoded segments are never eligible', () => {
    // asserted on the raw path string: a URL parser would rewrite %2e%2e before the server saw it
    for (const path of ['/api/tasks/..', '/api/tasks/.', '/api/tasks/%2e%2e', '/api/tasks/%2E', '/api/tasks/a%2Fb', '/api/tasks/%252e%252e', '/api/tasks/a;b', '/api/projects/p%2f1']) {
      expect(bearerReadEligible('GET', path), path).toBe(false)
    }
  })
  // Real route strings that must stay cookie-only, and near-misses of allowlisted ones.
  const EXCLUDED = [
    '/api/auth/sso/config', '/api/studio/database/query', '/api/studio/database/tables',
    '/api/agent-connections/r-1/status', '/api/alerts/webhooks', '/api/channels/bindings', '/api/channels/sync/status',
    '/api/billing/status', '/api/members/members', '/api/members/members/m-1',
    '/api/projects/p-1/evidence',
    '/api/loops', '/api/loops/l-1', '/api/loops/l-1/decisions',
    // dropped in round 2: no capability gate beyond the tenant (agents status, org/*)
    '/api/agents/agent-a/status', '/api/org/departments', '/api/org/departments/d-1/squads', '/api/org/squads/s-1/agents', '/api/org/tree',
    '/auth/me', '/auth/sessions', '/auth/identities', '/auth/reauth', '/auth/elevation/requests', '/auth/elevation/active',
    '/api/tasks/', '/api/tasks/t-1/extra', '/api/tasks/%252e%252e', '/api/Tasks', '/api/projects/p-1/other',
    '/api/prospects', '/api/reseller', '/api/router',
  ]
  it.each(EXCLUDED)('%s still refuses the bearer', async (path) => {
    expect(bearerReadEligible('GET', path)).toBe(false)
    const res = await probe().request(path, { headers: bearer(FIXTURES.admin.raw) }, env)
    expect(res.status).toBe(401)
  })
  it('/auth/* and requireRole instances never take a bearer even on an allowlisted-looking path', async () => {
    const roleApp = new Hono<{ Bindings: Env }>()
    roleApp.get('/api/tasks', requireRole('member'), (c) => c.json({ ok: true }))
    // NOTE: requireRole's own unauthenticated answer is a bare 200 (pre-existing: it returns c.res, not the guard's 401),
    // so assert what matters: the handler behind it never runs for a bearer.
    const viaRole = await roleApp.request('/api/tasks', { headers: bearer(FIXTURES.admin.raw) }, env)
    expect(await viaRole.text()).not.toContain('"ok":true')
    const me = await authApp.request('/me', { headers: bearer(FIXTURES.admin.raw) }, env)
    expect(me.status).toBe(401)
  })
  it('a cookie-less, header-less caller is still 401', async () => {
    expect((await probe().request('/api/tasks', {}, env)).status).toBe(401)
  })
})

describe('unauthenticated /api answers 401 JSON, browser pages still redirect', () => {
  it('names the accepted credentials instead of a 302', async () => {
    const res = await prodShape().request('/api/kanban/board', {}, env)
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'unauthenticated', accepted: ['bearer', 'cookie'] })
  })
  it('a route that stays cookie-only says so', async () => {
    const res = await prodShape().request('/api/loops', {}, env)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated', accepted: ['cookie'] })
  })
  it('an invalid bearer is the same 401', async () => {
    const res = await prodShape().request('/api/tasks', { headers: bearer('mupot_wrong') }, env)
    expect(res.status).toBe(401)
  })
  it('browser page routes still redirect to login', async () => {
    const res = await prodShape().request('/projects', { redirect: 'manual' }, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })
})
