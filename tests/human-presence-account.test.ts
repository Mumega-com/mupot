// Account lifecycle writers must not turn a browser session into a replacement credential.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { revokeLoginIdentity, linkLoginIdentity } from '../src/auth/login-identity'
import { unlinkSignIn } from '../src/auth/link-signin'
import { linkSignIn } from '../src/auth/link-signin'
import { revokeAllWebSessions } from '../src/auth/web-sessions'
import { revokeOwnPasskey } from '../src/secure-moments/store'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { PRESENCE_ENV, enrolPasskey, presenceRefusal, realTap } from './helpers/presence'
import type { SoftAuthenticator } from './helpers/webauthn-authenticator'

// Load this first: secure-moment routes otherwise meet the mcp import cycle only at the first ceremony.
import '../src/mcp/index'

const TENANT = 'local'
const ORIGIN = 'http://localhost'
let h: SqliteD1Harness
let env: Env
let cookie: string
let identity: string
let authn: SoftAuthenticator

function kv() {
  const values = new Map<string, string>()
  return { get: async (k: string) => values.get(k) ?? null, put: async (k: string, v: string) => void values.set(k, v), delete: async (k: string) => void values.delete(k) }
}
const one = <T>(sql: string, ...args: unknown[]) => h.sqlite.prepare(sql).get(...args) as T | undefined
const count = (sql: string, ...args: unknown[]) => Number((h.sqlite.prepare(sql).get(...args) as { n: number }).n)
async function request(path: string, body: unknown = {}, query = ''): Promise<Response> {
  return dashboardApp.request(`${path}${query ? `?${query}` : ''}`, {
    method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, env)
}
async function signIn(): Promise<void> {
  const r = await authApp.request('/dev-login', {}, env)
  const value = /mupot_session=([^;]+)/.exec(r.headers.get('set-cookie') ?? '')?.[1]
  if (!value) throw new Error('missing test web session')
  cookie = `mupot_session=${value}`
  h.sqlite.prepare("UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = 'm1'").run(new Date().toISOString())
}
async function secondIdentity(): Promise<string> {
  const r = await linkLoginIdentity(env, { tenant: TENANT, provider: 'google', providerSubject: 'sub-second', verifiedEmail: 'm1@example.test', memberId: 'm1' })
  if (!r.ok) throw new Error(JSON.stringify(r))
  return r.identity.id
}
async function grant(path: string, body: unknown, actor: SoftAuthenticator = authn): Promise<string> {
  const refused = await request(path, body)
  expect(refused.status).toBe(403)
  const p = await presenceRefusal(refused)
  expect(p?.grantId).toBeTruthy()
  expect((await realTap(env, actor, p?.approveUrl ?? '')).status).toBe(200)
  return p?.grantId ?? ''
}

beforeEach(async () => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  env = {
    TENANT_SLUG: TENANT, BRAND: 'Test', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'm1@example.test', DB: h.db, SESSIONS: kv(), OAUTH_KV: kv(),
    TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_PIN_WINDOW: '1', TELEGRAM_MINIAPP_BOT_ID: '12345', TELEGRAM_MINIAPP_BOT_TOKEN: `12345:${'a'.repeat(20)}`,
    ...PRESENCE_ENV,
  } as unknown as Env
  h.sqlite.exec(`INSERT INTO users (id, email, role) VALUES ('u', 'seed@example.test', 'member');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m1', 'm1@example.test', 'Member One', 'active', '${TENANT}');`)
  // dev-login must resolve the same real web-session identity as production's local-test lane.
  const linked = await linkLoginIdentity(env, { tenant: TENANT, provider: 'local-test', providerSubject: 'm1@example.test', verifiedEmail: 'm1@example.test', memberId: 'm1' })
  if (!linked.ok) throw new Error(JSON.stringify(linked))
  await signIn()
  authn = await enrolPasskey(env, h.sqlite, 'm1')
  identity = one<{ login_identity_id: string }>("SELECT login_identity_id FROM member_passkeys WHERE member_id = 'm1'")!.login_identity_id
})
afterEach(() => h.close())

describe('account credential lifecycle', () => {
  it('passkey_revoke refuses the final key and cannot be satisfied by the target key', async () => {
    const first = one<{ id: string }>("SELECT id FROM member_passkeys WHERE member_id = 'm1'")!
    const last = await request(`/account/passkey/${first.id}/revoke`)
    expect(last.status).toBe(409)
    expect(count('SELECT COUNT(*) AS n FROM presence_grants')).toBe(0)

    const other = await enrolPasskey(env, h.sqlite, 'm1')
    const refused = await request(`/account/passkey/${first.id}/revoke`)
    const p = await presenceRefusal(refused)
    expect((await realTap(env, authn, p?.approveUrl ?? '')).status).toBe(409)
    expect(one<{ revoked_at: string | null }>('SELECT revoked_at FROM member_passkeys WHERE id = ?', first.id)?.revoked_at).toBeNull()
    expect((await realTap(env, other, p?.approveUrl ?? '')).status).toBe(200)
    expect((await request(`/account/passkey/${first.id}/revoke`, {}, `presence_grant=${p?.grantId}`)).status).toBe(200)
    expect(count("SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE operation = 'passkey_revoke' AND member_id = 'm1' AND target_id = ?", first.id)).toBe(1)
    expect((await request(`/account/passkey/${first.id}/revoke`, {}, `presence_grant=${p?.grantId}`)).status).toBe(404)
    expect(count("SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE operation = 'passkey_revoke' AND member_id = 'm1' AND target_id = ?", first.id)).toBe(1)
  })

  it('revoked history blocks ungated re-enrolment and direct service removal needs the consumed grant', async () => {
    const first = one<{ id: string }>("SELECT id FROM member_passkeys WHERE member_id = 'm1'")!
    await enrolPasskey(env, h.sqlite, 'm1')
    expect(await revokeOwnPasskey(env, 'm1', first.id, undefined)).toBe(false)
    const id = await grant(`/account/passkey/${first.id}/revoke`, {}, await enrolPasskey(env, h.sqlite, 'm1'))
    expect((await request(`/account/passkey/${first.id}/revoke`, {}, `presence_grant=${id}`)).status).toBe(200)
    const enrol = await request('/account/passkey/enrol')
    expect(enrol.status).toBe(403)
    expect((await presenceRefusal(enrol))?.grantId).toBeTruthy()
    h.sqlite.prepare("UPDATE member_passkeys SET revoked_at = datetime('now') WHERE member_id = 'm1'").run()
    const historyOnly = await request('/account/passkey/enrol')
    expect(historyOnly.status).toBe(409)
    expect(await historyOnly.json()).toMatchObject({ error: 'last_passkey_recovery_required' })
  })

  it('session revocation leaves the passkey live, while identity removal preserves the last effective key', async () => {
    await revokeAllWebSessions(env, TENANT, 'm1', 'test')
    expect(count("SELECT COUNT(*) AS n FROM member_passkeys WHERE member_id = 'm1' AND revoked_at IS NULL")).toBe(1)
    const blocked = await revokeLoginIdentity(env, TENANT, 'm1', identity)
    expect(blocked).toMatchObject({ revoked: false, passkeyRecoveryRequired: true })
    expect(count("SELECT COUNT(*) AS n FROM human_login_identities WHERE id = ? AND revoked_at IS NULL", identity)).toBe(1)
  })

  it('login_identity_revoke and unlink require another identity passkey and a consumed grant', async () => {
    const otherIdentity = await secondIdentity()
    const other = await enrolPasskey(env, h.sqlite, 'm1')
    h.sqlite.prepare("UPDATE member_passkeys SET login_identity_id = ? WHERE id = (SELECT id FROM member_passkeys WHERE member_id = 'm1' ORDER BY created_at DESC LIMIT 1)").run(otherIdentity)
    const identityRequest = (query = '') => authApp.request(`/identities/${identity}/revoke${query ? `?${query}` : ''}`, { method: 'POST', headers: { cookie, origin: ORIGIN } }, env)
    const denied = await identityRequest()
    expect(denied.status).toBe(403)
    const p = await presenceRefusal(denied)
    expect((await realTap(env, other, p?.approveUrl ?? '')).status).toBe(200)
    expect((await identityRequest(`presence_grant=${p?.grantId}`)).status).toBe(200)

    // A direct unlink without its grant is refused at the shared writer.
    const actor: AuthContext = { userId: 'm1', role: 'member', tenant: TENANT, memberId: 'm1', webSessionMemberId: 'm1' }
    expect(await unlinkSignIn(env, actor, otherIdentity)).toMatchObject({ ok: false, error: 'passkey_recovery_required' })
  })

  it('identity move refuses a dependent live passkey before it can make a session-only replacement path', async () => {
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m2', 'm2@example.test', 'Old Member', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-owner', 'm1', 'org', NULL, 'owner')`)
    await enrolPasskey(env, h.sqlite, 'm2')
    h.sqlite.prepare("UPDATE human_login_identities SET provider = 'google', provider_subject = 'sub-move' WHERE id = 'hli-m2'").run()
    const actor: AuthContext = { userId: 'm1', role: 'owner', tenant: TENANT, memberId: 'm1', webSessionMemberId: 'm1' }
    const result = await linkSignIn(env, actor, { provider: 'google', subject: 'sub-move', verifiedEmail: 'm2@example.test' }, {
      confirmMove: true, expectedDuplicate: { identityId: 'hli-m2', memberId: 'm2' },
    })
    expect(result).toEqual({ ok: false, error: 'already_linked' })
    expect(one<{ member_id: string }>("SELECT member_id FROM human_login_identities WHERE id = 'hli-m2'")?.member_id).toBe('m2')
  })

  it('telegram device enrol and a trust-window lengthening file their named grants', async () => {
    const enrol = await request('/account/telegram-device/enrol')
    expect(enrol.status).toBe(403)
    expect(one<{ kind: string }>("SELECT kind FROM presence_grants ORDER BY created_at DESC LIMIT 1")?.kind).toBe('telegram_device_enrol')
    // A device row is enough to prove the window route reaches the gate before changing it.
    h.sqlite.exec(`INSERT INTO tg_miniapp_devices (id, tenant, member_id, telegram_user_id, login_identity_id, enrolment_token_id, secret_sha256, created_at, confirmed_at)
      VALUES ('device-1', '${TENANT}', 'm1', '123', '${identity}', 'enrol-1', '${'a'.repeat(64)}', datetime('now'), datetime('now'))`)
    const window = await request('/account/telegram-device/device-1/window', { seconds: 1800 })
    expect(window.status).toBe(403)
    expect(one<{ kind: string }>("SELECT kind FROM presence_grants ORDER BY created_at DESC LIMIT 1")?.kind).toBe('telegram_device_window')
  })
})
