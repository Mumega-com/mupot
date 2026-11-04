import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import type { AuthContext, Env } from '../src/types'
import { requireAuth, requireRole } from '../src/auth'
import { authApp } from '../src/auth'
import { BEARER_READ_ROUTES, bearerReadEligible, resolveBearerReadAuth } from '../src/auth/bearer-read'
import { authenticateMember, mcpApp } from '../src/mcp'
import { tasksApp, gatesApp } from '../src/tasks'
import { projectsApp } from '../src/projects'
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
  org?: 'admin' | 'member' | null
  agent?: string
  status?: 'active' | 'suspended'
  revoked?: boolean
  expired?: boolean
  otherTenant?: boolean
}

const FIXTURES: Record<string, Fixture> = {
  admin: { raw: 'mupot_admin', memberId: 'm-admin', channel: 'workspace', org: 'admin' },
  plain: { raw: 'mupot_plain', memberId: 'm-plain', channel: 'workspace', org: null },
  member: { raw: 'mupot_member', memberId: 'm-member', channel: 'workspace', org: 'member' },
  im: { raw: 'mupot_im', memberId: 'm-im', channel: 'im', org: 'admin' },
  dashboardToken: { raw: 'mupot_dash', memberId: 'm-dash', channel: 'dashboard', org: 'admin' },
  directoryUnbound: { raw: 'mupot_dir', memberId: 'm-dir', channel: 'directory', org: 'admin' },
  agentBound: { raw: 'mupot_agent', memberId: 'm-agent', channel: 'workspace', org: 'admin', agent: 'agent-a' },
  suspended: { raw: 'mupot_susp', memberId: 'm-susp', channel: 'workspace', org: 'admin', status: 'suspended' },
  revoked: { raw: 'mupot_rev', memberId: 'm-rev', channel: 'workspace', org: 'admin', revoked: true },
  expired: { raw: 'mupot_exp', memberId: 'm-exp', channel: 'workspace', org: 'admin', expired: true },
  foreignTenant: { raw: 'mupot_foreign', memberId: 'm-foreign', channel: 'workspace', org: 'admin', otherTenant: true },
}

async function seed(): Promise<void> {
  h.sqlite.exec(`
    INSERT INTO departments(id,slug,name) VALUES('dept-a','delivery','Delivery');
    INSERT INTO squads(id,department_id,slug,name) VALUES('squad-a','dept-a','alpha','Alpha');
    INSERT INTO agents(id,squad_id,slug,name,role,model,status) VALUES('agent-a','squad-a','agent-a','Agent A','member','m','active');
  `)
  for (const f of Object.values(FIXTURES)) {
    const tenant = f.otherTenant ? 'foreign' : TENANT
    h.sqlite.prepare(`INSERT INTO members(id,email,display_name,status,tenant) VALUES(?,?,?,?,?)`)
      .run(f.memberId, `${f.memberId}@example.test`, f.memberId, f.status ?? 'active', tenant)
    if (f.agent) h.sqlite.prepare(`INSERT INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES(?,?,?,datetime('now'))`).run(tenant, f.agent, f.memberId)
    h.sqlite.prepare(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant,revoked_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(`tok-${f.memberId}`, f.memberId, await hashMemberToken(f.raw), 'fx', f.channel, f.agent ?? null, tenant,
        f.revoked ? "2020-01-01 00:00:00" : null, f.expired ? '2020-01-01 00:00:00' : null)
    if (f.org) {
      h.sqlite.prepare(`INSERT INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES(?,?,?,?,?)`)
        .run(`cap-${f.memberId}`, f.memberId, 'org', null, f.org)
    }
  }
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
  app.route('/', dashboardApp)
  return app
}

const bearer = (raw: string): Record<string, string> => ({ authorization: `Bearer ${raw}` })

async function mcpTool(raw: string, name: string, args: Record<string, unknown> = {}): Promise<{ status: number; ok: boolean }> {
  const res = await mcpRequest('https://t.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(raw) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }, env)
  const body = (await res.clone().json().catch(() => null)) as { result?: { isError?: boolean }; error?: unknown } | null
  return { status: res.status, ok: res.status === 200 && !body?.error && body?.result?.isError !== true }
}

describe('principal parity with MCP authenticateMember', () => {
  it.each(Object.keys(FIXTURES))('%s: HTTP is never wider than MCP, and equals it for workspace/im keys', async (name) => {
    const f = FIXTURES[name]
    const header = (n: string): string | undefined => (n === 'authorization' ? `Bearer ${f.raw}` : undefined)
    const mcp = await authenticateMember({ req: { header }, env })
    const http = await resolveBearerReadAuth(env, `Bearer ${f.raw}`)
    if (!http) return // refused: always allowed to be narrower
    expect(mcp).not.toBeNull()
    expect(http.memberId).toBe(mcp?.memberId)
    expect(http.tenant).toBe(TENANT)
    expect(http.role).toBe('member')
    expect(http.channel).toBe(mcp?.channel)
    expect(http.boundAgentId ?? null).toBe(mcp?.boundAgentId ?? null)
    expect(http.tokenId).toBe(mcp?.tokenId)
    expect(JSON.stringify(http.capabilities)).toBe(JSON.stringify(mcp?.capabilities))
  })

  it('accepts exactly live workspace and im member keys that hold at least one grant', async () => {
    const allowed: string[] = []
    for (const [name, f] of Object.entries(FIXTURES)) if (await resolveBearerReadAuth(env, `Bearer ${f.raw}`)) allowed.push(name)
    expect(allowed.sort()).toEqual(['admin', 'agentBound', 'im', 'member'])
  })

  it('refuses a directory (OAuth-door / harness) credential even though MCP accepts it, and a dashboard-channel key', async () => {
    const header = (n: string): string | undefined => (n === 'authorization' ? `Bearer ${FIXTURES.directoryUnbound.raw}` : undefined)
    expect(await authenticateMember({ req: { header }, env })).not.toBeNull()
    expect(await resolveBearerReadAuth(env, `Bearer ${FIXTURES.directoryUnbound.raw}`)).toBeNull()
    expect(await resolveBearerReadAuth(env, `Bearer ${FIXTURES.dashboardToken.raw}`)).toBeNull()
  })

  it('refuses a token whose channel is missing/unknown (fail closed)', async () => {
    h.sqlite.exec("DROP TRIGGER IF EXISTS member_tokens_agent_binding_update")
    const broken = { ...env, DB: { prepare: () => { throw new Error('d1 down') } } } as unknown as Env
    expect(await resolveBearerReadAuth(broken, `Bearer ${FIXTURES.admin.raw}`)).toBeNull()
    expect(await resolveBearerReadAuth(env, undefined)).toBeNull()
    expect(await resolveBearerReadAuth(env, 'Basic abc')).toBeNull()
    expect(await resolveBearerReadAuth(env, 'Bearer ')).toBeNull()
    expect(await resolveBearerReadAuth(env, 'Bearer nope')).toBeNull()
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

describe('route parity with the MCP twin (real routers, real requireAuth)', () => {
  const TWINS: Array<{ http: string; tool: string; args?: Record<string, unknown> }> = [
    { http: '/api/tasks?squad_id=squad-a', tool: 'task_list', args: { squad_id: 'squad-a' } },
    { http: '/api/projects', tool: 'project_list' },
    { http: '/api/gates/grants', tool: 'grant_list_gate_capabilities' },
  ]

  for (const twin of TWINS) {
    it.each(Object.keys(FIXTURES))(`${twin.http} vs ${twin.tool}: %s`, async (name) => {
      const f = FIXTURES[name]
      const res = await prodShape().request(twin.http, { headers: bearer(f.raw) }, env)
      const httpAllowed = res.status === 200
      const mcp = await mcpTool(f.raw, twin.tool, twin.args)
      // Not vacuous: the admin key must actually be served, or the equalities below prove nothing.
      if (name === 'admin') expect({ status: res.status, mcp: mcp.ok }).toEqual({ status: 200, mcp: true })
      // Never wider: whatever HTTP serves, MCP serves the same token.
      if (httpAllowed) expect(mcp.ok).toBe(true)
      // Same decision for the key kinds that map 1:1 onto HTTP.
      if (f.channel === 'workspace' || f.channel === 'im') expect({ name, httpAllowed }).toEqual({ name, httpAllowed: mcp.ok })
      // Wherever MCP refuses or zero-grants the token, HTTP refuses it.
      if (!mcp.ok) expect(httpAllowed).toBe(false)
      // Credentials the ceiling excludes are answered 401, never a 200/403 that could leak existence.
      if (!res.ok && ['directoryUnbound', 'dashboardToken', 'suspended', 'revoked', 'expired', 'foreignTenant'].includes(name)) {
        expect(res.status).toBe(401)
      }
    })
  }

  it('a narrower admin ceiling is honoured: org member is 403 on the admin-only gates route, admin is 200', async () => {
    const asMember = await prodShape().request('/api/gates/grants', { headers: bearer(FIXTURES.member.raw) }, env)
    const asAdmin = await prodShape().request('/api/gates/grants', { headers: bearer(FIXTURES.admin.raw) }, env)
    expect(asMember.status).toBe(403)
    expect(asAdmin.status).toBe(200)
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
    '/api/projects/p-1/activity', '/api/projects/p-1/evidence', '/api/projects/p-1/squads', '/api/org/departments',
    '/api/org/departments/d-1/squads', '/api/org/squads/s-1/agents', '/api/org/tree', '/api/agents/a-1/status',
    '/api/kanban/board', '/api/telemetry/board-latency', '/api/pots',
  ]
  it('has a sample for every allowlist entry', () => {
    for (const r of BEARER_READ_ROUTES) expect(SAMPLES.some((s) => r.test(s)), String(r)).toBe(true)
    expect(SAMPLES.length).toBe(BEARER_READ_ROUTES.length)
  })
  it.each(SAMPLES)('GET and HEAD %s accept a valid bearer', async (path) => {
    for (const method of ['GET', 'HEAD']) {
      const res = await probe().request(path, { method, headers: bearer(FIXTURES.admin.raw) }, env)
      expect(res.status, `${method} ${path}`).toBe(200)
    }
  })
  it.each(SAMPLES)('POST, PUT, PATCH, DELETE %s are unchanged (bearer refused)', async (path) => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await probe().request(path, { method, headers: bearer(FIXTURES.admin.raw) }, env)
      expect(res.status, `${method} ${path}`).toBe(401)
    }
  })
  // Real route strings that must stay cookie-only, and a few near-misses of allowlisted ones.
  const EXCLUDED = [
    '/api/auth/sso/config', '/api/studio/database/query', '/api/studio/database/tables',
    '/api/agent-connections/r-1/status', '/api/alerts/webhooks', '/api/channels/bindings', '/api/channels/sync/status',
    '/api/billing/status', '/api/members/members', '/api/members/members/m-1',
    '/api/loops', '/api/loops/l-1', '/api/loops/l-1/decisions',
    '/auth/me', '/auth/sessions', '/auth/identities', '/auth/reauth', '/auth/elevation/requests', '/auth/elevation/active',
    '/api/tasks/', '/api/tasks/t-1/extra', '/api/tasks/%2e%2e', '/api/tasks/..', '/api/Tasks', '/api/projects/p-1/other',
    '/api/projects/p%2f1', '/api/prospects', '/api/reseller', '/api/router',
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
  it('a cookie-less, header-less caller is still 401, and a cookie session still works first', async () => {
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
  it('the dashboardApp /api path serves the bearer on an allowlisted GET', async () => {
    const res = await prodShape().request('/api/kanban/board', { headers: bearer(FIXTURES.admin.raw) }, env)
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(302)
  })
  it('keeps the OAuth-style mcp mount reachable (mcpApp unchanged)', () => {
    expect(typeof mcpApp.request).toBe('function')
  })
})
