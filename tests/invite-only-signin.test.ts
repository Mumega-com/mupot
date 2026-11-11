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
import { hasSignInStanding, isOpenSignup } from '../src/auth/invite-only'
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

  it('OPEN_SIGNUP_ENABLED=true opts out: a stranger gets a member row as before', async () => {
    const { h, env } = oauthSetup({ OPEN_SIGNUP_ENABLED: 'true' })
    const before = snapshot(h).members
    const res = await oauthSignIn(env, 'sub-stranger', 'stranger@gmail.test')
    expect(res.status).toBe(200)
    expect(snapshot(h).members).toBe(before + 1)
  })
})

describe('hasSignInStanding is read-only and fails closed on a D1 error', () => {
  it('a throwing DB surfaces as a throw, never as true', async () => {
    const env = { TENANT_SLUG: TENANT, DB: { prepare: () => { throw new Error('d1 down') } } } as unknown as Env
    await expect(hasSignInStanding(env, { email: 'x@y.test', provider: 'google', subject: 's' })).rejects.toThrow('d1 down')
  })
})
