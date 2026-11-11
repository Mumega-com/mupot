// tests/coordination-scope.test.ts — board dee4b1f4 (P0 2026-11-10).
//
// The Control Tower board was tenant-wide: any live token read every agent's journey goal and gate,
// and any agent-bound token could post a journey under another customer's project name. The board is
// now scoped by agent squad (read) and by project access (write). Real migrated schema; every call
// drives the real route handlers (coordinationApp) and the real dashboard route (/radar?tab=departures).
import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { coordinationApp } from '../src/coordination/routes'
import { listJourneys } from '../src/coordination/journeys'
import { Hono } from 'hono'
import { makeMissionControlApp } from '../src/dashboard/mission-control-routes'
import { resolveCapabilities } from '../src/auth/capability'
import { agentVisibility } from '../src/auth/agent-visibility'
import { hashMemberToken } from '../src/auth/member-bearer'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const RAW = {
  agentA: 'raw-agent-a', agentB: 'raw-agent-b', humanA: 'raw-human-a', obsA: 'raw-obs-a',
  zero: 'raw-zero', zeroAgent: 'raw-zero-agent', root: 'raw-root', rootAgent: 'raw-root-agent', homeX: 'raw-home-x',
}

let h: SqliteD1Harness
let env: Env

async function seed(): Promise<void> {
  const tokens = await Promise.all(Object.entries(RAW).map(async ([k, v]) => [k, await hashMemberToken(v)] as const))
  const hash = Object.fromEntries(tokens)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','A'),('dept-b','dept-b','B'),('dept-x','dept-x','X');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('cust-a','dept-a','cust-a','Cust A','work'),('cust-b','dept-b','cust-b','Cust B','work'),
      ('home-x','dept-x','home-x','Home X','home');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('mem-a-agent',NULL,'A agent','active','${TENANT}'),('mem-b-agent',NULL,'B agent','active','${TENANT}'),
      ('mem-a-human','a@a.test','A human','active','${TENANT}'),('mem-obs-a','o@a.test','Obs A','active','${TENANT}'),
      ('mem-zero','z@x.test','Zero','active','${TENANT}'),('mem-zero-agent',NULL,'Zero agent','active','${TENANT}'),
      ('mem-root','r@x.test','Root','active','${TENANT}'),('mem-root-agent',NULL,'Root agent','active','${TENANT}'),
      ('mem-x','x@evil.test','Stranger','active','${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, status, owner_member_id) VALUES
      ('ag-a','cust-a','a1','A1','active',NULL),('ag-b','cust-b','b1','B1','active',NULL),
      ('ag-zero','cust-a','z1','Z1','active',NULL),('ag-root','cust-a','r1','R1','active',NULL);
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c1','mem-a-agent','squad','cust-a','member'),('c2','mem-b-agent','squad','cust-b','member'),
      ('c3','mem-a-human','squad','cust-a','member'),('c4','mem-obs-a','squad','cust-a','observer'),
      ('c5','mem-root','org',NULL,'admin'),('c6','mem-root-agent','org',NULL,'admin'),
      ('c7','mem-x','squad','home-x','admin');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}','ag-a','mem-a-agent',datetime('now')),('${TENANT}','ag-b','mem-b-agent',datetime('now')),
      ('${TENANT}','ag-zero','mem-zero-agent',datetime('now')),('${TENANT}','ag-root','mem-root-agent',datetime('now'));
    INSERT INTO member_tokens (id, member_id, agent_id, tenant, channel, token_hash, label, expires_at) VALUES
      ('t-agent-a','mem-a-agent','ag-a','${TENANT}','workspace','${hash.agentA}','x','2099-01-01T00:00:00.000Z'),
      ('t-agent-b','mem-b-agent','ag-b','${TENANT}','workspace','${hash.agentB}','x','2099-01-01T00:00:00.000Z'),
      ('t-human-a','mem-a-human',NULL,'${TENANT}','workspace','${hash.humanA}','x','2099-01-01T00:00:00.000Z'),
      ('t-obs-a','mem-obs-a',NULL,'${TENANT}','workspace','${hash.obsA}','x','2099-01-01T00:00:00.000Z'),
      ('t-zero','mem-zero',NULL,'${TENANT}','workspace','${hash.zero}','x','2099-01-01T00:00:00.000Z'),
      ('t-zero-agent','mem-zero-agent','ag-zero','${TENANT}','workspace','${hash.zeroAgent}','x','2099-01-01T00:00:00.000Z'),
      ('t-root','mem-root',NULL,'${TENANT}','workspace','${hash.root}','x','2099-01-01T00:00:00.000Z'),
      ('t-root-agent','mem-root-agent','ag-root','${TENANT}','workspace','${hash.rootAgent}','x','2099-01-01T00:00:00.000Z'),
      ('t-home-x','mem-x',NULL,'${TENANT}','workspace','${hash.homeX}','x','2099-01-01T00:00:00.000Z');
    INSERT INTO projects (id, slug, name, status) VALUES ('p-a','proj-a','Proj A','active'),('p-b','proj-b','Proj B','active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p-a','cust-a','write'),('p-b','cust-b','write');
  `)
}

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  await seed()
})

const headers = (raw: string): Record<string, string> => ({ authorization: `Bearer ${raw}`, 'content-type': 'application/json' })
const post = (raw: string, body: unknown) =>
  coordinationApp.request('/', { method: 'POST', headers: headers(raw), body: JSON.stringify(body) }, env)
const get = (raw: string, q = '?scope=all') => coordinationApp.request(`/${q}`, { headers: headers(raw) }, env)
async function board(raw: string): Promise<{ status: number; goals: string[] }> {
  const res = await get(raw)
  const j = (await res.json()) as { board?: Array<{ goal: string }> }
  return { status: res.status, goals: (j.board ?? []).map((c) => c.goal).sort() }
}
// Seed one journey per customer straight through the legitimate route.
async function boardBoth(): Promise<void> {
  expect((await post(RAW.agentA, { project: 'proj-a', goal: 'A-SECRET', gate: 'A-GATE' })).status).toBe(201)
  expect((await post(RAW.agentB, { project: 'proj-b', goal: 'B-SECRET', gate: 'B-GATE' })).status).toBe(201)
}

describe('reading the board', () => {
  it('a member of squad A sees A journeys and none of B (including by gate text)', async () => {
    await boardBoth()
    for (const raw of [RAW.agentA, RAW.humanA, RAW.obsA]) {
      const res = await get(raw)
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text).toContain('A-SECRET')
      expect(text).not.toContain('B-SECRET')
      expect(text).not.toContain('B-GATE')
    }
  })
  it('squad B symmetric: sees B, not A', async () => {
    await boardBoth()
    expect((await board(RAW.agentB)).goals).toEqual(['B-SECRET'])
  })
  it('a zero-grant token reads an empty board in the same shape as before', async () => {
    await boardBoth()
    const res = await get(RAW.zero)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, board: [], scope: 'all' })
  })
  it('a stranger holding only an OAuth home squad reads nothing of A or B', async () => {
    await boardBoth()
    expect((await board(RAW.homeX)).goals).toEqual([])
  })
  it('org admin reads every squad', async () => {
    await boardBoth()
    expect((await board(RAW.root)).goals).toEqual(['A-SECRET', 'B-SECRET'])
  })
  it('the limit counts visible journeys only (hidden B rows cannot take A slots)', async () => {
    expect((await post(RAW.agentA, { project: 'proj-a', goal: 'A-1' })).status).toBe(201)
    for (let i = 0; i < 5; i++) await post(RAW.agentB, { project: 'proj-b', goal: `B-${i}` })
    expect((await post(RAW.agentA, { project: 'proj-a', goal: 'A-2' })).status).toBe(201)
    const res = await get(RAW.agentA, '?scope=all&limit=2')
    const j = (await res.json()) as { board: Array<{ goal: string }> }
    expect(j.board.map((c) => c.goal).sort()).toEqual(['A-1', 'A-2'])
  })
  it('a journey whose agent row is gone is visible only to org admin', async () => {
    h.sqlite.exec(`INSERT INTO journeys (id, tenant, agent, project, goal) VALUES ('j-orphan','${TENANT}','ag-deleted','proj-a','ORPHAN')`)
    expect((await board(RAW.humanA)).goals).toEqual([])
    expect((await board(RAW.root)).goals).toEqual(['ORPHAN'])
  })
  it('no token → 401', async () => {
    expect((await coordinationApp.request('/', {}, env)).status).toBe(401)
  })
})

describe('writing to the board', () => {
  it('legitimate: an agent boards under its own squad project; PATCH own flight works', async () => {
    const res = await post(RAW.agentA, { project: 'proj-a', goal: 'mine' })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: string }
    expect((await coordinationApp.request(`/${id}`, { method: 'PATCH', headers: headers(RAW.agentA), body: JSON.stringify({ status: 'departed' }) }, env)).status).toBe(200)
    expect((await coordinationApp.request(`/${id}`, { method: 'PATCH', headers: headers(RAW.agentB), body: JSON.stringify({ status: 'arrived' }) }, env)).status).toBe(404)
  })
  it('A cannot post under B project; refusal is identical to a nonexistent project and writes nothing', async () => {
    const other = await post(RAW.agentA, { project: 'proj-b', goal: 'INJECT' })
    const missing = await post(RAW.agentA, { project: 'no-such-project', goal: 'INJECT' })
    expect(other.status).toBe(missing.status)
    expect(other.status).toBe(404)
    expect(await other.json()).toEqual(await missing.json())
    // a project given by id and in different case is the same refusal
    expect((await post(RAW.agentA, { project: 'P-B' })).status).toBe(404)
    expect((await post(RAW.agentA, { project: 'PROJ-B' })).status).toBe(404)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM journeys').get()).toEqual({ n: 0 })
  })
  it('zero-grant tokens write nothing: unbound → 403, zero-grant agent weld → 401', async () => {
    expect((await post(RAW.zero, { project: 'proj-a' })).status).toBe(403)
    expect((await post(RAW.zeroAgent, { project: 'proj-a' })).status).toBe(401)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM journeys').get()).toEqual({ n: 0 })
  })
  it('a read-only project edge is not enough to board', async () => {
    h.sqlite.exec(`UPDATE project_squad_access SET access_level = 'read' WHERE project_id = 'p-a'`)
    expect((await post(RAW.agentA, { project: 'proj-a' })).status).toBe(404)
  })
  it('an org-admin agent may board under any name', async () => {
    expect((await post(RAW.rootAgent, { project: 'proj-b', goal: 'admin' })).status).toBe(201)
  })
  it('invalid project format is still 400', async () => {
    expect((await post(RAW.agentA, { project: 'bad space' })).status).toBe(400)
  })
})

describe('service and dashboard use the same scope', () => {
  // The real /radar handler (makeMissionControlApp) with the auth a session would have resolved to:
  // a member carries its live grants; the legacy owner leaves capabilities undefined.
  async function dashboardDepartures(memberId: string, role: 'member' | 'owner'): Promise<{ status: number; html: string }> {
    const auth: AuthContext = {
      userId: memberId, email: null, role, tenant: TENANT, memberId, channel: 'dashboard',
      ...(role === 'member' ? { capabilities: await resolveCapabilities(env, memberId) } : {}),
    }
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
    app.use('*', async (c, next) => { c.set('auth', auth); await next() })
    app.route('/', makeMissionControlApp((_e, _title, body) => body as never))
    const res = await app.request('/radar?tab=departures', {}, env)
    return { status: res.status, html: await res.text() }
  }
  it('the dashboard departures tab shows a non-admin only their squad journeys; admin sees all', async () => {
    await boardBoth()
    const a = await dashboardDepartures('mem-a-human', 'member')
    expect(a.status).toBe(200)
    expect(a.html).toContain('A-SECRET')
    expect(a.html).not.toContain('B-SECRET')
    expect(a.html).not.toContain('B-GATE')
    const root = await dashboardDepartures('mem-root', 'owner')
    expect(root.html).toContain('A-SECRET')
    expect(root.html).toContain('B-SECRET')
  })
  it('listJourneys applies canSee before the limit', async () => {
    await boardBoth()
    const auth = { userId: 'u', email: null, role: 'member', tenant: TENANT, memberId: 'mem-a-human', channel: 'workspace',
      capabilities: [{ member_id: 'mem-a-human', scope_type: 'squad', scope_id: 'cust-a', capability: 'member' }], boundAgentId: null } as unknown as AuthContext
    const rows = await listJourneys(env, { scope: 'all', canSee: agentVisibility(env, auth) })
    expect(rows.map((r) => r.goal)).toEqual(['A-SECRET'])
  })
})
