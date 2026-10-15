// mupot#1579 — a Telegram-first member gets a web login by PROOF OF CONTROL (a link minted inside the authenticated
// chat), never by email or name match. Real flow: member born through the real Telegram invite redeem, link minted
// through the real `/login` command, confirmed through the real authApp routes with real cookie sessions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { authApp } from '../src/auth'
import { resolveApexPathTenant } from '../src/dispatcher'
import { withTenantPrefix } from '../src/platform/tenant-path'
import { handleImMessage } from '../src/im'
import { mintTelegramLoginLink } from '../src/auth/telegram-login-link'
import { createProjectInvite } from '../src/members/project-invites'
import { decideIdentitylessAttach } from '../src/members/exclusive-control'
import { resolveHumanMemberId } from '../src/members/resolve-human-member'
import { findOrCreateHumanMember } from '../src/members/human-identity'
import { redeemTelegramLoginLink, telegramLoginTokenHash } from '../src/auth/telegram-login-link'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'https://pot.test'
const CHAT = '9001001'
const EMAIL = 'participant@example.test'
const DIGEST = 'b'.repeat(64)

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  }
}

describe('#1579 Telegram-first member web login', () => {
  let h: SqliteD1Harness
  let env: Env
  let updateSeq = 0

  const minter: AuthContext = {
    userId: 'u-minter', email: 'minter@example.test', role: 'member', tenant: TENANT, memberId: 'member-minter',
    capabilities: [{ member_id: 'member-minter', scope_type: 'squad', scope_id: 'squad-1', capability: 'admin' }],
  }

  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'participants', 'Participants');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'proj', 'Proj', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-minter', 'minter@example.test', 'Minter', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-minter', 'member-minter', 'squad', 'squad-1', 'admin');
    `)
    env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN, SESSIONS: kv(),
      OAUTH_PROVIDER: 'google', OAUTH_CLIENT_ID: 'cid', OAUTH_CLIENT_SECRET: 'sec' } as unknown as Env
  })
  afterEach(() => h.close())

  function telegramOptions(chat: string) {
    updateSeq += 1
    const update_id = `upd-${updateSeq}`
    h.sqlite.prepare(
      `INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
       VALUES (?, ?, ?, ?, 'processing', ?)`,
    ).run(TENANT, update_id, chat, DIGEST, new Date().toISOString())
    return { telegram: { update_id, telegram_user_id: chat, request_digest: DIGEST }, displayName: 'Pat' }
  }

  /** Born through the real Telegram door: invite -> /start <code>. */
  async function bornViaTelegram(): Promise<string> {
    const created = await createProjectInvite(env, minter, {
      email: EMAIL, project_id: 'project-1', squad_id: 'squad-1', capability: 'member', expires_in_seconds: 3600,
    })
    if (!created.ok) throw new Error(`invite failed ${created.error}`)
    const reply = await handleImMessage(env, CHAT, `/start ${created.value.pairing_code}`, telegramOptions(CHAT))
    expect(reply).toContain('Joined project')
    const row = h.sqlite.prepare(`SELECT id FROM members WHERE telegram_chat_id = ?`).get(CHAT) as { id: string }
    return row.id
  }

  async function mintLink(chat = CHAT): Promise<{ reply: string; token: string | null }> {
    const reply = await handleImMessage(env, chat, '/login', telegramOptions(chat))
    const token = /\/auth\/telegram-link\?t=([0-9a-f]{64})/.exec(reply)?.[1] ?? null
    return { reply, token }
  }

  async function sessionFor(provider: string, subject: string, email: string | null): Promise<string> {
    const id = `sid-${provider}-${subject}`
    await env.SESSIONS.put(`sess:${id}`, JSON.stringify({
      userId: `user-${subject}`, email, role: 'member', createdAt: new Date().toISOString(),
      loginIdentity: { provider, subject },
    }))
    return id
  }

  // ── a tiny browser: a Path-respecting cookie jar (RFC 6265) + the real routes ─────────────────
  // PFX emulates the apex's /t/<slug> path routing: the browser sees PFX + path, authApp sees the stripped path plus the
  // apex header, and (like applyTenantPrefix in production) Location is re-rooted but Set-Cookie Path is NOT.
  let PFX = ''
  type Jar = Map<string, { value: string; path: string }>
  const pathMatches = (cookiePath: string, requestPath: string) =>
    requestPath === cookiePath || (requestPath.startsWith(cookiePath) && (cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/'))
  const cookieHeader = (jar: Jar, visiblePath: string) =>
    [...jar].filter(([, c]) => pathMatches(c.path, visiblePath)).map(([k, c]) => `${k}=${c.value}`).join('; ')
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
  const jarGet = (jar: Jar, name: string) => jar.get(name)?.value
  /** Browser-visible Location, re-rooted the way applyTenantPrefix does for root-relative targets. */
  const loc = (res: Response) => {
    const l = res.headers.get('location')!
    return PFX && l.startsWith('/') && !l.startsWith('/t/') ? `${PFX}${l}` : l
  }
  async function visit(jar: Jar, path: string, init: RequestInit = {}, host = 'pot.test'): Promise<Response> {
    const visible = `${PFX}${path}`
    const cookie = cookieHeader(jar, visible.split('?')[0])
    const res = await authApp.request(`https://${host}${path.replace(/^\/auth/, '')}`, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(cookie ? { cookie } : {}),
        ...(PFX ? { 'x-mupot-path-prefix': PFX } : {}),
      },
    }, env)
    absorb(jar, res)
    return res
  }
  async function withGoogle<T>(sub: string, email: string, fn: () => Promise<T>): Promise<T> {
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (u: string) => {
      if (String(u).includes('token')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 1, token_type: 'Bearer' }))
      return new Response(JSON.stringify({ sub, email, email_verified: true }))
    }) as typeof fetch
    try { return await fn() } finally { globalThis.fetch = realFetch }
  }
  /** The victim's/member's browser: open the link, bounce through a fresh sign-in, land on the confirm page. */
  async function signInViaLink(token: string, sub: string, email: string, jar: Jar = new Map()) {
    const open = await visit(jar, `/auth/telegram-link?t=${token}`)
    expect(open.status).toBe(302)
    const login = await visit(jar, open.headers.get('location')!)
    expect(login.status).toBe(302)
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    const cb = await withGoogle(sub, email, () => visit(jar, `/auth/callback?code=c&state=${state}`))
    return { jar, state, cb, landed: cb.headers.get('location') }
  }
  const post = (jar: Jar, origin = ORIGIN) => visit(jar, '/auth/telegram-link/confirm', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: '',
  })
  async function linkAndConfirm(token: string, sub = 'sub-pat', email = EMAIL) {
    const r = await signInViaLink(token, sub, email)
    return { ...r, res: await post(r.jar) }
  }
  const identities = () => h.sqlite.prepare(`SELECT provider, provider_subject, member_id FROM human_login_identities`).all()
  const linkRow = () => h.sqlite.prepare(`SELECT consumed_at FROM telegram_login_links`).get()
  const webMember = async (jar: Jar) =>
    ((await (await visit(jar, '/auth/me')).json()) as { webSessionMemberId?: string }).webSessionMemberId

  it('REPRO: the Telegram-born member is locked out of web login and MCP by email alone (the lockout #1579 filed)', async () => {
    await bornViaTelegram()
    expect(await decideIdentitylessAttach(env, { tenant: TENANT, normalizedEmail: EMAIL }))
      .toEqual({ kind: 'denied_competing_control', reason: 'telegram_bound' })
    expect(await resolveHumanMemberId(env, { tenant: TENANT, provider: 'google', providerSubject: 'sub-pat', email: EMAIL })).toBeNull()
    await expect(findOrCreateHumanMember(env, EMAIL, 'Pat', { provider: 'google', subject: 'sub-pat' })).rejects.toThrow()
    const jar: Jar = new Map()
    const login = await visit(jar, '/auth/login')
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    await withGoogle('sub-pat', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))
    expect(await webMember(jar)).toBeUndefined()
  })

  it('PROBE (Opus lens): login-CSRF — attacker finishes consent in their browser, victim opens the callback; no session, no takeover', async () => {
    const victimMemberId = await bornViaTelegram()
    const attackerJar: Jar = new Map()
    const login = await visit(attackerJar, '/auth/login')
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    // the callback URL is forwarded to the victim's browser, which never held the state cookie
    const victimJar: Jar = new Map()
    const cb = await withGoogle('sub-ATTACKER', 'attacker@evil.test', () => visit(victimJar, `/auth/callback?code=attackercode&state=${state}`))
    expect(cb.status).toBe(400)
    expect(victimJar.has('mupot_session')).toBe(false)
    // and the full chain the probe ran: the victim then opens their own link and clicks Connect
    const { token } = await mintLink()
    const r = await signInViaLink(token!, 'sub-pat', EMAIL, victimJar)
    expect(identities()).toEqual([])
    expect(r.landed).toBe('/auth/telegram-link/confirm')
    expect(await resolveHumanMemberId(env, { tenant: TENANT, provider: 'google', providerSubject: 'sub-ATTACKER', email: 'attacker@evil.test' })).toBeNull()
    // a fresh Google identity for another email never resolves to the victim's member
    expect(await findOrCreateHumanMember(env, 'attacker@evil.test', 'A', { provider: 'google', subject: 'sub-ATTACKER' })).not.toBe(victimMemberId)
    expect(identities().every((i) => (i as { member_id: string }).member_id !== victimMemberId)).toBe(true)
  })

  it('an attacker-planted session in the victim browser cannot confirm: it carries no link nonce', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    // attacker plants a real, attacker-owned Google session (matching email!) in the victim jar BEFORE the link opens
    const victim: Jar = new Map()
    const aLogin = await visit(victim, '/auth/login')
    const aState = new URL(aLogin.headers.get('location')!).searchParams.get('state')!
    await withGoogle('sub-ATTACKER', EMAIL, () => visit(victim, `/auth/callback?code=c&state=${aState}`))
    expect(victim.has('mupot_session')).toBe(true)
    // victim opens their link (nonce cookie set) but the attacker's older session is all they hold
    const open = await visit(victim, `/auth/telegram-link?t=${token}`)
    expect(open.status).toBe(302)
    expect((await visit(victim, '/auth/telegram-link/confirm')).status).toBe(403)
    expect((await post(victim)).status).toBe(403)
    expect(identities()).toEqual([])
    expect(linkRow()).toEqual({ consumed_at: null })
  })

  it('an attacker whose verified email MATCHES cannot take the member without the link (no token, wrong token)', async () => {
    await bornViaTelegram()
    const jar: Jar = new Map()
    expect((await visit(jar, `/auth/telegram-link?t=${'f'.repeat(64)}`)).status).toBe(404)
    expect((await visit(jar, '/auth/telegram-link?t=nope')).status).toBe(404)
    expect((await post(jar)).status).toBe(403)
    const login = await visit(jar, '/auth/login')
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!
    await withGoogle('sub-attacker', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))
    expect((await post(jar)).status).toBe(403)
    expect(identities()).toEqual([])
    expect(await webMember(jar)).toBeUndefined()
  })

  it('happy path: /login -> link -> fresh sign-in (matching email) -> confirm shows the exact account -> link; web session and MCP resolve the member', async () => {
    const memberId = await bornViaTelegram()
    await expect(findOrCreateHumanMember(env, EMAIL, 'Pat', { provider: 'google', subject: 'sub-pat' })).rejects.toThrow()
    const { reply, token } = await mintLink()
    expect(reply).toContain(`${ORIGIN}/auth/telegram-link?t=`)
    expect(reply).toMatch(/do not share this link/i)
    const stored = h.sqlite.prepare(`SELECT token_hash FROM telegram_login_links`).all() as Array<{ token_hash: string }>
    expect(stored[0].token_hash).not.toBe(token)
    expect(stored[0].token_hash).toBe(await telegramLoginTokenHash(token!))

    const { jar, landed } = await signInViaLink(token!, 'sub-pat', EMAIL)
    expect(landed).toBe('/auth/telegram-link/confirm')
    const page = await visit(jar, landed!)
    expect(page.status).toBe(200)
    const text = (await page.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    // the EXACT provider account, the server-known member, a warning and a sign-out exit
    expect(text).toContain(`google account ${EMAIL}`)
    expect(text).toContain('p***@example.test')
    expect(text).toContain('ending 1001')
    expect(text).not.toContain('Pat')
    expect(text).toMatch(/do not continue/i)
    expect(text).toContain('Not you? Sign out')

    expect((await post(jar)).status).toBe(302)
    expect(identities()).toEqual([{ provider: 'google', provider_subject: 'sub-pat', member_id: memberId }])
    expect(await webMember(jar)).toBe(memberId)
    expect(await resolveHumanMemberId(env, { tenant: TENANT, provider: 'google', providerSubject: 'sub-pat', email: 'other@x.test' })).toBe(memberId)
    expect(await findOrCreateHumanMember(env, EMAIL, 'Pat', { provider: 'google', subject: 'sub-pat' })).toBe(memberId)
  })

  it('the confirming email must equal the member email (case-insensitive); a mismatch is refused and does not burn the link', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    const mismatched = await linkAndConfirm(token!, 'sub-other', 'pat@gmail.test')
    expect(mismatched.res.status).toBe(403)
    expect(identities()).toEqual([])
    expect(linkRow()).toEqual({ consumed_at: null })
    const upper = await linkAndConfirm(token!, 'sub-pat', EMAIL.toUpperCase())
    expect(upper.res.status).toBe(302)
    expect(identities()).toHaveLength(1)
  })

  it('a member with NO email gets no link (mint refuses, bot says why) and a NULL email can never satisfy the claim', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    // email removed after mint: the claim must not treat NULL as a match
    h.sqlite.prepare(`UPDATE members SET email = NULL WHERE id = ?`).run(memberId)
    expect((await linkAndConfirm(token!, 'sub-any', 'whoever@x.test')).res.status).toBe(403)
    expect(identities()).toEqual([])
    h.sqlite.prepare(`DELETE FROM telegram_login_links`).run()
    const noEmail = await mintLink()
    expect(noEmail.token).toBeNull()
    expect(noEmail.reply).toMatch(/no email on file/i)
    expect(await mintTelegramLoginLink(env, { memberId, chatId: CHAT })).toEqual({ ok: false, error: 'no_email' })
    expect(h.sqlite.prepare(`SELECT 1 FROM telegram_login_links`).all()).toEqual([])
  })

  it('the identity INSERT is anchored on THIS claim: a consumed link cannot be replayed into a link even if the identity row is gone', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    expect((await linkAndConfirm(token!)).res.status).toBe(302)
    h.sqlite.prepare(`DELETE FROM human_login_identities`).run()
    const again = await redeemTelegramLoginLink(env, {
      tokenHash: (await telegramLoginTokenHash(token!))!, provider: 'google', subject: 'sub-pat', verifiedEmail: EMAIL,
    })
    expect(again).toEqual({ ok: false, error: 'invalid_link' })
    expect(identities()).toEqual([])
    expect(memberId).toBeTruthy()
  })

  it('replay of the link is refused (same browser, another browser, and after the identity is revoked)', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    const first = await linkAndConfirm(token!)
    expect(first.res.status).toBe(302)
    expect((await post(first.jar)).status).toBe(403)
    h.sqlite.prepare(`UPDATE human_login_identities SET revoked_at = datetime('now')`).run()
    expect((await visit(new Map(), `/auth/telegram-link?t=${token}`)).status).toBe(404)
    const again = await signInViaLink(token!, 'sub-replayer', EMAIL).catch(() => null)
    expect(again).toBeNull()
    expect(h.sqlite.prepare(`SELECT 1 FROM human_login_identities WHERE revoked_at IS NULL`).all()).toEqual([])
  })

  it('an expired link is refused at open and at confirm', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    const r = await signInViaLink(token!, 'sub-pat', EMAIL)
    h.sqlite.prepare(`UPDATE telegram_login_links SET expires_at = ?`).run(new Date(Date.now() - 1000).toISOString())
    expect((await post(r.jar)).status).toBe(403)
    expect((await visit(new Map(), `/auth/telegram-link?t=${token}`)).status).toBe(404)
    expect(identities()).toEqual([])
  })

  it('a newer link supersedes the older one', async () => {
    await bornViaTelegram()
    const first = await mintLink()
    const second = await mintLink()
    expect((await visit(new Map(), `/auth/telegram-link?t=${first.token}`)).status).toBe(404)
    expect((await linkAndConfirm(second.token!)).res.status).toBe(302)
  })

  describe('the confirm step is bound to THIS browser and THIS sign-in', () => {
    async function ready() {
      await bornViaTelegram()
      const { token } = await mintLink()
      return { token: token!, ...(await signInViaLink(token!, 'sub-pat', EMAIL)) }
    }
    it('refuses a session minted BEFORE the link was opened', async () => {
      const r = await ready()
      const nonce = jarGet(r.jar, 'mupot_tg_link')!
      const sid = jarGet(r.jar, 'mupot_session')!
      const raw = JSON.parse((await env.SESSIONS.get(`sess:${sid}`))!)
      raw.createdAt = new Date(Date.now() - 3600_000).toISOString()
      await env.SESSIONS.put(`sess:${sid}`, JSON.stringify(raw))
      expect(nonce).toBeTruthy()
      expect((await post(r.jar)).status).toBe(403)
      expect(identities()).toEqual([])
    })
    it('refuses a session whose nonce differs from the cookie nonce', async () => {
      const r = await ready()
      const sid = jarGet(r.jar, 'mupot_session')!
      const raw = JSON.parse((await env.SESSIONS.get(`sess:${sid}`))!)
      raw.tgLinkNonce = 'a'.repeat(48)
      await env.SESSIONS.put(`sess:${sid}`, JSON.stringify(raw))
      expect((await post(r.jar)).status).toBe(403)
    })
    it('refuses without the nonce cookie, and when the server-side link record is gone', async () => {
      const r = await ready()
      const jar2 = new Map(r.jar); jar2.delete('mupot_tg_link')
      expect((await post(jar2)).status).toBe(403)
      await env.SESSIONS.delete(`tglink:${jarGet(r.jar, 'mupot_tg_link')}`)
      expect((await post(r.jar)).status).toBe(403)
      expect(identities()).toEqual([])
    })
    it('a login started with tg=1 but WITHOUT the nonce cookie carries nothing', async () => {
      await bornViaTelegram()
      const jar: Jar = new Map()
      const login = await visit(jar, '/auth/login?tg=1&return=/auth/telegram-link/confirm')
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      await withGoogle('sub-pat', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))
      const sid = jarGet(jar, 'mupot_session')!
      expect(JSON.parse((await env.SESSIONS.get(`sess:${sid}`))!).tgLinkNonce).toBeUndefined()
    })
    it('a callback whose browser lost the nonce cookie mints a session without the nonce', async () => {
      await bornViaTelegram()
      const { token } = await mintLink()
      const jar: Jar = new Map()
      const open = await visit(jar, `/auth/telegram-link?t=${token}`)
      const login = await visit(jar, open.headers.get('location')!)
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      jar.delete('mupot_tg_link')
      await withGoogle('sub-pat', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))
      const sid = jarGet(jar, 'mupot_session')!
      expect(JSON.parse((await env.SESSIONS.get(`sess:${sid}`))!).tgLinkNonce).toBeUndefined()
      expect((await post(jar)).status).toBe(403)
    })
    it('needs a same-origin POST', async () => {
      const r = await ready()
      expect((await post(r.jar, 'https://evil.test')).status).toBe(403)
      expect(identities()).toEqual([])
    })
  })

  describe('OAuth state is bound to the browser on the general login path', () => {
    it('/login sets one HttpOnly SameSite=Lax Secure cookie per state, scoped to the callback path', async () => {
      const a = await authApp.request(`${ORIGIN}/login`, {}, env)
      const b = await authApp.request(`${ORIGIN}/login`, {}, env)
      const stateA = new URL(a.headers.get('location')!).searchParams.get('state')!
      const stateB = new URL(b.headers.get('location')!).searchParams.get('state')!
      const lineA = a.headers.getSetCookie().find((l) => l.startsWith(`mupot_login_state_${stateA}=`))!
      expect(lineA).toBeTruthy()
      expect(lineA).toMatch(/HttpOnly/i)
      expect(lineA).toMatch(/SameSite=Lax/i)
      expect(lineA).toMatch(/Secure/i)
      expect(lineA).toMatch(/Path=\/auth\/callback/i)
      expect(stateA).not.toBe(stateB)
    })
    it('the callback refuses a state with no cookie, a cookie for another state, and a replay; the cookie is single use', async () => {
      const jar: Jar = new Map()
      const login = await visit(jar, '/auth/login')
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      expect((await withGoogle('s', EMAIL, () => visit(new Map(), `/auth/callback?code=c&state=${state}`))).status).toBe(400)
      expect((await withGoogle('s', EMAIL, () => visit(new Map([[`mupot_login_state_${'0'.repeat(48)}`, { value: '1', path: '/' }]]), `/auth/callback?code=c&state=${state}`))).status).toBe(400)
      const ok = await withGoogle('s', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))
      expect(ok.status).toBe(302)
      expect(jar.has(`mupot_login_state_${state}`)).toBe(false)
      const cookieAgain = new Map([[`mupot_login_state_${state}`, { value: '1', path: '/' }]])
      expect((await withGoogle('s', EMAIL, () => visit(cookieAgain, `/auth/callback?code=c&state=${state}`))).status).toBe(400)
    })
    it('a state value that is not one we mint is refused even with a matching cookie', async () => {
      await env.SESSIONS.put('oauthstate:abc', '1')
      const res = await withGoogle('s', EMAIL, () => visit(new Map([['mupot_login_state_abc', { value: '1', path: '/' }]]), '/auth/callback?code=c&state=abc'))
      expect(res.status).toBe(400)
    })
    it('a nonce whose server-side link record expired between login and callback is not stamped on the session', async () => {
      await bornViaTelegram()
      const { token } = await mintLink()
      const jar: Jar = new Map()
      const open = await visit(jar, `/auth/telegram-link?t=${token}`)
      const login = await visit(jar, open.headers.get('location')!)
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      await env.SESSIONS.delete(`tglink:${jarGet(jar, 'mupot_tg_link')}`)
      await withGoogle('sub-pat', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))
      const sid = jarGet(jar, 'mupot_session')!
      expect(JSON.parse((await env.SESSIONS.get(`sess:${sid}`))!).tgLinkNonce).toBeUndefined()
    })
    it('the reauth round trip is bound the same way', async () => {
      await bornViaTelegram()
      const { token } = await mintLink()
      const r = await linkAndConfirm(token!)
      expect(r.res.status).toBe(302)
      const reauth = await visit(r.jar, '/auth/reauth')
      expect(reauth.status).toBe(302)
      const state = new URL(reauth.headers.get('location')!).searchParams.get('state')!
      expect(jarGet(r.jar, `mupot_login_state_${state}`)).toBe('1')
    })
    it('return= accepts only a same-origin path', async () => {
      for (const bad of ['//evil.test/x', 'https://evil.test', '/a/../b', '/\\evil.test', 'javascript:1']) {
        const jar: Jar = new Map()
        const login = await visit(jar, `/auth/login?return=${encodeURIComponent(bad)}`)
        const state = new URL(login.headers.get('location')!).searchParams.get('state')!
        const cb = await withGoogle('s', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))
        expect(cb.headers.get('location')).toBe('/')
      }
      const jar: Jar = new Map()
      const login = await visit(jar, '/auth/login?return=/auth/telegram-link/confirm')
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      expect((await withGoogle('s', EMAIL, () => visit(jar, `/auth/callback?code=c&state=${state}`))).headers.get('location')).toBe('/auth/telegram-link/confirm')
    })
  })

  it('/login only mints inside the authenticated private chat for the chat-bound member', async () => {
    await bornViaTelegram()
    expect(await handleImMessage(env, CHAT, '/login')).not.toContain('/auth/telegram-link')
    expect(await handleImMessage(env, CHAT, '/login', { ...telegramOptions(CHAT), forwarded: true })).not.toContain('/auth/telegram-link')
    expect(await handleImMessage(env, CHAT, '/login', telegramOptions('7777'))).not.toContain('/auth/telegram-link')
    expect((await mintLink('5550000')).token).toBeNull()
    expect(h.sqlite.prepare(`SELECT 1 FROM telegram_login_links`).all()).toEqual([])
  })

  it('/login fence: each condition on its own refuses and writes no link row', async () => {
    await bornViaTelegram()
    const rows = () => h.sqlite.prepare(`SELECT COUNT(*) AS n FROM telegram_login_links`).get() as { n: number }
    // no webhook envelope at all
    expect(await handleImMessage(env, CHAT, '/login')).toMatch(/direct Telegram conversation/)
    expect(rows().n).toBe(0)
    // an envelope for a different Telegram user than the chat
    expect(await handleImMessage(env, CHAT, '/login', telegramOptions('7777'))).toMatch(/direct Telegram conversation/)
    expect(rows().n).toBe(0)
    // forwarded
    expect(await handleImMessage(env, CHAT, '/login', { ...telegramOptions(CHAT), forwarded: true })).not.toContain('/auth/telegram-link')
    expect(rows().n).toBe(0)
    // no pinned origin: refuses rather than emitting a relative link
    const saved = env
    env = { ...env, PUBLIC_ORIGIN: undefined } as unknown as Env
    expect(await handleImMessage(env, CHAT, '/login', telegramOptions(CHAT))).toMatch(/not configured/)
    expect(rows().n).toBe(0)
    env = saved
    // and the happy envelope does mint
    expect((await mintLink()).token).not.toBeNull()
    expect(rows().n).toBe(1)
  })

  it('a member that backs an agent gets no link, and the claim refuses it too', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    h.sqlite.exec(`
      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-x', 'dept-x', 'Dept X');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-x', 'dept-x', 'squad-x', 'Squad X');
      INSERT INTO agents (id, squad_id, slug, name, role, status, created_at) VALUES ('agent-1', 'squad-x', 'a1', 'A1', 'lead', 'active', datetime('now'));
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-1', '${memberId}', datetime('now'));
    `)
    // a link minted BEFORE the binding appeared cannot be confirmed
    expect((await linkAndConfirm(token!)).res.status).toBe(403)
    expect(identities()).toEqual([])
    expect(linkRow()).toEqual({ consumed_at: null })
    // and no new one is minted
    h.sqlite.prepare(`DELETE FROM telegram_login_links`).run()
    const again = await mintLink()
    expect(again.token).toBeNull()
    expect(again.reply).toMatch(/cannot use a web sign-in link/)
    expect(await mintTelegramLoginLink(env, { memberId, chatId: CHAT })).toEqual({ ok: false, error: 'agent_backed' })
  })

  it('/login on a member that already has a web sign-in mints nothing', async () => {
    const memberId = await bornViaTelegram()
    h.sqlite.prepare(`INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('id-existing', ?, 'google', 'sub-first', NULL, ?)`).run(TENANT, memberId)
    expect((await mintLink()).token).toBeNull()
    expect(h.sqlite.prepare(`SELECT 1 FROM telegram_login_links`).all()).toEqual([])
  })

  it('mint refuses a chat that is not bound, and a suspended or archived member', async () => {
    const memberId = await bornViaTelegram()
    expect(await mintTelegramLoginLink(env, { memberId, chatId: '424242' })).toEqual({ ok: false, error: 'not_bound' })
    h.sqlite.prepare(`UPDATE members SET status = 'suspended' WHERE id = ?`).run(memberId)
    expect(await mintTelegramLoginLink(env, { memberId, chatId: CHAT })).toEqual({ ok: false, error: 'not_bound' })
    h.sqlite.prepare(`UPDATE members SET status = 'active', archived_at = datetime('now') WHERE id = ?`).run(memberId)
    expect(await mintTelegramLoginLink(env, { memberId, chatId: CHAT })).toEqual({ ok: false, error: 'not_bound' })
    expect(h.sqlite.prepare(`SELECT 1 FROM telegram_login_links`).all()).toEqual([])
  })

  describe('claim guards (each refusal links nothing)', () => {
    async function armed() {
      const memberId = await bornViaTelegram()
      const { token } = await mintLink()
      const r = await signInViaLink(token!, 'sub-pat', EMAIL)
      return { memberId, token: token!, ...r }
    }
    it('refuses an unverified-email provider even with a valid link', async () => {
      const { token } = await (async () => { await bornViaTelegram(); return mintLink() })()
      const hash = (await telegramLoginTokenHash(token!))!
      for (const provider of ['local-test', 'bootstrap']) {
        expect(await redeemTelegramLoginLink(env, { tokenHash: hash, provider, subject: 'x', verifiedEmail: EMAIL })).toEqual({ ok: false, error: 'unverified_provider' })
      }
      expect(identities()).toEqual([])
    })
    it('refuses when the chat was unbound or rebound after minting', async () => {
      const a = await armed()
      h.sqlite.prepare(`UPDATE members SET telegram_chat_id = '123' WHERE id = ?`).run(a.memberId)
      expect((await post(a.jar)).status).toBe(403)
      h.sqlite.prepare(`UPDATE members SET telegram_chat_id = NULL WHERE id = ?`).run(a.memberId)
      expect((await post(a.jar)).status).toBe(403)
      expect(identities()).toEqual([])
    })
    it('refuses a suspended or archived member', async () => {
      const a = await armed()
      h.sqlite.prepare(`UPDATE members SET status = 'suspended' WHERE id = ?`).run(a.memberId)
      expect((await post(a.jar)).status).toBe(403)
      h.sqlite.prepare(`UPDATE members SET status = 'active', archived_at = datetime('now') WHERE id = ?`).run(a.memberId)
      expect((await post(a.jar)).status).toBe(403)
      expect(identities()).toEqual([])
    })
    it('refuses a member that now lives in another tenant', async () => {
      const a = await armed()
      h.sqlite.prepare(`UPDATE members SET tenant = 'elsewhere' WHERE id = ?`).run(a.memberId)
      expect((await post(a.jar)).status).toBe(403)
      expect(identities()).toEqual([])
    })
    it('refuses a link row from another tenant', async () => {
      const a = await armed()
      h.sqlite.prepare(`UPDATE telegram_login_links SET tenant = 'elsewhere'`).run()
      expect((await post(a.jar)).status).toBe(403)
      expect(identities()).toEqual([])
      expect(linkRow()).toEqual({ consumed_at: null })
    })
    it('refuses a live competing unbound bearer (liveCompetingBearerSql) without burning the link; a revoked one does not compete', async () => {
      const a = await armed()
      h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('tok-squat', ?, 'hash-squat', 'workspace', 'workspace', datetime('now'), NULL, ?)`).run(a.memberId, TENANT)
      expect((await post(a.jar)).status).toBe(403)
      expect(identities()).toEqual([])
      expect(linkRow()).toEqual({ consumed_at: null })
      h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = 'tok-squat'`).run()
      expect((await post(a.jar)).status).toBe(302)
    })
    it('refuses when the member already has a live identity, and when the confirming identity is bound elsewhere', async () => {
      const a = await armed()
      h.sqlite.prepare(`INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('id-existing', ?, 'google', 'sub-first', NULL, ?)`).run(TENANT, a.memberId)
      expect((await post(a.jar)).status).toBe(403)
      expect(identities()).toHaveLength(1)
      h.sqlite.prepare(`UPDATE human_login_identities SET revoked_at = datetime('now')`).run()
      h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-other', 'o@x.test', 'O', 'active', '${TENANT}');
        INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('id-other', '${TENANT}', 'google', 'sub-pat', NULL, 'member-other')`)
      expect((await post(a.jar)).status).toBe(403)
      expect(h.sqlite.prepare(`SELECT member_id FROM human_login_identities WHERE provider_subject = 'sub-pat'`).get()).toEqual({ member_id: 'member-other' })
    })
    it('a UNIQUE conflict is a refusal (403); any other D1 fault is a 503 and never a refusal', async () => {
      const a = await armed()
      const realBatch = env.DB.batch.bind(env.DB)
      env.DB.batch = (async () => { throw new Error('D1_ERROR: network connection lost') }) as typeof env.DB.batch
      expect((await post(a.jar)).status).toBe(503)
      env.DB.batch = (async () => { throw new Error('UNIQUE constraint failed: human_login_identities.tenant, human_login_identities.provider, human_login_identities.provider_subject') }) as typeof env.DB.batch
      expect((await post(a.jar)).status).toBe(403)
      env.DB.batch = realBatch
      expect((await post(a.jar)).status).toBe(302)
    })
  })

  describe('under a path-routed tenant (/t/local)', () => {
    beforeEach(() => {
      PFX = '/t/local'
      env = { ...env, PUBLIC_ORIGIN: `${ORIGIN}${PFX}` } as unknown as Env
    })
    afterEach(() => { PFX = '' })

    it('the state cookie is scoped to the PREFIXED callback path, and a full login -> callback round trip works with a Path-respecting jar', async () => {
      const jar: Jar = new Map()
      const login = await visit(jar, '/auth/login')
      expect(login.status).toBe(302)
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      expect(login.headers.get('location')).toContain(encodeURIComponent(`${ORIGIN}/t/local/auth/callback`))
      expect(jar.get(`mupot_login_state_${state}`)?.path).toBe('/t/local/auth/callback')
      const cb = await withGoogle('sub-x', 'someone@example.test', () => visit(jar, `/auth/callback?code=c&state=${state}`))
      expect(cb.status).toBe(302)
      expect(jarGet(jar, 'mupot_session')).toBeTruthy()
      expect(jar.has(`mupot_login_state_${state}`)).toBe(false)
    })

    it('a callback for a forwarded state is still refused under the prefix (no bypass)', async () => {
      const attacker: Jar = new Map()
      const login = await visit(attacker, '/auth/login')
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      const victim: Jar = new Map()
      expect((await withGoogle('s', EMAIL, () => visit(victim, `/auth/callback?code=c&state=${state}`))).status).toBe(400)
      expect(victim.has('mupot_session')).toBe(false)
    })

    it('the whole Telegram link round trip works under the prefix (nonce cookie reaches every /auth route)', async () => {
      const memberId = await bornViaTelegram()
      const { reply, token } = await mintLink()
      expect(reply).toContain(`${ORIGIN}/t/local/auth/telegram-link?t=`)
      const { jar, landed } = await signInViaLink(token!, 'sub-pat', EMAIL)
      expect(jar.get('mupot_tg_link')?.path ?? null).not.toBeNull()
      expect(landed).toBe('/auth/telegram-link/confirm')
      expect((await post(jar)).status).toBe(302)
      expect(identities()).toEqual([{ provider: 'google', provider_subject: 'sub-pat', member_id: memberId }])
    })

    it('the nonce cookie Path is the prefixed /auth base (not the bare /auth the browser would never send)', async () => {
      await bornViaTelegram()
      const { token } = await mintLink()
      const jar: Jar = new Map()
      await visit(jar, `/auth/telegram-link?t=${token}`)
      expect(jar.get('mupot_tg_link')?.path).toBe('/t/local/auth')
    })
  })

  describe('through the apex strip (resolveApexPathTenant + withTenantPrefix), not the tenant handler directly', () => {
    const root = new Hono().route('/auth', authApp)
    async function viaApex(jar: Jar, path: string, init: RequestInit = {}): Promise<Response> {
      const original = new Request(`${ORIGIN}/t/local${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...(cookieHeader(jar, `/t/local${path.split('?')[0]}`) ? { cookie: cookieHeader(jar, `/t/local${path.split('?')[0]}`) } : {}) },
      })
      const route = resolveApexPathTenant(original, 'local')
      if (route?.kind !== 'home') throw new Error('home route expected')
      const res = await withTenantPrefix(original, { TENANT_SLUG: 'local' }, () => root.fetch(route.request, env))
      absorb(jar, res)
      return res
    }
    it('a pinned path-tenant pot: state cookie Path is the browser-visible /t/local/auth/callback, Location is re-rooted, and the callback receives the cookie', async () => {
      env = { ...env, PUBLIC_ORIGIN: `${ORIGIN}/t/local` } as unknown as Env
      const jar: Jar = new Map()
      const login = await viaApex(jar, '/auth/login?return=/auth/telegram-link/confirm')
      expect(login.status).toBe(302)
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!
      expect(jar.get(`mupot_login_state_${state}`)?.path).toBe('/t/local/auth/callback')
      const cb = await withGoogle('sub-x', 'x@example.test', () => viaApex(jar, `/auth/callback?code=c&state=${state}`))
      expect(cb.status).toBe(302)
      expect(cb.headers.get('location')).toBe('/t/local/auth/telegram-link/confirm')
      expect(jarGet(jar, 'mupot_session')).toBeTruthy()
    })
    it('the Telegram link open sets the nonce cookie at the browser-visible /t/local/auth and redirects under the prefix', async () => {
      env = { ...env, PUBLIC_ORIGIN: `${ORIGIN}/t/local` } as unknown as Env
      await bornViaTelegram()
      const { token } = await mintLink()
      const jar: Jar = new Map()
      const open = await viaApex(jar, `/auth/telegram-link?t=${token}`)
      expect(open.status).toBe(302)
      expect(jar.get('mupot_tg_link')?.path).toBe('/t/local/auth')
      expect(open.headers.get('location')).toBe('/t/local/auth/login?tg=1&return=/auth/telegram-link/confirm')
    })
  })

  describe('login started on a host other than the pinned PUBLIC_ORIGIN host', () => {
    it('/login, /reauth-less entry points and the link open move the browser to the pinned host first (same path and query), setting no cookie', async () => {
      const jar: Jar = new Map()
      const res = await visit(jar, '/auth/login?return=/auth/telegram-link/confirm', {}, 'alias.workers.dev')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(`${ORIGIN}/login?return=/auth/telegram-link/confirm`)  // authApp is mounted at /auth in prod; the harness sees the stripped path
      expect(jar.size).toBe(0)
      await bornViaTelegram()
      const { token } = await mintLink()
      const open = await visit(jar, `/auth/telegram-link?t=${token}`, {}, 'alias.workers.dev')
      expect(open.status).toBe(302)
      expect(open.headers.get('location')).toBe(`${ORIGIN}/telegram-link?t=${token}`)
      expect(jar.size).toBe(0)
    })
    it('/reauth on another host also moves to the pinned host', async () => {
      await bornViaTelegram()
      const { token } = await mintLink()
      const r = await linkAndConfirm(token!)
      expect(r.res.status).toBe(302)
      const res = await visit(r.jar, '/auth/reauth', {}, 'alias.workers.dev')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(`${ORIGIN}/reauth`)
    })
    it('a path-tenant pinned origin keeps its prefix on the redirect', async () => {
      env = { ...env, PUBLIC_ORIGIN: `${ORIGIN}/t/local` } as unknown as Env
      const res = await visit(new Map(), '/auth/login', {}, 'alias.workers.dev')
      expect(res.headers.get('location')).toBe(`${ORIGIN}/t/local/login`)
    })
    it('on the pinned host there is no redirect', async () => {
      expect((await visit(new Map(), '/auth/login')).headers.get('location')).toContain('accounts.google.com')
    })
  })
})
