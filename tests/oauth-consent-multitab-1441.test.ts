// tests/oauth-consent-multitab-1441.test.ts — mupot#1441 (ONE COOKIE PER NONCE; jar below is RFC 6265 path/max-age aware,
// because a path-blind jar once hid a fix that did nothing in a real browser) —: Claude Desktop starts /authorize twice, so two consent
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

/** One browser: RFC 6265 jar. Cookie identity = (name, path); sent only when the request path path-matches the
 *  cookie path; Max-Age=0 deletes; a Set-Cookie for an existing (name, path) replaces it. */
class Browser {
  cookies = new Map<string, { name: string; value: string; path: string }>()
  secureViolations: string[] = []
  cookieFor(reqPath: string): string {
    const out: string[] = []
    for (const c of this.cookies.values()) {
      const pathMatch = reqPath === c.path || (reqPath.startsWith(c.path) && (c.path.endsWith('/') || reqPath[c.path.length] === '/'))
      if (pathMatch) out.push(`${c.name}=${c.value}`)
    }
    return out.join('; ')
  }
  has(name: string): boolean { return [...this.cookies.values()].some((c) => c.name === name) }
  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie()) {
      if (!/;\s*Secure/i.test(sc)) this.secureViolations.push(sc)
      const [pair] = sc.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i); const value = pair.slice(i + 1)
      const path = /Path=([^;]+)/i.exec(sc)?.[1] ?? '/'
      const key = `${name}|${path}`
      if (/Max-Age=0/i.test(sc) || value === '') this.cookies.delete(key)
      else this.cookies.set(key, { name, value, path })
    }
  }
  async send(env: Env, req: Request): Promise<Response> {
    const headers = new Headers(req.headers)
    const c = this.cookieFor(new URL(req.url).pathname)
    if (c) headers.set('Cookie', c)
    const res = await handleOAuthAuthorize(new Request(req, { headers }), env)
    this.absorb(res)
    return res
  }
}

const AUTH_URL = 'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256'
let ipSeq = 1

function stubGoogle(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'g' }), { status: 200 })
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) return new Response(JSON.stringify({ id: 'gs1', name: 'Human', email: 'human@example.test', verified_email: true }), { status: 200 })
    throw new Error(`unexpected fetch ${url}`)
  }))
}

async function startAuthorize(b: Browser, env: Env): Promise<string> {
  env.DB = h.db
  const a = await b.send(env, new Request(AUTH_URL))
  const state = new URL(a.headers.get('Location')!).searchParams.get('state')!
  expect(b.has(`mupot_oauth_nonce_${state}`)).toBe(true)
  return state
}

function callback(b: Browser, env: Env, state: string, cookieOverride?: string): Promise<Response> {
  stubGoogle()
  const headers: Record<string, string> = { 'CF-Connecting-IP': `10.1.0.${ipSeq++}` } // distinct IP: the per-IP registration limiter is not under test
  if (cookieOverride !== undefined) headers.Cookie = cookieOverride
  const req = new Request(`https://pot.test/oauth/google-callback?code=c&state=${state}`, { headers })
  return cookieOverride !== undefined ? handleOAuthAuthorize(req, env) : b.send(env, req)
}

async function renderConsent(b: Browser, env: Env): Promise<string> {
  const state = await startAuthorize(b, env)
  const res = await callback(b, env, state)
  expect(res.status).toBe(200)
  return /name="consent_nonce" value="([^"]+)"/.exec(await res.text())![1]
}

function decline(b: Browser, env: Env, nonce: string, cookieOverride?: string): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (cookieOverride !== undefined) headers.Cookie = cookieOverride
  const req = new Request('https://pot.test/oauth/consent', { method: 'POST', headers, body: new URLSearchParams({ consent_nonce: nonce, action: 'decline' }) })
  return cookieOverride !== undefined ? handleOAuthAuthorize(req, env) : b.send(env, req)
}

describe('mupot#1441 consent nonce binding across tabs (path-aware jar)', () => {
  it('REPRO: two consent renders in one browser; submitting the FIRST tab succeeds, then the second', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    const n2 = await renderConsent(b, env)
    expect(n1).not.toBe(n2)
    expect((await decline(b, env, n1)).status).toBe(200)
    expect((await decline(b, env, n2)).status).toBe(200)
  })

  it('replay of a consumed consent nonce is refused (400 by KV with the old cookie, 403 once the cookie is cleared)', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    await renderConsent(b, env)
    const old = b.cookieFor('/oauth/consent')
    expect((await decline(b, env, n1)).status).toBe(200)
    expect((await decline(b, env, n1, old)).status).toBe(400)
    expect((await decline(b, env, n1)).status).toBe(403)
  })

  it('a consent nonce minted for another browser is refused both ways; the owner is unharmed', async () => {
    const env = makeEnv(); const a = new Browser(); const evil = new Browser()
    const nA = await renderConsent(a, env)
    const nEvil = await renderConsent(evil, env)
    expect((await decline(evil, env, nA)).status).toBe(403)
    expect((await decline(a, env, nEvil)).status).toBe(403)
    expect((await decline(a, env, nA)).status).toBe(200)
  })

  it('no cookie, wrong value, other nonce, non-UUID or name-injecting nonce is refused', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    const n2 = await renderConsent(b, env)
    expect((await decline(b, env, n1, '')).status).toBe(403)
    expect((await decline(b, env, n1, `mupot_oauth_consent_${n1}=0`)).status).toBe(403)
    expect((await decline(b, env, n1, `mupot_oauth_consent_${n2}=1`)).status).toBe(403)
    expect((await decline(b, env, 'x', 'mupot_oauth_consent_x=1')).status).toBe(403)
    expect((await decline(b, env, `${n1}x`, `mupot_oauth_consent_${n1}x=1`)).status).toBe(403)
    expect((await decline(b, env, n1.toUpperCase(), `mupot_oauth_consent_${n1.toUpperCase()}=1`)).status).toBe(403)
    expect((await decline(b, env, `${n1}=1; mupot_oauth_consent_${n1}`, `mupot_oauth_consent_${n1}=1`)).status).toBe(403)
    expect((await decline(b, env, n1)).status).toBe(200) // the real one still works
  })

  it('every Set-Cookie on authorize/callback/consent carries Secure on https', async () => {
    const env = makeEnv(); const b = new Browser()
    const n1 = await renderConsent(b, env)
    await decline(b, env, n1)
    expect(b.secureViolations).toEqual([])
  })
})

describe('mupot#1441 flow-nonce cookie (/authorize -> callback), same class', () => {
  it('two interleaved /authorize flows in one browser: BOTH callbacks succeed, in either order', async () => {
    for (const order of [[0, 1], [1, 0]]) {
      const env = makeEnv(); const b = new Browser()
      const states = [await startAuthorize(b, env), await startAuthorize(b, env)]
      expect(states[0]).not.toBe(states[1])
      for (const i of order) expect((await callback(b, env, states[i])).status).toBe(200)
    }
  })

  it('CONCURRENT double /authorize (both requests read the jar before either response lands): both callbacks succeed', async () => {
    const env = makeEnv(); const b = new Browser(); env.DB = h.db
    const [r1, r2] = await Promise.all([b.send(env, new Request(AUTH_URL)), b.send(env, new Request(AUTH_URL))])
    const s1 = new URL(r1.headers.get('Location')!).searchParams.get('state')!
    const s2 = new URL(r2.headers.get('Location')!).searchParams.get('state')!
    expect(s1).not.toBe(s2)
    expect((await callback(b, env, s1)).status).toBe(200)
    expect((await callback(b, env, s2)).status).toBe(200)
  })

  it('cross-browser state is refused; replay of a consumed state is refused (403 jar, 400 KV with old cookie)', async () => {
    const env = makeEnv(); const a = new Browser(); const evil = new Browser()
    const sA = await startAuthorize(a, env)
    const sE = await startAuthorize(evil, env)
    expect((await callback(evil, env, sA)).status).toBe(403)
    expect((await callback(a, env, sE)).status).toBe(403)
    const old = a.cookieFor('/oauth/google-callback')
    expect((await callback(a, env, sA)).status).toBe(200)
    expect((await callback(a, env, sA)).status).toBe(403) // cookie consumed
    expect((await callback(a, env, sA, old)).status).toBe(400) // KV single-use
  })

  it('a non-UUID / injecting / wrong-valued flow cookie never binds', async () => {
    const env = makeEnv(); const b = new Browser()
    const s = await startAuthorize(b, env)
    expect((await callback(b, env, 'x', 'mupot_oauth_nonce_x=1')).status).toBe(403)
    expect((await callback(b, env, `${s}x`, `mupot_oauth_nonce_${s}x=1`)).status).toBe(403)
    expect((await callback(b, env, s, `mupot_oauth_nonce_${s}=0`)).status).toBe(403)
    expect((await callback(b, env, s.toUpperCase(), `mupot_oauth_nonce_${s.toUpperCase()}=1`)).status).toBe(403)
  })

  it('an unauthenticated cookie flood costs no extra KV reads (one lookup by exact name)', async () => {
    const env = makeEnv(); const b = new Browser(); env.DB = h.db
    const flood = Array.from({ length: 800 }, () => `mupot_oauth_nonce_${crypto.randomUUID()}=1`).join('; ')
    const kv = env.SESSIONS as unknown as { get: (k: string, t?: string) => Promise<unknown> }
    const realGet = kv.get.bind(kv)
    let reads = 0
    kv.get = async (k, t) => { reads++; return realGet(k, t) }
    await callback(b, env, crypto.randomUUID(), flood)
    expect(reads).toBe(0) // cookie for this state absent -> refused before any KV read
    await handleOAuthAuthorize(new Request(AUTH_URL, { headers: { Cookie: flood } }), env)
    expect(reads).toBe(0) // /authorize never reads the cookie at all
  })
})
