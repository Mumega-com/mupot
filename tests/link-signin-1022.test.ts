// mupot#1022 — Linked sign-ins. Real authApp routes, real cookie jars, real D1 schema (all migrations): a signed-in member
// links another Google account to THIS member; a duplicate member's identity moves only on confirm; nothing links on an
// email match or an unauthenticated login.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { listLinkedSignIns, linkSignIn } from '../src/auth/link-signin'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'https://pot.test'

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
    store,
  }
}

type Jar = Map<string, { value: string; path: string }>
const pathMatches = (cookiePath: string, requestPath: string) =>
  requestPath === cookiePath || (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'))

describe('#1022 linked sign-ins', () => {
  let h: SqliteD1Harness
  let env: Env
  let sessions: ReturnType<typeof kv>

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    sessions = kv()
    env = {
      DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN, SESSIONS: sessions,
      OAUTH_PROVIDER: 'google', OAUTH_CLIENT_ID: 'cid', OAUTH_CLIENT_SECRET: 'sec',
    } as unknown as Env
    h.sqlite.exec(`
      INSERT INTO users (id, email, role) VALUES ('u-first-owner', 'first-owner@example.test', 'owner');
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'sq-one', 'Squad One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-2', 'dept-1', 'sq-two', 'Squad Two');
      -- the member the person actually works as (admin on the org)
      INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES ('mem-main', 'main@example.test', 'Main', 'active', '${TENANT}', '2026-01-01T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-main', 'mem-main', 'org', NULL, 'admin');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('hli-main', '${TENANT}', 'google', 'sub-main', 'main@example.test', 'mem-main');
      -- the duplicate: same person's other Google account, its own member with two small grants
      INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES ('mem-dup', 'dup@gmail.test', 'Dup', 'active', '${TENANT}', '2026-09-26T00:00:00.000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-dup-1', 'mem-dup', 'squad', 'squad-1', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-dup-2', 'mem-dup', 'squad', 'squad-2', 'member');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('hli-dup', '${TENANT}', 'google', 'sub-dup', 'dup@gmail.test', 'mem-dup');
    `)
  })
  afterEach(() => {
    h.close()
    vi.unstubAllGlobals()
  })

  // ── tiny browser ───────────────────────────────────────────────────────────────────────────────
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
  async function visit(jar: Jar, path: string, init: RequestInit = {}): Promise<Response> {
    const cookie = [...jar].filter(([, c]) => pathMatches(c.path, path.split('?')[0])).map(([k, c]) => `${k}=${c.value}`).join('; ')
    const res = await authApp.request(`${ORIGIN}${path.replace(/^\/auth/, '')}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) },
    }, env)
    absorb(jar, res)
    return res
  }
  async function withGoogle<T>(sub: string, email: string | null, fn: () => Promise<T>): Promise<T> {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (u: string) => {
      if (String(u).includes('token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 1, token_type: 'Bearer' }))
      return new Response(JSON.stringify({ sub, ...(email ? { email, email_verified: true } : {}) }))
    }) as typeof fetch
    try { return await fn() } finally { globalThis.fetch = realFetch }
  }
  async function signIn(sub: string, email: string, jar: Jar = new Map()): Promise<Jar> {
    const login = await visit(jar, '/auth/login')
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    await withGoogle(sub, email, () => visit(jar, `/auth/callback?code=c&state=${state}`))
    return jar
  }
  const memberOf = async (jar: Jar) => ((await (await visit(jar, '/auth/me')).json()) as { webSessionMemberId?: string }).webSessionMemberId
  const freshen = (memberId: string, agoMs = 0) =>
    h.sqlite.prepare(`UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = ?`).run(new Date(Date.now() - agoMs).toISOString(), memberId)
  const post = (jar: Jar, path: string, origin = ORIGIN) =>
    visit(jar, path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: '' })
  async function startLink(jar: Jar): Promise<{ res: Response; state: string | null }> {
    const res = await post(jar, '/auth/link-signin/start')
    const loc = res.headers.get('location') ?? ''
    return { res, state: loc.includes('accounts.google.com') ? new URL(loc).searchParams.get('state') : null }
  }
  async function completeLink(jar: Jar, state: string, sub: string, email: string | null = `${sub}@gmail.test`): Promise<Response> {
    return withGoogle(sub, email, () => visit(jar, `/auth/callback?code=c&state=${state}`))
  }
  /** main member signed in and freshly re-authenticated. */
  async function mainSession(): Promise<Jar> {
    const jar = await signIn('sub-main', 'main@example.test')
    expect(await memberOf(jar)).toBe('mem-main')
    freshen('mem-main')
    return jar
  }
  const identity = (sub: string) =>
    h.sqlite.prepare(`SELECT member_id, revoked_at, linked_by_member_id FROM human_login_identities WHERE provider = 'google' AND provider_subject = ?`).get(sub) as
      { member_id: string; revoked_at: string | null; linked_by_member_id: string | null } | undefined
  const audits = (op: string) =>
    h.sqlite.prepare(`SELECT operation, evidence_json FROM mutation_audit_entries WHERE handler = 'auth.linked_signins' AND operation = ?`).all(op)

  // ── 1. happy path ──────────────────────────────────────────────────────────────────────────────
  it('link happy path: a fresh signed-in member links a new Google subject; row, audit, and login resolution', async () => {
    const jar = await mainSession()
    const { res, state } = await startLink(jar)
    expect(res.status).toBe(302)
    expect(state).toBeTruthy()
    const cb = await completeLink(jar, state!, 'sub-new', 'other@gmail.test')
    expect(cb.headers.get('location')).toBe('/account?signin=linked')
    expect(identity('sub-new')).toEqual({ member_id: 'mem-main', revoked_at: null, linked_by_member_id: 'mem-main' })
    expect(audits('link')).toHaveLength(1)
    const list = await listLinkedSignIns(env, 'mem-main')
    expect(list.map((i) => i.maskedEmail)).toContain('o***@gmail.test')
    expect(JSON.stringify(list)).not.toContain('other@gmail.test')
    // the callback does not mint or swap a session
    expect(await memberOf(jar)).toBe('mem-main')
  })

  it('login with the newly linked Google subject resolves to the main member, not a new one', async () => {
    const jar = await mainSession()
    const { state } = await startLink(jar)
    await completeLink(jar, state!, 'sub-new', 'other@gmail.test')
    const membersBefore = (h.sqlite.prepare(`SELECT COUNT(*) AS n FROM members`).get() as { n: number }).n
    const other = await signIn('sub-new', 'other@gmail.test')
    expect(await memberOf(other)).toBe('mem-main')
    expect((h.sqlite.prepare(`SELECT COUNT(*) AS n FROM members`).get() as { n: number }).n).toBe(membersBefore)
  })

  // ── 2. what must never link ────────────────────────────────────────────────────────────────────
  it('email match alone never links: a login whose verified email equals a member email gets no identity on it', async () => {
    // mem-main already has a live identity, so a second Google subject carrying its email must not attach (#1551)
    await signIn('sub-stranger', 'main@example.test')
    expect(identity('sub-stranger')?.member_id).not.toBe('mem-main')
    expect(audits('link')).toHaveLength(0)
  })

  it('an unauthenticated browser cannot start a link, and a link-intent callback with no session links nothing', async () => {
    const anon: Jar = new Map()
    expect((await post(anon, '/auth/link-signin/start')).status).toBe(401)
    const jar = await mainSession()
    const { state } = await startLink(jar)
    // the state cookie is in `jar`; move ONLY it to a browser with no session
    const stray: Jar = new Map([[...jar].find(([k]) => k.startsWith('mupot_login_state_'))!])
    const cb = await completeLink(stray, state!, 'sub-new')
    expect(cb.status).toBe(403)
    expect(identity('sub-new')).toBeUndefined()
  })

  it('a forged or unknown state is refused and links nothing', async () => {
    const jar = await mainSession()
    const forged = 'a'.repeat(48)
    jar.set(`mupot_login_state_${forged}`, { value: '1', path: '/callback' })
    const cb = await completeLink(jar, forged, 'sub-new')
    expect(cb.status).toBe(400)
    // and with no cookie at all
    const noCookie = await completeLink(jar, 'b'.repeat(48), 'sub-new')
    expect(noCookie.status).toBe(400)
    expect(identity('sub-new')).toBeUndefined()
  })

  it('a state started by one session is refused in another session (cross-session)', async () => {
    const a = await mainSession()
    const { state } = await startLink(a)
    // B: the duplicate member, signed in and fresh, holding A's state cookie (a lured / planted callback)
    const b = await signIn('sub-dup', 'dup@gmail.test')
    freshen('mem-dup')
    const stateCookie = [...a].find(([k]) => k.startsWith('mupot_login_state_'))!
    b.set(stateCookie[0], stateCookie[1])
    const cb = await completeLink(b, state!, 'sub-attacker')
    expect(cb.status).toBe(403)
    expect(identity('sub-attacker')).toBeUndefined()
  })

  // ── 3. freshness ───────────────────────────────────────────────────────────────────────────────
  it('a stale session cannot start a link: it is sent to re-authenticate first, and no state is written', async () => {
    const jar = await signIn('sub-main', 'main@example.test')
    freshen('mem-main', 10 * 60 * 1000)
    const before = sessions.store.size
    const { res, state } = await startLink(jar)
    expect(state).toBeNull()
    expect(res.headers.get('location')).toBe('/auth/reauth?return=/account')
    expect(sessions.store.size).toBe(before)
  })

  it('a session that went stale between start and callback links nothing', async () => {
    const jar = await mainSession()
    const { state } = await startLink(jar)
    freshen('mem-main', 10 * 60 * 1000)
    const cb = await completeLink(jar, state!, 'sub-new')
    expect(cb.headers.get('location')).toBe('/account?signin=reauth_required')
    expect(identity('sub-new')).toBeUndefined()
  })

  // ── 4. already_linked / duplicate move ─────────────────────────────────────────────────────────
  it('already_linked: a subject live on a member that outranks you is refused, and nothing moves', async () => {
    h.sqlite.exec(`
      DELETE FROM capabilities WHERE id = 'cap-main';
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-main', 'mem-main', 'squad', 'squad-1', 'member');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-dup-owner', 'mem-dup', 'org', NULL, 'owner');
    `)
    const jar = await mainSession()
    const { state } = await startLink(jar)
    const cb = await completeLink(jar, state!, 'sub-dup', 'dup@gmail.test')
    expect(cb.headers.get('location')).toBe('/account?signin=already_linked')
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
  })

  it('already_linked: a duplicate with a live competing bearer (#1963) is not movable', async () => {
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at, revoked_at)
      VALUES ('tok-dup', 'mem-dup', 'hash-dup', 'workspace', 'workspace', datetime('now'), NULL, '${TENANT}', NULL, NULL)`)
    const jar = await mainSession()
    const { state } = await startLink(jar)
    const cb = await completeLink(jar, state!, 'sub-dup', 'dup@gmail.test')
    expect(cb.headers.get('location')).toBe('/account?signin=already_linked')
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
  })

  it('linkSignIn never re-points a live subject without the confirmed move (library-level)', async () => {
    const auth: AuthContext = { userId: 'u', email: 'main@example.test', role: 'member', tenant: TENANT, memberId: 'mem-main' }
    const r = await linkSignIn(env, auth, { provider: 'google', subject: 'sub-dup', verifiedEmail: 'dup@gmail.test' })
    expect(r).toEqual({ ok: false, error: 'already_linked' })
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
  })

  async function reachMoveConfirm(): Promise<{ jar: Jar; page: string }> {
    const jar = await mainSession()
    const { state } = await startLink(jar)
    const cb = await completeLink(jar, state!, 'sub-dup', 'dup@gmail.test')
    expect(cb.status).toBe(200)
    return { jar, page: await cb.text() }
  }

  it('duplicate: the confirm page names the old member (date, permission count) and nothing has moved yet', async () => {
    const { page } = await reachMoveConfirm()
    expect(page).toContain('This Google account already has its own member (created 2026-09-26, 2 permissions).')
    expect(page).toContain('Linking moves sign-in to this account; the old member is left as-is for an admin to archive.')
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
  })

  it('duplicate move on confirm: identity re-points, old sessions end, old member and its grants are left as-is, audited', async () => {
    const oldBrowser = await signIn('sub-dup', 'dup@gmail.test')
    expect(await memberOf(oldBrowser)).toBe('mem-dup')
    const { jar } = await reachMoveConfirm()
    const done = await post(jar, '/auth/link-signin/confirm')
    expect(done.headers.get('location')).toBe('/account?signin=moved')
    expect(identity('sub-dup')).toEqual({ member_id: 'mem-main', revoked_at: null, linked_by_member_id: 'mem-main' })
    expect(h.sqlite.prepare(`SELECT status FROM members WHERE id = 'mem-dup'`).get()).toEqual({ status: 'active' })
    expect((h.sqlite.prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'mem-dup'`).get() as { n: number }).n).toBe(2)
    expect(await memberOf(oldBrowser)).toBeUndefined() // the old member's session for that identity was cut
    expect(audits('move')).toHaveLength(1)
    // and signing in with that Google account now lands in the main member
    expect(await memberOf(await signIn('sub-dup', 'dup@gmail.test'))).toBe('mem-main')
  })

  it('the duplicate-move batch is all-or-nothing: a failure in the cutoff statement leaves the identity on the old member', async () => {
    await signIn('sub-dup', 'dup@gmail.test') // a live old session so the cutoff UPDATE has a row to touch
    const { jar } = await reachMoveConfirm()
    h.sqlite.exec(`CREATE TRIGGER boom BEFORE UPDATE ON web_sessions BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const done = await post(jar, '/auth/link-signin/confirm')
    expect(done.headers.get('location')).toBe('/account?signin=service_error')
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
    expect(audits('move')).toHaveLength(0)
  })

  it('the confirm is single-use and bound to the session that was shown the duplicate', async () => {
    const { jar } = await reachMoveConfirm()
    // another session replaying the nonce cookie
    const other = await signIn('sub-dup', 'dup@gmail.test')
    freshen('mem-dup')
    other.set('mupot_link_move', jar.get('mupot_link_move')!)
    const mismatch = await post(other, '/auth/link-signin/confirm')
    expect(mismatch.status).toBe(403)
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
    // the legitimate session: the nonce was consumed by the failed attempt, so it cannot be replayed afterwards
    const replay = await post(jar, '/auth/link-signin/confirm')
    expect(replay.headers.get('location')).toBe('/account?signin=expired')
  })

  it('confirm refuses when the duplicate changed after it was shown', async () => {
    const { jar } = await reachMoveConfirm()
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at, revoked_at)
      VALUES ('tok-late', 'mem-dup', 'hash-late', 'workspace', 'workspace', datetime('now'), NULL, '${TENANT}', NULL, NULL)`)
    const done = await post(jar, '/auth/link-signin/confirm')
    expect(done.headers.get('location')).toBe('/account?signin=already_linked')
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
  })

  it('confirm refuses a different duplicate than the one that was shown', async () => {
    const { jar } = await reachMoveConfirm()
    h.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant, created_at) VALUES ('mem-dup2', 'dup2@gmail.test', 'Dup2', 'active', '${TENANT}', '2026-10-01T00:00:00.000Z');
      UPDATE human_login_identities SET member_id = 'mem-dup2' WHERE id = 'hli-dup';
    `)
    const done = await post(jar, '/auth/link-signin/confirm')
    expect(done.headers.get('location')).toBe('/account?signin=changed')
    expect(identity('sub-dup')?.member_id).toBe('mem-dup2')
  })

  // ── 5. unlink ──────────────────────────────────────────────────────────────────────────────────
  it('unlinking the last identity is refused; with two it succeeds, audits, and ends that identity\'s sessions', async () => {
    const jar = await mainSession()
    const only = await post(jar, '/auth/link-signin/hli-main/unlink')
    expect(only.headers.get('location')).toBe('/account?signin=last_identity')
    expect(identity('sub-main')?.revoked_at).toBeNull()

    const { state } = await startLink(jar)
    await completeLink(jar, state!, 'sub-new', 'other@gmail.test')
    const newId = (h.sqlite.prepare(`SELECT id FROM human_login_identities WHERE provider_subject = 'sub-new'`).get() as { id: string }).id
    const viaNew = await signIn('sub-new', 'other@gmail.test')
    expect(await memberOf(viaNew)).toBe('mem-main')
    const ok = await post(jar, `/auth/link-signin/${newId}/unlink`)
    expect(ok.headers.get('location')).toBe('/account?signin=unlinked')
    expect(identity('sub-new')?.revoked_at).not.toBeNull()
    expect(await memberOf(viaNew)).toBeUndefined()
    expect(audits('unlink')).toHaveLength(1)
    // now back to one live identity: the last-one guard holds again
    expect((await post(jar, '/auth/link-signin/hli-main/unlink')).headers.get('location')).toBe('/account?signin=last_identity')
  })

  it('unlink cannot touch another member\'s identity', async () => {
    const jar = await mainSession()
    const res = await post(jar, '/auth/link-signin/hli-dup/unlink')
    expect(res.headers.get('location')).toBe('/account?signin=not_found')
    expect(identity('sub-dup')?.revoked_at).toBeNull()
  })

  it('a cross-origin POST is refused (csrf)', async () => {
    const jar = await mainSession()
    const res = await post(jar, '/auth/link-signin/start', 'https://evil.test')
    expect(res.status).toBe(403)
  })

  it('a subject unlinked before can be linked again by the SAME member, never taken from another member\'s revoked row', async () => {
    const jar = await mainSession()
    const first = await startLink(jar)
    await completeLink(jar, first.state!, 'sub-new', 'other@gmail.test')
    const newId = (h.sqlite.prepare(`SELECT id FROM human_login_identities WHERE provider_subject = 'sub-new'`).get() as { id: string }).id
    await post(jar, `/auth/link-signin/${newId}/unlink`)
    const second = await startLink(jar)
    const cb = await completeLink(jar, second.state!, 'sub-new', 'other@gmail.test')
    expect(cb.headers.get('location')).toBe('/account?signin=reactivated')
    expect(identity('sub-new')?.revoked_at).toBeNull()
    // a revoked row that belongs to someone else is never revived onto this member
    h.sqlite.exec(`UPDATE human_login_identities SET revoked_at = datetime('now') WHERE id = 'hli-dup'`)
    const third = await startLink(jar)
    const refused = await completeLink(jar, third.state!, 'sub-dup', 'dup@gmail.test')
    expect(refused.headers.get('location')).toBe('/account?signin=identity_revoked')
    expect(identity('sub-dup')?.member_id).toBe('mem-dup')
  })

  it('an unverified email is refused', async () => {
    const jar = await mainSession()
    const { state } = await startLink(jar)
    const cb = await completeLink(jar, state!, 'sub-noemail', null)
    expect(cb.headers.get('location')).toBe('/account?signin=unverified')
    expect(identity('sub-noemail')).toBeUndefined()
  })

  // ── 6. consent empty state ─────────────────────────────────────────────────────────────────────
  describe('consent empty state', () => {
    function memoryKv() {
      const m = new Map<string, string>()
      return {
        async get(key: string, type?: string) { const v = m.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
        async put(key: string, value: string) { m.set(key, value) },
        async delete(key: string) { m.delete(key) },
      }
    }
    async function consentFor(email: string, googleId: string): Promise<string> {
      const provider = {
        parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
        completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
      }
      const cenv = {
        DB: h.db, TENANT_SLUG: TENANT, BRAND: 'mupot', POT_TIER: 'scale', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
        SESSIONS: memoryKv(), OAUTH_PROVIDER: provider, BUS: { send: async () => {} },
      } as unknown as Env
      const authorize = await handleOAuthAuthorize(new Request(
        'https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256'), cenv)
      const nonce = /mupot_oauth_nonce_([0-9a-f-]{36})=/.exec(authorize.headers.get('Set-Cookie') ?? '')![1]
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
        return new Response(JSON.stringify({ id: googleId, name: 'P', email, verified_email: true }), { status: 200 })
      }))
      const res = await handleOAuthAuthorize(new Request(
        `https://pot.test/oauth/google-callback?code=abc&state=${nonce}`, { headers: { Cookie: `mupot_oauth_nonce_${nonce}=1` } }), cenv)
      return res.text()
    }

    it('an existing member with no consentable agents is told the sign-in is not linked to the main account', async () => {
      const page = await consentFor('dup@gmail.test', 'sub-dup')
      expect(page).toContain("This sign-in (d***@gmail.test) isn't linked to your main account.")
      expect(page).toContain('open My Account &rarr; Linked sign-ins, and link this Google account.')
      expect(page).toContain('<strong>New agent</strong>')
      expect(page).not.toContain('just created a new, empty member')
    })

    it('a login that JUST created a member says so, once, in the same page', async () => {
      const page = await consentFor('brand-new@gmail.test', 'sub-brand-new')
      expect(page).toContain('This sign-in just created a new, empty member in this workspace.')
      expect(page).toContain("isn't linked to your main account")
      // the next consent for the same (now existing) login no longer claims a creation
      const again = await consentFor('brand-new@gmail.test', 'sub-brand-new')
      expect(again).not.toContain('just created a new, empty member')
    })
  })

  it('the account page lists linked sign-ins (masked) and offers Link and Unlink only when more than one', async () => {
    const { linkedSignInsSectionBody } = await import('../src/dashboard/account')
    const auth: AuthContext = { userId: 'u', email: 'main@example.test', role: 'member', tenant: TENANT, memberId: 'mem-main', webSessionIdHash: 'x', webSessionMemberId: 'mem-main' }
    let body = String(await linkedSignInsSectionBody(env, auth, null))
    expect(body).toContain('m***@example.test')
    expect(body).not.toContain('main@example.test')
    expect(body).toContain('Link another Google account')
    expect(body).toContain('your only sign-in')
    expect(body).not.toContain('/unlink')
    h.sqlite.exec(`INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('hli-2', '${TENANT}', 'google', 'sub-2', 'two@gmail.test', 'mem-main')`)
    body = String(await linkedSignInsSectionBody(env, auth, 'linked'))
    expect(body).toContain('/auth/link-signin/hli-2/unlink')
    expect(body).toContain('Google account linked.')
  })
})
