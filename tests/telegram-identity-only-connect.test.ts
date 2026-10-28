import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createIdentityOnlyInvite, createProjectInvite, redeemTelegramProjectInvite } from '../src/members/project-invites'
import { acceptInvite, membersApp } from '../src/members'
import { inviteApp, loadInviteLanding } from '../src/dashboard/invite'
import { loadInviteLinkAuthority } from '../src/auth/pending-invite-link'
import { telegramSectionBody } from '../src/dashboard/account'
import { runInbound } from '../src/channels'
import { handleImMessage, imApp } from '../src/im'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const digest = 'c'.repeat(64)
describe('identity-only Telegram self-connect', () => {
  let h: SqliteD1Harness
  let env: Env
  const auth = (extra: Partial<AuthContext> = {}): AuthContext => ({
    userId: 'self', email: 'self@x.test', role: 'member', tenant: 'local', memberId: 'self',
    channel: 'dashboard', webSessionIdHash: 'session-self', webSessionMemberId: 'self', capabilities: [], ...extra,
  })
  const mint = (a = auth(), member = 'self') => createIdentityOnlyInvite(env, a, { member_id: member })
  const redeem = (code: string, telegram = '90001', update = 'u1') => {
    h.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
      VALUES ('local', ?, ?, ?, 'processing', datetime('now'))`).run(update, telegram, digest)
    return redeemTelegramProjectInvite(env, { pairing_code: code, telegram_user_id: telegram, display_name: 'Self', update_id: update, request_digest: digest })
  }
  const authority = () => Object.fromEntries(['capabilities', 'memberships', 'project_squad_access', 'members', 'squads', 'departments'].map((t) =>
    [t, h.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()]))
  beforeEach(() => {
    h = createSqliteD1()
    applyAllMigrations(h.sqlite)
    env = { DB: h.db, TENANT_SLUG: 'local', BRAND: 'Test Pot' } as Env
    h.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('self','self@x.test','Self','active','local'), ('other','other@x.test','Other','active','local');
      INSERT INTO departments (id, slug, name, kind) VALUES ('home-dept','home-dept','Home','home');
      INSERT INTO squads (id, slug, name, department_id, kind) VALUES ('home','home','Home','home-dept','home');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('home-cap','self','squad','home','admin');
      INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
        VALUES ('ident-self','local','local-test','self','self@x.test','self',datetime('now'));
      INSERT INTO web_sessions (id_hash, tenant, member_id, login_identity_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, recent_reauth_at)
        VALUES ('session-self','local','self','ident-self',datetime('now'),datetime('now'),datetime('now','+1 day'),datetime('now','+7 days'),datetime('now'));
    `)
  })
  afterEach(() => h.close())
  it('redeems identity with zero capability, membership, project-link or member additions and completes the bind receipt', async () => {
    const before = authority()
    const created = await mint()
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(Date.parse(created.value.invite.pairing_expires_at) - Date.parse(created.value.invite.created_at)).toBe(86400000)
    const row = h.sqlite.prepare('SELECT invite_kind, project_id, squad_id, department_id FROM invites').get()
    expect(row).toEqual({ invite_kind: 'identity_only', project_id: null, squad_id: null, department_id: null })
    const result = await redeem(created.value.pairing_code)
    const after = authority()
    for (const table of ['capabilities', 'memberships', 'project_squad_access', 'squads', 'departments']) {
      expect(after[table]).toHaveLength(before[table].length)
      expect(after[table]).toEqual(before[table])
    }
    expect(result).toEqual({ ok: true, value: { member_id: 'self', project_id: null, squad_id: null, capability: 'observer', identity_only: true } })
    expect(after.members).toHaveLength(before.members.length)
    expect(h.sqlite.prepare("SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id='self'").get()).toEqual({ telegram_chat_id: '90001', telegram_bound_at: expect.any(String) })
    expect(h.sqlite.prepare('SELECT state, response_text FROM telegram_webhook_receipts').get()).toEqual({ state: 'completed', response_text: expect.stringContaining('"identity_only":true') })
    expect(await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: '90001', display_name: 'Self', update_id: 'u1', request_digest: digest })).toMatchObject({ ok: true })
    expect(await redeem(created.value.pairing_code, '90001', 'u2')).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
  })
  it('offers the identity-only account action for a home-only member', async () => {
    const body = String(await telegramSectionBody(env, auth()))
    expect(body).toContain('Connect Telegram (sign-in and notifications only)')
    expect(body).toContain('identity_only')
    expect(body).toContain('No squad or project access is granted')
  })
  it.each(['member', 'admin', 'owner'] as const)('refuses another member even for role %s', async (role) => {
    expect(await mint(auth({ role }), 'other')).toEqual({ ok: false, error: 'forbidden' })
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM invites').get()).toEqual({ n: 0 })
  })
  it('requires a fresh live web session', async () => {
    h.sqlite.exec("UPDATE web_sessions SET recent_reauth_at=datetime('now','-1 day')")
    expect(await mint()).toEqual({ ok: false, error: 'reauth_required' })
  })
  it.each([{ channel: 'mcp' }, { boundAgentId: 'agent' }, { seatBinding: {} }, { webSessionIdHash: undefined }])('refuses a non-human dashboard context %j', async (extra) => {
    expect(await mint(auth(extra as Partial<AuthContext>))).toEqual({ ok: false, error: 'forbidden' })
  })
  it.each(['target', 'reverse'])('retains Telegram identity conflict checks: %s', async (side) => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    h.sqlite.prepare('UPDATE members SET telegram_chat_id=? WHERE id=?').run(side === 'target' ? '90002' : '90001', side === 'target' ? 'self' : 'other')
    expect(await redeem(created.value.pairing_code)).toEqual({ ok: false, error: 'telegram_identity_conflict' })
    expect(h.sqlite.prepare('SELECT accepted_at FROM invites').get()).toEqual({ accepted_at: null })
  })
  it('keeps grant-bearing home invitations refused', async () => {
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('p','p','P','active');
      INSERT INTO project_squad_access (project_id,squad_id,access_level) VALUES ('p','home','write');`)
    expect(await createProjectInvite(env, auth({ role: 'owner' }), { member_id: 'self', project_id: 'p', squad_id: 'home', capability: 'observer', expires_in_seconds: 86400 })).toEqual({ ok: false, error: 'home_scope_not_invitable' })
  })
  it('cannot redeem through JSON/web accept or the login-link authority reader before or after binding', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    const id = created.value.invite.id
    expect(await acceptInvite(env, id, 'Self')).toEqual({ ok: false, error: 'project_invite_requires_telegram' })
    const response = await membersApp.request(`/invites/${id}/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'Self' }) }, env)
    expect(response.status).toBe(409)
    expect(await loadInviteLanding(env, id)).toMatchObject({ kind: 'telegram_only' })
    const webAccept = await inviteApp.request(`/${id}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' }, body: 'display_name=Self' }, env)
    expect(webAccept.status).toBe(409)
    expect(await loadInviteLinkAuthority(env, id)).toBeNull()
    expect((await redeem(created.value.pairing_code)).ok).toBe(true)
    expect(await loadInviteLinkAuthority(env, id)).toBeNull()
    expect(await acceptInvite(env, id, 'Self')).toEqual({ ok: false, error: 'project_invite_requires_telegram' })
  })
  it('the /start path binds without provisioning any squad or capability', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    h.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
      VALUES ('local','u-start','90001',?,'processing',datetime('now'))`).run(digest)
    const before = authority()
    const reply = await handleImMessage(env, '90001', `/start ${created.value.pairing_code}`, { telegram: { telegram_user_id: '90001', update_id: 'u-start', request_digest: digest } })
    expect(reply).toContain('Telegram connected')
    expect(reply).not.toContain('Joined project')
    for (const table of ['capabilities', 'memberships', 'project_squad_access', 'squads', 'departments']) expect(authority()[table]).toEqual(before[table])
  })
  it('is identity-only for a member with no standing at all', async () => {
    h.sqlite.exec('DELETE FROM capabilities')
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    expect((await redeem(created.value.pairing_code)).ok).toBe(true)
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM capabilities').get()).toEqual({ n: 0 })
  })
  it.each(['status', 'tenant', 'archived_at'])('claim refuses a changed member %s without consuming the invite', async (column) => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    const value = column === 'status' ? 'suspended' : column === 'tenant' ? 'other' : new Date().toISOString()
    h.sqlite.prepare(`UPDATE members SET ${column}=? WHERE id='self'`).run(value)
    expect(await redeem(created.value.pairing_code)).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
    expect(h.sqlite.prepare('SELECT accepted_at FROM invites').get()).toEqual({ accepted_at: null })
    expect(h.sqlite.prepare('SELECT state FROM telegram_webhook_receipts').get()).toEqual({ state: 'processing' })
  })
  it('requires the reserved Telegram receipt', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    expect(await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: '90001', display_name: 'Self', update_id: 'missing', request_digest: digest }))
      .toEqual({ ok: false, error: 'update_receipt_invalid' })
    expect(h.sqlite.prepare('SELECT accepted_at FROM invites').get()).toEqual({ accepted_at: null })
  })
  it.each([
    "invite_kind='grant'", "member_id='other', minted_by_member_id='other', invited_by='other'",
    "capability='owner'", "squad_id='home'", "department_id='home-dept'", "pairing_hash=NULL", "pairing_expires_at=NULL",
  ])('schema refuses repurposing identity-only pairing: %s', async (assignment) => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    expect(() => h.sqlite.exec(`UPDATE invites SET ${assignment}`)).toThrow()
    expect((await redeem(created.value.pairing_code)).ok).toBe(true)
  })
  it('the real authenticated private webhook and its duplicate replay report identity connection without authority additions', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    const before = authority()
    env.IM_WEBHOOK_SECRET = 'test-webhook-secret'
    const post = () => imApp.request('/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'test-webhook-secret' },
      body: JSON.stringify({ update_id: 12345, message: { from: { id: 90001, first_name: 'Self' }, chat: { id: 90001, type: 'private' }, text: `/start ${created.value.pairing_code}` } }) }, env)
    const first = await post()
    expect(first.status).toBe(200)
    const result = await first.json()
    expect(result).toMatchObject({ ok: true, bound: true, member_id: 'self', reply: expect.stringContaining('Telegram connected') })
    expect(await (await post()).json()).toEqual(result)
    for (const table of ['capabilities', 'memberships', 'project_squad_access', 'squads', 'departments']) expect(authority()[table]).toEqual(before[table])
  })

  it('the separate channel /link door cannot consume an identity-only pairing code', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    h.sqlite.exec("INSERT INTO channel_bindings (id, platform, external_channel_id, squad_id) VALUES ('binding','telegram','chat','home')")
    const before = authority()
    expect(await runInbound(env, 'telegram', 'chat', '90001', `/link ${created.value.pairing_code}`)).toContain('invalid or has expired')
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM member_identities').get()).toEqual({ n: 0 })
    expect(h.sqlite.prepare('SELECT accepted_at FROM invites').get()).toEqual({ accepted_at: null })
    for (const table of ['capabilities', 'memberships', 'project_squad_access']) expect(authority()[table]).toEqual(before[table])
    expect((await redeem(created.value.pairing_code)).ok).toBe(true)
  })

})
