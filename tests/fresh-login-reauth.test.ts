// A brand-new Google sign-in whose signed id_token carries a fresh auth_time counts as a recent reauth, so Confirm/Allow
// does not force a second Google login. Real authApp routes, real cookie jar, real migrations.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { GOOGLE_AUTH_MAX_AGE_SECONDS, GOOGLE_AUTH_TIME_CLAIMS } from '../src/auth/index'
import { hasRecentReauth, type WebSessionRecord } from '../src/auth/web-sessions'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'https://pot.test'
const nowSec = () => Math.floor(Date.now() / 1000)

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string, type?: string) => {
      const v = store.get(k)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}
type Jar = Map<string, { value: string; path: string }>
const pathMatches = (cp: string, rp: string) => rp === cp || (rp.startsWith(cp) && (cp.endsWith('/') || rp[cp.length] === '/'))
const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('fresh Google sign-in counts as recent reauth', () => {
  let h: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    env = {
      DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN, SESSIONS: kv(),
      OAUTH_PROVIDER: 'google', OAUTH_CLIENT_ID: 'cid', OAUTH_CLIENT_SECRET: 'sec', LOCAL_TEST_AUTH: '1',
    } as unknown as Env
    h.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES ('mem-a', 'a@example.test', 'A', 'active', '${TENANT}', '2026-01-01T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'mem-a', 'org', NULL, 'admin');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('hli-a', '${TENANT}', 'google', 'sub-a', 'a@example.test', 'mem-a');
    `)
  })
  afterEach(() => h.close())

  function absorb(jar: Jar, res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      const path = attrs.map((a) => a.trim()).find((a) => /^path=/i.test(a))?.slice(5) ?? '/'
      if (value === '' || /Max-Age=0/i.test(line)) jar.delete(name)
      else jar.set(name, { value, path })
    }
  }
  async function visit(jar: Jar, path: string): Promise<Response> {
    const cookie = [...jar].filter(([, c]) => pathMatches(c.path, path.split('?')[0])).map(([k, c]) => `${k}=${c.value}`).join('; ')
    const res = await authApp.request(`${ORIGIN}${path.replace(/^\/auth/, '')}`, { headers: cookie ? { cookie } : {} }, env)
    absorb(jar, res)
    return res
  }
  /** Google's token endpoint answers with this id_token body (null = no id_token at all). */
  async function signIn(idToken: string | null, extraQuery = ''): Promise<WebSessionRecord> {
    const jar: Jar = new Map()
    const login = await visit(jar, '/auth/login')
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (u: string) => {
      if (new URL(String(u)).pathname.includes('token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 1, token_type: 'Bearer', ...(idToken ? { id_token: idToken } : {}) }))
      }
      return new Response(JSON.stringify({ sub: 'sub-a', email: 'a@example.test', email_verified: true }))
    }) as typeof fetch
    try { await visit(jar, `/auth/callback?code=c&state=${state}${extraQuery}`) } finally { globalThis.fetch = realFetch }
    return onlySession()
  }
  const tokenWith = (authTime: unknown) => `x.${b64({ auth_time: authTime })}.y`
  const onlySession = () =>
    h.sqlite.prepare(`SELECT * FROM web_sessions WHERE member_id = 'mem-a' ORDER BY created_at DESC LIMIT 1`).get() as WebSessionRecord

  it('login asks Google for auth_time via the claims request', async () => {
    const res = await visit(new Map(), '/auth/login')
    expect(new URL(res.headers.get('location')!).searchParams.get('claims')).toBe(GOOGLE_AUTH_TIME_CLAIMS)
  })

  it('1. fresh auth_time: the new session is recently reauthed (Confirm needs no second login)', async () => {
    const s = await signIn(tokenWith(nowSec() - 5))
    expect(s.recent_reauth_at).not.toBeNull()
    expect(hasRecentReauth(s)).toBe(true)
  })

  it('1b. auth_time at the edge of the window (14 min) is still fresh', async () => {
    expect(GOOGLE_AUTH_MAX_AGE_SECONDS).toBe(15 * 60)
    expect(hasRecentReauth(await signIn(tokenWith(nowSec() - 14 * 60)))).toBe(true)
  })

  it('2. stale auth_time (16 min): not fresh', async () => {
    const s = await signIn(tokenWith(nowSec() - 16 * 60))
    expect(s.recent_reauth_at).toBeNull()
    expect(hasRecentReauth(s)).toBe(false)
  })

  it('2b. auth_time far in the future: not fresh', async () => {
    expect((await signIn(tokenWith(nowSec() + 3600))).recent_reauth_at).toBeNull()
  })

  it('3. missing auth_time (no claim, no id_token, non-numeric): not fresh, login still succeeds', async () => {
    expect((await signIn(`x.${b64({ sub: 'sub-a' })}.y`)).recent_reauth_at).toBeNull()
    h.sqlite.exec(`DELETE FROM web_sessions`)
    expect((await signIn(null)).recent_reauth_at).toBeNull()
    h.sqlite.exec(`DELETE FROM web_sessions`)
    expect((await signIn(tokenWith('9999999999'))).recent_reauth_at).toBeNull()
  })

  it('4. an auth_time smuggled via the callback query string or userinfo is ignored', async () => {
    const s = await signIn(null, `&auth_time=${nowSec()}&id_token=${encodeURIComponent(tokenWith(nowSec()))}`)
    expect(s.recent_reauth_at).toBeNull()
    expect(hasRecentReauth(s)).toBe(false)
  })

  it('5. a session minted by another path (dev-login) is unaffected', async () => {
    const jar: Jar = new Map()
    const res = await visit(jar, '/auth/dev-login')
    expect(res.status).toBe(302)
    const rows = h.sqlite.prepare(`SELECT recent_reauth_at FROM web_sessions`).all() as Array<{ recent_reauth_at: string | null }>
    expect(rows.every((r) => r.recent_reauth_at === null)).toBe(true)
  })
})
