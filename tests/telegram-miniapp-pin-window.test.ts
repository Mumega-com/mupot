// tests/telegram-miniapp-pin-window.test.ts — secure moments W4.2: the PIN fallback and the user-chosen trusted-device
// window (src/secure-moments/telegram-miniapp-pin-window.ts), behind TELEGRAM_MINIAPP_PIN_WINDOW. Real migrated schema, the
// REAL routes. Neither the PIN nor the window may grant authority: the defect classes below are what the gate hunts.
// Contract: docs/architecture/secure-moments.md (W4.2).
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { initData, newTestKey, type InitDataSpec } from './helpers/telegram-initdata'
import { momentsApp } from '../src/secure-moments/routes'
import { makeAccountApp } from '../src/dashboard/account'
import { consumeMomentTelegram, mintTgEnrolmentToken, revokeOwnTgDevice } from '../src/secure-moments/telegram-miniapp-store'
import { tokenHash } from '../src/secure-moments/store'
import {
  PIN_MAX_WRONG, TRUST_WINDOW_MAX_SECONDS, TRUST_WINDOW_PRESETS, changeTrustWindow, consumeMomentTelegramPw, derivePinHash, parseTrustWindow, pinFormatOk, pinIsTooEasy, pinWindowOn,
} from '../src/secure-moments/telegram-miniapp-pin-window'
import { TG_SCRIPT } from '../src/secure-moments/telegram-miniapp-client'
import { TG_SCRIPT_PIN_WINDOW } from '../src/secure-moments/telegram-miniapp-client-pin-window'
import { ELEVATION_ACTIONS, isRequestableElevationAction, SENSITIVE_STEP_UP_ACTIONS } from '../src/auth/elevation-actions'
import { TELEGRAM_PASSKEY_ONLY_EXTRA } from '../src/secure-moments/telegram-miniapp'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { createWebSession, markRecentReauth, revokeAllWebSessions } from '../src/auth/web-sessions'
import * as cryptoLib from '../src/lib/crypto'
import { seedPasskey, throughGate } from './helpers/presence'

const TENANT = 'tenant-a'
const HOST = 'secure.example.test'
const ORIGIN = `https://${HOST}`
const COLONY = 'colony.example.test'
const MASTER = 'a1'.repeat(32)
const BOT = '123456789'
const BOT_TOKEN = `${BOT}:AAEhqMY-dedicated-miniapp-test-token`
const key = newTestKey()
const seedText = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')
const TG = { owner: 1001, plain: 1002, sqadmin: 1003, agent: 1004, other: 1005 }
const PIN = '482915'
const WRONG = '739104'

let harness: SqliteD1Harness
let env: Env

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER, PUBLIC_ORIGIN: `https://${COLONY}`,
    SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST,
    TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_PIN_WINDOW: '1', TELEGRAM_MINIAPP_BOT_ID: BOT, TELEGRAM_MINIAPP_BOT_TOKEN: BOT_TOKEN, TELEGRAM_MINIAPP_EXTRA_PUBKEYS: key.publicKeyHex,
    ...over,
  } as Env
}
const offEnv = (): Env => baseEnv({ TELEGRAM_MINIAPP_PIN_WINDOW: undefined })

const count = (t: string, where = '1=1'): number => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).get() as { n: number }).n
const one = <T>(sql: string, ...p: unknown[]): T | undefined => harness.sqlite.prepare(sql).get(...p) as T | undefined
const identities: Record<string, string> = {}
async function link(sub: string, memberId: string, email: string): Promise<string> {
  const r = await linkLoginIdentity(env, { tenant: TENANT, provider: 'google', providerSubject: sub, verifiedEmail: email, memberId })
  if (!r.ok) throw new Error(`link failed ${JSON.stringify(r)}`)
  return r.identity.id
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}');
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'a', 'A');
    INSERT INTO users (id, email, role) VALUES ('u-owner', 'owner@x.test', 'owner');
    INSERT INTO members (id, email, display_name, status, tenant, telegram_chat_id) VALUES
      ('mem-owner', 'owner@x.test', 'Owner', 'active', '${TENANT}', '${TG.owner}'),
      ('mem-plain', 'plain@x.test', 'Plain', 'active', '${TENANT}', '${TG.plain}'),
      ('mem-sqadmin', 'sqadmin@x.test', 'Squad Admin', 'active', '${TENANT}', '${TG.sqadmin}'),
      ('mem-agent', 'agent@x.test', 'Agent Member', 'active', '${TENANT}', '${TG.agent}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-x', 'mem-agent', datetime('now'));
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('tok-1', 'mem-agent', 'hash-1', 'primary', 'workspace', '${TENANT}', 'agent-x', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-p', 'mem-plain', 'squad', 'squad-a', 'member'),
      ('cap-sa', 'mem-sqadmin', 'squad', 'squad-a', 'admin');
  `)
  env = baseEnv()
  identities.owner = await link('g-owner', 'mem-owner', 'owner@x.test')
  identities.sqadmin = await link('g-sqadmin', 'mem-sqadmin', 'sqadmin@x.test')
})
afterEach(() => { harness.close(); vi.restoreAllMocks(); vi.useRealTimers() })

// ── requests ─────────────────────────────────────────────────────────────────────────────────────
async function hit(path: string, json: unknown, e: Env = env): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', origin: ORIGIN })
  return momentsApp.fetch(new Request(`https://${HOST}${path}`, { method: 'POST', headers, body: JSON.stringify(json) }), e)
}
const get = (path: string, e: Env = env): Promise<Response> => momentsApp.fetch(new Request(`https://${HOST}${path}`), e)
type J = {
  ok?: boolean; title?: string; message?: string; code?: string; attempts_left?: number; nonce?: string; device_token?: string
  device_token_next?: string; trust_token_next?: string; trusted_until?: string
}
const jbody = async (r: Response): Promise<J> => (await r.clone().json()) as J
const init = (userId: number, spec: InitDataSpec = {}): string => initData({ botId: BOT, userId, ...spec }, key)

// ── a "phone": what the Mini App client holds, following rotations like the real client ──────────
interface Phone { deviceToken: string; trustToken: string | null; trustedUntil: string | null; mode: 'biometric' | 'pin'; pin: string | null; memberId: string; tg: number }
interface SetupOpts { mode?: 'biometric' | 'pin'; pin?: string; window?: unknown; extra?: Record<string, unknown>; e?: Env; omitWindow?: boolean }

async function setup(memberId: string, tg: number, identityId: string | null, o: SetupOpts = {}): Promise<Phone> {
  const e = o.e ?? env
  const { token } = await mintTgEnrolmentToken(env, memberId, identityId)
  const start = await hit(`/m/tg/enrol/${token}/start`, { init_data: init(tg) }, e)
  expect(start.status).toBe(200)
  const deviceToken = (await jbody(start)).device_token ?? ''
  const mode = o.mode ?? 'biometric'
  const body: Record<string, unknown> = { init_data: init(tg), device_token: deviceToken, unlock_mode: mode, ...(o.omitWindow ? {} : { trust_window_seconds: o.window ?? 1800 }), ...(mode === 'pin' ? { pin: o.pin ?? PIN } : {}), ...(o.extra ?? {}) }
  const fin = await hit(`/m/tg/enrol/${token}/confirm`, body, e)
  expect(fin.status, JSON.stringify(await jbody(fin))).toBe(200)
  return { deviceToken, trustToken: null, trustedUntil: null, mode, pin: mode === 'pin' ? (o.pin ?? PIN) : null, memberId, tg }
}
const deviceId = (p: Phone): string => p.deviceToken.split('.')[0]
const devRow = (p: Phone): Record<string, unknown> => one<Record<string, unknown>>('SELECT * FROM tg_miniapp_devices WHERE id = ?', deviceId(p)) ?? {}

// ── moments ──────────────────────────────────────────────────────────────────────────────────────
const agentAuth = (): AuthContext => ({
  userId: 'mem-agent', email: 'agent@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-agent', tokenId: 'tok-1',
  capabilities: [{ member_id: 'mem-agent', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
interface Moment { id: string; subject: string }
function parseLink(url: string): { id: string } {
  const [, m, id] = new URL(url).pathname.split('/')
  if (m !== 'm') throw new Error(`not a moment link ${url}`)
  return { id }
}
async function fileSeed(): Promise<Moment> {
  const r = await invokeTool(agentAuth(), env, 'seed_attach_request', { seed: seedText }, 'https://pot.test')
  if (!r.ok) throw new Error(`file failed ${JSON.stringify(r)}`)
  const res = r.result as { request_id: string; approve_url: string }
  return { ...parseLink(res.approve_url), subject: res.request_id }
}
async function fileElevation(actions: string[]): Promise<Moment> {
  await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.test')
  const r = await invokeTool(agentAuth(), env, 'request_elevation',
    { actions, scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 60, reason: 'need it' }, 'https://pot.test')
  if (!r.ok) throw new Error(`elevation failed ${JSON.stringify(r)}`)
  const res = r.result as { request: { id: string }; approve_url?: string }
  if (!res.approve_url) throw new Error('no approve_url')
  return { ...parseLink(res.approve_url), subject: res.request.id }
}
// One grant per (agent session, action, scope): every moment asks for a DIFFERENT non-sensitive action.
const freeActions = Object.keys(ELEVATION_ACTIONS).filter((k) => !SENSITIVE_STEP_UP_ACTIONS.has(k) && !TELEGRAM_PASSKEY_ONLY_EXTRA.has(k) && isRequestableElevationAction(k) && !k.startsWith('action:install_')) // installer windows are flag-gated and requested alone (tests/installer-window.test.ts)
let nextAction = 0
const act = (): string => freeActions[nextAction++ % freeActions.length]
const momentStatus = (id: string): string => one<{ status: string }>('SELECT status FROM secure_moments WHERE id = ?', id)?.status ?? 'missing'
async function elevation(): Promise<{ m: Moment; action: string }> {
  const action = act()
  return { m: await fileElevation([action]), action }
}

interface Choice { decision: 'approve' | 'deny'; actions?: string[]; duration_minutes?: number }
async function nonceFor(m: Moment, tg: number, c: Choice): Promise<string> {
  const r = await hit('/m/tg/challenge', { init_data: init(tg), moment_id: m.id, ...c })
  expect(r.status, JSON.stringify(await jbody(r))).toBe(200)
  return (await jbody(r)).nonce ?? ''
}
interface GoOpts { via?: 'secret' | 'trust'; pin?: string | null; nonce?: string; deviceToken?: string; trustToken?: string; init?: string; e?: Env }
/** One decision, the way the client sends it; follows device/trust rotation on the phone like the real client. */
async function go(p: Phone, m: Moment, c: Choice, o: GoOpts = {}): Promise<Response> {
  const nonce = o.nonce ?? await nonceFor(m, p.tg, c)
  const via = o.via ?? 'secret'
  const body: Record<string, unknown> = { init_data: o.init ?? init(p.tg), moment_id: m.id, nonce, ...c }
  if (via === 'secret') {
    body.device_token = o.deviceToken ?? p.deviceToken
    const pin = o.pin === undefined ? p.pin : o.pin
    if (pin !== null) body.pin = pin
  } else {
    body.trust_token = o.trustToken ?? p.trustToken
  }
  const res = await hit('/m/tg/decide', body, o.e ?? env)
  const j = await jbody(res)
  if (j.device_token_next) p.deviceToken = j.device_token_next
  if (j.trust_token_next) { p.trustToken = j.trust_token_next; p.trustedUntil = j.trusted_until ?? null }
  return res
}
const approve = (action: string): Choice => ({ decision: 'approve', actions: [action], duration_minutes: 15 })

const SEC = 1000
const advance = (ms: number): void => { vi.setSystemTime(Date.now() + ms) }

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('the migration (real schema chain)', () => {
  it('adds the columns with safe defaults to existing rows, and the database itself enforces the 7-day cap and the 5-attempt cap', async () => {
    const p = await setup('mem-owner', TG.owner, identities.owner, { omitWindow: true, e: offEnv() }) // a device that never chose a window
    expect(devRow(p)).toMatchObject({ unlock_mode: 'biometric', pin_hash: null, pin_salt: null, pin_failed_attempts: 0, trust_window_seconds: 0, trust_secret_sha256: null, trusted_until: null })
    const id = deviceId(p)
    const bad = (sql: string): void => expect(() => harness.sqlite.exec(sql)).toThrow()
    bad(`UPDATE tg_miniapp_devices SET trust_window_seconds = ${TRUST_WINDOW_MAX_SECONDS + 1} WHERE id = '${id}'`)
    bad(`UPDATE tg_miniapp_devices SET trust_window_seconds = -1 WHERE id = '${id}'`)
    bad(`UPDATE tg_miniapp_devices SET pin_failed_attempts = 6 WHERE id = '${id}'`)
    bad(`UPDATE tg_miniapp_devices SET unlock_mode = 'sms' WHERE id = '${id}'`)
    bad(`UPDATE tg_miniapp_devices SET pin_hash = 'abc' WHERE id = '${id}'`)
    bad(`UPDATE tg_miniapp_devices SET pin_iterations = 100001 WHERE id = '${id}'`)
    harness.sqlite.exec(`UPDATE tg_miniapp_devices SET trust_window_seconds = ${TRUST_WINDOW_MAX_SECONDS} WHERE id = '${id}'`)
  })
  it('the revoke trigger ends a running window in the same statement, whatever revoked the device', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const { m, action } = await elevation()
    expect((await go(p, m, approve(action))).status).toBe(200)
    expect(devRow(p).trusted_until).toBeTruthy()
    expect(devRow(p).trust_secret_sha256).toBeTruthy()
    harness.sqlite.exec(`UPDATE tg_miniapp_devices SET revoked_at = datetime('now'), revoked_reason = 'x' WHERE id = '${deviceId(p)}'`)
    expect(devRow(p)).toMatchObject({ trusted_until: null, trust_secret_sha256: null })
  })
})

describe('flag off: W4.1 behaviour exactly', () => {
  it('window fields at setup are ignored and no trust is ever issued; a device enrolled flag-off never silently gets a window, even once the flag turns on', async () => {
    const off = offEnv()
    expect(pinWindowOn(off)).toBe(false)
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { window: 604800, e: off })
    expect(devRow(p)).toMatchObject({ unlock_mode: 'biometric', pin_hash: null, trust_window_seconds: 0 })
    const { m, action } = await elevation()
    const r = await go(p, m, approve(action), { e: off })
    expect(r.status).toBe(200)
    const j = await jbody(r)
    expect(j.device_token_next).toBeTruthy()
    expect(j.trust_token_next).toBeUndefined()
    expect(devRow(p)).toMatchObject({ trusted_until: null, trust_secret_sha256: null })
    // the flag turns ON: the pre-existing device still gets no trust (its window is its off value, 0)
    const m2 = await elevation()
    const r2 = await go(p, m2.m, approve(m2.action))
    expect(r2.status).toBe(200)
    expect((await jbody(r2)).trust_token_next).toBeUndefined()
    expect(devRow(p)).toMatchObject({ trusted_until: null, trust_secret_sha256: null })
    expect(count('mutation_audit_entries', "operation IN ('tg_device_pin_set','tg_device_pin_attempt','tg_device_window_change')")).toBe(0)
  })
  it('FAILS CLOSED: a PIN device enrolled with the flag on cannot decide with the flag off (initData + stored secret alone is refused), and the challenge says set up', async () => {
    const off = offEnv()
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    for (const pin of [null, PIN, WRONG]) {
      const r = await go(p, m, approve(action), { e: off, nonce, pin })
      expect(r.status, String(pin)).toBe(403)
    }
    expect(momentStatus(m.id)).toBe('pending')
    expect(devRow(p).pin_failed_attempts).toBe(0)
    const ch = await hit('/m/tg/challenge', { init_data: init(p.tg), moment_id: m.id, ...approve(action) }, off)
    expect(ch.status).toBe(409)
    expect(await jbody(ch)).toMatchObject({ title: 'Set up this device' })
    // flag back on: the same device works with its PIN
    expect((await go(p, m, approve(action), { nonce })).status).toBe(200)
  })
  it('consumeMomentTelegram (the W4 consume) refuses a PIN device in its own WHERE, whatever the caller read earlier', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m } = await elevation()
    const secret = await tokenHash(p.deviceToken.split('.')[1])
    const r = await consumeMomentTelegram(env, { momentId: m.id, decision: 'deny', memberId: 'mem-sqadmin', telegramUserId: String(TG.sqadmin), deviceId: deviceId(p), secretSha256: secret }, Date.now())
    expect(r.won).toBe(false)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('the enrol race: a client that started under the flag and confirms as a PIN device after it flipped off is refused, not saved as a biometric device', async () => {
    const off = offEnv()
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const start = await hit(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })
    const dt = (await jbody(start)).device_token
    const fin = await hit(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: dt, unlock_mode: 'pin', pin: PIN, trust_window_seconds: 1800 }, off)
    expect(fin.status).toBe(409)
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
    expect(count('tg_miniapp_enrolment_tokens', 'consumed_at IS NULL')).toBeGreaterThan(0)
  })
  it('a trust token is just an unknown credential, and the decision path never reads the PIN: an invalid body field is not even looked at', async () => {
    const off = offEnv()
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    const r = await hit('/m/tg/decide', { init_data: init(p.tg), moment_id: m.id, nonce, trust_token: p.deviceToken, ...approve(action) }, off)
    expect(r.status).toBe(403)
    expect(await jbody(r)).toMatchObject({ title: 'Device not recognised' })
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('the page serves the W4.1 script byte for byte; the W4.2 script only with the sub-flag; both are valid JavaScript', async () => {
    const off = await (await get('/m/tg', offEnv())).text()
    const on = await (await get('/m/tg', env)).text()
    expect(off).toContain('Confirm decisions in this workspace')
    expect(off).not.toContain('trust_token')
    expect(on).toContain('trust_token')
    expect(() => new vm.Script(TG_SCRIPT)).not.toThrow()
    expect(() => new vm.Script(TG_SCRIPT_PIN_WINDOW)).not.toThrow()
    expect(off).toContain(TG_SCRIPT.trim())
  })
  it('the sub-flag does nothing while the channel itself is off or misconfigured (it never lights a dark channel)', () => {
    expect(pinWindowOn(baseEnv({ TELEGRAM_MINIAPP: undefined }))).toBe(false)
    expect(pinWindowOn(baseEnv({ TELEGRAM_MINIAPP_BOT_ID: 'nope' }))).toBe(false)
    expect(pinWindowOn(baseEnv({ SECURE_MOMENTS: undefined }))).toBe(false)
    expect(pinWindowOn(env)).toBe(true)
  })
  it('the /account window route is a 404 while the sub-flag is off', async () => {
    const p = await setup('mem-owner', TG.owner, identities.owner)
    const { app, setAuth } = accountApp(offEnv())
    setAuth(await webAuth('mem-owner', identities.owner, true))
    const r = await app.request(`/account/telegram-device/${deviceId(p)}/window`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ seconds: 0 }) }, offEnv())
    expect(r.status).toBe(404)
    expect(devRow(p).trust_window_seconds).toBe(1800)
  })
})

describe('the PIN: format, storage, binding', () => {
  it('a PIN is exactly six digits and not a repeated digit or a straight run: anything else is refused at setup and the link stays unspent', async () => {
    for (const bad of ['12345', '1234567', '12345a', '111111', '123456', '654321', '000000', ' 48291', '48 915']) {
      const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
      const start = await hit(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })
      const dt = (await jbody(start)).device_token
      const fin = await hit(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: dt, unlock_mode: 'pin', pin: bad, trust_window_seconds: 1800 })
      expect(fin.status, bad).toBe(400)
    }
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const start = await hit(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })
    const dt = (await jbody(start)).device_token
    for (const bad of [482915, null, ['482915'], { a: 1 }, true]) {
      expect((await hit(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: dt, unlock_mode: 'pin', pin: bad, trust_window_seconds: 1800 })).status).toBe(400)
    }
    expect((await hit(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: dt, unlock_mode: 'pin', trust_window_seconds: 1800 })).status).toBe(400) // a PIN device needs a PIN
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
    expect(one<{ consumed_at: string | null }>('SELECT consumed_at FROM tg_miniapp_enrolment_tokens WHERE consumed_at IS NULL ORDER BY created_at DESC LIMIT 1')).toBeTruthy()
    expect(pinFormatOk('482915')).toBe(true)
    expect(pinFormatOk('４８２９１５')).toBe(false) // full-width digits are not ASCII digits
    expect(pinIsTooEasy('135790')).toBe(false)
  })
  it('only a salted PBKDF2 hash is stored: a per-device salt (same PIN, different hash), the iteration count, and nothing derivable by eye', async () => {
    const a = await setup('mem-owner', TG.owner, identities.owner, { mode: 'pin' })
    const b = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const ra = devRow(a) as { pin_hash: string; pin_salt: string; pin_iterations: number; unlock_mode: string }
    const rb = devRow(b) as { pin_hash: string; pin_salt: string }
    expect(ra.unlock_mode).toBe('pin')
    expect(ra.pin_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(ra.pin_salt).toMatch(/^[0-9a-f]{32}$/)
    expect(ra.pin_iterations).toBe(100000)
    expect(ra.pin_salt).not.toBe(rb.pin_salt)
    expect(ra.pin_hash).not.toBe(rb.pin_hash)
    expect(ra.pin_hash).toBe(await derivePinHash(PIN, ra.pin_salt, { deviceId: deviceId(a), memberId: 'mem-owner', telegramUserId: String(TG.owner) }, 100000))
    expect(ra.pin_hash).not.toBe(await tokenHash(PIN))
  })
  it('the hash is BOUND to the device row: copying hash+salt onto another device (even the same member and PIN) does not verify there', async () => {
    const a = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const b = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const ra = devRow(a) as { pin_hash: string; pin_salt: string }
    harness.sqlite.prepare('UPDATE tg_miniapp_devices SET pin_hash = ?, pin_salt = ? WHERE id = ?').run(ra.pin_hash, ra.pin_salt, deviceId(b))
    const { m, action } = await elevation()
    const r = await go(b, m, approve(action))
    expect(r.status).toBe(403)
    expect((await jbody(r)).code).toBe('pin_wrong')
    expect(momentStatus(m.id)).toBe('pending')
    const ok = await go(a, m, approve(action))
    expect(ok.status).toBe(200)
  })
  it('the comparison is the constant-time one, against the stored digest', async () => {
    const spy = vi.spyOn(cryptoLib, 'timingSafeEqual')
    const a = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    spy.mockClear()
    await go(a, m, approve(action), { pin: WRONG })
    const stored = (devRow(a) as { pin_hash: string }).pin_hash
    const derived = await derivePinHash(WRONG, (devRow(a) as { pin_salt: string }).pin_salt, { deviceId: deviceId(a), memberId: 'mem-sqadmin', telegramUserId: String(TG.sqadmin) }, 100000)
    expect(spy.mock.calls.some(([x, y]) => x === derived && y === stored)).toBe(true)
  })
})

describe('the PIN never leaks', () => {
  it('is in no table, no receipt, no response and no console output (setup, wrong attempts, success and lockout)', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')]
    const responses: string[] = []
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    for (const pin of [WRONG, '561820', PIN]) responses.push(await (await go(p, m, approve(action), { pin })).clone().text())
    const m2 = await elevation()
    for (let i = 0; i < PIN_MAX_WRONG; i++) responses.push(await (await go(p, m2.m, approve(m2.action), { pin: '902817' })).clone().text())
    // every table, minus anything that is a long hex/uuid/timestamp run (random digests can contain six digits by chance)
    const tables = (harness.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((r) => r.name)
    const dump = tables.map((t) => JSON.stringify(harness.sqlite.prepare(`SELECT * FROM "${t}"`).all())).join('\n')
      .replace(/[0-9a-f]{16,}/g, '').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '').replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '').replace(/\d{9,}/g, '')
    for (const secret of [PIN, WRONG, '561820', '902817']) {
      expect(dump, secret).not.toContain(secret)
      expect(responses.join('\n'), secret).not.toContain(secret)
      for (const s of spies) expect(JSON.stringify(s.mock.calls), secret).not.toContain(secret)
    }
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_attempt'")).toBeGreaterThan(0)
  })
})

describe('PIN decisions and the attempt counter', () => {
  it('a correct PIN decides; a missing PIN is asked for (nonce NOT burned); a wrong PIN says how many tries are left; success resets the counter', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    const none = await go(p, m, approve(action), { nonce, pin: null })
    expect(none.status).toBe(403)
    expect((await jbody(none)).code).toBe('pin_required')
    expect(count('tg_miniapp_nonces', 'consumed_at IS NOT NULL')).toBe(0)
    const wrong = await go(p, m, approve(action), { nonce, pin: WRONG })
    expect(wrong.status).toBe(403)
    expect(await jbody(wrong)).toMatchObject({ code: 'pin_wrong', attempts_left: 4 })
    expect(devRow(p).pin_failed_attempts).toBe(1)
    expect(count('tg_miniapp_nonces', 'consumed_at IS NOT NULL')).toBe(0) // a wrong PIN never burns the challenge
    const ok = await go(p, m, approve(action), { nonce })
    expect(ok.status).toBe(200)
    expect(devRow(p).pin_failed_attempts).toBe(0)
    expect(momentStatus(m.id)).toBe('consumed')
  })
  it('a malformed PIN is just "PIN needed" and does not spend an attempt', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    for (const bad of ['12', 482915, '48291a', '']) {
      const r = await go(p, m, approve(action), { pin: bad as string })
      expect(r.status).toBe(403)
      expect((await jbody(r)).code).toBe('pin_required')
    }
    expect(devRow(p).pin_failed_attempts).toBe(0)
  })
  it('the device secret alone is not enough for a PIN device, and the PIN alone is not enough without the device secret or initData', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    expect((await go(p, m, approve(action), { pin: null })).status).toBe(403)
    expect((await go(p, m, approve(action), { deviceToken: `${deviceId(p)}.${'A'.repeat(43)}` })).status).toBe(403)
    expect((await go(p, m, approve(action), { init: init(TG.owner) })).status).toBe(403) // another member's initData
    expect(devRow(p).pin_failed_attempts).toBe(0) // none of those could even reach the counter
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('five wrong PINs lock the device (pin_lockout), write attempt and lockout receipts, and the correct PIN no longer works', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const warm = await elevation()
    expect((await go(p, warm.m, approve(warm.action))).status).toBe(200) // opens a window, which the lockout must end
    expect(devRow(p).trusted_until).toBeTruthy()
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    const codes: Array<string | undefined> = []
    for (let i = 0; i < PIN_MAX_WRONG; i++) codes.push((await jbody(await go(p, m, approve(action), { nonce, pin: WRONG }))).code)
    expect(codes).toEqual(['pin_wrong', 'pin_wrong', 'pin_wrong', 'pin_wrong', 'pin_lockout'])
    expect(devRow(p)).toMatchObject({ revoked_reason: 'pin_lockout', pin_failed_attempts: 5 })
    expect(devRow(p).revoked_at).toBeTruthy()
    const after = await go(p, m, approve(action), { nonce, pin: PIN })
    expect(after.status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
    expect(devRow(p)).toMatchObject({ trusted_until: null, trust_secret_sha256: null })
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_attempt'")).toBe(6) // the warm-up success + the five wrong ones
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_attempt' AND evidence_json LIKE '%\"outcome\":\"wrong\"%'")).toBe(5)
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_lockout'")).toBe(1)
    const lock = one<{ evidence_json: string; member_id: string }>("SELECT evidence_json, member_id FROM mutation_audit_entries WHERE operation = 'tg_device_pin_lockout'")
    expect(JSON.parse(lock?.evidence_json ?? '{}')).toMatchObject({ reason: 'pin_lockout', device_id: deviceId(p) })
    // re-setup is a new device from /account's link; the locked one stays dead
    expect((await challengeOk(p, m)).status).toBe(409)
  })
  it('a correct PIN between wrong ones resets the run (it is five CONSECUTIVE wrong PINs)', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const a = await elevation()
    for (let i = 0; i < 4; i++) await go(p, a.m, approve(a.action), { pin: WRONG })
    expect(devRow(p).pin_failed_attempts).toBe(4)
    expect((await go(p, a.m, approve(a.action))).status).toBe(200)
    expect(devRow(p).pin_failed_attempts).toBe(0)
    const b = await elevation()
    for (let i = 0; i < 4; i++) await go(p, b.m, approve(b.action), { pin: WRONG })
    expect(devRow(p).revoked_at).toBeNull()
  })
  it('CONCURRENT wrong attempts cannot exceed the cap: twelve at once verify at most five, the counter stops at five, one lockout', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    const rs = await Promise.all(Array.from({ length: 12 }, () => go(p, m, approve(action), { nonce, pin: WRONG })))
    expect(rs.every((r) => r.status === 403)).toBe(true)
    expect(devRow(p)).toMatchObject({ pin_failed_attempts: 5, revoked_reason: 'pin_lockout' })
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_attempt'")).toBeLessThanOrEqual(5)
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_lockout'")).toBe(1)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('concurrent attempts that include the CORRECT PIN: it may win, but the wrong ones still stop at the cap', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    await Promise.all([...Array.from({ length: 8 }, () => go(p, m, approve(action), { nonce, pin: WRONG })), go(p, m, approve(action), { nonce })])
    expect(devRow(p).pin_failed_attempts).toBeLessThanOrEqual(5)
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_attempt' AND evidence_json LIKE '%wrong%'")).toBeLessThanOrEqual(5)
  })
  it('a PIN device with no stored hash fails closed (it is not a biometric device by accident)', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    harness.sqlite.prepare('UPDATE tg_miniapp_devices SET pin_hash = NULL WHERE id = ?').run(deviceId(p))
    const { m, action } = await elevation()
    expect((await go(p, m, approve(action))).status).toBe(403)
    expect((await go(p, m, approve(action), { pin: null })).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('a biometric device ignores a PIN field (it never turns a biometric device into a PIN one, or the reverse)', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const { m, action } = await elevation()
    expect((await go(p, m, approve(action), { pin: WRONG })).status).toBe(200)
    expect(devRow(p).pin_failed_attempts).toBe(0)
  })
})
/** A challenge for a fresh moment against a (possibly dead) device: 409 once it is revoked. */
async function challengeOk(p: Phone, m: Moment): Promise<Response> {
  return hit('/m/tg/challenge', { init_data: init(p.tg), moment_id: m.id, decision: 'approve', actions: [freeActions[0]] })
}

describe('the trusted window: set at setup, recorded after a decision, used without a prompt', () => {
  it('a setup that never chose a window gets NONE (an older page); every preset is accepted; a window of 0 issues no trust at all', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { omitWindow: true })
    expect(devRow(p).trust_window_seconds).toBe(0)
    expect(TRUST_WINDOW_PRESETS.map((x) => x.seconds)).toEqual([0, 1800, 7200, 28800, 86400, 604800])
    for (const w of TRUST_WINDOW_PRESETS) {
      const q = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { window: w.seconds, mode: 'biometric' })
      expect(devRow(q).trust_window_seconds).toBe(w.seconds)
      if (w.seconds === 0) {
        const { m, action } = await elevation()
        const r = await go(q, m, approve(action))
        expect(r.status).toBe(200)
        expect((await jbody(r)).trust_token_next).toBeUndefined()
        expect(devRow(q)).toMatchObject({ trusted_until: null, trust_secret_sha256: null })
      }
      await revokeOwnTgDevice(env, 'mem-sqadmin', deviceId(q))
    }
  })
  it('after a successful decision trusted_until = now + the window, and a routine decision then needs ONLY initData + the current trust token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { window: 7200 })
    const first = await elevation()
    const t0 = Date.now()
    const r1 = await go(p, first.m, approve(first.action))
    expect(r1.status).toBe(200)
    expect(Date.parse(p.trustedUntil ?? '')).toBe(t0 + 7200 * SEC)
    expect(devRow(p).trusted_until).toBe(p.trustedUntil)
    expect(p.trustToken?.split('.')[0]).toBe(deviceId(p))
    const secretBefore = devRow(p).secret_sha256
    advance(10 * 60 * SEC)
    const second = await elevation()
    const r2 = await go(p, second.m, approve(second.action), { via: 'trust' })
    expect(r2.status, JSON.stringify(await jbody(r2))).toBe(200)
    expect(momentStatus(second.m.id)).toBe('consumed')
    // the window did not move (a window is never extended by being used) ...
    expect(devRow(p).trusted_until).toBe(p.trustedUntil)
    expect(Date.parse(p.trustedUntil ?? '')).toBe(t0 + 7200 * SEC)
    // ... and the trust secret rotated on the window path, the device secret did not
    expect(devRow(p).secret_sha256).toBe(secretBefore)
    expect(devRow(p).trust_secret_sha256).toBe(await tokenHash((p.trustToken ?? '').split('.')[1]))
    // a deny is routine too
    const third = await elevation()
    expect((await go(p, third.m, { decision: 'deny' }, { via: 'trust' })).status).toBe(200)
    expect(momentStatus(third.m.id)).toBe('denied')
  })
  it('the device secret still rotates on every secret-path decision and the trust secret is a DIFFERENT secret', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const a = await elevation()
    const oldDevice = p.deviceToken
    await go(p, a.m, approve(a.action))
    expect(p.deviceToken).not.toBe(oldDevice)
    expect(p.trustToken?.split('.')[1]).not.toBe(p.deviceToken.split('.')[1])
    expect(count('tg_miniapp_retired_secrets', `device_id = '${deviceId(p)}'`)).toBe(1)
  })
  it('the cached trust token cannot stand in for the device secret, nor the device secret for the trust token', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    const b = await elevation()
    const trust = p.trustToken ?? ''
    expect((await go(p, b.m, approve(b.action), { via: 'secret', deviceToken: trust })).status).toBe(403)
    expect((await go(p, b.m, approve(b.action), { via: 'trust', trustToken: p.deviceToken })).status).toBe(403)
    expect(momentStatus(b.m.id)).toBe('pending')
    expect(devRow(p).revoked_at).toBeNull() // plain mismatches revoke nothing
  })
  it('an EXPIRED window prompts again: the trust token is void at trusted_until (server side), the device secret still works', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { window: 1800 })
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    const stale = p.trustToken ?? ''
    advance(1800 * SEC - 1000)
    const live = await elevation()
    expect((await go(p, live.m, approve(live.action), { via: 'trust' })).status).toBe(200)
    advance(2000)
    const b = await elevation()
    const nonce = await nonceFor(b.m, p.tg, approve(b.action))
    const r = await go(p, b.m, approve(b.action), { via: 'trust', trustToken: p.trustToken ?? stale, nonce })
    expect(r.status).toBe(403)
    expect((await jbody(r)).code).toBe('window_expired')
    expect(momentStatus(b.m.id)).toBe('pending')
    expect(devRow(p).revoked_at).toBeNull() // an expired window is not an attack
    // the same challenge answers with the full proof, and that opens a NEW window
    const full = await go(p, b.m, approve(b.action), { nonce })
    expect(full.status).toBe(200)
    expect(Date.parse(p.trustedUntil ?? '')).toBeGreaterThan(Date.now())
  })
  it('the expiry is enforced INSIDE the consuming statement: a trust proof that expires between check and consume wins nothing', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    const b = await elevation()
    const presented = await tokenHash((p.trustToken ?? '').split('.')[1])
    harness.sqlite.prepare("UPDATE tg_miniapp_devices SET trusted_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(deviceId(p))
    const r = await consumeMomentTelegramPw(env, { momentId: b.m.id, decision: 'deny', memberId: 'mem-sqadmin', telegramUserId: String(TG.sqadmin), deviceId: deviceId(p), presentedSha256: presented, proof: 'trust' }, Date.now())
    expect(r.won).toBe(false)
    expect(momentStatus(b.m.id)).toBe('pending')
    expect(count('tg_miniapp_decisions', `moment_id = '${b.m.id}'`)).toBe(0)
  })
})

describe('the window stops at the PIN cap (Hadi 2026-10-12)', () => {
  it('a device stuck at the cap but not revoked cannot decide through its trust token: refused at the door and inside the consume', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const a = await elevation()
    expect((await go(p, a.m, approve(a.action))).status).toBe(200)
    expect(p.trustToken).toBeTruthy()
    // the slot-5 request died before revoking: counter at the cap, device still active, window still live
    harness.sqlite.prepare('UPDATE tg_miniapp_devices SET pin_failed_attempts = 5 WHERE id = ?').run(deviceId(p))
    const b = await elevation()
    const r = await go(p, b.m, { decision: 'deny' }, { via: 'trust' })
    expect(r.status).not.toBe(200)
    expect(momentStatus(b.m.id)).toBe('pending')
    // and the consume itself refuses, even with a live trust digest (no check-then-act gap)
    const presented = await tokenHash((p.trustToken ?? '').split('.')[1])
    const c = await consumeMomentTelegramPw(env, { momentId: b.m.id, decision: 'deny', memberId: 'mem-sqadmin', telegramUserId: String(TG.sqadmin), deviceId: deviceId(p), presentedSha256: presented, proof: 'trust' }, Date.now())
    expect(c.won).toBe(false)
    expect(momentStatus(b.m.id)).toBe('pending')
    expect(count('tg_miniapp_decisions', `moment_id = '${b.m.id}'`)).toBe(0)
  })
})

describe('the window is bound to the device and the Telegram user', () => {
  it('another device of the same member gets no benefit, and its own window is independent', async () => {
    const a = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const b = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const m1 = await elevation()
    await go(a, m1.m, approve(m1.action))
    expect(devRow(b).trusted_until).toBeNull()
    const m2 = await elevation()
    // B's own device secret is not a trust token, and B holds none
    expect((await go(b, m2.m, approve(m2.action), { via: 'trust', trustToken: b.deviceToken })).status).toBe(403)
    // A's token under B's device id is not B's credential either
    const forged = `${deviceId(b)}.${(a.trustToken ?? '').split('.')[1]}`
    expect((await go(b, m2.m, approve(m2.action), { via: 'trust', trustToken: forged })).status).toBe(403)
    expect(momentStatus(m2.m.id)).toBe('pending')
    expect(devRow(a).revoked_at).toBeNull()
    expect(devRow(b).revoked_at).toBeNull()
  })
  it('another member (and another Telegram user) holding the token, with their own valid initData, is refused and revokes nothing', async () => {
    const a = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const o = await setup('mem-owner', TG.owner, identities.owner)
    const m1 = await elevation()
    await go(a, m1.m, approve(m1.action))
    const m2 = await elevation()
    const nonce = await nonceFor(m2.m, TG.owner, approve(m2.action))
    const r = await hit('/m/tg/decide', { init_data: init(TG.owner), moment_id: m2.m.id, nonce, trust_token: a.trustToken, ...approve(m2.action) })
    expect(r.status).toBe(403)
    expect(momentStatus(m2.m.id)).toBe('pending')
    expect(devRow(a).revoked_at).toBeNull()
    expect(devRow(a).trusted_until).toBeTruthy()
    // the owner's own device row is untouched
    expect(devRow(o).trusted_until).toBeNull()
    // same member row, Telegram user MOVED: the device's trust is useless for the new id
    harness.sqlite.exec(`UPDATE members SET telegram_chat_id = '${TG.sqadmin}' WHERE id = 'mem-sqadmin'`)
    const m3 = await elevation()
    const n3 = await nonceFor(m3.m, TG.sqadmin, approve(m3.action))
    harness.sqlite.exec(`UPDATE members SET telegram_chat_id = '5555' WHERE id = 'mem-sqadmin'`)
    expect((await go(a, m3.m, approve(m3.action), { via: 'trust', init: init(5555), nonce: n3 })).status).toBe(403)
    expect(momentStatus(m3.m.id)).toBe('pending')
  })
  it('consumeMomentTelegramPw itself re-checks member, Telegram user and the trust digest in its WHERE (a stale in-memory proof wins nothing)', async () => {
    const a = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const m1 = await elevation()
    await go(a, m1.m, approve(m1.action))
    const presented = await tokenHash((a.trustToken ?? '').split('.')[1])
    const base = { decision: 'deny' as const, deviceId: deviceId(a), presentedSha256: presented, proof: 'trust' as const }
    const cases: Array<[string, Partial<Parameters<typeof consumeMomentTelegramPw>[1]>]> = [
      ['wrong member', { memberId: 'mem-owner', telegramUserId: String(TG.sqadmin) }],
      ['wrong telegram user', { memberId: 'mem-sqadmin', telegramUserId: String(TG.owner) }],
      ['wrong digest', { memberId: 'mem-sqadmin', telegramUserId: String(TG.sqadmin), presentedSha256: await tokenHash('nope') }],
      ['device secret digest as a trust proof', { memberId: 'mem-sqadmin', telegramUserId: String(TG.sqadmin), presentedSha256: (devRow(a) as { secret_sha256: string }).secret_sha256 }],
    ]
    for (const [name, over] of cases) {
      const m = await elevation()
      const r = await consumeMomentTelegramPw(env, { ...base, momentId: m.m.id, memberId: 'mem-sqadmin', telegramUserId: String(TG.sqadmin), ...over }, Date.now())
      expect(r.won, name).toBe(false)
      expect(momentStatus(m.m.id), name).toBe('pending')
    }
  })
})

describe('invariants: neither the PIN nor the window grants authority', () => {
  it('a sensitive elevation ignores BOTH: refused at challenge and at decide with a live window and a correct PIN, nothing consumed', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const warm = await elevation()
    await go(p, warm.m, approve(warm.action)) // opens the window
    expect(p.trustToken).toBeTruthy()
    const sens = await fileElevation(['action:project_status', 'action:manage_access'])
    // a valid nonce for a harmless selection, then the sensitive selection at decide: refused by the policy, every proof
    const nonce = await nonceFor(sens, p.tg, approve('action:project_status'))
    for (const a of [...SENSITIVE_STEP_UP_ACTIONS, ...TELEGRAM_PASSKEY_ONLY_EXTRA]) {
      const c = { decision: 'approve' as const, actions: ['action:project_status', a], duration_minutes: 15 }
      const ch = await hit('/m/tg/challenge', { init_data: init(p.tg), moment_id: sens.id, ...c })
      expect(ch.status, a).toBe(403)
      for (const via of ['trust', 'secret'] as const) {
        const d = await go(p, sens, c, { via, nonce, pin: PIN })
        expect(d.status, `${a} ${via}`).toBe(403)
        expect((await jbody(d)).title).toBe('Use a passkey')
      }
    }
    expect(momentStatus(sens.id)).toBe('pending')
    expect(count('elevation_grants', `elevation_request_id = '${sens.subject}'`)).toBe(0)
  })
  it('a seed approve is NOT routine: the window never carries it (prompt_required, nothing consumed); a fresh proof does', async () => {
    const o = await setup('mem-owner', TG.owner, identities.owner)
    const first = await fileSeed()
    expect((await go(o, first, { decision: 'deny' })).status).toBe(200) // a deny opens the window
    expect(o.trustToken).toBeTruthy()
    const seed = await fileSeed()
    const nonce = await nonceFor(seed, o.tg, { decision: 'approve' })
    const viaWindow = await go(o, seed, { decision: 'approve' }, { via: 'trust', nonce })
    expect(viaWindow.status).toBe(403)
    expect((await jbody(viaWindow)).code).toBe('prompt_required')
    expect(momentStatus(seed.id)).toBe('pending')
    expect(devRow(o).revoked_at).toBeNull()
    const full = await go(o, seed, { decision: 'approve' }, { nonce })
    expect(full.status, JSON.stringify(await jbody(full))).toBe(200)
    expect(momentStatus(seed.id)).toBe('consumed')
  })
  it('the PIN and the window never rescue a request the member has no authority for, a credential moment, or a closed one', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const warm = await elevation()
    await go(p, warm.m, approve(warm.action))
    const seed = await fileSeed() // sqadmin lacks the org-admin floor for a seed
    expect((await hit('/m/tg/challenge', { init_data: init(p.tg), moment_id: seed.id, decision: 'approve' })).status).toBe(404)
    const r = await go(p, seed, { decision: 'approve' }, { via: 'trust', nonce: 'A'.repeat(43) })
    expect(r.status).toBe(404)
    expect(momentStatus(seed.id)).toBe('pending')
    const closed = await elevation()
    harness.sqlite.exec(`UPDATE secure_moments SET status = 'consumed' WHERE id = '${closed.m.id}'`)
    expect((await go(p, closed.m, approve(closed.action), { via: 'trust', nonce: 'A'.repeat(43) })).status).toBe(409)
  })
})

describe('stale-secret replay still revokes the device and clears the window', () => {
  it('a retired DEVICE secret replayed: the device is removed, the window columns are cleared, a suspicious receipt is written', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const old = p.deviceToken
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    expect(devRow(p).trusted_until).toBeTruthy()
    const b = await elevation()
    const nonce = await nonceFor(b.m, p.tg, approve(b.action))
    const r = await go(p, b.m, approve(b.action), { nonce, deviceToken: old })
    expect(r.status).toBe(403)
    expect((await jbody(r)).title).toBe('Device removed')
    expect(devRow(p)).toMatchObject({ revoked_reason: 'stale_secret_replayed', trusted_until: null, trust_secret_sha256: null })
    expect(devRow(p).revoked_at).toBeTruthy()
    const rec = one<{ evidence_json: string }>("SELECT evidence_json FROM mutation_audit_entries WHERE operation = 'tg_device_revoke' ORDER BY recorded_at DESC LIMIT 1")
    expect(JSON.parse(rec?.evidence_json ?? '{}')).toMatchObject({ reason: 'stale_secret_replayed', suspicious: '1' })
    // the genuine phone's trust token died with the window
    expect((await go(p, b.m, approve(b.action), { via: 'trust', nonce })).status).toBe(403)
    expect(momentStatus(b.m.id)).toBe('pending')
  })
  it('a retired TRUST secret replayed (a harvested copy after the window path rotated it): same outcome', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    const harvested = p.trustToken ?? ''
    const b = await elevation()
    expect((await go(p, b.m, approve(b.action), { via: 'trust' })).status).toBe(200) // rotates the trust secret; `harvested` is now retired
    expect(p.trustToken).not.toBe(harvested)
    const c = await elevation()
    const r = await go(p, c.m, approve(c.action), { via: 'trust', trustToken: harvested })
    expect(r.status).toBe(403)
    expect((await jbody(r)).title).toBe('Device removed')
    expect(devRow(p)).toMatchObject({ revoked_reason: 'stale_secret_replayed', trusted_until: null, trust_secret_sha256: null })
    const rec = one<{ evidence_json: string }>("SELECT evidence_json FROM mutation_audit_entries WHERE operation = 'tg_device_revoke' ORDER BY recorded_at DESC LIMIT 1")
    expect(JSON.parse(rec?.evidence_json ?? '{}')).toMatchObject({ presented: 'trust_secret', suspicious: '1' })
    expect(momentStatus(c.m.id)).toBe('pending')
  })
  it('a trust secret replaced by a NEW window (a fresh secret-path decision) is retired too: its copy is detected', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    const first = p.trustToken ?? ''
    const b = await elevation()
    await go(p, b.m, approve(b.action)) // secret path again: a new trust secret
    expect(p.trustToken).not.toBe(first)
    const c = await elevation()
    const r = await go(p, c.m, approve(c.action), { via: 'trust', trustToken: first })
    expect((await jbody(r)).title).toBe('Device removed')
  })
  it('a third party presenting a retired secret under their own initData revokes nothing', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const o = await setup('mem-owner', TG.owner, identities.owner)
    const a = await elevation()
    const old = p.deviceToken
    await go(p, a.m, approve(a.action))
    const b = await elevation()
    const nonce = await nonceFor(b.m, TG.owner, approve(b.action))
    const r = await hit('/m/tg/decide', { init_data: init(TG.owner), moment_id: b.m.id, nonce, device_token: old, ...approve(b.action) })
    expect(r.status).toBe(403)
    expect(devRow(p).revoked_at).toBeNull()
    expect(devRow(o).revoked_at).toBeNull()
  })
})

describe('fix pass: proof provenance and the attempt counter', () => {
  const proofOf = (momentId: string): string | undefined => {
    const rows = harness.sqlite.prepare("SELECT evidence_json FROM mutation_audit_entries WHERE evidence_json LIKE '%tg_device_id%' AND evidence_json LIKE ?").all(`%${momentId}%`) as Array<{ evidence_json: string }>
    return rows.map((r) => (JSON.parse(r.evidence_json) as { tg_proof?: string }).tg_proof).find((x) => x !== undefined)
  }
  it('every decision receipt names the factor that carried it: biometric, pin or trust', async () => {
    const bio = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const pin = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const a = await elevation()
    expect((await go(bio, a.m, approve(a.action))).status).toBe(200)
    expect(proofOf(a.m.id)).toBe('biometric')
    const b = await elevation()
    expect((await go(pin, b.m, approve(b.action))).status).toBe(200)
    expect(proofOf(b.m.id)).toBe('pin')
    const c = await elevation()
    expect((await go(pin, c.m, approve(c.action), { via: 'trust' })).status).toBe(200)
    expect(proofOf(c.m.id)).toBe('trust')
  })
  it('flag off adds no tg_proof (W4.1 evidence is unchanged)', async () => {
    const off = offEnv()
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { e: off })
    const a = await elevation()
    expect((await go(p, a.m, approve(a.action), { e: off })).status).toBe(200)
    expect(proofOf(a.m.id)).toBeUndefined()
  })
  it('the counter resets only in the WINNING consume: a right PIN with a bad nonce resets nothing but costs no slot; a winning decision resets it', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    await go(p, m, approve(action), { nonce, pin: WRONG })
    await go(p, m, approve(action), { nonce, pin: WRONG })
    expect(devRow(p).pin_failed_attempts).toBe(2)
    const bad = await go(p, m, approve(action), { nonce: 'A'.repeat(43) })
    expect(bad.status).toBe(403)
    expect(devRow(p).pin_failed_attempts).toBe(2) // the right PIN gave its own slot back: no reset of the earlier wrong ones, and no extra cost
    expect((await go(p, m, approve(action), { nonce })).status).toBe(200)
    expect(devRow(p).pin_failed_attempts).toBe(0)
  })
  it('five CORRECT PINs that do not win (bad nonce) cost no tries: the counter stays at 0 and the next real decision works', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    for (let i = 0; i < 6; i++) expect((await go(p, m, approve(action), { nonce: 'A'.repeat(43) })).status).toBe(403)
    expect(devRow(p).pin_failed_attempts).toBe(0)
    expect(devRow(p).revoked_at).toBeNull()
    expect((await go(p, m, approve(action), { nonce })).status).toBe(200)
  })
  it('a device stuck at the cap (the slot-5 request died) is revoked by the next attempt, which finds no slot (idempotent self-heal)', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { mode: 'pin' })
    const { m, action } = await elevation()
    const nonce = await nonceFor(m, p.tg, approve(action))
    harness.sqlite.prepare('UPDATE tg_miniapp_devices SET pin_failed_attempts = 5 WHERE id = ?').run(deviceId(p))
    const r = await go(p, m, approve(action), { nonce })
    expect(r.status).toBe(403)
    expect((await jbody(r)).code).toBe('pin_lockout')
    expect(devRow(p).revoked_at).not.toBeNull()
    expect(devRow(p).revoked_reason).toBe('pin_lockout')
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_lockout'")).toBe(1)
    // a second slotless attempt revokes nothing more (idempotent)
    await go(p, m, approve(action), { nonce })
    expect(count('mutation_audit_entries', "operation = 'tg_device_pin_lockout'")).toBe(1)
  })
  it('the PIN setup success copy names the PIN', async () => {
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const start = await hit(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })
    const fin = await hit(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: (await jbody(start)).device_token, unlock_mode: 'pin', pin: PIN, trust_window_seconds: 1800 })
    expect((await jbody(fin)).message).toMatch(/PIN/)
    expect((await jbody(fin)).message).not.toMatch(/fingerprint/)
  })
})

describe('the window ends with the device', () => {
  it('owner removal, sign-out-everywhere and a lockout all clear it', async () => {
    const mk = async (): Promise<Phone> => {
      const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
      const a = await elevation()
      await go(p, a.m, approve(a.action))
      expect(devRow(p).trusted_until).toBeTruthy()
      return p
    }
    const p1 = await mk()
    await revokeOwnTgDevice(env, 'mem-sqadmin', deviceId(p1))
    expect(devRow(p1)).toMatchObject({ trusted_until: null, trust_secret_sha256: null })
    const p2 = await mk()
    await revokeAllWebSessions(env, TENANT, 'mem-sqadmin', 'test')
    expect(devRow(p2)).toMatchObject({ trusted_until: null, trust_secret_sha256: null })
    expect(devRow(p2).revoked_at).toBeTruthy()
    const b = await elevation()
    expect((await go(p2, b.m, approve(b.action), { via: 'trust', nonce: 'A'.repeat(43) })).status).toBe(403)
  })
  it('a revoked device\'s trust token is refused outright', async () => {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    await revokeOwnTgDevice(env, 'mem-sqadmin', deviceId(p))
    const b = await elevation()
    expect((await go(p, b.m, approve(b.action), { via: 'trust', nonce: 'A'.repeat(43) })).status).toBe(403)
    expect(momentStatus(b.m.id)).toBe('pending')
  })
})

describe('changing the window (changeTrustWindow and the /account route)', () => {
  async function warmDevice(window = 86400): Promise<Phone> {
    const p = await setup('mem-sqadmin', TG.sqadmin, identities.sqadmin, { window })
    const a = await elevation()
    await go(p, a.m, approve(a.action))
    return p
  }
  it('a forged window above the cap, or any non-preset value, is refused server-side at setup AND on change; nothing changes', async () => {
    for (const bad of [TRUST_WINDOW_MAX_SECONDS + 1, 2 ** 31, 10 ** 12, -1, 1, 1801, 31 * 60, '1800', '604800', null, 1.5, Number.NaN, Infinity, {}, [1800], true]) {
      expect(parseTrustWindow(bad), String(bad)).toBeNull()
      const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
      const start = await hit(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })
      const fin = await hit(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: (await jbody(start)).device_token, trust_window_seconds: bad })
      expect(fin.status, `setup ${String(bad)}`).toBe(400)
    }
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
    const p = await warmDevice()
    for (const bad of [TRUST_WINDOW_MAX_SECONDS + 1, 10 ** 12, 1234, '1800', null]) {
      expect(await changeTrustWindow(env, 'mem-sqadmin', deviceId(p), bad)).toEqual({ ok: false, reason: 'bad_window' })
    }
    expect(devRow(p).trust_window_seconds).toBe(86400)
    expect(parseTrustWindow(604800)).toBe(604800)
    expect(count('mutation_audit_entries', "operation = 'tg_device_window_change'")).toBe(0)
  })
  it('SHORTENING takes effect immediately: trusted_until is clamped, and 0 ends the window and voids the trust token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const p = await warmDevice(86400)
    const t0 = Date.now()
    expect(Date.parse(devRow(p).trusted_until as string)).toBe(t0 + 86400 * SEC)
    advance(60 * SEC)
    expect(await changeTrustWindow(env, 'mem-sqadmin', deviceId(p), 1800)).toEqual({ ok: true, from: 86400, to: 1800 })
    expect(Date.parse(devRow(p).trusted_until as string)).toBe(Date.now() + 1800 * SEC)
    advance(1801 * SEC)
    const b = await elevation()
    expect(await jbody(await go(p, b.m, approve(b.action), { via: 'trust' }))).toMatchObject({ code: 'window_expired' })
    // back to a window, then 0
    const c = await elevation()
    expect((await go(p, c.m, approve(c.action))).status).toBe(200)
    expect(devRow(p).trusted_until).toBeTruthy()
    await changeTrustWindow(env, 'mem-sqadmin', deviceId(p), 0)
    expect(devRow(p)).toMatchObject({ trusted_until: null, trust_secret_sha256: null, trust_window_seconds: 0 })
    const d = await elevation()
    expect((await go(p, d.m, approve(d.action), { via: 'trust' })).status).toBe(403)
  })
  it('LENGTHENING does not extend a window already running; it applies from the next decision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const p = await warmDevice(1800)
    const until = devRow(p).trusted_until
    await changeTrustWindow(env, 'mem-sqadmin', deviceId(p), 604800)
    expect(devRow(p).trusted_until).toBe(until)
    const b = await elevation()
    const t = Date.now()
    await go(p, b.m, approve(b.action))
    expect(Date.parse(devRow(p).trusted_until as string)).toBe(t + 604800 * SEC)
  })
  it('a change is owner-only and live-device-only, and writes a receipt with from and to', async () => {
    const p = await warmDevice()
    expect(await changeTrustWindow(env, 'mem-owner', deviceId(p), 0)).toEqual({ ok: false, reason: 'not_found' })
    expect(await changeTrustWindow(env, 'mem-sqadmin', '11111111-1111-4111-8111-111111111111', 0)).toEqual({ ok: false, reason: 'not_found' })
    expect(devRow(p).trust_window_seconds).toBe(86400)
    await changeTrustWindow(env, 'mem-sqadmin', deviceId(p), 7200)
    const rec = one<{ evidence_json: string; member_id: string; target_id: string }>("SELECT evidence_json, member_id, target_id FROM mutation_audit_entries WHERE operation = 'tg_device_window_change'")
    expect(rec).toMatchObject({ member_id: 'mem-sqadmin', target_id: deviceId(p) })
    expect(JSON.parse(rec?.evidence_json ?? '{}')).toMatchObject({ from_seconds: '86400', to_seconds: '7200', via: 'telegram_miniapp' })
    await revokeOwnTgDevice(env, 'mem-sqadmin', deviceId(p))
    expect(await changeTrustWindow(env, 'mem-sqadmin', deviceId(p), 0)).toEqual({ ok: false, reason: 'not_found' })
  })

  describe('the /account route: lengthening needs the SAME fresh session as enrolment, shortening only a real session', () => {
    const post = (app: Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>, id: string, body: unknown, origin = 'http://localhost', query = ''): Promise<Response> =>
      Promise.resolve(app.request(`/account/telegram-device/${id}/window${query ? `?${query}` : ''}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env))
    it('stale session: lengthening and re-saving are reauth_required, shortening works; agent, cross-origin, bad values and other members are refused; a fresh session may lengthen', async () => {
      const p = await warmDevice() // 86400
      const { app, setAuth } = accountApp(env)
      setAuth(await webAuth('mem-sqadmin', identities.sqadmin, false))
      for (const longer of [TRUST_WINDOW_MAX_SECONDS, 86400]) {
        const r = await post(app, deviceId(p), { seconds: longer })
        expect(r.status, String(longer)).toBe(403)
        expect(await r.json()).toMatchObject({ error: 'reauth_required' })
      }
      expect(devRow(p).trust_window_seconds).toBe(86400)
      setAuth(agentAuth())
      expect((await post(app, deviceId(p), { seconds: 0 })).status).toBe(403)
      setAuth(await webAuth('mem-sqadmin', identities.sqadmin, true))
      expect((await post(app, deviceId(p), { seconds: 0 }, 'https://evil.example.test')).status).toBe(403)
      expect((await post(app, deviceId(p), { seconds: TRUST_WINDOW_MAX_SECONDS + 1 })).status).toBe(400)
      expect((await post(app, deviceId(p), 'junk')).status).toBe(400)
      expect(devRow(p).trust_window_seconds).toBe(86400)
      expect(count('mutation_audit_entries', "operation = 'tg_device_window_change'")).toBe(0)
      // shortening with a STALE session (no fresh re-auth): allowed, immediate, receipted
      setAuth(await webAuth('mem-sqadmin', identities.sqadmin, false))
      const short = await post(app, deviceId(p), { seconds: 7200 })
      expect(short.status).toBe(200)
      expect(devRow(p).trust_window_seconds).toBe(7200)
      expect(count('mutation_audit_entries', "operation = 'tg_device_window_change'")).toBe(1)
      // Lengthening with a fresh session also needs the presence proof. This
      // suite is about the window mechanics, so pass the common gate with its
      // DB shortcut; human-presence-account.test.ts exercises the ceremony.
      setAuth(await webAuth('mem-sqadmin', identities.sqadmin, true))
      seedPasskey(harness.sqlite, TENANT, 'mem-sqadmin')
      const lengthened = await throughGate(harness.sqlite, TENANT, (q) => post(app, deviceId(p), { seconds: 28800 }, 'http://localhost', q))
      expect(lengthened.status).toBe(200)
      expect(devRow(p).trust_window_seconds).toBe(28800)
      // another member's fresh session cannot touch it
      setAuth(await webAuth('mem-owner', identities.owner, true))
      expect((await post(app, deviceId(p), { seconds: 0 })).status).toBe(404)
      expect(devRow(p).trust_window_seconds).toBe(28800)
    })
  })
})

function accountApp(e: Env): { app: Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>; setAuth: (a: AuthContext) => void } {
  let current: AuthContext = agentAuth()
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
  app.use('*', async (c, next) => { c.set('auth', current); await next() })
  app.route('/', makeAccountApp((_e, _t, body) => body))
  void e
  return { app, setAuth: (a) => { current = a } }
}
async function webAuth(memberId: string, identityId: string, reauth: boolean): Promise<AuthContext> {
  const created = await createWebSession(env, `raw-${memberId}-${reauth}-${Math.random()}`, { tenant: TENANT, memberId, loginIdentityId: identityId })
  const hash = created.id_hash // by the row just created (several sessions of one member can share a created_at)
  if (reauth) await markRecentReauth(env, hash)
  return { userId: memberId, email: null, role: 'member', tenant: TENANT, channel: 'dashboard', memberId, webSessionMemberId: memberId, webSessionIdHash: hash } as AuthContext
}
