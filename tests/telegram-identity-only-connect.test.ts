import { createHash } from 'node:crypto'
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
  const disconnect = async () => {
    h.sqlite.prepare("UPDATE web_sessions SET id_hash=? WHERE id_hash='session-self'").run(createHash('sha256').update('disconnect').digest('hex'))
    const session = JSON.stringify({ ...auth(), webSessionRegistered: true, createdAt: new Date().toISOString() })
    const disconnectEnv = { ...env, SESSIONS: {
      get: async (key: string) => key === 'sess:disconnect' ? session : null,
      put: async () => undefined, delete: async () => undefined,
    } } as unknown as Env
    return membersApp.request('/members/self/telegram', {
      method: 'DELETE', headers: { 'content-type': 'application/json', cookie: 'mupot_session=disconnect' },
    }, disconnectEnv)
  }
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
  it('normalizes the identity-only invite email before storing it', async () => {
    h.sqlite.exec("UPDATE members SET email='  Self@X.Test  ' WHERE id='self'")
    expect((await mint()).ok).toBe(true)
    expect(h.sqlite.prepare('SELECT email FROM invites').get()).toEqual({ email: 'self@x.test' })
  })
  it('claim refuses an agent-bound member without consuming the invite', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('agent-self','home','agent-self','Agent','r','m','active');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('local','agent-self','self',datetime('now'));`)
    expect(await redeem(created.value.pairing_code)).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
    expect(h.sqlite.prepare('SELECT accepted_at FROM invites').get()).toEqual({ accepted_at: null })
    expect(h.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id='self'").get()).toEqual({ telegram_chat_id: null })
    expect(h.sqlite.prepare('SELECT state FROM telegram_webhook_receipts').get()).toEqual({ state: 'processing' })
  })
  it('schema refuses a raw malformed identity-only insert', () => {
    h.sqlite.exec("INSERT INTO projects (id,slug,name,status) VALUES ('p','p','P','active')")
    expect(() => h.sqlite.prepare(`INSERT INTO invites
      (id,email,capability,invited_by,created_at,member_id,minted_by_member_id,project_id,pairing_hash,pairing_expires_at,invite_kind)
      VALUES ('bad','self@x.test','owner','other',datetime('now'),'self','other','p',?,datetime('now','+1 day'),'identity_only')`)
      .run('a'.repeat(64))).toThrow(/invalid identity-only invite/)
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM invites').get()).toEqual({ n: 0 })
  })
  it('schema refuses INSERT OR REPLACE with NULL kind and an invalid grant shape', () => {
    expect(() => h.sqlite.exec(`INSERT OR REPLACE INTO invites
      (id,email,capability,invited_by,created_at,member_id,invite_kind)
      VALUES ('bad-null','self@x.test','observer','self',datetime('now'),'self',NULL)`))
      .toThrow(/project invite member bind requires the full project field set/)
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM invites').get()).toEqual({ n: 0 })
  })
  it('schema refuses UPDATE OR REPLACE to NULL kind on an identity-only row', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    expect(() => h.sqlite.exec('UPDATE OR REPLACE invites SET invite_kind=NULL')).toThrow(/invite kind is immutable/)
    expect((await redeem(created.value.pairing_code)).ok).toBe(true)
  })
  it('disconnect expires outstanding identity-only codes so they cannot rebind', async () => {
    const accepted = await mint()
    if (!accepted.ok) throw new Error(JSON.stringify(accepted))
    expect((await redeem(accepted.value.pairing_code)).ok).toBe(true)
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    h.sqlite.prepare(`INSERT INTO invites
      (id,email,capability,invited_by,created_at,member_id,minted_by_member_id,pairing_hash,pairing_expires_at,invite_kind)
      VALUES ('other-code','other@x.test','observer','other',datetime('now'),'other','other',?,?,'identity_only')`)
      .run('b'.repeat(64), created.value.invite.pairing_expires_at)
    const response = await disconnect()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(h.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id='self'").get()).toEqual({ telegram_chat_id: null })
    expect(await redeem(created.value.pairing_code, '90002', 'after-disconnect')).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
    expect(h.sqlite.prepare('SELECT accepted_at FROM invites WHERE id=?').get(created.value.invite.id)).toEqual({ accepted_at: null })
    expect(h.sqlite.prepare('SELECT pairing_expires_at FROM invites WHERE id=?').get(accepted.value.invite.id))
      .toEqual({ pairing_expires_at: accepted.value.invite.pairing_expires_at })
    expect(h.sqlite.prepare("SELECT pairing_expires_at FROM invites WHERE id='other-code'").get())
      .toEqual({ pairing_expires_at: created.value.invite.pairing_expires_at })
  })
  it('disconnect leaves an already-expired unaccepted identity-only code unchanged without aborting the batch', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    h.sqlite.exec("UPDATE members SET telegram_chat_id='90001', telegram_bound_at=datetime('now') WHERE id='self'")
    h.sqlite.prepare('UPDATE invites SET pairing_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', created.value.invite.id)
    const before = h.sqlite.prepare('SELECT * FROM invites WHERE id=?').get(created.value.invite.id)
    const response = await disconnect()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(h.sqlite.prepare('SELECT * FROM invites WHERE id=?').get(created.value.invite.id)).toEqual(before)
    expect(h.sqlite.prepare("SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id='self'").get())
      .toEqual({ telegram_chat_id: null, telegram_bound_at: null })
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM telegram_unbind_receipts').get()).toEqual({ n: 1 })
  })
  it('disconnect expires an outstanding identity-only code for an already-unbound member without a receipt', async () => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    expect(h.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id='self'").get()).toEqual({ telegram_chat_id: null })
    const before = new Date().toISOString()
    const response = await disconnect()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toEqual({ member_id: 'self', telegram_unbound: true })
    const row = h.sqlite.prepare('SELECT pairing_expires_at FROM invites WHERE id=?').get(created.value.invite.id)!
    expect(Date.parse(String(row.pairing_expires_at))).toBeGreaterThanOrEqual(Date.parse(before))
    expect(Date.parse(String(row.pairing_expires_at))).toBeLessThanOrEqual(Date.now())
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM telegram_unbind_receipts').get()).toEqual({ n: 0 })
    expect(await redeem(created.value.pairing_code, '90002', 'already-unbound')).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
  })
  it.each([0, 2])('bound disconnect expires codes, revokes bot grants and records the correct audit count for %i devices', async (deviceCount) => {
    const created = await mint()
    if (!created.ok) throw new Error(JSON.stringify(created))
    h.sqlite.exec(`
      UPDATE members SET telegram_chat_id='90001', telegram_bound_at=datetime('now') WHERE id='self';
      INSERT INTO agents (id, squad_id, slug, name, role, model, status)
        VALUES ('grant-agent','home','grant-agent','Agent','r','m','active');
      INSERT INTO agent_sessions (id, tenant, agent_id, member_id, auth_kind, credential_id, idle_expires_at, absolute_expires_at)
        VALUES ('grant-session','local','grant-agent','other','workspace_token','credential',datetime('now','+1 day'),datetime('now','+7 days'));
      INSERT INTO web_sessions (id_hash, tenant, member_id, login_identity_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
        SELECT 'grant-web-session', tenant, member_id, login_identity_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at FROM web_sessions WHERE id_hash='session-self';
      INSERT INTO elevation_requests (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
        requested_scope_type, requested_duration_minutes, reason, status, created_at, decision_expires_at, decided_by_member_id, decided_via)
        VALUES ('bot-request','local','grant-session','grant-agent','other','["action:task_create"]',
          'org',60,'test','approved',datetime('now'),datetime('now','+1 day'),'self','approval_bot');
      INSERT INTO elevation_grants (id, tenant, elevation_request_id, agent_session_id, action, scope_type, effect,
        approved_by_member_id, approved_by_web_session_hash, created_at, expires_at)
        VALUES ('bot-grant','local','bot-request','grant-session','action:task_create','org','reversible',
          'self','grant-web-session',datetime('now'),'9999-01-01T00:00:00.000Z');
    `)
    for (let i = 0; i < deviceCount; i++) {
      h.sqlite.prepare(`INSERT INTO tg_miniapp_devices
        (id, tenant, member_id, telegram_user_id, enrolment_token_id, secret_sha256, created_at, confirmed_at)
        VALUES (?, 'local', 'self', '90001', ?, ?, datetime('now'), datetime('now'))`)
        .run(`device-${i}`, `enrol-${i}`, 'a'.repeat(64))
    }
    const before = new Date().toISOString()
    const response = await disconnect()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(h.sqlite.prepare("SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id='self'").get())
      .toEqual({ telegram_chat_id: null, telegram_bound_at: null })
    const receipt = h.sqlite.prepare('SELECT * FROM telegram_unbind_receipts').all()
    expect(receipt).toHaveLength(1)
    expect(receipt[0]).toMatchObject({ member_id: 'self', prior_telegram_chat_id: '90001' })
    const expiry = h.sqlite.prepare('SELECT pairing_expires_at FROM invites WHERE id=?').get(created.value.invite.id)!
    expect(Date.parse(String(expiry.pairing_expires_at))).toBeGreaterThanOrEqual(Date.parse(before))
    expect(expiry.pairing_expires_at).toBe(receipt[0].created_at)
    expect(h.sqlite.prepare("SELECT revoked_at, revoke_reason FROM elevation_grants WHERE id='bot-grant'").get())
      .toEqual({ revoked_at: receipt[0].created_at, revoke_reason: 'telegram_unbound' })
    expect(h.sqlite.prepare("SELECT COUNT(*) n FROM tg_miniapp_devices WHERE revoked_at IS NOT NULL AND revoked_reason='telegram_unbound'").get())
      .toEqual({ n: deviceCount })
    const audits = h.sqlite.prepare("SELECT evidence_json FROM mutation_audit_entries WHERE operation='tg_device_revoke'").all()
    expect(audits).toHaveLength(deviceCount === 0 ? 0 : 1)
    if (deviceCount > 0) expect(JSON.parse(String(audits[0].evidence_json))).toMatchObject({ reason: 'telegram_unbound', count: String(deviceCount) })
  })
  it('disconnect preserves other-member, accepted and grant-kind invites', async () => {
    const accepted = await mint()
    if (!accepted.ok) throw new Error(JSON.stringify(accepted))
    expect((await redeem(accepted.value.pairing_code)).ok).toBe(true)
    const outstanding = await mint()
    if (!outstanding.ok) throw new Error(JSON.stringify(outstanding))
    h.sqlite.prepare(`INSERT INTO invites
      (id,email,capability,invited_by,created_at,member_id,minted_by_member_id,pairing_hash,pairing_expires_at,invite_kind)
      VALUES ('other-code','other@x.test','observer','other',datetime('now'),'other','other',?,?,'identity_only')`)
      .run('b'.repeat(64), outstanding.value.invite.pairing_expires_at)
    h.sqlite.exec(`INSERT INTO projects (id,slug,name,status) VALUES ('grant-project','grant-project','Project','active');
      INSERT INTO project_squad_access (project_id,squad_id,access_level) VALUES ('grant-project','home','write');`)
    h.sqlite.prepare(`INSERT INTO invites (id,email,capability,invited_by,created_at,member_id,project_id,squad_id,pairing_hash,pairing_expires_at,invite_kind)
      VALUES ('grant-code','self@x.test','observer','self',datetime('now'),'self','grant-project','home',?,?,'grant')`)
      .run('d'.repeat(64), outstanding.value.invite.pairing_expires_at)
    const preserved = () => h.sqlite.prepare('SELECT * FROM invites WHERE id != ? ORDER BY id').all(outstanding.value.invite.id)
    const before = preserved()
    expect(before).toHaveLength(3)
    const response = await disconnect()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(preserved()).toEqual(before)
    expect(await redeem(outstanding.value.pairing_code, '90002', 'after-isolated-disconnect')).toEqual({ ok: false, error: 'invalid_or_expired_pairing_code' })
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
    "capability='owner'", "squad_id='home'", "department_id='home-dept'", "pairing_hash=NULL", "pairing_expires_at=NULL", "pairing_expires_at='9999-01-01T00:00:00.000Z'",
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
