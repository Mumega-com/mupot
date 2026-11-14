// Task 875e3de5 — POST /api/studio/dispatch must refuse a caller without member rank on the TARGET squad
// (isolation-review-lens2-20261110 P1-1). Real schema; no pot-wide "first agent by name" fallback.
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import type { CapabilityGrant } from '../src/auth/capability'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { dispatchStudioFlight, loadStudioData, studioApp } from '../src/dashboard/studio'
import { encryptConnectorSecret } from '../src/connectors/crypto'

let harness: SqliteD1Harness | undefined
afterEach(() => { harness?.close(); harness = undefined })

const grant = (memberId: string, scope_type: 'org' | 'squad', scope_id: string | null, capability: CapabilityGrant['capability']): CapabilityGrant =>
  ({ member_id: memberId, scope_type, scope_id, capability }) as CapabilityGrant
const who = (memberId: string, capabilities: CapabilityGrant[]): AuthContext =>
  ({ userId: memberId, email: `${memberId}@pot.test`, role: 'member', tenant: 'pot', memberId, capabilities })

function pot(): Env {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'd', 'a', 'A'), ('sq-b', 'd', 'b', 'B');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-a', 'sq-a', 'ag-a', 'AgA', 'active'), ('ag-b', 'sq-b', 'ag-b', 'AgB', 'active');
  `)
  harness = h
  return { DB: h.db, TENANT_SLUG: 'pot', RELEASE_SHA: 'a'.repeat(40) } as unknown as Env
}
const count = (env: Env, t: string) => (harness!.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n

describe('Studio dispatch squad standing', () => {
  it('refuses a member of squad A dispatching to squad B: 403, no task, no flight', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-a', [grant('m-a', 'squad', 'sq-a', 'member')]), { prompt: 'x', squadId: 'sq-b' })
    expect(r).toMatchObject({ ok: false, status: 403, error: 'squad_forbidden' })
    expect(r.ok === false && r.next_step).toMatch(/member grant/)
    expect(count(env, 'tasks')).toBe(0)
    expect(count(env, 'flights')).toBe(0)
  })

  it('refuses an unscoped member (no squad grant) with no squad_id, instead of the pot-wide first agent', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-x', [grant('m-x', 'squad', 'sq-a', 'observer')]), { prompt: 'x' })
    expect(r).toMatchObject({ ok: false, status: 403, error: 'squad_forbidden' })
    expect(count(env, 'tasks')).toBe(0)
    expect(count(env, 'flights')).toBe(0)
  })

  it('refuses an observer on B', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-o', [grant('m-o', 'squad', 'sq-b', 'observer')]), { prompt: 'x', squadId: 'sq-b' })
    expect(r).toMatchObject({ ok: false, status: 403 })
    expect(count(env, 'tasks')).toBe(0)
  })

  it('a nonexistent squad and a hidden squad give the identical refusal', async () => {
    const env = pot()
    const a = who('m-a', [grant('m-a', 'squad', 'sq-a', 'member')])
    const hidden = await dispatchStudioFlight(env, a, { prompt: 'x', squadId: 'sq-b' })
    const ghost = await dispatchStudioFlight(env, a, { prompt: 'x', squadId: 'sq-nope' })
    expect(ghost).toEqual(hidden)
  })

  it('allows a member of B to dispatch to B, attributed to the caller (not the target agent)', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-b', [grant('m-b', 'squad', 'sq-b', 'member')]), { prompt: 'x', squadId: 'sq-b' })
    expect(r.ok).toBe(true)
    const t = harness!.sqlite.prepare(`SELECT squad_id FROM tasks`).get() as { squad_id: string }
    expect(t.squad_id).toBe('sq-b')
    const f = harness!.sqlite.prepare(`SELECT dispatched_by_agent_id AS d FROM flights`).get() as { d: string }
    expect(f.d).toBe('member:m-b')
  })

  it('defaults a member with no squad_id to their own squad', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-b', [grant('m-b', 'squad', 'sq-b', 'member')]), { prompt: 'x' })
    expect(r.ok).toBe(true)
    expect((harness!.sqlite.prepare(`SELECT squad_id FROM tasks`).get() as { squad_id: string }).squad_id).toBe('sq-b')
  })

  it('allows an org admin on any squad', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-adm', [grant('m-adm', 'org', null, 'admin')]), { prompt: 'x', squadId: 'sq-b' })
    expect(r.ok).toBe(true)
  })

  it('HTTP: the route answers 403 with a next_step', async () => {
    const env = pot()
    const app = studioApp
    const res = await app.request('/dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', squad_id: 'sq-b' }),
    }, env)
    // No credential at all: refused before any write.
    expect([401, 403]).toContain(res.status)
    expect(count(env, 'tasks')).toBe(0)
  })
})

describe('Studio dispatch: home squads stay private, archived squads take no work (#2397)', () => {
  function withHome(): Env {
    const env = pot()
    harness!.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sq-home-x', 'd', 'home-x', 'Home X', 'home'), ('sq-home-m', 'd', 'home-m', 'Home M', 'home');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-home-x', 'sq-home-x', 'ag-home-x', 'HomeX', 'active'), ('ag-home-m', 'sq-home-m', 'ag-home-m', 'HomeM', 'active');
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-own', 'pot', 'own@pot.test', 'Own', 'active');
      INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('m-own', 'squad', 'sq-home-m', 'admin');
    `)
    return env
  }
  const refused = { ok: false, status: 403, error: 'squad_forbidden' }

  it('refuses an org-scope member naming another member home squad: 403, no task', async () => {
    const env = withHome()
    const a = who('m-org', [grant('m-org', 'org', null, 'member')])
    const r = await dispatchStudioFlight(env, a, { prompt: 'x', squadId: 'sq-home-x' })
    expect(r).toMatchObject(refused)
    expect(count(env, 'tasks')).toBe(0)
    // Same body as a squad that does not exist: no existence oracle.
    expect(await dispatchStudioFlight(env, a, { prompt: 'x', squadId: 'sq-ghost' })).toEqual(r)
  })

  it('refuses an org admin naming another member home squad', async () => {
    const env = withHome()
    const r = await dispatchStudioFlight(env, who('m-adm', [grant('m-adm', 'org', null, 'admin')]), { prompt: 'x', squadId: 'sq-home-x' })
    expect(r).toMatchObject(refused)
    expect(count(env, 'tasks')).toBe(0)
  })

  it('allows a member naming their own home squad', async () => {
    const env = withHome()
    const r = await dispatchStudioFlight(env, who('m-own', [grant('m-own', 'squad', 'sq-home-m', 'admin')]), { prompt: 'x', squadId: 'sq-home-m' })
    expect(r.ok).toBe(true)
    expect((harness!.sqlite.prepare(`SELECT squad_id FROM tasks`).get() as { squad_id: string }).squad_id).toBe('sq-home-m')
  })

  it('refuses an archived squad on the explicit path, and the default path skips it', async () => {
    const env = pot()
    harness!.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = 'sq-a'`)
    const adm = who('m-adm', [grant('m-adm', 'org', null, 'admin')])
    expect(await dispatchStudioFlight(env, adm, { prompt: 'x', squadId: 'sq-a' })).toMatchObject(refused)
    expect(count(env, 'tasks')).toBe(0)
    const d = await dispatchStudioFlight(env, adm, { prompt: 'x' })
    expect(d.ok).toBe(true)
    expect((harness!.sqlite.prepare(`SELECT squad_id FROM tasks`).get() as { squad_id: string }).squad_id).toBe('sq-b')
  })

  it('HTTP: a non-string squad_id is 400, not silently dropped', async () => {
    const env = pot()
    const app = new Hono<{ Variables: { auth: AuthContext } }>()
    app.use('*', async (c, next) => { c.set('auth', who('m-adm', [grant('m-adm', 'org', null, 'admin')])); await next() })
    app.route('/', studioApp)
    const res = await app.request('/dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x', squad_id: 42 }),
    }, env)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_squad_id' })
    expect(count(env, 'tasks')).toBe(0)
  })
})

describe('Studio page connector (finding 2778c210)', () => {
  it('does not decrypt the pot-wide connector for a member; admin still sees it', async () => {
    const env = pot()
    const KEY = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
    const e = { ...env, TENANT_SLUG: 'gaf', CONNECTOR_MASTER_KEY: KEY } as Env
    const enc = await encryptConnectorSecret(KEY, 'conn_1', 'supabase', JSON.stringify({ url: 'https://x.supabase.co', apiKey: 'k' }))
    harness!.sqlite.prepare(
      `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, created_by, created_at)
       VALUES ('conn_1', 'gaf', 'supabase', 'S', ?1, 'admin_1', CURRENT_TIMESTAMP)`,
    ).run(enc)
    const member = await loadStudioData(e, who('m-a', [grant('m-a', 'squad', 'sq-a', 'member')]))
    expect(member.hasSupabase).toBe(false)
    const admin = await loadStudioData(e, who('m-adm', [grant('m-adm', 'org', null, 'admin')]))
    expect(admin.hasSupabase).toBe(true)
  })
})
