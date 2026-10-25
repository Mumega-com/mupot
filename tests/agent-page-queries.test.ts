// GET /agents/:id as an org admin: D1 statement count must not scale with org size (members/squads/agents).
// Before the fix the "Set owner" candidate list ran exceedsTargetRankCeiling per member (up to 200 members,
// ~4+k serial D1 round trips each), which is the multi-minute signed-in render.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { exceedsTargetRankCeiling, exceedsTargetRankCeilingForMembers } from '../src/auth/capability'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

let h: SqliteD1Harness
let sqls: string[] = []

function seed(members: number) {
  const s: string[] = [
    `INSERT INTO users (id, email, role) VALUES ('user-owner', 'boss@x.test', 'owner');`,
    `INSERT INTO users (id, email, role) VALUES ('user-adm', 'admin@x.test', 'admin');`,
    `INSERT INTO departments (id, slug, name) VALUES ('D1','d1','Dept One'),('D2','d2','Dept Two');`,
    `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin','admin@x.test','Ada Admin','active','${TENANT}');`,
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin','mem-admin','org',NULL,'admin');`,
    `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-boss','boss@x.test','Boss','active','${TENANT}');`,
    `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-boss','mem-boss','org',NULL,'owner');`,
  ]
  for (let i = 0; i < 20; i++) s.push(`INSERT INTO squads (id, department_id, slug, name) VALUES ('S${i}','D${(i % 2) + 1}','sq${i}','Squad ${i}');`)
  for (let i = 0; i < 66; i++) s.push(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag${i}','S${i % 20}','ag${i}','Agent ${i}','member','test','active');`)
  for (let i = 0; i < members; i++) {
    s.push(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m${i}','m${i}@x.test','Member ${i}','active','${TENANT}');`)
    s.push(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c${i}a','m${i}','squad','S${i % 20}','member'),('c${i}b','m${i}','squad','S${(i + 7) % 20}','lead');`)
  }
  for (let i = 0; i < 300; i++) {
    s.push(`INSERT INTO tasks (id, title, status, assignee_agent_id, squad_id) VALUES ('t${i}','Task ${i}','in_progress','ag0','S0');`)
  }
  return s.join('\n')
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  sqls = []
})
afterEach(() => h.close())

async function get(members: number) {
  h.sqlite.exec(seed(members))
  const counting = new Proxy(h.db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === 'prepare') return (sql: string) => { sqls.push(sql); return (v as (s: string) => unknown).call(target, sql) }
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  const env = { TENANT_SLUG: TENANT, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'admin@x.test', SESSIONS: kv(), DB: counting } as unknown as Env
  const login = await authApp.request('/dev-login', {}, env)
  const cookie = `mupot_session=${/mupot_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]}`
  sqls = []
  const res = await dashboardApp.request('/agents/ag0', { headers: { cookie } }, env)
  return { res, body: await res.text() }
}

describe('GET /agents/:id (org admin) query count', () => {
  it('does not scale with member count', async () => {
    const { res, body } = await get(150)
    expect(res.status).toBe(200)
    expect(body).toContain('Set owner')
    // Same sections and same candidates as before: the owner outranks the admin and is absent, the caller is absent,
    // ordinary members are listed, and the other panels still render.
    expect(body).not.toContain('value="mem-boss"')
    expect(body).not.toContain('value="mem-admin"')
    expect(body).toContain('value="m0"')
    expect(body).toContain('value="m149"')
    expect((body.match(/<option value="m\d+"/g) ?? []).length).toBe(150)
    expect(body).toContain('<h2>Access</h2>')
    const n = sqls.length
    if (process.env.PRINT_QUERIES) {
      const by = new Map<string, number>()
      for (const q of sqls) { const k = q.replace(/\s+/g, ' ').slice(0, 110); by.set(k, (by.get(k) ?? 0) + 1) }
      console.log(`TOTAL ${n}\n` + [...by].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${c}\t${k}`).join('\n'))
    }
    expect(n).toBeLessThanOrEqual(30)
  })
})

describe('exceedsTargetRankCeilingForMembers matches the per-member predicate', () => {
  it('same verdict for every member across grant planes, home squads, legacy role, self', async () => {
    h.sqlite.exec(seed(40))
    h.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mh','mh@x.test','Home Admin','active','${TENANT}'),('mu','admin@x.test2','NoUser','active','${TENANT}'),('mn',NULL,'NoEmail','active','${TENANT}'),('me','','EmptyEmail','active','${TENANT}'),('md','Dup@x.test','DupCase','active','${TENANT}'),('mr','BOSS@x.test','RoleOnly','active','${TENANT}');
      INSERT INTO users (id, email, role) VALUES ('u-empty','','owner'),('u-dup1','dup@x.test','member'),('u-dup2','DUP@x.test','admin');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('SH','D1','home1','Home','home');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('ch','mh','squad','SH','owner'),('cd','mu','department','D1','admin'),('co','m3','squad','S4','owner');
    `)
    const env = { TENANT_SLUG: TENANT, DB: h.db } as unknown as Env
    const ids = [...(h.sqlite.prepare('SELECT id FROM members').all() as Array<{ id: string }>)].map((r) => r.id)
    const EXPECTED_SIZE: Record<string, number> = { 'mem-admin': 3, 'mem-boss': 0, m1: 43 }
    for (const actor of [
      { role: 'admin' as const, memberId: 'mem-admin' },
      { role: 'owner' as const, memberId: 'mem-boss' },
      { role: 'member' as const, memberId: 'm1' },
    ]) {
      const auth = { ...actor, boundAgentId: undefined } as unknown as Parameters<typeof exceedsTargetRankCeiling>[1]
      const bulk = await exceedsTargetRankCeilingForMembers(env, auth, ids)
      for (const id of ids) {
        expect(bulk.has(id), `${actor.memberId} vs ${id}`).toBe(await exceedsTargetRankCeiling(env, auth, id))
      }
      expect(bulk.size).toBe(EXPECTED_SIZE[actor.memberId])
    }
    const adminAuth = { role: 'admin', memberId: 'mem-admin' } as unknown as Parameters<typeof exceedsTargetRankCeiling>[1]
    const bulk = await exceedsTargetRankCeilingForMembers(env, adminAuth, ids)
    expect(bulk.has('mem-boss')).toBe(true) // owner outranks admin
    expect(bulk.has('mr')).toBe(true) // legacy role plane (users.role=owner via email)
    expect(bulk.has('mh')).toBe(false) // owner on a HOME squad only does not inflate global rank
    expect(bulk.has('m3')).toBe(true) // owner on a work squad
    expect(bulk.has('m1')).toBe(false)
    expect(bulk.has('me')).toBe(false) // empty email: rank 0, like the per-member lookup
  })
})
