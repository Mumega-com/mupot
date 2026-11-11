// First-owner claim on the Google web door (src/auth/first-owner.ts). Real authApp handlers, real migrated SQLite D1;
// only the Google endpoints are doubles.
//
// The bug (gate 2386, executed on main 8054b8ab): "first user" was `COUNT(*) FROM users = 0`. A provisioned pot (members row +
// org owner grant, NO users row, src/pots/service.ts) or an MCP-only pot has zero users rows, so the first stranger to sign in
// became OWNER.
//
// PR A scope note: main has open sign-up, so a non-owner stranger still gets a role=member session here. What this PR
// guarantees is that no stranger becomes owner, no owner claim/grant is written for them, and the provisioned owner IS owner.
// Refusing strangers outright is PR B (#2386).
//
// ATOMICITY NOTE: local SQLite serialises every statement, so Promise.all cannot interleave two writers the way real D1
// requests can. The concurrency tests therefore prove the SQL is CONDITIONAL (the second writer's INSERT is a 0-row no-op and
// it is not owner) rather than reproducing an interleaving.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import { claimFirstOwner, isProvisionedOwnerEmail } from '../src/auth/first-owner'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    get: async (k: string, t?: string) => { const v = store.get(k); if (v === undefined) return null; return t === 'json' ? JSON.parse(v) : v },
    put: async (k: string, v: string) => { store.set(k, v) },
    delete: async (k: string) => { store.delete(k) },
  }
}
const mkEnv = (h: SqliteD1Harness) => ({
  DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN,
  OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 'secret', SESSIONS: memoryKv(),
}) as unknown as Env

function stubGoogle(users: Record<string, { sub: string; email: string }>) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: new URLSearchParams(String(init?.body ?? '')).get('code') ?? '' }), { status: 200 })
    }
    if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
      const tok = (init?.headers as Record<string, string>).authorization.replace('Bearer ', '')
      const u = users[tok]
      return new Response(JSON.stringify({ sub: u.sub, email: u.email, email_verified: true }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
}
async function startLogin(env: Env): Promise<string> {
  const login = await authApp.request(`${ORIGIN}/login`, {}, env)
  return new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? ''
}
const callback = (env: Env, state: string, code: string) =>
  authApp.request(`${ORIGIN}/callback?code=${code}&state=${encodeURIComponent(state)}`, { headers: { cookie: `mupot_login_state_${state}=1` } }, env)
async function webSignIn(env: Env, sub: string, email: string): Promise<Response> {
  const state = await startLogin(env)
  stubGoogle({ [sub]: { sub, email } })
  return callback(env, state, sub)
}
async function meRole(env: Env, res: Response): Promise<string | null> {
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => c.startsWith('mupot_session')).join('; ')
  const me = await authApp.request(`${ORIGIN}/me`, { headers: { cookie } }, env)
  return me.status === 200 ? ((await me.json()) as { role: string }).role : null
}
const userRole = (h: SqliteD1Harness, email: string) =>
  (h.sqlite.prepare('SELECT role FROM users WHERE email = ?').get(email) as { role: string } | undefined)?.role
const count = (h: SqliteD1Harness, sql: string) => (h.sqlite.prepare(sql).get() as { n: number }).n

/** The rows src/pots/service.ts seeds: owner member + org owner grant + a lead-agent member (NULL email). No users row. */
function provision(h: SqliteD1Harness, tenant = TENANT): void {
  h.sqlite.exec(`
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-owner','realowner@customer.test','Real Owner','active','${tenant}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, granted_via) VALUES ('cap-owner','mem-owner','org',NULL,'owner','pot_provision');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-lead',NULL,'Lead Agent','active','${tenant}');`)
}

/** An agent identity weld as src/members/service.ts writes it: a NULL-email member bound to an agent. */
function agentMember(h: SqliteD1Harness, memberId: string, tenant = TENANT): void {
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('d-ag','d-ag','D');
    INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('sq-ag','d-ag','sq-ag','S');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('ag-${memberId}','sq-ag','ag-${memberId}','Agent','active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('${memberId}',NULL,'Agent','active','${tenant}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${tenant}','ag-${memberId}','${memberId}','2026-01-01T00:00:00.000Z');`)
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('provisioned pot (members + org owner grant, zero users rows)', () => {
  it('a stranger is not owner: role member, no claim row, no new grant', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provision(h)
    const env = mkEnv(h)
    expect(count(h, 'SELECT COUNT(*) AS n FROM users')).toBe(0)
    const caps = count(h, 'SELECT COUNT(*) AS n FROM capabilities')
    const res = await webSignIn(env, 'sub-evil', 'evil@gmail.test')
    expect(res.status).toBe(302)
    expect(userRole(h, 'evil@gmail.test')).toBe('member')
    expect(await meRole(env, res)).toBe('member')
    expect(count(h, 'SELECT COUNT(*) AS n FROM owner_bootstrap_claim')).toBe(0)
    expect(count(h, 'SELECT COUNT(*) AS n FROM capabilities')).toBe(caps)
  })

  it('the real owner signing in on the web for the first time gets owner, matched to their member row (case-insensitive)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provision(h)
    const env = mkEnv(h)
    const res = await webSignIn(env, 'sub-owner', 'RealOwner@Customer.test')
    expect(res.status).toBe(302)
    expect(userRole(h, 'realowner@customer.test')).toBe('owner')
    expect(await meRole(env, res)).toBe('owner')
    // they were matched, not claimed through the empty-pot rule: no claim row
    expect(count(h, 'SELECT COUNT(*) AS n FROM owner_bootstrap_claim')).toBe(0)
  })

  it.each([
    ['suspended', `UPDATE members SET status='suspended' WHERE id='mem-owner'`],
    ['archived', `UPDATE members SET archived_at='2026-01-01T00:00:00.000Z' WHERE id='mem-owner'`],
    ['superseded', `UPDATE members SET superseded_by_member_id='mem-lead' WHERE id='mem-owner'`],
    ['expired grant', `UPDATE capabilities SET expires_at='2020-01-01 00:00:00' WHERE id='cap-owner'`],
    ['admin (not owner) grant', `UPDATE capabilities SET capability='admin' WHERE id='cap-owner'`],
    ['squad-scoped owner grant', `UPDATE capabilities SET scope_type='squad', scope_id='sq-x' WHERE id='cap-owner'`],
  ])('a %s provisioned-owner row does not make that email owner', async (_n, sql) => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provision(h)
    h.sqlite.exec(sql)
    const env = mkEnv(h)
    await webSignIn(env, 'sub-owner', 'realowner@customer.test')
    expect(userRole(h, 'realowner@customer.test')).toBe('member')
  })

  it('a member of ANOTHER tenant with an owner grant does not make that email owner here', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provision(h)
    h.sqlite.exec(`UPDATE members SET tenant='other-pot' WHERE id='mem-owner'`)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-h','h@here.test','H','active','${TENANT}')`)
    const env = mkEnv(h)
    await webSignIn(env, 'sub-owner', 'realowner@customer.test')
    expect(userRole(h, 'realowner@customer.test')).toBe('member')
  })
})

describe('MCP-only pot (human members, no users rows, no owner grant)', () => {
  it('a stranger is not owner', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-mcp','mcp@user.test','Mcp','active','${TENANT}')`)
    const env = mkEnv(h)
    const res = await webSignIn(env, 'sub-evil', 'evil@gmail.test')
    expect(res.status).toBe(302)
    expect(userRole(h, 'evil@gmail.test')).toBe('member')
    expect(count(h, 'SELECT COUNT(*) AS n FROM owner_bootstrap_claim')).toBe(0)
  })
})

describe('other signals of a non-empty pot', () => {
  it('an org admin grant held by an email-less (agent) member keeps the pot non-empty', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    agentMember(h, 'mem-agent')
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-a','mem-agent','org',NULL,'admin')`)
    await webSignIn(mkEnv(h), 'sub-s', 's@gmail.test')
    expect(userRole(h, 's@gmail.test')).toBe('member')
  })

  it('agent-bound members alone (no human, no org grant) do NOT make the pot non-empty: the first human is owner', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    agentMember(h, 'mem-agent')
    await webSignIn(mkEnv(h), 'sub-first', 'first@here.test')
    expect(userRole(h, 'first@here.test')).toBe('owner')
  })

  it('an existing owner_bootstrap_claim keeps the pot non-empty even with no users or members rows', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    h.sqlite.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO owner_bootstrap_claim (singleton, user_id) VALUES (1, 'gone-user');`)
    await webSignIn(mkEnv(h), 'sub-s', 's@gmail.test')
    expect(userRole(h, 's@gmail.test')).toBe('member')
  })

  it('members of ANOTHER tenant do not make this tenant non-empty (tenant-scoped, not a global COUNT)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-o','o@other.test','O','active','other-pot');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-o','mem-o','org',NULL,'owner')`)
    await webSignIn(mkEnv(h), 'sub-first', 'first@here.test')
    expect(userRole(h, 'first@here.test')).toBe('owner')
  })

  it('an existing users row keeps the pot non-empty', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    h.sqlite.exec(`INSERT INTO users (id, email, role) VALUES ('u1','member@x.test','member')`)
    await webSignIn(mkEnv(h), 'sub-s', 's@gmail.test')
    expect(userRole(h, 's@gmail.test')).toBe('member')
  })
})

describe('truly empty pot', () => {
  it('first Google sign-in becomes owner exactly once (claim row written); the second is not owner', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const env = mkEnv(h)
    const first = await webSignIn(env, 'sub-first', 'first@pot.test')
    expect(first.status).toBe(302)
    expect(userRole(h, 'first@pot.test')).toBe('owner')
    expect(await meRole(env, first)).toBe('owner')
    expect(count(h, 'SELECT COUNT(*) AS n FROM owner_bootstrap_claim')).toBe(1)
    await webSignIn(env, 'sub-second', 'second@gmail.test')
    expect(userRole(h, 'second@gmail.test')).toBe('member')
    expect(count(h, `SELECT COUNT(*) AS n FROM users WHERE role='owner'`)).toBe(1)
  })

  it('two simultaneous first sign-ins produce exactly one owner (see the atomicity note at the top)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const env = mkEnv(h)
    const s1 = await startLogin(env); const s2 = await startLogin(env)
    stubGoogle({ a: { sub: 'a', email: 'a@x.test' }, b: { sub: 'b', email: 'b@x.test' } })
    await Promise.all([callback(env, s1, 'a'), callback(env, s2, 'b')])
    expect(count(h, `SELECT COUNT(*) AS n FROM users WHERE role='owner'`)).toBe(1)
    expect(count(h, 'SELECT COUNT(*) AS n FROM owner_bootstrap_claim')).toBe(1)
  })

  it('claimFirstOwner directly: second concurrent claimant writes 0 rows and is not owner; the claim row names the winner', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const env = mkEnv(h)
    const [r1, r2] = await Promise.all([claimFirstOwner(env, 'u-a', 'a@x.test'), claimFirstOwner(env, 'u-b', 'b@x.test')])
    expect([r1, r2].filter(Boolean).length).toBe(1)
    expect(count(h, 'SELECT COUNT(*) AS n FROM users')).toBe(1)
    const claim = h.sqlite.prepare('SELECT user_id FROM owner_bootstrap_claim').get() as { user_id: string }
    expect(claim.user_id).toBe(r1 ? 'u-a' : 'u-b')
  })

  it('non-Google doors never bootstrap an owner: a handoff-style upsert (allowBootstrapOwner=false) on an empty pot yields member', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const { upsertUserByEmail } = await import('../src/auth')
    const r = await upsertUserByEmail(mkEnv(h), 'u-h', 'h@x.test', false)
    expect(r.role).toBe('member')
    expect(count(h, 'SELECT COUNT(*) AS n FROM owner_bootstrap_claim')).toBe(0)
  })
})

describe('isProvisionedOwnerEmail', () => {
  it('null / unknown email is false', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provision(h)
    expect(await isProvisionedOwnerEmail(mkEnv(h), null)).toBe(false)
    expect(await isProvisionedOwnerEmail(mkEnv(h), 'nobody@x.test')).toBe(false)
    expect(await isProvisionedOwnerEmail(mkEnv(h), 'realowner@customer.test')).toBe(true)
    expect(await isProvisionedOwnerEmail(mkEnv(h), '  RealOwner@Customer.TEST ')).toBe(true)
  })
})
