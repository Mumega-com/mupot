// Door PR C (mupot task 920df5e9) — the per-IP registration limiter (B2) charges NEW members only.
// Before: checkOAuthRegRateLimit ran on every Google callback, so a team behind one NAT locked out after five
// sign-ins of EXISTING members. Now it is the required pre-create guard of findOrCreateHumanMemberDetailed:
// it runs after every resolve branch said not_found and immediately before the members INSERT.
// Real SQLite D1 (all migrations), real handleOAuthAuthorize routes, one shared IP.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { findOrCreateHumanMember, findOrCreateHumanMemberDetailed, NewMemberRefusedError } from '../src/members/human-identity'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

const IP = '203.0.113.7'
const RL_KEY = `oauth-reg-rl:${IP}`
const AUTH_URL = 'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256'

type Kv = ReturnType<typeof memoryKv>
function memoryKv(opts: { throwOn?: 'get' | 'put' | 'both' } = {}) {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string, type?: string) {
      if (key.startsWith('oauth-reg-rl:') && (opts.throwOn === 'get' || opts.throwOn === 'both')) throw new Error('kv down')
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) {
      if (key.startsWith('oauth-reg-rl:') && (opts.throwOn === 'put' || opts.throwOn === 'both')) throw new Error('kv down')
      store.set(key, value)
    },
    async delete(key: string) { store.delete(key) },
  }
}

function setup(kvOpts: { throwOn?: 'get' | 'put' | 'both' } = {}) {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  const sessions: Kv = memoryKv(kvOpts)
  const provider = {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', redirectUri: 'https://client.example.test/callback', scope: ['mcp:read'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
    lookupClient: vi.fn(async () => ({ clientName: 'Claude' })),
  }
  const env = {
    DB: h.db, TENANT_SLUG: 'mumega', BRAND: 'mupot', POT_TIER: 'scale',
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret',
    SESSIONS: sessions, OAUTH_PROVIDER: provider, BUS: { send: async () => {} },
  } as unknown as Env
  const count = (table: string) => (h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
  return { h, env, sessions, count }
}

function stubGoogle(sub: string, email: string): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) return new Response(JSON.stringify({ id: sub, name: sub, email, verified_email: true }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }))
}

/** One full browser leg: /authorize, then the Google callback from IP, as the Google account (sub, email). */
async function signIn(env: Env, sub: string, email: string, ip = IP): Promise<Response> {
  const a = await handleOAuthAuthorize(new Request(AUTH_URL), env)
  const state = new URL(a.headers.get('Location')!).searchParams.get('state')!
  const cookie = a.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  stubGoogle(sub, email)
  return handleOAuthAuthorize(new Request(`https://pot.test/oauth/google-callback?code=c&state=${state}`, {
    headers: { 'CF-Connecting-IP': ip, Cookie: cookie },
  }), env)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('B2 limiter: existing members are neither refused nor counted', () => {
  it('six existing-member sign-ins from one IP all succeed and the KV counter stays absent', async () => {
    const { h, env, sessions, count } = setup()
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('m1', 'team@example.test', 'Team', 'active', '2026-08-01T00:00:00.000Z', 'mumega');`)
    const membersBefore = count('members')
    for (let i = 0; i < 6; i++) {
      const res = await signIn(env, 'gs-team', 'team@example.test')
      expect(res.status).toBe(200)
    }
    expect(sessions.store.get(RL_KEY)).toBeUndefined()
    expect(count('members')).toBe(membersBefore)
    h.close()
  })

  it('an existing member from a saturated IP still signs in, and the counter is untouched at 5', async () => {
    const { h, env, sessions, count } = setup()
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('m1', 'team@example.test', 'Team', 'active', '2026-08-01T00:00:00.000Z', 'mumega');`)
    sessions.store.set(RL_KEY, '5')
    const res = await signIn(env, 'gs-team', 'team@example.test')
    expect(res.status).toBe(200)
    expect(sessions.store.get(RL_KEY)).toBe('5')
    expect(count('members')).toBe(1)
    h.close()
  })

  it('a member found by a linked login identity (email changed) is also not counted', async () => {
    const { h, env, sessions } = setup()
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('m1', 'old@example.test', 'Old', 'active', '2026-08-01T00:00:00.000Z', 'mumega');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
      VALUES ('hli-1', 'mumega', 'google', 'gs-linked', 'old@example.test', 'm1');`)
    sessions.store.set(RL_KEY, '5')
    const res = await signIn(env, 'gs-linked', 'old@example.test')
    expect(res.status).toBe(200)
    expect(sessions.store.get(RL_KEY)).toBe('5')
    h.close()
  })
})

describe('B2 limiter: new members are limited to 5 per IP per hour, decided before any write', () => {
  it('five new members from one IP succeed; the sixth gets 429 with no members row and no member_tokens row', async () => {
    const { h, env, sessions, count } = setup()
    for (let i = 1; i <= 5; i++) {
      const res = await signIn(env, `gs-new-${i}`, `new${i}@example.test`)
      expect(res.status).toBe(200)
      expect(sessions.store.get(RL_KEY)).toBe(String(i))
    }
    expect(count('members')).toBe(5)
    const tokensBefore = count('member_tokens')

    const sixth = await signIn(env, 'gs-new-6', 'new6@example.test')
    expect(sixth.status).toBe(429)
    expect(sixth.headers.get('Retry-After')).toBe('3600')
    expect(await sixth.text()).toBe(
      'Too many new accounts have been created from this network recently, so we cannot create another one right now. '
      + 'Try again in an hour, or ask an org admin to invite you.',
    )
    expect(count('members')).toBe(5)
    expect(count('member_tokens')).toBe(tokensBefore)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE email = 'new6@example.test'`).get()).toEqual({ n: 0 })
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE provider_subject = 'gs-new-6'`).get()).toEqual({ n: 0 })
    expect(sessions.store.get(RL_KEY)).toBe('5') // a refused sign-in does not advance the counter
    h.close()
  })

  it('new-member budget is per IP: a different IP still creates', async () => {
    const { h, env, sessions, count } = setup()
    sessions.store.set(RL_KEY, '5')
    expect((await signIn(env, 'gs-a', 'a@example.test')).status).toBe(429)
    expect(count('members')).toBe(0)
    expect((await signIn(env, 'gs-b', 'b@example.test', '203.0.113.8')).status).toBe(200)
    expect(count('members')).toBe(1)
    expect(sessions.store.get('oauth-reg-rl:203.0.113.8')).toBe('1')
    h.close()
  })

  it('the guard runs BEFORE the insert: a refusal writes no members row and no grant (direct)', async () => {
    const { h, env, count } = setup()
    const calls: string[] = []
    const guard = async () => { calls.push(`members=${count('members')}`); return { allowed: false, retryAfter: 3600 } }
    await expect(findOrCreateHumanMemberDetailed(env, 'x@example.test', 'X', guard, { provider: 'google', subject: 'gs-x' }))
      .rejects.toBeInstanceOf(NewMemberRefusedError)
    expect(calls).toEqual(['members=0']) // guard consulted exactly once, with nothing written yet
    expect(count('members')).toBe(0)
    expect(count('capabilities')).toBe(0)
    h.close()
  })

  it('the guard is NOT consulted when an existing member resolves (direct)', async () => {
    const { h, env } = setup()
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant)
      VALUES ('m1', 'team@example.test', 'Team', 'active', '2026-08-01T00:00:00.000Z', 'mumega');`)
    const guard = vi.fn(async () => ({ allowed: false, retryAfter: 3600 }))
    expect(await findOrCreateHumanMemberDetailed(env, 'team@example.test', 'Team', guard, { provider: 'google', subject: 'gs-team' }))
      .toEqual({ id: 'm1', created: false })
    expect(guard).not.toHaveBeenCalled()
    h.close()
  })

  it('findOrCreateHumanMember (no OAuth budget to enforce) still creates with the explicit allow guard', async () => {
    const { h, env, count } = setup()
    const id = await findOrCreateHumanMember(env, 'y@example.test', 'Y', { provider: 'google', subject: 'gs-y' })
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(count('members')).toBe(1)
    h.close()
  })
})

describe('B2 limiter: fail-open on KV errors', () => {
  it.each(['get', 'put', 'both'] as const)('KV %s throwing on the limiter key still allows new members', async (throwOn) => {
    const { h, env, count } = setup({ throwOn })
    // only the limiter's own key throws; the nonce/consent KV writes in the same flow keep working
    for (let i = 1; i <= 7; i++) {
      expect((await signIn(env, `gs-k${i}`, `k${i}@example.test`)).status).toBe(200)
    }
    expect(count('members')).toBe(7) // fail-open: not even a sixth/seventh is refused when KV cannot count
    h.close()
  })
})
