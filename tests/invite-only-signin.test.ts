// Invite-only sign-in (Hadi 2026-11-11: "now invite only, if it means anyone from internet").
// Real route handlers (authApp /callback + /email/verify, handleOAuthAuthorize), real migrated SQLite D1.
// Only the Google token/userinfo endpoints and the OAuth provider library handle are doubles.
//
// RULE UNDER TEST (src/auth/invite-only.ts): a person with no live login identity, no members row, no legacy
// owner/admin users row (and not the first-owner ceremony of an empty pot) gets NOTHING written and a clear
// invite-only refusal. OPEN_SIGNUP_ENABLED === 'true' is the explicit opt-out.
//
// MUTATION LEDGER: see agents/kasra/receipts/invite-only-signin-20261111.md.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { acceptInvite } from '../src/members'
import { decideSignIn, isOpenSignup } from '../src/auth/invite-only'
import { HANDOFF_AUD, HANDOFF_ISS } from '../src/auth/handoff-verify'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

interface Kv {
  store: Map<string, string>
  get: (key: string, type?: string) => Promise<unknown>
  put: (key: string, value: string) => Promise<void>
  delete: (key: string) => Promise<void>
}
function memoryKv(): Kv {
  const store = new Map<string, string>()
  return {
    store,
    get: async (key, type) => {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (key, value) => { store.set(key, value) },
    delete: async (key) => { store.delete(key) },
  }
}

function seed(h: SqliteD1Harness): void {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'member-admin', 'department', 'dept-a', 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-existing', 'existing@pot.test', 'Existing', 'active', '${TENANT}');
    INSERT INTO users (id, email, role) VALUES ('user-owner', 'owner@pot.test', 'owner');
    INSERT INTO invites (id, email, squad_id, capability, invited_by) VALUES ('inv-1', 'invitee@example.com', 'squad-web', 'member', 'member-admin');
  `)
}

/** What src/pots/service.ts seeds: the owner's member row + org owner grant + lead-agent member bound to an agent. NO users row. */
function provisionPot(h: SqliteD1Harness): void {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d-p','core','Acme');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-p','d-p','core','Core');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-owner','realowner@customer.test','Real Owner','active','${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, granted_via) VALUES ('cap-owner','mem-owner','org',NULL,'owner','pot_provision');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-lead',NULL,'Lead','active','${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, status, kind, owner_member_id) VALUES ('ag-lead','sq-p','lead','Lead','lead','active','work','mem-lead');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}','ag-lead','mem-lead','2026-01-01T00:00:00.000Z');`)
}
const INACTIVE_SQL: Array<[string, string]> = [
  ['suspended', `UPDATE members SET status='suspended' WHERE id='member-existing'`],
  ['archived', `UPDATE members SET archived_at='2026-01-01T00:00:00.000Z' WHERE id='member-existing'`],
  ['superseded', `UPDATE members SET superseded_by_member_id='member-admin' WHERE id='member-existing'`],
]
const usersFor = (h: SqliteD1Harness, email: string) => (h.sqlite.prepare('SELECT COUNT(*) AS n FROM users WHERE lower(email) = ?').get(email) as { n: number }).n

/** Tables a stranger must not move. */
const WRITE_TABLES = ['members', 'users', 'capabilities', 'squads', 'departments', 'agents', 'member_tokens', 'human_login_identities', 'web_sessions', 'invites']
function snapshot(h: SqliteD1Harness): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of WRITE_TABLES) out[t] = (h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
  return out
}
const acceptedAt = (h: SqliteD1Harness, id: string) => (h.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(id) as { accepted_at: string | null }).accepted_at

function webEnv(h: SqliteD1Harness, kv: Kv, extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN,
    OAUTH_CLIENT_ID: 'cid.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 'secret', SESSIONS: kv,
    ...extra,
  } as unknown as Env
}

function stubGoogleWeb(sub: string, email: string): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
    if (url.includes('openidconnect.googleapis.com/v1/userinfo')) return new Response(JSON.stringify({ sub, email, email_verified: true }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }))
}

async function webSignIn(env: Env, sub: string, email: string): Promise<Response> {
  const login = await authApp.request(`${ORIGIN}/login`, {}, env)
  const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? ''
  stubGoogleWeb(sub, email)
  return authApp.request(`${ORIGIN}/callback?code=abc&state=${encodeURIComponent(state)}`, { headers: { cookie: `mupot_login_state_${state}=1` } }, env)
}
const sessionKeys = (kv: Kv) => [...kv.store.keys()].filter((k) => k.startsWith('sess:'))

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('web Google sign-in (/auth/callback)', () => {
  it('stranger: refused with the invite-only page, no session cookie, nothing written anywhere', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const kv = memoryKv()
    const before = snapshot(h)
    const res = await webSignIn(webEnv(h, kv), 'sub-stranger', 'stranger@gmail.test')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('invite-only')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mupot_session')
    expect(sessionKeys(kv)).toEqual([])
    expect(snapshot(h)).toEqual(before)
    expect(acceptedAt(h, 'inv-1')).toBeNull()
  })

  it('existing member (members row by email) signs in as before', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const kv = memoryKv()
    const res = await webSignIn(webEnv(h, kv), 'sub-existing', 'Existing@Pot.test')
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie') ?? '').toContain('mupot_session')
    expect(sessionKeys(kv).length).toBe(1)
  })

  it('returning identity (live login identity bound to a member with a different email) signs in as before', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('hli-1', '${TENANT}', 'google', 'sub-alias', 'old@elsewhere.test', 'member-existing', '2026-01-01T00:00:00.000Z')`)
    const res = await webSignIn(webEnv(h, memoryKv()), 'sub-alias', 'renamed@elsewhere.test')
    expect(res.status).toBe(302)
  })

  it('existing member whose row is under another credential (Telegram-bound, resolver says denied) is NOT locked out by the invite-only gate', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant, telegram_chat_id) VALUES ('member-tg', 'tg@pot.test', 'Tg', 'active', '${TENANT}', '555')`)
    const res = await webSignIn(webEnv(h, memoryKv()), 'sub-tg', 'tg@pot.test')
    expect(res.status).toBe(302)
  })

  it('legacy owner/admin users row with no members row signs in as before', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const res = await webSignIn(webEnv(h, memoryKv()), 'sub-owner', 'owner@pot.test')
    expect(res.status).toBe(302)
  })

  it('a leftover role=member users row (an earlier stranger sign-in) with no members row is refused', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`INSERT INTO users (id, email, role) VALUES ('user-old-stranger', 'oldstranger@gmail.test', 'member')`)
    const res = await webSignIn(webEnv(h, memoryKv()), 'sub-old', 'oldstranger@gmail.test')
    expect(res.status).toBe(403)
  })

  it('invited person: redeeming the invite (acceptInvite) once makes sign-in work; the invite is consumed once and a reuse is refused', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const env = webEnv(h, memoryKv())
    const first = await acceptInvite(env, 'inv-1', 'Invitee')
    expect(first.ok).toBe(true)
    expect(acceptedAt(h, 'inv-1')).not.toBeNull()
    const membersAfterAccept = snapshot(h).members
    const res = await webSignIn(env, 'sub-invitee', 'invitee@example.com')
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie') ?? '').toContain('mupot_session')
    // sign-in minted no second member
    expect(snapshot(h).members).toBe(membersAfterAccept)
    // reuse refused, no second member row for that email
    const second = await acceptInvite(env, 'inv-1', 'Replay')
    expect(second).toMatchObject({ ok: false, error: 'invite_already_accepted' })
    expect((h.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE lower(email) = 'invitee@example.com'`).get() as { n: number }).n).toBe(1)
  })

  it('a stranger holding only an UNREDEEMED invite email does not get in, and the invite is not consumed by the attempt', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const res = await webSignIn(webEnv(h, memoryKv()), 'sub-invitee', 'invitee@example.com')
    expect(res.status).toBe(403)
    expect(acceptedAt(h, 'inv-1')).toBeNull()
  })

  it('virgin pot: the first Google sign-in (first-owner ceremony) still works; the next stranger is refused', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const env = webEnv(h, memoryKv())
    const first = await webSignIn(env, 'sub-first', 'first@pot.test')
    expect(first.status).toBe(302)
    expect((h.sqlite.prepare(`SELECT role FROM users WHERE email = 'first@pot.test'`).get() as { role: string }).role).toBe('owner')
    const second = await webSignIn(env, 'sub-second', 'second@gmail.test')
    expect(second.status).toBe(403)
  })

  it('PROVISIONED pot (owner member + org owner grant + bound lead agent, zero users rows): a stranger is refused, nothing written, no claim, not owner', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provisionPot(h)
    const kv = memoryKv(); const before = snapshot(h)
    const res = await webSignIn(webEnv(h, kv), 'sub-evil', 'evil@gmail.test')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('invite-only')
    expect(snapshot(h)).toEqual(before)
    expect(sessionKeys(kv)).toEqual([])
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM owner_bootstrap_claim').get() as { n: number }).n).toBe(0)
  })

  it('PROVISIONED pot: the real owner signing in on the web for the first time is admitted AS OWNER (matched to their member row)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provisionPot(h)
    const res = await webSignIn(webEnv(h, memoryKv()), 'sub-realowner', 'RealOwner@Customer.test')
    expect(res.status).toBe(302)
    expect((h.sqlite.prepare(`SELECT role FROM users WHERE email='realowner@customer.test'`).get() as { role: string }).role).toBe('owner')
  })

  it.each(INACTIVE_SQL)('a %s member is refused with the inactive message, leaves no users row and no session', async (_n, sql) => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h); h.sqlite.exec(sql)
    const kv = memoryKv(); const before = snapshot(h)
    const res = await webSignIn(webEnv(h, kv), 'sub-existing', 'existing@pot.test')
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).toContain('not active')
    expect(body).not.toContain('invite-only')
    expect(usersFor(h, 'existing@pot.test')).toBe(0)
    expect(sessionKeys(kv)).toEqual([])
    expect(snapshot(h)).toEqual(before)
  })

  it.each([
    ['suspended', `UPDATE members SET status='suspended' WHERE id='member-existing'`],
    ['archived', `UPDATE members SET archived_at='2026-01-01T00:00:00.000Z' WHERE id='member-existing'`],
  ])('a live login identity bound to a %s member (different email) is refused as inactive', async (_n, sql) => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('hli-x', '${TENANT}', 'google', 'sub-alias', 'old@elsewhere.test', 'member-existing', '2026-01-01T00:00:00.000Z')`)
    h.sqlite.exec(sql)
    const kv = memoryKv()
    const res = await webSignIn(webEnv(h, kv), 'sub-alias', 'renamed@elsewhere.test')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('not active')
    expect(sessionKeys(kv)).toEqual([])
  })

  it('a member row with this email in ANOTHER tenant does not admit (tenant-scoped)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-other','elsewhere@x.test','E','active','other-pot')`)
    expect((await webSignIn(webEnv(h, memoryKv()), 'sub-e', 'elsewhere@x.test')).status).toBe(403)
  })

  it('a legacy owner whose members row is suspended is refused (inactive wins over the legacy rung)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-lo','owner@pot.test','O','suspended','${TENANT}')`)
    expect((await webSignIn(webEnv(h, memoryKv()), 'sub-lo', 'owner@pot.test')).status).toBe(403)
  })

  it('legacy owner/admin is matched case-insensitively (mixed-case IdP email)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    expect((await webSignIn(webEnv(h, memoryKv()), 'sub-owner', 'Owner@Pot.TEST')).status).toBe(302)
  })

  it('refusal copy: the stranger message names an invite and says what to do if you are the owner; it is not the inactive message', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const body = await (await webSignIn(webEnv(h, memoryKv()), 'sub-stranger', 'stranger@gmail.test')).text()
    expect(body).toContain('Ask an org admin for an invite')
    expect(body).toContain('an invite will not help you')
    expect(body).not.toContain('not active')
  })

  it('virgin pot: two simultaneous first Google sign-ins admit exactly ONE (the loser is refused, writes nothing)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const env = webEnv(h, memoryKv())
    const states = await Promise.all([authApp.request(`${ORIGIN}/login`, {}, env), authApp.request(`${ORIGIN}/login`, {}, env)])
    const [s1, s2] = states.map((r) => new URL(r.headers.get('location') ?? '').searchParams.get('state') ?? '')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: new URLSearchParams(String(init?.body ?? '')).get('code') }), { status: 200 })
      const who = (init?.headers as Record<string, string>).authorization.replace('Bearer ', '')
      return new Response(JSON.stringify({ sub: `sub-${who}`, email: `${who}@x.test`, email_verified: true }), { status: 200 })
    }))
    const cb = (st: string, code: string) => authApp.request(`${ORIGIN}/callback?code=${code}&state=${encodeURIComponent(st)}`, { headers: { cookie: `mupot_login_state_${st}=1` } }, env)
    const res = await Promise.all([cb(s1, 'a'), cb(s2, 'b')])
    expect(res.map((r) => r.status).sort()).toEqual([302, 403])
    expect(snapshot(h).users).toBe(1)
    expect((h.sqlite.prepare(`SELECT role FROM users`).get() as { role: string }).role).toBe('owner')
  })

  it('OPEN_SIGNUP_ENABLED=true is the explicit opt-out; any other value stays closed', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const open = await webSignIn(webEnv(h, memoryKv(), { OPEN_SIGNUP_ENABLED: 'true' }), 'sub-a', 'a@gmail.test')
    expect(open.status).toBe(302)
    for (const v of ['TRUE', '1', 'yes', 'false', '']) {
      const closed = await webSignIn(webEnv(h, memoryKv(), { OPEN_SIGNUP_ENABLED: v }), `sub-${v}`, `b${v}@gmail.test`)
      expect(closed.status, v).toBe(403)
    }
    expect(isOpenSignup({})).toBe(false)
  })
})

describe('email one-time sign-in (/auth/email/verify)', () => {
  function noopCtx() { return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext }
  async function mailedCode(env: Env, email: string): Promise<{ token: string; attemptId: string }> {
    const calls: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { calls.push(a.map(String).join(' ')) })
    const deferred: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => deferred.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext
    const res = await authApp.fetch(new Request(`${ORIGIN}/email/start`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email }) }), env, ctx)
    expect(res.status).toBe(200)
    await Promise.all(deferred)
    const url = new URL(/Sign in: (\S+)/.exec(calls[calls.length - 1] ?? '')?.[1] ?? '')
    return { token: url.searchParams.get('t') ?? '', attemptId: url.searchParams.get('a') ?? '' }
  }
  const confirm = (env: Env, t: { token: string; attemptId: string }) =>
    authApp.fetch(new Request(`${ORIGIN}/email/verify`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ t: t.token, a: t.attemptId }) }), env, noopCtx())
  const emailEnv = (h: SqliteD1Harness, kv: Kv, extra: Record<string, unknown> = {}) => webEnv(h, kv, { EMAIL_LOGIN_ENABLED: 'true', EMAIL_PROVIDER: 'console', ...extra })

  it('stranger with a valid mailed link: refused, no session, no users/members/identity rows', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const kv = memoryKv(); const env = emailEnv(h, kv)
    const mail = await mailedCode(env, 'stranger@example.net')
    const before = snapshot(h)
    const res = await confirm(env, mail)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('invite-only')
    expect(res.headers.get('set-cookie') ?? '').not.toContain('mupot_session')
    expect(sessionKeys(kv)).toEqual([])
    expect(snapshot(h)).toEqual(before)
  })

  it('virgin pot: the email door can NEVER bootstrap an owner (first-owner is web-Google only)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const env = emailEnv(h, memoryKv())
    const mail = await mailedCode(env, 'first@example.net')
    const res = await confirm(env, mail)
    expect(res.status).toBe(403)
    expect(snapshot(h).users).toBe(0)
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM owner_bootstrap_claim').get() as { n: number }).n).toBe(0)
  })

  it('a suspended member is refused (inactive), leaves no users row and no session', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`UPDATE members SET status='suspended' WHERE id='member-existing'`)
    const kv = memoryKv(); const env = emailEnv(h, kv)
    const res = await confirm(env, await mailedCode(env, 'existing@pot.test'))
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('not active')
    expect(usersFor(h, 'existing@pot.test')).toBe(0)
    expect(sessionKeys(kv)).toEqual([])
  })

  it('existing member: signs in as before', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const env = emailEnv(h, memoryKv())
    const mail = await mailedCode(env, 'existing@pot.test')
    const res = await confirm(env, mail)
    expect(res.status).toBe(302)
    expect(res.headers.get('set-cookie') ?? '').toContain('mupot_session')
  })
})

describe('mumega handoff (/auth/handoff)', () => {
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  const u8 = (x: string) => b64(new TextEncoder().encode(x))
  async function signedHandoff(email: string): Promise<{ token: string; pub: string }> {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey
    const now = Math.floor(Date.now() / 1000)
    const head = u8(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
    const body = u8(JSON.stringify({ iss: HANDOFF_ISS, aud: HANDOFF_AUD, sub: email, email, email_verified: true, channel: 'email', iat: now, exp: now + 60, jti: crypto.randomUUID() }))
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(`${head}.${body}`)))
    return { token: `${head}.${body}.${b64(sig)}`, pub: JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }) }
  }
  it('stranger with a validly signed claim: refused, no users row, no session', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const kv = memoryKv()
    const { token, pub } = await signedHandoff('stranger@mumega.test')
    const before = snapshot(h)
    const res = await authApp.request(`${ORIGIN}/handoff?token=${token}`, {}, webEnv(h, kv, { MUPOT_HANDOFF_PUBLIC_KEY: pub }))
    expect(res.status).toBe(403)
    expect(sessionKeys(kv)).toEqual([])
    expect(snapshot(h)).toEqual(before)
  })
  it('virgin pot: a handoff can NEVER bootstrap an owner (first-owner is web-Google only)', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const kv = memoryKv()
    const { token, pub } = await signedHandoff('first@mumega.test')
    const res = await authApp.request(`${ORIGIN}/handoff?token=${token}`, {}, webEnv(h, kv, { MUPOT_HANDOFF_PUBLIC_KEY: pub }))
    expect(res.status).toBe(403)
    expect(snapshot(h).users).toBe(0)
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM owner_bootstrap_claim').get() as { n: number }).n).toBe(0)
  })
  it('legacy owner is matched case-insensitively on a handoff claim email', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const { token, pub } = await signedHandoff('Owner@Pot.TEST')
    const res = await authApp.request(`${ORIGIN}/handoff?token=${token}`, {}, webEnv(h, memoryKv(), { MUPOT_HANDOFF_PUBLIC_KEY: pub }))
    expect(res.status).toBe(302)
  })
  it('a suspended member with a validly signed claim is refused and leaves no users row', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    h.sqlite.exec(`UPDATE members SET status='suspended' WHERE id='member-existing'`)
    const kv = memoryKv()
    const { token, pub } = await signedHandoff('existing@pot.test')
    const res = await authApp.request(`${ORIGIN}/handoff?token=${token}`, {}, webEnv(h, kv, { MUPOT_HANDOFF_PUBLIC_KEY: pub }))
    expect(res.status).toBe(403)
    expect(usersFor(h, 'existing@pot.test')).toBe(0)
    expect(sessionKeys(kv)).toEqual([])
  })
  it('existing member with a validly signed claim signs in as before', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const kv = memoryKv()
    const { token, pub } = await signedHandoff('existing@pot.test')
    const res = await authApp.request(`${ORIGIN}/handoff?token=${token}`, {}, webEnv(h, kv, { MUPOT_HANDOFF_PUBLIC_KEY: pub }))
    expect(res.status).toBe(302)
    expect(sessionKeys(kv).length).toBe(1)
  })
})

describe('MCP OAuth authorize / Google callback (handleOAuthAuthorize)', () => {
  const AUTH_URL = `${ORIGIN}/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256`
  function oauthSetup(extra: Record<string, unknown> = {}) {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); seed(h)
    const sessions = memoryKv()
    const provider = {
      parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', redirectUri: 'https://client.example.test/callback', scope: ['mcp:read'] })),
      completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
      lookupClient: vi.fn(async () => ({ clientName: 'Claude' })),
    }
    const env = {
      DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret',
      SESSIONS: sessions, OAUTH_PROVIDER: provider, BUS: { send: async () => {} }, ...extra,
    } as unknown as Env
    return { h, env, sessions, provider }
  }
  async function oauthSignIn(env: Env, sub: string, email: string): Promise<Response> {
    const a = await handleOAuthAuthorize(new Request(AUTH_URL), env)
    const state = new URL(a.headers.get('Location') ?? '').searchParams.get('state') ?? ''
    const cookie = a.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
      if (url.includes('googleapis.com/oauth2/v2/userinfo')) return new Response(JSON.stringify({ id: sub, name: sub, email, verified_email: true }), { status: 200 })
      throw new Error(`unexpected fetch ${url}`)
    }))
    return handleOAuthAuthorize(new Request(`${ORIGIN}/oauth/google-callback?code=c&state=${state}`, { headers: { Cookie: cookie } }), env)
  }
  const consentKeys = (kv: Kv) => [...kv.store.keys()].filter((k) => k.startsWith('oauth-consent:'))

  it('stranger: 403 invite-only, no member/home squad/token/identity, no consent nonce, no OAuth grant', async () => {
    const { h, env, sessions, provider } = oauthSetup()
    const before = snapshot(h)
    const res = await oauthSignIn(env, 'sub-stranger', 'stranger@gmail.test')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('invite-only')
    expect(snapshot(h)).toEqual(before)
    expect(consentKeys(sessions)).toEqual([])
    expect(provider.completeAuthorization).not.toHaveBeenCalled()
    expect([...sessions.store.keys()].filter((k) => k.startsWith('oauth-reg-rl:'))).toEqual([])
  })

  it('existing member: reaches the consent page as before', async () => {
    const { env, sessions } = oauthSetup()
    const res = await oauthSignIn(env, 'sub-existing', 'existing@pot.test')
    expect(res.status).toBe(200)
    expect(consentKeys(sessions).length).toBe(1)
  })

  it('invited person (invite redeemed once): reaches consent; no second member; reuse refused', async () => {
    const { h, env } = oauthSetup()
    expect((await acceptInvite(env, 'inv-1', 'Invitee')).ok).toBe(true)
    const members = snapshot(h).members
    const res = await oauthSignIn(env, 'sub-invitee', 'invitee@example.com')
    expect(res.status).toBe(200)
    expect(snapshot(h).members).toBe(members)
    expect(await acceptInvite(env, 'inv-1', 'Replay')).toMatchObject({ ok: false, error: 'invite_already_accepted' })
  })

  it('stranger holding only an unredeemed invite email is refused and does not burn the invite', async () => {
    const { h, env } = oauthSetup()
    const res = await oauthSignIn(env, 'sub-invitee', 'invitee@example.com')
    expect(res.status).toBe(403)
    expect(acceptedAt(h, 'inv-1')).toBeNull()
  })

  it('REAL OWNER over MCP: a legacy owner (users owner row, no member row) can connect with the same Google account (member row created, as on main)', async () => {
    const { h, env, sessions } = oauthSetup()
    const before = snapshot(h).members
    const res = await oauthSignIn(env, 'sub-owner', 'owner@pot.test')
    expect(res.status).toBe(200)
    expect(consentKeys(sessions).length).toBe(1)
    expect(snapshot(h).members).toBe(before + 1)
  })

  it('REAL OWNER over MCP: the provisioned owner (member row + org owner grant) connects; no extra member row', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite); provisionPot(h)
    const sessions = memoryKv()
    const provider = { parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', redirectUri: 'https://client.example.test/callback', scope: ['mcp:read'] })), completeAuthorization: vi.fn(), lookupClient: vi.fn(async () => ({ clientName: 'Claude' })) }
    const env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', SESSIONS: sessions, OAUTH_PROVIDER: provider, BUS: { send: async () => {} } } as unknown as Env
    const before = snapshot(h).members
    const res = await oauthSignIn(env, 'sub-owner', 'realowner@customer.test')
    expect(res.status).toBe(200)
    expect(snapshot(h).members).toBe(before)
  })

  it.each(INACTIVE_SQL)('a %s member is refused over MCP with the inactive message and no consent nonce', async (_n, sql) => {
    const { h, env, sessions } = oauthSetup(); h.sqlite.exec(sql)
    const before = snapshot(h)
    const res = await oauthSignIn(env, 'sub-existing', 'existing@pot.test')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('not active')
    expect(consentKeys(sessions)).toEqual([])
    expect(snapshot(h)).toEqual(before)
  })

  it('virgin pot: a stranger over MCP is refused (the first-owner claim is web-Google only), nothing claimed', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const provider = { parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', redirectUri: 'https://client.example.test/callback', scope: ['mcp:read'] })), completeAuthorization: vi.fn(), lookupClient: vi.fn(async () => ({ clientName: 'Claude' })) }
    const env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret', SESSIONS: memoryKv(), OAUTH_PROVIDER: provider, BUS: { send: async () => {} } } as unknown as Env
    const res = await oauthSignIn(env, 'sub-first', 'first@pot.test')
    expect(res.status).toBe(403)
    expect(snapshot(h).members).toBe(0)
    expect((h.sqlite.prepare('SELECT COUNT(*) AS n FROM owner_bootstrap_claim').get() as { n: number }).n).toBe(0)
  })

  it('a leftover role=member users row with no member row is refused over MCP too (same rule as web)', async () => {
    const { h, env } = oauthSetup()
    h.sqlite.exec(`INSERT INTO users (id, email, role) VALUES ('u-old','oldstranger@gmail.test','member')`)
    expect((await oauthSignIn(env, 'sub-old', 'oldstranger@gmail.test')).status).toBe(403)
  })

  it('OPEN_SIGNUP_ENABLED=true opts out: a stranger gets a member row as before', async () => {
    const { h, env } = oauthSetup({ OPEN_SIGNUP_ENABLED: 'true' })
    const before = snapshot(h).members
    const res = await oauthSignIn(env, 'sub-stranger', 'stranger@gmail.test')
    expect(res.status).toBe(200)
    expect(snapshot(h).members).toBe(before + 1)
  })
})

describe('decideSignIn: the first-owner claim is offered to the Google web door only', () => {
  it('on an empty pot a non-web door that is handed a new user id still cannot claim', async () => {
    const h = createSqliteD1(); applyAllMigrations(h.sqlite)
    const env = webEnv(h, memoryKv())
    for (const door of ['email', 'handoff', 'oauth_mcp'] as const) {
      expect(await decideSignIn(env, { door, email: 'f@x.test', provider: 'x', subject: 'f@x.test', newUserId: 'u-f' })).toEqual({ allowed: false, reason: 'invite_only' })
    }
    expect(snapshot(h).users).toBe(0)
    expect(await decideSignIn(env, { door: 'google_web', email: 'f@x.test', provider: 'google', subject: 's', newUserId: 'u-f' })).toEqual({ allowed: true, via: 'first_owner' })
  })
})

describe('decideSignIn is read-only on its refusals and fails closed on a D1 error', () => {
  it('a throwing DB surfaces as a throw, never as an admit', async () => {
    const env = { TENANT_SLUG: TENANT, DB: { prepare: () => { throw new Error('d1 down') } } } as unknown as Env
    await expect(decideSignIn(env, { door: 'oauth_mcp', email: 'x@y.test', provider: 'google', subject: 's' })).rejects.toThrow('d1 down')
  })
})
