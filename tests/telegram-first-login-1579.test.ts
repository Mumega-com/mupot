// mupot#1579 — a Telegram-first member gets a web login by PROOF OF CONTROL (a link minted inside the authenticated
// chat), never by email or name match. Real flow: member born through the real Telegram invite redeem, link minted
// through the real `/login` command, confirmed through the real authApp routes with real cookie sessions.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { handleImMessage } from '../src/im'
import { mintTelegramLoginLink } from '../src/auth/telegram-login-link'
import { createProjectInvite } from '../src/members/project-invites'
import { decideIdentitylessAttach } from '../src/members/exclusive-control'
import { resolveHumanMemberId } from '../src/members/resolve-human-member'
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
    env = { DB: h.db, TENANT_SLUG: TENANT, BRAND: 'Test Pot', PUBLIC_ORIGIN: ORIGIN, SESSIONS: kv() } as unknown as Env
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

  function confirm(token: string, sid: string | null, origin = ORIGIN) {
    return authApp.request(`${ORIGIN}/telegram-link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded', origin,
        ...(sid ? { cookie: `mupot_session=${sid}` } : {}),
      },
      body: new URLSearchParams({ t: token }).toString(),
    }, env)
  }

  const identities = () => h.sqlite.prepare(`SELECT provider, provider_subject, member_id FROM human_login_identities`).all()

  it('REPRO: the Telegram-born member is locked out of web login by email alone (the lockout #1579 filed)', async () => {
    const memberId = await bornViaTelegram()
    expect(h.sqlite.prepare(`SELECT 1 FROM human_login_identities`).all()).toEqual([])
    expect(await decideIdentitylessAttach(env, { tenant: TENANT, normalizedEmail: EMAIL }))
      .toEqual({ kind: 'denied_competing_control', reason: 'telegram_bound' })
    expect(await resolveHumanMemberId(env, { tenant: TENANT, provider: 'google', providerSubject: 'sub-pat', email: EMAIL })).toBeNull()
    const sid = await sessionFor('google', 'sub-pat', EMAIL)
    const me = (await (await authApp.request('/me', { headers: { cookie: `mupot_session=${sid}` } }, env)).json()) as { webSessionMemberId?: string }
    expect(me.webSessionMemberId).toBeUndefined()
    expect(memberId).toBeTruthy()
  })

  it('an attacker whose verified email MATCHES cannot take the Telegram member (no token, wrong token, no link at all)', async () => {
    const memberId = await bornViaTelegram()
    const attacker = await sessionFor('google', 'sub-attacker', EMAIL)
    expect((await confirm('f'.repeat(64), attacker)).status).toBe(403)
    expect((await confirm('not-a-token', attacker)).status).toBe(403)
    // A real link exists for the member, but the attacker does not have it: a guessed neighbour token is refused.
    const { token } = await mintLink()
    expect(token).not.toBeNull()
    const guess = token!.slice(0, 63) + (token!.endsWith('0') ? '1' : '0')
    expect((await confirm(guess, attacker)).status).toBe(403)
    expect(identities()).toEqual([])
    const me = (await (await authApp.request('/me', { headers: { cookie: `mupot_session=${attacker}` } }, env)).json()) as { webSessionMemberId?: string }
    expect(me.webSessionMemberId).toBeUndefined()
    expect(memberId).toBeTruthy()
  })

  it('happy path: /login in the chat -> open link -> sign in -> confirm links that identity; web session and the resolver now resolve the member', async () => {
    const memberId = await bornViaTelegram()
    const { reply, token } = await mintLink()
    expect(token).not.toBeNull()
    expect(reply).toContain(`${ORIGIN}/auth/telegram-link?t=`)
    // stored hashed, never plaintext
    const stored = h.sqlite.prepare(`SELECT token_hash FROM telegram_login_links`).all() as Array<{ token_hash: string }>
    expect(stored).toHaveLength(1)
    expect(stored[0].token_hash).not.toBe(token)

    const sid = await sessionFor('google', 'sub-pat', 'pat@gmail.test')
    const page = await authApp.request(`${ORIGIN}/telegram-link?t=${token}`, { headers: { cookie: `mupot_session=${sid}` } }, env)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Connect')
    const res = await confirm(token!, sid)
    expect(res.status).toBe(302)
    expect(identities()).toEqual([{ provider: 'google', provider_subject: 'sub-pat', member_id: memberId }])
    const me = (await (await authApp.request('/me', { headers: { cookie: `mupot_session=${sid}` } }, env)).json()) as { webSessionMemberId?: string }
    expect(me.webSessionMemberId).toBe(memberId)
    expect(await resolveHumanMemberId(env, { tenant: TENANT, provider: 'google', providerSubject: 'sub-pat', email: 'other@x.test' }))
      .toBe(memberId)
  })

  it('replay of the link is refused (same session, and a different session)', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    const sid = await sessionFor('google', 'sub-pat', 'pat@gmail.test')
    expect((await confirm(token!, sid)).status).toBe(302)
    expect((await confirm(token!, sid)).status).toBe(403)
    const other = await sessionFor('google', 'sub-replayer', 'r@x.test')
    expect((await confirm(token!, other)).status).toBe(403)
    expect(identities()).toHaveLength(1)
    const page = await authApp.request(`${ORIGIN}/telegram-link?t=${token}`, { headers: { cookie: `mupot_session=${other}` } }, env)
    expect(page.status).toBe(404)
  })

  it('an expired link is refused and links nothing', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    h.sqlite.prepare(`UPDATE telegram_login_links SET expires_at = ?`).run(new Date(Date.now() - 1000).toISOString())
    const sid = await sessionFor('google', 'sub-pat', 'pat@gmail.test')
    expect((await confirm(token!, sid)).status).toBe(403)
    expect((await authApp.request(`${ORIGIN}/telegram-link?t=${token}`, { headers: { cookie: `mupot_session=${sid}` } }, env)).status).toBe(404)
    expect(identities()).toEqual([])
  })

  it('a newer link supersedes the older one', async () => {
    await bornViaTelegram()
    const first = await mintLink()
    const second = await mintLink()
    const sid = await sessionFor('google', 'sub-pat', null)
    expect((await confirm(first.token!, sid)).status).toBe(403)
    expect((await confirm(second.token!, sid)).status).toBe(302)
  })

  it('/login only mints inside the authenticated private chat for the chat-bound member', async () => {
    await bornViaTelegram()
    // no webhook envelope (forwarded/direct-call shape)
    expect(await handleImMessage(env, CHAT, '/login')).not.toContain('/auth/telegram-link')
    // forwarded
    expect(await handleImMessage(env, CHAT, '/login', { ...telegramOptions(CHAT), forwarded: true })).not.toContain('/auth/telegram-link')
    // envelope whose Telegram user is not the chat
    const spoof = telegramOptions('7777')
    expect(await handleImMessage(env, CHAT, '/login', spoof)).not.toContain('/auth/telegram-link')
    // an unbound chat gets nothing
    expect((await mintLink('5550000')).token).toBeNull()
    expect(h.sqlite.prepare(`SELECT 1 FROM telegram_login_links`).all()).toEqual([])
  })

  it('refuses an unverified-email provider (local-test / bootstrap) even with a valid link', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    for (const provider of ['local-test', 'bootstrap']) {
      expect((await confirm(token!, await sessionFor(provider, 'x', EMAIL))).status).toBe(403)
    }
    expect(identities()).toEqual([])
    // refusal did not burn the link
    expect((await confirm(token!, await sessionFor('google', 'sub-pat', null))).status).toBe(302)
  })

  it('refuses when the chat was unbound or rebound after minting', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    h.sqlite.prepare(`UPDATE members SET telegram_chat_id = '123' WHERE id = ?`).run(memberId)
    expect((await confirm(token!, await sessionFor('google', 'sub-pat', null))).status).toBe(403)
    h.sqlite.prepare(`UPDATE members SET telegram_chat_id = NULL WHERE id = ?`).run(memberId)
    expect((await confirm(token!, await sessionFor('google', 'sub-pat', null))).status).toBe(403)
    expect(identities()).toEqual([])
  })

  it('refuses a suspended or archived member', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    h.sqlite.prepare(`UPDATE members SET status = 'suspended' WHERE id = ?`).run(memberId)
    expect((await confirm(token!, await sessionFor('google', 'sub-pat', null))).status).toBe(403)
    h.sqlite.prepare(`UPDATE members SET status = 'active', archived_at = datetime('now') WHERE id = ?`).run(memberId)
    expect((await confirm(token!, await sessionFor('google', 'sub-pat', null))).status).toBe(403)
    expect(identities()).toEqual([])
  })

  it('refuses when a live competing unbound bearer holds the row (exclusive control, liveCompetingBearerSql), and does not burn the link', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    h.sqlite.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
       VALUES ('tok-squat', ?, 'hash-squat', 'workspace', 'workspace', datetime('now'), NULL, ?)`,
    ).run(memberId, TENANT)
    const sid = await sessionFor('google', 'sub-pat', null)
    expect((await confirm(token!, sid)).status).toBe(403)
    expect(identities()).toEqual([])
    expect(h.sqlite.prepare(`SELECT consumed_at FROM telegram_login_links`).get()).toEqual({ consumed_at: null })
    // a REVOKED bearer is not competing control
    h.sqlite.prepare(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = 'tok-squat'`).run()
    expect((await confirm(token!, sid)).status).toBe(302)
  })

  it('refuses when the member already has a live login identity, and when the confirming identity is already bound elsewhere', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    h.sqlite.prepare(
      `INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
       VALUES ('id-existing', ?, 'google', 'sub-first', NULL, ?)`,
    ).run(TENANT, memberId)
    expect((await confirm(token!, await sessionFor('google', 'sub-second', null))).status).toBe(403)
    expect(identities()).toHaveLength(1)

    // identity bound to ANOTHER member can never be re-pointed at the Telegram member
    h.sqlite.prepare(`UPDATE human_login_identities SET revoked_at = datetime('now')`).run()
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-other', 'o@x.test', 'O', 'active', '${TENANT}');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('id-other', '${TENANT}', 'google', 'sub-other', NULL, 'member-other')`)
    expect((await confirm(token!, await sessionFor('google', 'sub-other', null))).status).toBe(403)
    expect(h.sqlite.prepare(`SELECT member_id FROM human_login_identities WHERE provider_subject = 'sub-other'`).get()).toEqual({ member_id: 'member-other' })
  })

  it('/login on a member that already has a web sign-in mints nothing', async () => {
    const memberId = await bornViaTelegram()
    h.sqlite.prepare(
      `INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
       VALUES ('id-existing', ?, 'google', 'sub-first', NULL, ?)`,
    ).run(TENANT, memberId)
    const { token } = await mintLink()
    expect(token).toBeNull()
    expect(h.sqlite.prepare(`SELECT 1 FROM telegram_login_links`).all()).toEqual([])
  })

  it('a consumed link stays dead even after the identity it created is revoked (single use is its own guard)', async () => {
    const memberId = await bornViaTelegram()
    const { token } = await mintLink()
    expect((await confirm(token!, await sessionFor('google', 'sub-pat', null))).status).toBe(302)
    h.sqlite.prepare(`UPDATE human_login_identities SET revoked_at = datetime('now')`).run()
    expect((await confirm(token!, await sessionFor('google', 'sub-replayer', null))).status).toBe(403)
    expect(h.sqlite.prepare(`SELECT provider_subject FROM human_login_identities WHERE revoked_at IS NULL`).all()).toEqual([])
    expect(memberId).toBeTruthy()
  })

  it('mint refuses a chat that is not the member\'s bound chat', async () => {
    const memberId = await bornViaTelegram()
    expect(await mintTelegramLoginLink(env, { memberId, chatId: '424242' })).toEqual({ ok: false, error: 'not_bound' })
    expect(h.sqlite.prepare(`SELECT 1 FROM telegram_login_links`).all()).toEqual([])
  })

  it('needs a session and a same-origin POST', async () => {
    await bornViaTelegram()
    const { token } = await mintLink()
    expect((await confirm(token!, null)).status).toBe(403)
    const sid = await sessionFor('google', 'sub-pat', null)
    expect((await confirm(token!, sid, 'https://evil.test')).status).toBe(403)
    expect(identities()).toEqual([])
    const unsigned = await authApp.request(`${ORIGIN}/telegram-link?t=${token}`, {}, env)
    expect(unsigned.status).toBe(200)
    expect(await unsigned.text()).toContain('Sign in first')
  })
})
