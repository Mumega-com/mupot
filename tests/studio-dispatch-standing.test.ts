// Task 875e3de5 — POST /api/studio/dispatch must refuse a caller without member rank on the TARGET squad
// (isolation-review-lens2-20261110 P1-1). Real schema; no pot-wide "first agent by name" fallback.
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import type { CapabilityGrant } from '../src/auth/capability'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { dispatchStudioFlight, loadStudioData, studioApp, studioPageHtml } from '../src/dashboard/studio'
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

  it('refuses an unscoped member (no squad grant) with no squad_id as no_squad, not omit-squad_id', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-x', [grant('m-x', 'squad', 'sq-a', 'observer')]), { prompt: 'x' })
    expect(r).toMatchObject({ ok: false, status: 409, error: 'no_squad' })
    expect(r.ok === false && r.next_step).toMatch(/member grant on a squad/)
    expect(r.ok === false && r.next_step).not.toMatch(/omit squad_id/)
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

describe('Studio dispatch: home squads stay private, archived squads take no work (#2397/#2399)', () => {
  // Foreign home sq-home-x carries ITS OWNER's live admin row. Without that row,
  // dropping c.member_id or c.scope_id from the home-squad guard still leaves every
  // test green (#2399). Caller m-own holds admin on a DIFFERENT home (sq-home-m).
  function withHome(): Env {
    const env = pot()
    harness!.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES
        ('sq-home-x', 'd', 'home-x', 'Home X', 'home'),
        ('sq-home-m', 'd', 'home-m', 'Home M', 'home');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES
        ('ag-home-x', 'sq-home-x', 'ag-home-x', 'HomeX', 'active'),
        ('ag-home-m', 'sq-home-m', 'ag-home-m', 'HomeM', 'active');
      INSERT INTO members (id, tenant, email, display_name, status) VALUES
        ('m-x-own', 'pot', 'xown@pot.test', 'XOwn', 'active'),
        ('m-own', 'pot', 'own@pot.test', 'Own', 'active'),
        ('m-member-home', 'pot', 'memhome@pot.test', 'MemHome', 'active'),
        ('m-expired', 'pot', 'expired@pot.test', 'Expired', 'active');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
        ('cap-x-own', 'm-x-own', 'squad', 'sq-home-x', 'admin'),
        ('cap-m-own', 'm-own', 'squad', 'sq-home-m', 'admin'),
        ('cap-m-member', 'm-member-home', 'squad', 'sq-home-m', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at) VALUES
        ('cap-expired', 'm-expired', 'squad', 'sq-home-m', 'admin', '2020-01-01 00:00:00');
    `)
    return env
  }
  const refused = { ok: false, status: 403, error: 'squad_forbidden' }

  // Org-scope so mayWrite passes and the home-squad SQL guard is the one that bites.
  // Auth also carries admin on sq-home-m so a scope_id-blind mutant finds that row.
  const otherHomeAdmin = () => who('m-own', [
    grant('m-own', 'org', null, 'member'),
    grant('m-own', 'squad', 'sq-home-m', 'admin'),
  ])

  it('refuses a caller who holds admin on a DIFFERENT home naming the foreign home: 403, no task', async () => {
    const env = withHome()
    const r = await dispatchStudioFlight(env, otherHomeAdmin(), { prompt: 'x', squadId: 'sq-home-x' })
    expect(r).toMatchObject(refused)
    expect(count(env, 'tasks')).toBe(0)
  })

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

  it('allows the owner to dispatch into their own home squad', async () => {
    const env = withHome()
    const r = await dispatchStudioFlight(env, who('m-own', [grant('m-own', 'squad', 'sq-home-m', 'admin')]), { prompt: 'x', squadId: 'sq-home-m' })
    expect(r.ok).toBe(true)
    expect((harness!.sqlite.prepare(`SELECT squad_id FROM tasks`).get() as { squad_id: string }).squad_id).toBe('sq-home-m')
  })

  it('refuses a lesser rank (member, not admin) on a home squad', async () => {
    const env = withHome()
    const r = await dispatchStudioFlight(
      env,
      who('m-member-home', [grant('m-member-home', 'squad', 'sq-home-m', 'member')]),
      { prompt: 'x', squadId: 'sq-home-m' },
    )
    expect(r).toMatchObject(refused)
    expect(count(env, 'tasks')).toBe(0)
  })

  it('refuses an expired admin grant on a home squad', async () => {
    const env = withHome()
    // Auth carries admin so mayWrite passes; the DB row is expired so the live-grant
    // predicate must refuse. Dropping CAPABILITY_LIVE_PREDICATE would reopen this.
    const r = await dispatchStudioFlight(
      env,
      who('m-expired', [grant('m-expired', 'squad', 'sq-home-m', 'admin')]),
      { prompt: 'x', squadId: 'sq-home-m' },
    )
    expect(r).toMatchObject(refused)
    expect(count(env, 'tasks')).toBe(0)
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

describe('Studio dispatch P2 follow-ups (#2397)', () => {
  it('a caller with zero member-rank squads gets no_squad next_step, never omit squad_id', async () => {
    const env = pot()
    const r = await dispatchStudioFlight(env, who('m-none', []), { prompt: 'ship it' })
    expect(r).toMatchObject({ ok: false, status: 409, error: 'no_squad' })
    expect(r.ok === false && r.next_step).toBe(
      'You hold member rank on no squad. Ask an org admin for a member grant on a squad.',
    )
    expect(String(r.ok === false && r.next_step)).not.toContain('omit squad_id')
  })

  it('Studio page client prefers next_step over the bare error code on refusal', async () => {
    const html = String(await studioPageHtml({
      brand: 'Mupot',
      tenant: 'pot',
      operator: 'm@pot.test',
      branch: 'main',
      flights: [],
      authorityRole: 'member',
    }))
    expect(html).toContain('data.next_step || data.error')
    expect(html).not.toMatch(/statusEl\.textContent = 'Dispatch failed' \+ \(data\.error \? ': ' \+ data\.error/)
  })

  it('dashboardApp POST /api/studio/dispatch is studioApp (ok+next_step), not the removed shadow', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const indexSrc = readFileSync(join(process.cwd(), 'src/dashboard/index.ts'), 'utf8')
    // The late duplicate handler is gone; only the mount remains.
    expect(indexSrc).toMatch(/dashboardApp\.route\('\/api\/studio',\s*studioApp\)/)
    expect(indexSrc).not.toMatch(/dashboardApp\.post\('\/api\/studio\/dispatch'/)

    const env = pot()
    const app = new Hono<{ Variables: { auth: AuthContext } }>()
    app.use('*', async (c, next) => {
      c.set('auth', who('m-a', [grant('m-a', 'squad', 'sq-a', 'member')]))
      await next()
    })
    // Same mount shape as dashboard: studioApp first under /api/studio.
    app.route('/api/studio', studioApp)
    const res = await app.request('/api/studio/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'x', squad_id: 'sq-b' }),
    }, env)
    expect(res.status).toBe(403)
    const body = await res.json() as { ok?: boolean; error?: string; next_step?: string }
    // studioApp shape (ok + next_step). The removed shadow returned only { error }.
    expect(body).toMatchObject({ ok: false, error: 'squad_forbidden' })
    expect(body.next_step).toMatch(/omit squad_id/)
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
