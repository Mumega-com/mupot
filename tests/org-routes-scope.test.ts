// tests/org-routes-scope.test.ts — board aa25736e (P0 2026-11-11).
//
// The WEB routes under /api/org and /api/agents returned the whole directory to any
// signed-in member of the tenant. They now show a caller only squads it holds observer-or-above
// on (src/org/visibility.ts, over canOnSquadAuth/canOnSquad), the agents and memberships inside
// them, and answer a hidden squad / department / agent exactly as a missing one. An org admin
// sees every work squad but, by the convention squad_member_list / peers / resolveScopedSquad
// follow, not another member's home squad.
//
// Real migrated schema (createSqliteD1 + applyAllMigrations). Every principal reaches the routes
// through the REAL requireAuth cookie path: personas sign in by the real email one-time-code door
// (authApp) and the resulting mupot_session cookie is replayed. No session is mocked, except the
// legacy-owner persona whose KV session record is written directly (the email door can never
// mint an owner). The only double is the AGENT Durable Object binding, needed by /status.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { authApp } from '../src/auth'
import { orgApp } from '../src/org'
import { agentsApp } from '../src/agents'
import { createHomeForMember } from '../src/org/service'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}

let h: SqliteD1Harness
let env: Env
let kv: ReturnType<typeof memoryKv>

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
function deferredCtx() {
  const pending: Promise<unknown>[] = []
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext,
    flush: () => Promise.all(pending),
  }
}

function app(): Hono<{ Bindings: Env }> {
  const a = new Hono<{ Bindings: Env }>()
  a.route('/api/org', orgApp)
  a.route('/api/agents', agentsApp)
  return a
}

// Real email sign-in: start -> read the code the console sender printed -> verify -> cookie.
async function signIn(email: string): Promise<string> {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) })
  const d = deferredCtx()
  const start = await authApp.fetch(new Request(`${ORIGIN}/email/start`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email }),
  }), env, d.ctx)
  expect(start.status).toBe(200)
  await d.flush()
  spy.mockRestore()
  const code = /Or enter this code: (\d{6})/.exec(lines[lines.length - 1] ?? '')?.[1]
  if (!code) throw new Error('no sign-in code was sent')
  const verify = await authApp.fetch(new Request(`${ORIGIN}/email/verify`, {
    method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email, code }),
  }), env, ctx)
  expect(verify.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(verify.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return `mupot_session=${m[1]}`
}

async function get(cookie: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await app().fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), env, ctx)
  return { status: res.status, body: await res.json().catch(() => null) }
}

interface TreeAgent { id: string; memberships: Array<{ squad_id: string }> }
interface TreeSquad { id: string; agents: TreeAgent[] }
interface Tree { departments: Array<{ id: string; squads: TreeSquad[] }> }
const treeSquads = (b: unknown): TreeSquad[] => (b as Tree).departments.flatMap((d) => d.squads)
const treeAgentIds = (b: unknown): string[] => treeSquads(b).flatMap((s) => s.agents.map((a) => a.id)).sort()
const ids = (rows: unknown, key: string): string[] =>
  ((rows as Record<string, Array<{ id: string }>>)[key] ?? []).map((r) => r.id).sort()

let homeOfStranger = ''
let homeDeptOfStranger = ''
let cookies: { alice: string; bob: string; stranger: string; admin: string; owner: string }

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  kv = memoryKv()
  env = {
    DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN,
    OAUTH_CLIENT_ID: 'x.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 's',
    SESSIONS: kv, EMAIL_LOGIN_ENABLED: 'true', EMAIL_PROVIDER: 'console',
    AGENT: {
      idFromName: (n: string) => n,
      get: () => ({ fetch: async () => new Response(JSON.stringify({ cycles: 0 }), { headers: { 'content-type': 'application/json' } }) }),
    },
  } as unknown as Env

  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1','delivery','Delivery');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('squad-a','dept-1','a','Customer A','work'),('squad-b','dept-1','b','Customer B','work');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a1','squad-a','a1','Alpha One','member','m','active'),
      ('agent-b1','squad-b','b1','Bravo One','member','m','active');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES
      ('ms-a1-a','agent-a1','squad-a','member'),
      ('ms-a1-b','agent-a1','squad-b','observer'),
      ('ms-b1-b','agent-b1','squad-b','member');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('mem-alice','alice@a.test','Alice','active','${TENANT}'),
      ('mem-bob','bob@b.test','Bob','active','${TENANT}'),
      ('mem-stranger','stranger@x.test','Stranger','active','${TENANT}'),
      ('mem-admin','admin@x.test','Admin','active','${TENANT}'),
      ('mem-owner','owner@x.test','Owner','active','${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('g-alice','mem-alice','squad','squad-a','member'),
      ('g-bob','mem-bob','squad','squad-b','member'),
      ('g-admin','mem-admin','org',NULL,'admin');
  `)
  // Alice and Bob own a home each too, so "another person's home" has a real subject.
  const stranger = await createHomeForMember(env, 'mem-stranger')
  if (!stranger.ok) throw new Error('home for stranger')
  homeOfStranger = stranger.squad.id
  homeDeptOfStranger = (h.sqlite.prepare('SELECT department_id AS d FROM squads WHERE id = ?').get(homeOfStranger) as { d: string }).d
  const bobHome = await createHomeForMember(env, 'mem-bob')
  if (!bobHome.ok) throw new Error('home for bob')
  h.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-home-s','${homeOfStranger}','hs','Stranger Home Agent','member','m','active'),
      ('agent-home-b','${bobHome.squad.id}','hb','Bob Home Agent','member','m','active');
  `)
  // The legacy-role owner plane: the email door can never mint an owner, so seed the KV session
  // record directly (the cookie/KV resolution is still the real one).
  kv.store.set('sess:owner-sess', JSON.stringify({ userId: 'u-owner', email: 'owner@x.test', role: 'owner', createdAt: new Date().toISOString() }))
  cookies = {
    alice: await signIn('alice@a.test'),
    bob: await signIn('bob@b.test'),
    stranger: await signIn('stranger@x.test'),
    admin: await signIn('admin@x.test'),
    owner: 'mupot_session=owner-sess',
  }
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

describe('GET /api/org/tree', () => {
  it('a member of A gets A (and nothing of B), memberships on B are pruned', async () => {
    const r = await get(cookies.alice, '/api/org/tree')
    expect(r.status).toBe(200)
    expect(treeSquads(r.body).map((s) => s.id)).toEqual(['squad-a'])
    expect(treeAgentIds(r.body)).toEqual(['agent-a1'])
    const a1 = treeSquads(r.body)[0].agents[0]
    expect(a1.memberships.map((m) => m.squad_id)).toEqual(['squad-a'])
    expect(JSON.stringify(r.body)).not.toContain('agent-b1')
    expect(JSON.stringify(r.body)).not.toContain('squad-b')
  })
  it('a stranger with only a home squad gets nothing of A or B (and no home squad leaks into the tree)', async () => {
    const r = await get(cookies.stranger, '/api/org/tree')
    expect(r.status).toBe(200)
    expect(treeSquads(r.body)).toEqual([])
    expect(treeAgentIds(r.body)).toEqual([])
  })
  it('org admin and legacy owner get every work squad, agent and membership; never a home squad', async () => {
    for (const who of [cookies.admin, cookies.owner]) {
      const r = await get(who, '/api/org/tree')
      expect(r.status).toBe(200)
      expect(treeSquads(r.body).map((s) => s.id).sort()).toEqual(['squad-a', 'squad-b'])
      expect(treeAgentIds(r.body)).toEqual(['agent-a1', 'agent-b1'])
      expect(treeSquads(r.body).flatMap((s) => s.agents.flatMap((a) => a.memberships)).length).toBe(3)
    }
  })
})

describe('GET /api/org/squads/:id/agents', () => {
  it('the member of A reads A; B answers exactly as a missing squad', async () => {
    const own = await get(cookies.alice, '/api/org/squads/squad-a/agents')
    expect(own.status).toBe(200)
    expect(ids(own.body, 'agents')).toEqual(['agent-a1'])
    const hidden = await get(cookies.alice, '/api/org/squads/squad-b/agents')
    const missing = await get(cookies.alice, '/api/org/squads/squad-does-not-exist/agents')
    expect(hidden.status).toBe(404)
    expect(hidden).toEqual(missing)
  })
  it('the stranger gets nothing of A or B, identical to missing', async () => {
    const missing = await get(cookies.stranger, '/api/org/squads/squad-does-not-exist/agents')
    for (const sq of ['squad-a', 'squad-b']) {
      expect(await get(cookies.stranger, `/api/org/squads/${sq}/agents`)).toEqual(missing)
    }
  })
  it('org admin and legacy owner read A and B', async () => {
    for (const who of [cookies.admin, cookies.owner]) {
      expect(ids((await get(who, '/api/org/squads/squad-a/agents')).body, 'agents')).toEqual(['agent-a1'])
      expect(ids((await get(who, '/api/org/squads/squad-b/agents')).body, 'agents')).toEqual(['agent-b1'])
    }
  })
  it('home squad: only its owner reads it; another member, an org admin and a legacy owner are refused as if it did not exist', async () => {
    const ownRead = await get(cookies.stranger, `/api/org/squads/${homeOfStranger}/agents`)
    expect(ownRead.status).toBe(200)
    expect(ids(ownRead.body, 'agents')).toEqual(['agent-home-s'])
    const missing = await get(cookies.alice, '/api/org/squads/squad-does-not-exist/agents')
    for (const who of [cookies.alice, cookies.bob, cookies.admin, cookies.owner]) {
      expect(await get(who, `/api/org/squads/${homeOfStranger}/agents`)).toEqual(missing)
    }
  })
})

describe('GET /api/org/departments/:id/squads', () => {
  it('a member of A sees only squad A in the shared department', async () => {
    const r = await get(cookies.alice, '/api/org/departments/dept-1/squads')
    expect(r.status).toBe(200)
    expect(ids(r.body, 'squads')).toEqual(['squad-a'])
  })
  it('the stranger sees no squad of the department', async () => {
    const r = await get(cookies.stranger, '/api/org/departments/dept-1/squads')
    expect(r.status).toBe(200)
    expect(ids(r.body, 'squads')).toEqual([])
  })
  it('org admin and legacy owner see both work squads', async () => {
    for (const who of [cookies.admin, cookies.owner]) {
      expect(ids((await get(who, '/api/org/departments/dept-1/squads')).body, 'squads')).toEqual(['squad-a', 'squad-b'])
    }
  })
  it("another member's home department answers exactly as a missing department (org admin and legacy owner included); its owner sees their home squad", async () => {
    const missing = await get(cookies.alice, '/api/org/departments/dept-does-not-exist/squads')
    expect(missing.status).toBe(404)
    for (const who of [cookies.alice, cookies.bob, cookies.admin, cookies.owner]) {
      expect(await get(who, `/api/org/departments/${homeDeptOfStranger}/squads`)).toEqual(missing)
    }
    const own = await get(cookies.stranger, `/api/org/departments/${homeDeptOfStranger}/squads`)
    expect(own.status).toBe(200)
    expect(ids(own.body, 'squads')).toEqual([homeOfStranger])
  })
})

describe('GET /api/agents/:agentId/status', () => {
  it('the member of A reads A1; B1 answers exactly as a missing agent', async () => {
    expect((await get(cookies.alice, '/api/agents/agent-a1/status')).status).toBe(200)
    const missing = await get(cookies.alice, '/api/agents/agent-nope/status')
    expect(missing.status).toBe(404)
    expect(await get(cookies.alice, '/api/agents/agent-b1/status')).toEqual(missing)
  })
  it('the stranger gets nothing of A or B', async () => {
    const missing = await get(cookies.stranger, '/api/agents/agent-nope/status')
    for (const a of ['agent-a1', 'agent-b1']) expect(await get(cookies.stranger, `/api/agents/${a}/status`)).toEqual(missing)
  })
  it('org admin and legacy owner read every work-squad agent', async () => {
    for (const who of [cookies.admin, cookies.owner]) {
      for (const a of ['agent-a1', 'agent-b1']) expect((await get(who, `/api/agents/${a}/status`)).status).toBe(200)
    }
  })
  it("home squad: an agent in another member's home is hidden from everyone but its owner, org admin and legacy owner included", async () => {
    const missing = await get(cookies.alice, '/api/agents/agent-nope/status')
    for (const who of [cookies.alice, cookies.bob, cookies.admin, cookies.owner]) {
      expect(await get(who, '/api/agents/agent-home-s/status')).toEqual(missing)
    }
    expect((await get(cookies.stranger, '/api/agents/agent-home-s/status')).status).toBe(200)
  })
})

// "Does a stranger who has only signed in reach these routes through the real requireAuth?"
// A brand-new email that no admin ever added: real sign-in, real cookie, real routes. The `stranger`
// persona above (member row + home squad only, the OAuth-review shape) signs in by the same real door.
describe('stranger reach through the real sign-in path', () => {
  it('a brand-new email signs in, gets a real session, and is authenticated on all four routes; the answer is empty or missing', async () => {
    const before = (h.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n
    const cookie = await signIn('walk-in@nowhere.test')
    const created = h.sqlite.prepare(`SELECT id FROM members WHERE lower(email) = 'walk-in@nowhere.test'`).all() as Array<{ id: string }>
    // Measured 2026-11-11: the email door mints NO members row for an unknown email (session role 'member', no memberId,
    // no grants). If a door ever does mint one, give it the OAuth-review shape (a home squad only) before asking.
    if (created.length === 1) await createHomeForMember(env, created[0].id)
    const grants = created.length === 1
      ? (h.sqlite.prepare('SELECT scope_type FROM capabilities WHERE member_id = ?').all(created[0].id) as Array<{ scope_type: string }>)
      : []
    expect(grants.every((g) => g.scope_type === 'squad')).toBe(true)
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }).n).toBeGreaterThanOrEqual(before)

    const tree = await get(cookie, '/api/org/tree')
    const agents = await get(cookie, '/api/org/squads/squad-a/agents')
    const dept = await get(cookie, '/api/org/departments/dept-1/squads')
    const status = await get(cookie, '/api/agents/agent-a1/status')
    // 200 on the tree and department routes proves requireAuth + tenant guard admitted the walk-in.
    expect(tree.status).toBe(200)
    expect(dept.status).toBe(200)
    expect(treeAgentIds(tree.body)).toEqual([])
    expect(ids(dept.body, 'squads')).toEqual([])
    expect(agents.status).toBe(404)
    expect(status.status).toBe(404)
    // and without any cookie none of them is reachable at all
    expect((await get('', '/api/org/tree')).status).toBe(401)
  })
  it('a bearer is refused on every one of these routes (they are cookie-only)', async () => {
    h.sqlite.exec(`INSERT INTO member_tokens(id,member_id,token_hash,label,channel,agent_id,tenant) VALUES ('tok-x','mem-alice','deadbeef','fx','workspace',NULL,'${TENANT}')`)
    for (const p of ['/api/org/tree', '/api/org/squads/squad-a/agents', '/api/org/departments/dept-1/squads', '/api/agents/agent-a1/status']) {
      const res = await app().fetch(new Request(`${ORIGIN}${p}`, { headers: { authorization: 'Bearer anything' } }), env, ctx)
      expect(res.status).toBe(401)
    }
  })
})
