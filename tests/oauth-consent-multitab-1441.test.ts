// tests/oauth-consent-multitab-1441.test.ts — mupot#1441: Claude Desktop starts /authorize twice, so two consent
// pages render for ONE browser. The consent cookie must bind BOTH nonces (no overwrite), while a nonce from
// another browser, a replay, a forged/absent cookie and a non-list-element prefix are all still refused.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import type { Env } from '../src/types'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

// Minimal DB: findOrCreateMember / listings are not under test; make them resolve to one member.
function makeEnv(): Env {
  const provider = {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', redirectUri: 'https://client.example.test/callback', scope: ['mcp:read'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
    lookupClient: vi.fn(async () => ({ clientName: 'Claude' })),
  }
  return {
    DB: undefined, TENANT_SLUG: 'mumega', BRAND: 'mupot', POT_TIER: 'scale',
    GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secret',
    SESSIONS: memoryKv(), OAUTH_PROVIDER: provider, BUS: { send: async () => {} },
  } as unknown as Env
}

import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const h = createSqliteD1()
applyAllMigrations(h.sqlite)
h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant)
  VALUES ('m1', 'human@example.test', 'Human', 'active', '2026-08-01T00:00:00.000Z', 'mumega');`)
afterEach(() => { vi.unstubAllGlobals() })

/** One browser: a tiny cookie jar keyed by cookie name (all paths here are distinct enough for the test). */
class Browser {
  jar = new Map<string, string>()
  cookie(): string { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') }
  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';')
      const i = pair.indexOf('=')
      const k = pair.slice(0, i); const v = pair.slice(i + 1)
      if (/Max-Age=0/.test(sc) || v === '') this.jar.delete(k)
      else this.jar.set(k, v)
    }
  }
  async send(env: Env, req: Request): Promise<Response> {
    const headers = new Headers(req.headers)
    if (this.jar.size) headers.set('Cookie', this.cookie())
    const res = await handleOAuthAuthorize(new Request(req, { headers }), env)
    this.absorb(res)
    return res
  }
}

let ipSeq = 1
async function renderConsent(b: Browser, env: Env): Promise<string> {
  env.DB = h.db
  const a = await b.send(env, new Request('https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256'))
  const state = /mupot_oauth_nonce=([^;]+)/.exec(a.headers.get('Set-Cookie') ?? '')![1]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) return new Response(JSON.stringify({ id: 'gs1', name: 'Human', email: 'human@example.test', verified_email: true }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }))
  const res = await b.send(env, new Request(`https://pot.test/oauth/google-callback?code=c&state=${state}`, { headers: { 'CF-Connecting-IP': `10.0.0.${ipSeq++}` } })) // distinct IP: the per-IP registration limiter is not under test
  expect(res.status).toBe(200)
  return /name="consent_nonce" value="([^"]+)"/.exec(await res.text())![1]
}

function decline(b: Browser, env: Env, nonce: string, cookieOverride?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cookieOverride !== undefined) headers.Cookie = cookieOverride
  const req = new Request('https://pot.test/oauth/consent', { method: 'POST', headers, body: new URLSearchParams({ consent_nonce: nonce, action: 'decline' }) })
  return cookieOverride !== undefined ? handleOAuthAuthorize(req, env) : b.send(env, req)
}

describe('mupot#1441 consent nonce binding across tabs', () => {
  it('REPRO: two consent renders in one browser; submitting the FIRST tab succeeds (was 403 mismatch)', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    const n2 = await renderConsent(b, env)
    expect(n1).not.toBe(n2)
    const r1 = await decline(b, env, n1)
    expect(r1.status).toBe(200)
    // and the SECOND tab still works afterwards (back-button / other tab)
    const r2 = await decline(b, env, n2)
    expect(r2.status).toBe(200)
  })

  it('replay of a consumed nonce is refused', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    const n2 = await renderConsent(b, env)
    expect((await decline(b, env, n1)).status).toBe(200)
    const replayWithOldCookie = await decline(b, env, n1, `mupot_oauth_consent=${n1}.${n2}`)
    expect(replayWithOldCookie.status).toBe(400) // KV record consumed
    expect((await decline(b, env, n1)).status).toBe(403) // cookie no longer lists it
  })

  it('a nonce minted for another browser/session is refused', async () => {
    const env = makeEnv(); const a = new Browser(); const evil = new Browser()
    const nA = await renderConsent(a, env)
    const nEvil = await renderConsent(evil, env)
    expect((await decline(evil, env, nA)).status).toBe(403)  // evil browser posts victim's nonce with its own cookie
    expect((await decline(a, env, nEvil)).status).toBe(403)
    expect((await decline(a, env, nA)).status).toBe(200)     // victim's flow unharmed
  })

  it('no cookie, garbage cookie, or a substring/prefix of a listed nonce is refused', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    expect((await decline(b, env, n1, '')).status).toBe(403)
    expect((await decline(b, env, n1, 'mupot_oauth_consent=not-a-uuid')).status).toBe(403)
    expect((await decline(b, env, n1.slice(0, 20), `mupot_oauth_consent=${n1}`)).status).toBe(403)
    expect((await decline(b, env, n1, `mupot_oauth_consent=${n1.replace(/.$/, 'x')}`)).status).toBe(403)
  })

  it('a nonce whose KV record is gone is pruned from the cookie on the next render', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    await env.SESSIONS.delete(`oauth-consent:${n1}`) // expired
    const n2 = await renderConsent(b, env)
    expect(b.jar.get('mupot_oauth_consent')).toBe(n2)
  })

  it('a non-UUID element in the cookie is never honoured (shape check before the list check)', async () => {
    const env = makeEnv(); const b = new Browser()
    expect((await decline(b, env, 'x', 'mupot_oauth_consent=x')).status).toBe(403)
  })

  it('cookie list is bounded and stale nonces are pruned', async () => {
    const env = makeEnv(); const b = new Browser()
    const ns: string[] = []
    for (let i = 0; i < 7; i++) ns.push(await renderConsent(b, env))
    const listed = b.jar.get('mupot_oauth_consent')!.split('.')
    expect(listed).toHaveLength(5)
    expect(listed).toEqual(ns.slice(-5))
    expect((await decline(b, env, ns[0])).status).toBe(403) // fell off the cookie
  })
})

// Same class, earlier hop: /authorize -> google-callback binding cookie (mupot_oauth_nonce).
async function startAuthorize(b: Browser, env: Env): Promise<string> {
  env.DB = h.db
  const a = await b.send(env, new Request('https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256'))
  const state = new URL(a.headers.get('Location')!).searchParams.get('state')!
  expect(b.jar.get('mupot_oauth_nonce')!.split('.')).toContain(state)
  return state
}
function callback(b: Browser, env: Env, state: string, cookieOverride?: string): Promise<Response> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) return new Response(JSON.stringify({ id: 'gs1', name: 'Human', email: 'human@example.test', verified_email: true }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }))
  const headers: Record<string, string> = { 'CF-Connecting-IP': `10.1.0.${ipSeq++}` }
  if (cookieOverride !== undefined) headers.Cookie = cookieOverride
  const req = new Request(`https://pot.test/oauth/google-callback?code=c&state=${state}`, { headers })
  return cookieOverride !== undefined ? handleOAuthAuthorize(req, env) : b.send(env, req)
}

describe('mupot#1441 flow-nonce cookie (/authorize -> callback), same class', () => {
  it('two interleaved /authorize flows in one browser: BOTH callbacks succeed, in either order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const env = makeEnv(); const b = new Browser()
      const states = [await startAuthorize(b, env), await startAuthorize(b, env)]
      expect(states[0]).not.toBe(states[1])
      for (const i of order) expect((await callback(b, env, states[i])).status).toBe(200)
    }
  })

  it('cross-browser state is refused; replay of a consumed state is refused', async () => {
    const env = makeEnv(); const a = new Browser(); const evil = new Browser()
    const sA = await startAuthorize(a, env)
    const sE = await startAuthorize(evil, env)
    expect((await callback(evil, env, sA)).status).toBe(403)
    expect((await callback(a, env, sE)).status).toBe(403)
    expect((await callback(a, env, sA)).status).toBe(200)
    expect((await callback(a, env, sA)).status).toBe(403) // cookie entry consumed
    const sA2 = await startAuthorize(a, env)
    expect((await callback(a, env, sA2, `mupot_oauth_nonce=${sA}`)).status).toBe(403) // listed-nonce missing for sA2
  })

  it('a non-UUID / forged cookie never binds; dead flows are pruned; list is capped at 5', async () => {
    const env = makeEnv(); const b = new Browser()
    expect((await callback(b, env, 'x', 'mupot_oauth_nonce=x')).status).toBe(403)
    const s1 = await startAuthorize(b, env)
    await env.SESSIONS.delete(`oauth-req:${s1}`) // expired
    const s2 = await startAuthorize(b, env)
    expect(b.jar.get('mupot_oauth_nonce')).toBe(s2)
    const all = [s2]
    for (let i = 0; i < 6; i++) all.push(await startAuthorize(b, env))
    expect(b.jar.get('mupot_oauth_nonce')!.split('.')).toEqual(all.slice(-5))
  })
})
