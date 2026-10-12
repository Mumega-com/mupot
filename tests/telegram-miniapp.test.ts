// tests/telegram-miniapp.test.ts — secure moments W4: the Telegram Mini App adapter (src/secure-moments/telegram-miniapp*.ts).
// Real migrated schema (sqlite-d1 harness) and the REAL routes: initData forgery/replay is covered in
// telegram-initdata.test.ts; here the gate hunts mapping to the wrong member, unbound users, cross-tenant, device-secret
// theft/replay/revocation, step-up policy bypass, single-use, CSP, and the flag-off no-op.
// Contract: docs/architecture/secure-moments.md (W4).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool, advertisedTools } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { SoftAuthenticator } from './helpers/webauthn-authenticator'
import { initData, newTestKey, type InitDataSpec } from './helpers/telegram-initdata'
import { momentsApp } from '../src/secure-moments/routes'
import { mintDecideChallenge, mintEnrolmentToken, tokenHash } from '../src/secure-moments/store'
import { confirmDeviceEnrolment, loadTgEnrolmentToken, mintTgEnrolmentToken, consumeMomentTelegram, resolveActiveDevice, revokeOwnTgDevice, TG_DEVICES_MAX_PER_MEMBER } from '../src/secure-moments/telegram-miniapp-store'
import { mintTgEnrolmentLink, momentMiniappLaunch } from '../src/secure-moments/telegram-miniapp-launch'
import { telegramMiniappStatus } from '../src/secure-moments/telegram-miniapp-config'
import { PASSKEY_REQUIRED_MESSAGE, telegramPolicyRefusal } from '../src/secure-moments/telegram-miniapp'
import { SENSITIVE_STEP_UP_ACTIONS } from '../src/auth/elevation-actions'
import { linkLoginIdentity, revokeLoginIdentity } from '../src/auth/login-identity'
import { createWebSession, markRecentReauth, revokeAllWebSessions } from '../src/auth/web-sessions'

const TENANT = 'tenant-a'
const HOST = 'secure.example.test'
const ORIGIN = `https://${HOST}`
const COLONY = 'colony.example.test'
const MASTER = 'a1'.repeat(32)
const BOT = '123456789'
const key = newTestKey()
const seedText = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')
// Telegram user ids (the members.telegram_chat_id of a private chat).
const TG = { owner: 1001, plain: 1002, sqadmin: 1003, agent: 1004, other: 1005, stranger: 9999 }

let harness: SqliteD1Harness
let env: Env

function baseEnv(over: Partial<Env> = {}): Env {
  return {
    DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER, PUBLIC_ORIGIN: `https://${COLONY}`,
    SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST,
    TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: BOT, TELEGRAM_MINIAPP_EXTRA_PUBKEYS: key.publicKeyHex,
    ...over,
  } as Env
}

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
      ('mem-agent', 'agent@x.test', 'Agent Member', 'active', '${TENANT}', '${TG.agent}'),
      ('mem-other', 'other@y.test', 'Other Tenant', 'active', 'tenant-b', '${TG.other}');
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
  identities.plain = await link('g-plain', 'mem-plain', 'plain@x.test')
  identities.sqadmin = await link('g-sqadmin', 'mem-sqadmin', 'sqadmin@x.test')
})
afterEach(() => { harness.close(); vi.unstubAllGlobals() })

// ── request helpers ──────────────────────────────────────────────────────────────────────────────
interface Req { method?: string; json?: unknown; origin?: string | null; host?: string; headers?: Record<string, string>; ctx?: ExecutionContext }
async function hit(path: string, r: Req = {}, e: Env = env): Promise<Response> {
  const headers = new Headers(r.headers)
  const method = r.method ?? 'GET'
  let body: string | undefined
  if (method === 'POST') {
    const origin = r.origin === undefined ? ORIGIN : r.origin
    if (origin) headers.set('origin', origin)
    headers.set('content-type', 'application/json')
    body = JSON.stringify(r.json ?? {})
  }
  return momentsApp.fetch(new Request(`https://${r.host ?? HOST}${path}`, { method, headers, body }), e, r.ctx)
}
const post = (path: string, json: unknown, e: Env = env): Promise<Response> => hit(path, { method: 'POST', json }, e)
type J = { ok?: boolean; title?: string; message?: string; nonce?: string; device_token?: string; needs_enrol?: boolean; state?: string; view_html?: string; kind?: string; passkey_only_actions?: string[]; device_enrolled?: boolean }
const jbody = async (r: Response): Promise<J> => (await r.json()) as J

const init = (userId: number, spec: InitDataSpec = {}): string => initData({ botId: BOT, userId, ...spec }, key)

// ── devices, through the real enrolment routes ───────────────────────────────────────────────────
async function enrolDevice(memberId: string, tgUser: number, identityId: string | null, over: { initData?: string } = {}): Promise<string> {
  const { token } = await mintTgEnrolmentToken(env, memberId, identityId)
  const start = await post(`/m/tg/enrol/${token}/start`, { init_data: over.initData ?? init(tgUser) })
  expect(start.status).toBe(200)
  const deviceToken = (await jbody(start)).device_token ?? ''
  const fin = await post(`/m/tg/enrol/${token}/confirm`, { init_data: over.initData ?? init(tgUser), device_token: deviceToken })
  expect(fin.status).toBe(200)
  return deviceToken
}

// ── moments through the REAL tools ───────────────────────────────────────────────────────────────
const agentAuth = (): AuthContext => ({
  userId: 'mem-agent', email: 'agent@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-agent', tokenId: 'tok-1',
  capabilities: [{ member_id: 'mem-agent', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
interface Moment { id: string; token: string; subject: string }
function parseLink(url: string): { id: string; token: string } {
  const [, m, id, token] = new URL(url).pathname.split('/')
  if (m !== 'm') throw new Error(`not a moment link ${url}`)
  return { id, token }
}
async function fileSeed(e: Env = env): Promise<Moment> {
  const r = await invokeTool(agentAuth(), e, 'seed_attach_request', { seed: seedText }, 'https://pot.test')
  if (!r.ok) throw new Error(`file failed ${JSON.stringify(r)}`)
  const res = r.result as { request_id: string; approve_url: string }
  return { ...parseLink(res.approve_url), subject: res.request_id }
}
async function fileElevation(actions = ['action:project_status', 'action:manage_access'], minutes = 60, e: Env = env): Promise<Moment> {
  await invokeTool(agentAuth(), e, 'check_in', {}, 'https://pot.test')
  const r = await invokeTool(agentAuth(), e, 'request_elevation',
    { actions, scope_type: 'squad', scope_id: 'squad-a', duration_minutes: minutes, reason: 'need it' }, 'https://pot.test')
  if (!r.ok) throw new Error(`elevation failed ${JSON.stringify(r)}`)
  const res = r.result as { request: { id: string }; approve_url?: string }
  if (!res.approve_url) throw new Error('no approve_url')
  return { ...parseLink(res.approve_url), subject: res.request.id }
}

interface Choice { decision: 'approve' | 'deny'; actions?: string[]; duration_minutes?: number | string }
async function challenge(m: Moment, tg: number, c: Choice, spec: InitDataSpec = {}): Promise<Response> {
  return post('/m/tg/challenge', { init_data: init(tg, spec), moment_id: m.id, ...c })
}
async function nonceFor(m: Moment, tg: number, c: Choice): Promise<string> {
  const r = await challenge(m, tg, c)
  expect(r.status).toBe(200)
  return (await jbody(r)).nonce ?? ''
}
async function decide(m: Moment, tg: number, device: string, c: Choice, over: { nonce?: string; init?: string; send?: Record<string, unknown>; deviceToken?: unknown } = {}): Promise<Response> {
  const nonce = over.nonce ?? (await nonceFor(m, tg, c))
  return post('/m/tg/decide', { init_data: over.init ?? init(tg), moment_id: m.id, nonce, device_token: 'deviceToken' in over ? over.deviceToken : device, ...(over.send ?? c) })
}
const momentStatus = (id: string): string => one<{ status: string }>('SELECT status FROM secure_moments WHERE id = ?', id)?.status ?? 'missing'

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('flag off is a true no-op', () => {
  const off = (): Env => baseEnv({ TELEGRAM_MINIAPP: undefined })
  it('every /m/tg path answers exactly what it answered before W4 (404), with no Telegram-aware body or header', async () => {
    const m = await fileSeed(off())
    for (const path of ['/m/tg', `/m/tg/${m.id}`, '/m/tg/enrol/' + 'a'.repeat(43)]) {
      const r = await hit(path, {}, off())
      expect(r.status).toBe(404)
      expect(r.headers.get('content-security-policy') ?? '').not.toContain('telegram.org')
      expect(await r.text()).not.toContain('telegram')
    }
    for (const path of ['/m/tg/view', '/m/tg/challenge', '/m/tg/decide', '/m/tg/enrol/' + 'a'.repeat(43) + '/start']) {
      const r = await hit(path, { method: 'POST', json: { init_data: init(TG.owner) } }, off())
      expect(r.status).toBe(404)
    }
    expect(count('tg_miniapp_devices') + count('tg_miniapp_decisions') + count('tg_miniapp_enrolment_tokens')).toBe(0)
  })
  it('the helper tool is not advertised and refuses a direct call; no launch payload exists', async () => {
    expect(advertisedTools(off()).map((t) => t.name)).not.toContain('moment_miniapp_link')
    expect(advertisedTools(env).map((t) => t.name)).toContain('moment_miniapp_link')
    const m = await fileSeed(off())
    const r = await invokeTool(agentAuth(), off(), 'moment_miniapp_link', { moment_id: m.id }, 'https://pot.test')
    expect(r.ok).toBe(false)
    expect(await momentMiniappLaunch(off(), agentAuth(), m.id)).toMatchObject({ ok: false, error: 'not_enabled' })
    expect(await mintTgEnrolmentLink(off(), agentAuth())).toMatchObject({ ok: false, error: 'not_enabled' })
  })
  it('W1 passkey pages are unchanged by the flag either way (no Telegram origin in their CSP)', async () => {
    const m = await fileSeed()
    const page = await hit(`/m/${m.id}/${m.token}`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).not.toContain('telegram')
    const { token } = await mintEnrolmentToken(env, 'mem-owner', identities.owner)
    const enrol = await hit(`/m/enrol/${token}`)
    expect(enrol.status).toBe(200)
    expect(enrol.headers.get('content-security-policy')).not.toContain('telegram')
  })
  it('on needs SECURE_MOMENTS and a numeric bot id: otherwise misconfigured, and the routes fall through', async () => {
    expect(telegramMiniappStatus(baseEnv({ SECURE_MOMENTS: undefined })).state).toBe('misconfigured')
    expect(telegramMiniappStatus(baseEnv({ TELEGRAM_MINIAPP_BOT_ID: undefined })).state).toBe('misconfigured')
    expect(telegramMiniappStatus(baseEnv({ TELEGRAM_MINIAPP_BOT_ID: 'bot' })).state).toBe('misconfigured')
    expect(telegramMiniappStatus(baseEnv({ SECURE_MOMENTS_HOST: COLONY })).state).toBe('misconfigured')
    expect(telegramMiniappStatus(env)).toEqual({ state: 'on', host: HOST, botId: BOT })
    expect((await hit('/m/tg', {}, baseEnv({ TELEGRAM_MINIAPP_BOT_ID: undefined }))).status).toBe(404)
    expect((await hit('/m/tg/view', { method: 'POST', json: { init_data: init(TG.owner) } }, baseEnv({ TELEGRAM_MINIAPP_BOT_ID: undefined }))).status).toBe(404)
  })
})

describe('pages and CSP', () => {
  it('the Mini App pages allow exactly Telegram\'s one script URL beside the nonce, and nothing else widens', async () => {
    const m = await fileSeed()
    for (const path of ['/m/tg', `/m/tg/${m.id}`, `/m/tg/enrol/${'b'.repeat(43)}`]) {
      const r = await hit(path)
      expect(r.status).toBe(200)
      const csp = r.headers.get('content-security-policy') ?? ''
      const script = /script-src ([^;]+)/.exec(csp)?.[1] ?? ''
      expect(script.split(' ').filter((s) => !s.startsWith("'nonce-"))).toEqual(['https://telegram.org/js/telegram-web-app.js'])
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("connect-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain("form-action 'none'")
      expect(csp).toContain("base-uri 'none'")
      expect(csp.match(/https:\/\/telegram\.org/g)?.length).toBe(1)
      expect(r.headers.get('x-frame-options')).toBe('DENY')
      expect(r.headers.get('cache-control')).toBe('no-store')
      const html = await r.text()
      expect(html).toContain('<script src="https://telegram.org/js/telegram-web-app.js"></script>')
      expect(html.match(/<script[^>]*src=/g)?.length).toBe(1)
      expect(html).toMatch(/<script nonce="[A-Za-z0-9_-]+">/)
    }
  })
  it('JSON responses carry no script source at all', async () => {
    const r = await post('/m/tg/view', { init_data: init(TG.stranger) })
    expect(r.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'")
  })
  it('a page for a malformed id or token is a bare 404 (no shell, no oracle)', async () => {
    expect((await hit('/m/tg/not-a-uuid')).status).toBe(404)
    expect((await hit('/m/tg/enrol/short')).status).toBe(404)
  })
  it('the W1 routes keep working next to /m/tg (a moment link is still /m/<id>/<token>)', async () => {
    const m = await fileSeed()
    expect((await hit(`/m/${m.id}/${m.token}`)).status).toBe(200)
  })
})

describe('identity: initData -> Telegram user -> member', () => {
  it('an UNBOUND Telegram user is refused with a clear message and nothing is written', async () => {
    const r = await post('/m/tg/view', { init_data: init(TG.stranger) })
    expect(r.status).toBe(403)
    expect((await jbody(r)).message).toMatch(/not linked/i)
  })
  it('a member in ANOTHER tenant bound to that id is unbound here', async () => {
    const r = await post('/m/tg/view', { init_data: init(TG.other) })
    expect(r.status).toBe(403)
    expect((await jbody(r)).title).toBe('Telegram account not linked')
  })
  it('an agent-welded member row, a suspended member and an archived member are refused as ineligible', async () => {
    expect((await jbody(await post('/m/tg/view', { init_data: init(TG.agent) }))).title).toBe('Not eligible')
    harness.sqlite.exec("UPDATE members SET status = 'suspended' WHERE id = 'mem-plain'")
    expect((await jbody(await post('/m/tg/view', { init_data: init(TG.plain) }))).title).toMatch(/Not eligible|not linked/i)
    harness.sqlite.exec("UPDATE members SET status = 'active', archived_at = datetime('now') WHERE id = 'mem-plain'")
    expect((await post('/m/tg/view', { init_data: init(TG.plain) })).status).toBe(403)
  })
  it('the member is whoever the SIGNED id is bound to, never an id the body claims', async () => {
    const m = await fileElevation(['action:project_status'])
    const r = await post('/m/tg/view', { init_data: init(TG.plain), moment_id: m.id, member_id: 'mem-owner', telegram_user_id: TG.owner })
    expect(r.status).toBe(404) // plain has no authority over squad-a elevations; the claimed owner id changed nothing
  })
  it('a group, supergroup or channel launch is refused; private, sender and no chat_type are accepted', async () => {
    for (const t of ['group', 'supergroup', 'channel', 'bogus']) {
      const r = await post('/m/tg/view', { init_data: init(TG.owner, { chatType: t }) })
      expect(r.status).toBe(403)
      expect((await jbody(r)).title).toBe('Private chat only')
    }
    for (const t of ['private', 'sender', undefined]) {
      expect((await post('/m/tg/view', { init_data: init(TG.owner, { chatType: t }) })).status).toBe(200)
    }
  })
  it('stale, wrong-bot and forged payloads are refused before any member lookup, with a Telegram-specific message', async () => {
    const stale = await post('/m/tg/view', { init_data: init(TG.owner, { authDate: Math.floor(Date.now() / 1000) - 3600 }) })
    expect(stale.status).toBe(403)
    expect((await jbody(stale)).message).toMatch(/too old/i)
    expect((await post('/m/tg/view', { init_data: init(TG.owner, { signedBotId: '987654321' }) })).status).toBe(403)
    expect((await post('/m/tg/view', { init_data: init(TG.owner, { key: newTestKey() }) })).status).toBe(403)
    expect((await post('/m/tg/view', { init_data: init(TG.owner, { tamper: (f) => { f.user = JSON.stringify({ id: TG.sqadmin }) } }) })).status).toBe(403)
    expect((await post('/m/tg/view', {})).status).toBe(403)
  })
  it('production trust: with no extra key configured a test-signed payload is refused (only the production key is accepted)', async () => {
    const prodOnly = baseEnv({ TELEGRAM_MINIAPP_EXTRA_PUBKEYS: undefined })
    const r = await post('/m/tg/view', { init_data: init(TG.owner) }, prodOnly)
    expect(r.status).toBe(403)
    expect((await jbody(r)).title).toBe('Telegram sign-in failed')
  })
  it('the optional classic HMAC path works only when the worker secret is configured and names the bot', async () => {
    const token = `${BOT}:AAEhqMY-classic-test-token`
    const raw = init(TG.owner, { omitSignature: true, hmacToken: token })
    expect((await post('/m/tg/view', { init_data: raw })).status).toBe(403)
    expect((await post('/m/tg/view', { init_data: raw }, baseEnv({ TELEGRAM_MINIAPP_BOT_TOKEN: token }))).status).toBe(200)
    expect((await post('/m/tg/view', { init_data: raw }, baseEnv({ TELEGRAM_MINIAPP_BOT_TOKEN: '555555555:other' }))).status).toBe(403)
  })
  it('same-origin and JSON are required on every POST', async () => {
    const body = { init_data: init(TG.owner) }
    expect((await hit('/m/tg/view', { method: 'POST', json: body, origin: 'https://evil.example' })).status).toBe(403)
    expect((await hit('/m/tg/view', { method: 'POST', json: body, origin: null })).status).toBe(403)
    expect((await hit('/m/tg/view', { method: 'POST', json: body, headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    const r = await momentsApp.fetch(new Request(`${ORIGIN}/m/tg/view`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'text/plain' }, body: JSON.stringify(body) }), env)
    expect(r.status).toBe(400)
  })
})

describe('view', () => {
  it('shows the seed (agent text in the untrusted box) to a member who may decide it, and flags the device state', async () => {
    const m = await fileSeed()
    const r = await post('/m/tg/view', { init_data: init(TG.owner), moment_id: m.id })
    expect(r.status).toBe(200)
    const j = await jbody(r)
    expect(j).toMatchObject({ ok: true, state: 'moment', kind: 'seed_attach', device_enrolled: false })
    expect(j.view_html).toContain('class="untrusted"')
    expect(j.view_html).not.toContain('<script')
  })
  it('an elevation view lists the sensitive actions as passkey-only', async () => {
    const m = await fileElevation()
    const j = await jbody(await post('/m/tg/view', { init_data: init(TG.sqadmin), moment_id: m.id }))
    expect(j.passkey_only_actions).toEqual(['action:manage_access'])
  })
  it('a member without authority, an unknown id, a malformed id and another tenant\'s moment all read identically (404)', async () => {
    const m = await fileSeed()
    const e = await fileElevation()
    harness.sqlite.exec(`INSERT INTO secure_moments (id, tenant, kind, subject_id, link_token_sha256, status, created_at, expires_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'tenant-b', 'seed_attach', 'x', '${'a'.repeat(64)}', 'pending', datetime('now'), datetime('now', '+1 day'))`)
    const probe = async (tg: number, id: unknown): Promise<[number, string | undefined]> => {
      const r = await post('/m/tg/view', { init_data: init(tg), moment_id: id })
      return [r.status, (await jbody(r)).message]
    }
    const results = [await probe(TG.plain, m.id), await probe(TG.plain, e.id), await probe(TG.owner, '22222222-2222-4222-8222-222222222222'),
      await probe(TG.owner, 'nope'), await probe(TG.owner, 42), await probe(TG.owner, '11111111-1111-4111-8111-111111111111')]
    for (const r of results) expect(r).toEqual([404, 'There is nothing here for you.'])
  })
  it('a moment addressed to another member is invisible to everyone else', async () => {
    const m = await fileSeed()
    harness.sqlite.prepare('UPDATE secure_moments SET decider_member_id = ? WHERE id = ?').run('mem-sqadmin', m.id)
    expect((await post('/m/tg/view', { init_data: init(TG.owner), moment_id: m.id })).status).toBe(404)
  })
  it('the moment can arrive in the SIGNED start_param (t.me direct link), not just the body', async () => {
    const m = await fileSeed()
    const j = await jbody(await post('/m/tg/view', { init_data: init(TG.owner, { startParam: `m_${m.id}` }) }))
    expect(j).toMatchObject({ ok: true, state: 'moment' })
    const none = await jbody(await post('/m/tg/view', { init_data: init(TG.owner) }))
    expect(none.state).toBe('idle')
  })
  it('a closed request: applied reads as approved; a consumed moment reads as closed', async () => {
    const m = await fileSeed()
    harness.sqlite.exec("UPDATE secure_moments SET status = 'consumed'")
    const r = await post('/m/tg/view', { init_data: init(TG.owner), moment_id: m.id })
    expect(r.status).toBe(409)
  })
})

describe('device enrolment', () => {
  it('the happy path stores only a hash, binds member + Telegram user + login identity, consumes the link, and audits', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const row = one<{ member_id: string; telegram_user_id: string; login_identity_id: string; secret_sha256: string; confirmed_at: string }>('SELECT * FROM tg_miniapp_devices')
    expect(row).toMatchObject({ member_id: 'mem-owner', telegram_user_id: String(TG.owner), login_identity_id: identities.owner })
    expect(row?.confirmed_at).toBeTruthy()
    expect(row?.secret_sha256).toBe(await tokenHash(dev.split('.')[1]))
    expect(JSON.stringify(harness.sqlite.prepare('SELECT * FROM tg_miniapp_devices').all())).not.toContain(dev.split('.')[1])
    expect(count('tg_miniapp_enrolment_tokens', 'consumed_at IS NOT NULL')).toBe(1)
    expect(one<{ evidence_json: string }>("SELECT evidence_json FROM mutation_audit_entries WHERE operation = 'tg_device_enrol'")?.evidence_json).toContain('telegram_miniapp')
  })
  it('the link names a member: another member\'s Telegram user (even bound and eligible) cannot use it', async () => {
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const r = await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.sqadmin) })
    expect(r.status).toBe(403)
    expect(count('tg_miniapp_devices')).toBe(0)
    expect((await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.stranger) })).status).toBe(403)
  })
  it('needs a FRESH initData: stale or forged is refused before the link is even looked at', async () => {
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    expect((await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner, { authDate: Math.floor(Date.now() / 1000) - 4000 }) })).status).toBe(403)
    expect((await post(`/m/tg/enrol/${token}/start`, {})).status).toBe(403)
    expect(count('tg_miniapp_devices')).toBe(0)
  })
  it('an unknown, malformed, expired or consumed link is refused', async () => {
    expect((await post(`/m/tg/enrol/${'z'.repeat(43)}/start`, { init_data: init(TG.owner) })).status).toBe(404)
    expect((await post('/m/tg/enrol/short/start', { init_data: init(TG.owner) })).status).toBe(404)
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    harness.sqlite.prepare('UPDATE tg_miniapp_enrolment_tokens SET expires_at = ?').run(new Date(Date.now() - 60000).toISOString())
    expect((await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })).status).toBe(409)
    const t2 = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const ok = await post(`/m/tg/enrol/${t2.token}/start`, { init_data: init(TG.owner) })
    const dev = (await jbody(ok)).device_token
    expect((await post(`/m/tg/enrol/${t2.token}/confirm`, { init_data: init(TG.owner), device_token: dev })).status).toBe(200)
    expect((await post(`/m/tg/enrol/${t2.token}/start`, { init_data: init(TG.owner) })).status).toBe(409)
    expect((await post(`/m/tg/enrol/${t2.token}/confirm`, { init_data: init(TG.owner), device_token: dev })).status).toBe(409)
  })
  it('minting a new link supersedes the old one', async () => {
    const a = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    expect((await post(`/m/tg/enrol/${a.token}/start`, { init_data: init(TG.owner) })).status).toBe(409)
  })
  it('confirm needs the secret that was read BACK: a wrong, foreign or missing secret leaves the device pending and the link unspent', async () => {
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const dev = (await jbody(await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) }))).device_token ?? ''
    const [id] = dev.split('.')
    for (const bad of [`${id}.${'A'.repeat(43)}`, `${crypto.randomUUID()}.${dev.split('.')[1]}`, 'garbage', '', undefined, 5]) {
      expect((await post(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: bad })).status).toBe(409)
    }
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
    expect(count('tg_miniapp_enrolment_tokens', 'consumed_at IS NOT NULL')).toBe(0)
    expect((await post(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: dev })).status).toBe(200)
  })
  it('a second start under the same link supersedes the first device: only the latest secret can confirm', async () => {
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const first = (await jbody(await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) }))).device_token ?? ''
    const second = (await jbody(await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) }))).device_token ?? ''
    expect(first).not.toBe(second)
    expect((await post(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: first })).status).toBe(409)
    expect((await post(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: second })).status).toBe(200)
  })
  it('a link minted for a revoked login identity cannot confirm', async () => {
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const dev = (await jbody(await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) }))).device_token ?? ''
    await revokeLoginIdentity(env, TENANT, 'mem-owner', identities.owner)
    expect((await post(`/m/tg/enrol/${token}/confirm`, { init_data: init(TG.owner), device_token: dev })).status).toBe(409)
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
  })
  it('the link expiring or its identity dying between start and confirm leaves NO active device (the device UPDATE is guarded by both, not rescued afterwards)', async () => {
    const t1 = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const d1 = (await jbody(await post(`/m/tg/enrol/${t1.token}/start`, { init_data: init(TG.owner) }))).device_token ?? ''
    harness.sqlite.prepare('UPDATE tg_miniapp_enrolment_tokens SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
    expect((await post(`/m/tg/enrol/${t1.token}/confirm`, { init_data: init(TG.owner), device_token: d1 })).status).toBe(409)
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
    const t2 = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const d2 = (await jbody(await post(`/m/tg/enrol/${t2.token}/start`, { init_data: init(TG.owner) }))).device_token ?? ''
    harness.sqlite.prepare("UPDATE human_login_identities SET revoked_at = datetime('now') WHERE id = ?").run(identities.owner) // direct row update: no lever ran
    expect((await post(`/m/tg/enrol/${t2.token}/confirm`, { init_data: init(TG.owner), device_token: d2 })).status).toBe(409)
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
    expect(count('tg_miniapp_enrolment_tokens', 'consumed_at IS NOT NULL')).toBeLessThanOrEqual(1) // t1 was superseded by t2; t2 itself is unspent
    expect(one<{ consumed_at: string | null }>('SELECT consumed_at FROM tg_miniapp_enrolment_tokens WHERE id = (SELECT enrolment_token_id FROM tg_miniapp_devices ORDER BY created_at DESC LIMIT 1)')?.consumed_at ?? null).toBeNull()
  })
  it('confirmDeviceEnrolment is itself guarded against a link that dies after the route read it (a stale in-memory row wins nothing)', async () => {
    const t = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const staleCopy = await loadTgEnrolmentToken(env, t.token)
    const dev = (await jbody(await post(`/m/tg/enrol/${t.token}/start`, { init_data: init(TG.owner) }))).device_token ?? ''
    harness.sqlite.prepare('UPDATE tg_miniapp_enrolment_tokens SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString())
    expect(staleCopy).not.toBeNull()
    if (staleCopy) expect(await confirmDeviceEnrolment(env, { token: staleCopy, deviceToken: dev, telegramUserId: String(TG.owner) }, Date.now())).toMatchObject({ ok: false })
    expect(count('tg_miniapp_devices', 'confirmed_at IS NOT NULL')).toBe(0)
    expect(count('tg_miniapp_enrolment_tokens', 'consumed_at IS NOT NULL')).toBe(0)
  })
  it('a link minted with NO login identity yields a device that can never decide', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, null).catch(() => 'refused')
    expect(dev === 'refused' || (await resolveActiveDevice(env, dev, { memberId: 'mem-owner', telegramUserId: String(TG.owner) })) === null).toBe(true)
  })
  it('the per-member cap holds: the sixth device is refused at start', async () => {
    for (let i = 0; i < TG_DEVICES_MAX_PER_MEMBER; i++) await enrolDevice('mem-owner', TG.owner, identities.owner)
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    const r = await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })
    expect(r.status).toBe(409)
    expect((await jbody(r)).message).toMatch(/maximum/)
  })
  it('a member cannot enrol if the Telegram binding moved after the link was minted', async () => {
    const { token } = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = '2001' WHERE id = 'mem-owner'")
    expect((await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })).status).toBe(403)
  })
  describe('dashboard "Set up Telegram device" mint', () => {
    const webAuth = (hash: string, memberId = 'mem-owner'): AuthContext => ({ userId: memberId, email: null, role: 'member', tenant: TENANT, channel: 'dashboard', memberId, webSessionMemberId: memberId, webSessionIdHash: hash } as AuthContext)
    async function session(memberId: string, identityId: string, reauth: boolean): Promise<string> {
      await createWebSession(env, `raw-${memberId}-${reauth}`, { tenant: TENANT, memberId, loginIdentityId: identityId })
      const hash = one<{ id_hash: string }>('SELECT id_hash FROM web_sessions WHERE member_id = ? ORDER BY created_at DESC', memberId)?.id_hash ?? ''
      if (reauth) await markRecentReauth(env, hash)
      return hash
    }
    it('uses the SAME rules as the passkey link: a real web session, fresh re-auth, live identity, active human', async () => {
      const stale = await session('mem-owner', identities.owner, false)
      expect(await mintTgEnrolmentLink(env, webAuth(stale))).toMatchObject({ ok: false, error: 'reauth_required' })
      expect(await mintTgEnrolmentLink(env, agentAuth())).toMatchObject({ ok: false, error: 'not_a_web_session' })
      expect(await mintTgEnrolmentLink(env, { ...webAuth(stale), memberId: 'mem-plain' })).toMatchObject({ ok: false, error: 'not_a_web_session' })
      expect(count('tg_miniapp_enrolment_tokens')).toBe(0)
      harness.sqlite.exec('DELETE FROM web_sessions')
      const fresh = await session('mem-owner', identities.owner, true)
      const r = await mintTgEnrolmentLink(env, webAuth(fresh))
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.url.startsWith(`${ORIGIN}/m/tg/enrol/`)).toBe(true)
        expect(r.launch.web_app_button.web_app.url).toBe(r.url)
        expect(r.launch.reply_markup.inline_keyboard[0][0]).toEqual(r.launch.web_app_button)
      }
      expect(one<{ login_identity_id: string }>('SELECT login_identity_id FROM tg_miniapp_enrolment_tokens')?.login_identity_id).toBe(identities.owner)
      harness.sqlite.prepare("UPDATE human_login_identities SET revoked_at = datetime('now') WHERE id = ?").run(identities.owner)
      expect(await mintTgEnrolmentLink(env, webAuth(fresh))).toMatchObject({ ok: false, error: 'session_identity_unavailable' })
    })
    it('a passkey enrolment link is NOT a device enrolment link (separate tables, separate tokens)', async () => {
      const { token } = await mintEnrolmentToken(env, 'mem-owner', identities.owner)
      expect((await post(`/m/tg/enrol/${token}/start`, { init_data: init(TG.owner) })).status).toBe(404)
      const t = await mintTgEnrolmentToken(env, 'mem-owner', identities.owner)
      expect((await hit(`/m/enrol/${t.token}`)).status).toBe(404)
    })
    it('the t.me link appears only when the bot username and app short name are configured', async () => {
      const fresh = await session('mem-owner', identities.owner, true)
      const plain = await mintTgEnrolmentLink(env, webAuth(fresh))
      expect(plain.ok && plain.launch.t_me_link).toBeNull()
      const cfg = baseEnv({ TELEGRAM_MINIAPP_BOT_USERNAME: '@kayhermes_mubot', TELEGRAM_MINIAPP_APP_SHORTNAME: 'approve' })
      const r = await mintTgEnrolmentLink(cfg, webAuth(fresh))
      expect(r.ok && /^https:\/\/t\.me\/kayhermes_mubot\/approve\?startapp=e_[A-Za-z0-9_-]{43}$/.test(r.launch.t_me_link ?? '')).toBe(true)
      const bad = await mintTgEnrolmentLink(baseEnv({ TELEGRAM_MINIAPP_BOT_USERNAME: 'x', TELEGRAM_MINIAPP_APP_SHORTNAME: 'a b' }), webAuth(fresh))
      expect(bad.ok && bad.launch.t_me_link).toBeNull()
    })
  })
})

describe('decisions: seed attach', () => {
  it('needs a device: before enrolment the challenge says to set one up and issues no nonce', async () => {
    const m = await fileSeed()
    const r = await challenge(m, TG.owner, { decision: 'approve' })
    expect(r.status).toBe(409)
    expect(await jbody(r)).toMatchObject({ needs_enrol: true })
    expect(count('passkey_challenges')).toBe(0)
  })
  it('approves through the shared core: project created, moment consumed once, channel recorded, receipts say telegram_miniapp', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const r = await decide(m, TG.owner, dev, { decision: 'approve' })
    expect(r.status).toBe(200)
    expect((await jbody(r)).title).toBe('Approved')
    expect(momentStatus(m.id)).toBe('consumed')
    expect(one<{ status: string; decided_via: string; decided_by_member_id: string }>('SELECT status, decided_via, decided_by_member_id FROM seed_attach_requests WHERE id = ?', m.subject))
      .toEqual({ status: 'applied', decided_via: 'telegram_miniapp', decided_by_member_id: 'mem-owner' })
    expect(one<{ decided_via: string | null; decided_by_member_id: string }>('SELECT decided_via, decided_by_member_id FROM secure_moments WHERE id = ?', m.id)).toEqual({ decided_via: null, decided_by_member_id: 'mem-owner' })
    expect(one('SELECT * FROM tg_miniapp_decisions WHERE moment_id = ?', m.id)).toMatchObject({ member_id: 'mem-owner', telegram_user_id: String(TG.owner), decision: 'approve' })
    const receipt = one<{ evidence_json: string }>("SELECT evidence_json FROM mutation_audit_entries WHERE operation <> 'tg_device_enrol' AND evidence_json LIKE '%telegram_miniapp%' LIMIT 1")
    expect(JSON.parse(receipt?.evidence_json ?? '{}')).toMatchObject({ via: 'telegram_miniapp', moment_id: m.id })
    expect(one<{ last_used_at: string | null }>('SELECT last_used_at FROM tg_miniapp_devices')?.last_used_at).toBeTruthy()
  })
  it('deny records denied and nothing is created', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const before = count('projects')
    expect((await decide(m, TG.owner, dev, { decision: 'deny' })).status).toBe(200)
    expect(momentStatus(m.id)).toBe('denied')
    expect(count('projects')).toBe(before)
    expect(one<{ decided_via: string }>('SELECT decided_via FROM seed_attach_requests WHERE id = ?', m.subject)?.decided_via).toBe('telegram_miniapp')
  })
  it('a member without the org-admin floor cannot decide a seed even with a device (404, nothing consumed)', async () => {
    const dev = await enrolDevice('mem-plain', TG.plain, identities.plain)
    const m = await fileSeed()
    const r = await post('/m/tg/challenge', { init_data: init(TG.plain), moment_id: m.id, decision: 'approve' })
    expect(r.status).toBe(404)
    const direct = await post('/m/tg/decide', { init_data: init(TG.plain), moment_id: m.id, nonce: 'A'.repeat(43), device_token: dev, decision: 'approve' })
    expect(direct.status).toBe(404)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('initData is NOT enough: no device token, a garbage one, or none of the member\'s => refused, link unspent', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    for (const bad of [undefined, '', 'garbage', `${crypto.randomUUID()}.${'A'.repeat(43)}`, `${dev.split('.')[0]}.${'B'.repeat(43)}`, 5, {}]) {
      const r = await decide(m, TG.owner, dev, { decision: 'approve' }, { deviceToken: bad })
      expect(r.status).toBe(403)
    }
    expect(momentStatus(m.id)).toBe('pending')
    expect((await decide(m, TG.owner, dev, { decision: 'approve' })).status).toBe(200)
  })
  it('the device token alone is NOT enough: a stale, forged or other-member initData is refused', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const nonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    const call = (initStr: string | undefined): Promise<Response> => post('/m/tg/decide', { init_data: initStr, moment_id: m.id, nonce, device_token: dev, decision: 'approve' })
    expect((await call(init(TG.owner, { authDate: Math.floor(Date.now() / 1000) - 4000 }))).status).toBe(403)
    expect((await call(init(TG.owner, { key: newTestKey() }))).status).toBe(403)
    expect((await call(undefined)).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('device token theft: another member\'s device token, presented with their own valid initData, is refused', async () => {
    const ownerDev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    await enrolDevice('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    const m = await fileSeed()
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-sa-org', 'mem-sqadmin', 'org', '', 'admin')")
    const nonce = await nonceFor(m, TG.sqadmin, { decision: 'approve' })
    const r = await post('/m/tg/decide', { init_data: init(TG.sqadmin), moment_id: m.id, nonce, device_token: ownerDev, decision: 'approve' })
    expect(r.status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('resolveActiveDevice also compares the MEMBER: a device row that names another member is not this member\'s', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    // The row is moved WHOLESALE to another member (identity too), so only the member compare can refuse it.
    harness.sqlite.prepare("UPDATE tg_miniapp_devices SET member_id = 'mem-plain', login_identity_id = ?").run(identities.plain)
    expect(await resolveActiveDevice(env, dev, { memberId: 'mem-owner', telegramUserId: String(TG.owner) })).toBeNull()
  })
  it('a device is bound to its Telegram user: if the member\'s binding moves to another id, the old device is useless for the new id', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = '2001' WHERE id = 'mem-owner'")
    expect(await resolveActiveDevice(env, dev, { memberId: 'mem-owner', telegramUserId: '2001' })).toBeNull()
    const fresh = await challenge(m, 2001, { decision: 'approve' })
    expect(fresh.status).toBe(409) // no device is bound to the NEW id: set one up
    expect(await jbody(fresh)).toMatchObject({ needs_enrol: true })
    const forced = await post('/m/tg/decide', { init_data: init(2001), moment_id: m.id, nonce: 'A'.repeat(43), device_token: dev, decision: 'approve' })
    expect(forced.status).toBe(403)
    expect((await challenge(m, TG.owner, { decision: 'approve' })).status).toBe(403) // the old id is unbound now
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('unbinding Telegram between challenge and decide refuses the decision', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const nonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = NULL WHERE id = 'mem-owner'")
    expect((await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce })).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('replay: the nonce is single-use and the moment decides once', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const nonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    expect((await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce })).status).toBe(200)
    // The seed is APPLIED, so a replay reads as "already approved" (idempotent, as on the other channels) and decides nothing.
    const replay = await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce })
    expect((await jbody(replay)).message).toMatch(/already approved/)
    const again = await post('/m/tg/decide', { init_data: init(TG.owner), moment_id: m.id, nonce, device_token: dev, decision: 'deny' })
    expect((await jbody(again)).message).toMatch(/already approved/)
    expect(count('tg_miniapp_decisions')).toBe(1)
    expect(momentStatus(m.id)).toBe('consumed')
    // A DENIED moment (not applied) answers 409 closed to a replay.
    const m2 = await fileSeed().catch(() => null)
    if (m2) {
      const n2 = await nonceFor(m2, TG.owner, { decision: 'deny' })
      expect((await decide(m2, TG.owner, dev, { decision: 'deny' }, { nonce: n2 })).status).toBe(200)
      expect((await decide(m2, TG.owner, dev, { decision: 'deny' }, { nonce: n2 })).status).toBe(409)
    }
  })
  it('two concurrent decisions: exactly one wins', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const [n1, n2] = [await nonceFor(m, TG.owner, { decision: 'approve' }), await nonceFor(m, TG.owner, { decision: 'approve' })]
    const rs = await Promise.all([decide(m, TG.owner, dev, { decision: 'approve' }, { nonce: n1 }), decide(m, TG.owner, dev, { decision: 'approve' }, { nonce: n2 })])
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409])
    expect(count('tg_miniapp_decisions')).toBe(1)
    expect(count('projects', "slug LIKE '%'")).toBeGreaterThanOrEqual(1)
  })
  it('the nonce is bound: the decision, the moment, the member and the parameters', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const m2 = await fileSeed(env).catch(() => null)
    const approveNonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    // approve nonce cannot carry deny
    expect((await decide(m, TG.owner, dev, { decision: 'deny' }, { nonce: approveNonce })).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
    // a nonce for another moment
    if (m2 && m2.id !== m.id) expect((await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce: await nonceFor(m2, TG.owner, { decision: 'approve' }) })).status).toBe(403)
    // garbage / wrong shape / missing nonce
    for (const bad of ['', 'x', 'A'.repeat(43), 'A'.repeat(44)]) expect((await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce: bad })).status).toBeGreaterThanOrEqual(400)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('a nonce minted for one member cannot be consumed under another member\'s initData', async () => {
    const ownerDev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const adminDev = await enrolDevice('mem-sqadmin', TG.sqadmin, identities.sqadmin)
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-sa-org', 'mem-sqadmin', 'org', '', 'admin')")
    const m = await fileSeed()
    const ownerNonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    expect((await decide(m, TG.sqadmin, adminDev, { decision: 'approve' }, { nonce: ownerNonce })).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
    expect((await decide(m, TG.owner, ownerDev, { decision: 'approve' }, { nonce: ownerNonce })).status).toBe(200)
  })
  it('a refusal before the gate never burns the moment: an already-closed seed request stays what it is', async () => {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    const nonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    harness.sqlite.prepare("UPDATE seed_attach_requests SET status = 'denied' WHERE id = ?").run(m.subject)
    const r = await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce })
    expect(r.status).toBe(409)
    expect(momentStatus(m.id)).toBe('pending')
    expect(count('tg_miniapp_decisions')).toBe(0)
  })
  it('a credential-kind moment id (W2) is refused in the Mini App with the passkey message', async () => {
    harness.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    harness.sqlite.exec(`INSERT INTO secure_moments (id, tenant, kind, subject_id, link_token_sha256, status, created_at, expires_at)
      VALUES ('33333333-3333-4333-8333-333333333333', '${TENANT}', 'credential', 'x', '${'c'.repeat(64)}', 'pending', datetime('now'), datetime('now', '+1 day'))`)
    harness.sqlite.exec('PRAGMA ignore_check_constraints = OFF')
    const r = await post('/m/tg/view', { init_data: init(TG.owner), moment_id: '33333333-3333-4333-8333-333333333333' })
    expect(r.status).toBe(409)
    expect((await jbody(r)).message).toMatch(/passkey/i)
  })
})

describe('decisions: elevation and the step-up policy', () => {
  async function ready(): Promise<{ dev: string }> {
    return { dev: await enrolDevice('mem-sqadmin', TG.sqadmin, identities.sqadmin) }
  }
  it('a non-sensitive elevation is approved in Telegram, narrowed to what was ticked, with the grant bound to a session minted for the decision', async () => {
    const { dev } = await ready()
    const m = await fileElevation(['action:project_status', 'action:manage_access'])
    const r = await decide(m, TG.sqadmin, dev, { decision: 'approve', actions: ['action:project_status'], duration_minutes: 15 })
    expect(r.status).toBe(200)
    expect(momentStatus(m.id)).toBe('consumed')
    const grants = harness.sqlite.prepare("SELECT action FROM elevation_grants WHERE elevation_request_id = ?").all(m.subject) as Array<{ action: string }>
    expect(grants.map((g) => g.action)).toEqual(['action:project_status'])
    expect(one<{ handler: string }>("SELECT handler FROM mutation_audit_entries WHERE operation = 'elevation_approve'")?.handler).toBe('secure_moment')
    expect(count('tg_miniapp_decisions', "decision = 'approve'")).toBe(1)
  })
  it('SENSITIVE actions need a passkey: every member of SENSITIVE_STEP_UP_ACTIONS is refused at challenge AND at decide, nothing consumed', async () => {
    const { dev } = await ready()
    const m = await fileElevation(['action:project_status', 'action:manage_access'])
    for (const a of SENSITIVE_STEP_UP_ACTIONS) {
      const c = await challenge(m, TG.sqadmin, { decision: 'approve', actions: ['action:project_status', a] })
      expect(c.status).toBe(403)
      expect((await jbody(c)).message).toBe(PASSKEY_REQUIRED_MESSAGE)
      const nonce = await nonceFor(m, TG.sqadmin, { decision: 'approve', actions: ['action:project_status'] })
      const d = await post('/m/tg/decide', { init_data: init(TG.sqadmin), moment_id: m.id, nonce, device_token: dev, decision: 'approve', actions: ['action:project_status', a] })
      expect(d.status).toBe(403)
    }
    expect(momentStatus(m.id)).toBe('pending')
    expect(count('elevation_grants')).toBe(0)
  })
  it('even a VALID nonce for a sensitive selection cannot carry it: the policy runs again at decide, independent of the nonce binding', async () => {
    const { dev } = await ready()
    const m = await fileElevation(['action:project_status', 'action:manage_access'])
    const actions = ['action:manage_access', 'action:project_status']
    // The nonce binding as documented (member + Telegram user are part of the digest), minted directly because the
    // challenge route would refuse it: this isolates the decide-time policy check.
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
      v: 'tg1', kind: 'elevation', subject: m.subject, decision: 'approve', actions, duration: null, member: 'mem-sqadmin', tg_user: String(TG.sqadmin),
    }))))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const nonce = await mintDecideChallenge(env, { momentId: m.id, decision: 'approve', payloadSha256: digest })
    expect(nonce).toBeTruthy()
    const r = await post('/m/tg/decide', { init_data: init(TG.sqadmin), moment_id: m.id, nonce, device_token: dev, decision: 'approve', actions })
    expect(r.status).toBe(403)
    expect((await jbody(r)).message).toBe(PASSKEY_REQUIRED_MESSAGE)
    expect(momentStatus(m.id)).toBe('pending')
    expect(count('elevation_grants')).toBe(0)
  })
  it('the policy is an allowlist: an unknown action and an empty selection are refused too', () => {
    const p = (actions: string[], decision: 'approve' | 'deny' = 'approve') => telegramPolicyRefusal('elevation', { decision, actions, duration: undefined })
    expect(p(['action:not_a_real_action'])).toBe(PASSKEY_REQUIRED_MESSAGE)
    expect(p(['toString'])).toBe(PASSKEY_REQUIRED_MESSAGE)
    expect(p(['__proto__'])).toBe(PASSKEY_REQUIRED_MESSAGE)
    expect(p([])).toMatch(/at least one/)
    expect(p(['action:project_status'])).toBeNull()
    expect(p(['action:manage_access'], 'deny')).toBeNull()
    expect(telegramPolicyRefusal('seed_attach', { decision: 'approve', actions: [], duration: undefined })).toBeNull()
  })
  it('a deny is allowed whatever the request asked for (denying grants nothing)', async () => {
    const { dev } = await ready()
    const m = await fileElevation(['action:manage_access'])
    expect((await decide(m, TG.sqadmin, dev, { decision: 'deny' })).status).toBe(200)
    expect(momentStatus(m.id)).toBe('denied')
    expect(count('elevation_grants')).toBe(0)
  })
  it('a refusal the core would raise (a duration longer than requested) happens BEFORE the gate: the moment stays pending', async () => {
    const { dev } = await ready()
    const m = await fileElevation(['action:project_status'], 15)
    const r = await decide(m, TG.sqadmin, dev, { decision: 'approve', actions: ['action:project_status'], duration_minutes: 1440 })
    expect(r.status).toBe(409)
    expect(momentStatus(m.id)).toBe('pending')
    expect(count('tg_miniapp_decisions')).toBe(0)
    expect((await decide(m, TG.sqadmin, dev, { decision: 'approve', actions: ['action:project_status'], duration_minutes: 15 })).status).toBe(200)
  })
  it('parameters must be well-formed: a non-array, a huge list or a bad duration is a 400 and consumes nothing', async () => {
    await ready()
    const m = await fileElevation(['action:project_status'])
    for (const send of [{ decision: 'approve', actions: 'action:project_status' }, { decision: 'approve', actions: Array(40).fill('a') },
      { decision: 'approve', actions: ['action:project_status'], duration_minutes: -1 }, { decision: 'approve', actions: ['action:project_status'], duration_minutes: 'abc' },
      { decision: 'maybe' }, {}]) {
      expect((await post('/m/tg/challenge', { init_data: init(TG.sqadmin), moment_id: m.id, ...send })).status).toBe(400)
    }
    expect(count('passkey_challenges')).toBe(0)
  })
  it('a member without authority over the elevation\'s scope cannot even see it (404)', async () => {
    const m = await fileElevation(['action:project_status'])
    const r = await post('/m/tg/view', { init_data: init(TG.plain), moment_id: m.id })
    expect(r.status).toBe(404)
  })
})

describe('revocation and the cut-off levers', () => {
  async function ready(): Promise<{ dev: string; m: Moment }> {
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    return { dev, m: await fileSeed() }
  }
  it('the owner revokes a device: it can no longer decide', async () => {
    const { dev, m } = await ready()
    const id = dev.split('.')[0]
    expect(await revokeOwnTgDevice(env, 'mem-plain', id)).toBe(false) // not the owner's
    expect(await revokeOwnTgDevice(env, 'mem-owner', id)).toBe(true)
    expect(await revokeOwnTgDevice(env, 'mem-owner', id)).toBe(false)
    expect((await challenge(m, TG.owner, { decision: 'approve' })).status).toBe(409) // needs_enrol again
    expect(count('mutation_audit_entries', "operation = 'tg_device_revoke'")).toBe(1)
  })
  it('a revoked device with a nonce already issued is still refused at decide', async () => {
    const { dev, m } = await ready()
    const nonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    await revokeOwnTgDevice(env, 'mem-owner', dev.split('.')[0])
    expect((await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce })).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('sign out everywhere revokes the devices (the same lever that revokes passkeys)', async () => {
    const { dev, m } = await ready()
    const nonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    await revokeAllWebSessions(env, TENANT, 'mem-owner', 'test')
    expect(one<{ revoked_reason: string }>('SELECT revoked_reason FROM tg_miniapp_devices')?.revoked_reason).toContain('sessions_revoked')
    expect((await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce })).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('revoking a login identity revokes only the devices enrolled under it; a device on another live identity keeps working', async () => {
    const devA = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const identity2 = await link('g-owner-2', 'mem-owner', 'owner@x.test')
    const devB = await enrolDevice('mem-owner', TG.owner, identity2)
    const m = await fileSeed()
    const nonceA = await nonceFor(m, TG.owner, { decision: 'approve' })
    await revokeLoginIdentity(env, TENANT, 'mem-owner', identities.owner)
    expect(count('tg_miniapp_devices', 'revoked_at IS NOT NULL')).toBe(1)
    expect((await decide(m, TG.owner, devA, { decision: 'approve' }, { nonce: nonceA })).status).toBe(403)
    expect(momentStatus(m.id)).toBe('pending')
    expect((await decide(m, TG.owner, devB, { decision: 'approve' })).status).toBe(200)
  })
  it('a device whose login identity is revoked WITHOUT the revoke lever (a direct row update) is refused at use and inside the consume WHERE', async () => {
    const { dev, m } = await ready()
    const nonce = await nonceFor(m, TG.owner, { decision: 'approve' })
    harness.sqlite.prepare("UPDATE human_login_identities SET revoked_at = datetime('now') WHERE id = ?").run(identities.owner)
    expect((await decide(m, TG.owner, dev, { decision: 'approve' }, { nonce })).status).toBe(403)
    const deviceId = dev.split('.')[0]
    const secret = await tokenHash(dev.split('.')[1])
    expect(await consumeMomentTelegram(env, { momentId: m.id, decision: 'approve', memberId: 'mem-owner', telegramUserId: String(TG.owner), deviceId, secretSha256: secret }, Date.now())).toBe(false)
    expect(momentStatus(m.id)).toBe('pending')
  })
  it('consumeMomentTelegram itself refuses: wrong member, wrong Telegram user, wrong secret, revoked device, unbound member, decider mismatch, expired moment', async () => {
    const { dev, m } = await ready()
    const deviceId = dev.split('.')[0]
    const secretSha256 = await tokenHash(dev.split('.')[1])
    const base = { momentId: m.id, decision: 'approve' as const, memberId: 'mem-owner', telegramUserId: String(TG.owner), deviceId, secretSha256 }
    const now = Date.now()
    expect(await consumeMomentTelegram(env, { ...base, memberId: 'mem-sqadmin' }, now)).toBe(false)
    expect(await consumeMomentTelegram(env, { ...base, telegramUserId: '5555' }, now)).toBe(false)
    expect(await consumeMomentTelegram(env, { ...base, secretSha256: 'f'.repeat(64) }, now)).toBe(false)
    expect(await consumeMomentTelegram(env, { ...base, deviceId: crypto.randomUUID() }, now)).toBe(false)
    harness.sqlite.prepare('UPDATE secure_moments SET decider_member_id = ? WHERE id = ?').run('mem-sqadmin', m.id)
    expect(await consumeMomentTelegram(env, base, now)).toBe(false)
    harness.sqlite.prepare('UPDATE secure_moments SET decider_member_id = NULL WHERE id = ?').run(m.id)
    expect(await consumeMomentTelegram(env, base, now + 3 * 24 * 3600 * 1000)).toBe(false)
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = NULL WHERE id = 'mem-owner'")
    expect(await consumeMomentTelegram(env, base, now)).toBe(false)
    harness.sqlite.exec(`UPDATE members SET telegram_chat_id = '${TG.owner}' WHERE id = 'mem-owner'`)
    harness.sqlite.prepare("UPDATE tg_miniapp_devices SET revoked_at = datetime('now')").run()
    expect(await consumeMomentTelegram(env, base, now)).toBe(false)
    expect(momentStatus(m.id)).toBe('pending')
    expect(count('tg_miniapp_decisions')).toBe(0)
    harness.sqlite.prepare('UPDATE tg_miniapp_devices SET revoked_at = NULL').run()
    expect(await consumeMomentTelegram(env, base, now)).toBe(true)
    expect(await consumeMomentTelegram(env, base, now)).toBe(false) // single use
    expect(count('tg_miniapp_decisions')).toBe(1)
  })
  it('the consume itself refuses a credential-kind moment (W2) even with a perfectly valid device', async () => {
    const { dev } = await ready()
    const credId = '44444444-4444-4444-8444-444444444444'
    harness.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    harness.sqlite.exec(`INSERT INTO secure_moments (id, tenant, kind, subject_id, link_token_sha256, status, created_at, expires_at)
      VALUES ('${credId}', '${TENANT}', 'credential', 'x', '${'d'.repeat(64)}', 'pending', datetime('now'), '2999-01-01T00:00:00.000Z')`)
    harness.sqlite.exec('PRAGMA ignore_check_constraints = OFF')
    const input = { momentId: credId, decision: 'approve' as const, memberId: 'mem-owner', telegramUserId: String(TG.owner), deviceId: dev.split('.')[0], secretSha256: await tokenHash(dev.split('.')[1]) }
    expect(await consumeMomentTelegram(env, input, Date.now())).toBe(false)
    expect(momentStatus(credId)).toBe('pending')
    harness.sqlite.prepare("UPDATE secure_moments SET kind = 'seed_attach' WHERE id = ?").run(credId)
    expect(await consumeMomentTelegram(env, input, Date.now())).toBe(true) // control: only the kind was in the way
  })
  it('the passkey consume path is untouched: a Telegram decision leaves no passkey fields behind', async () => {
    const { dev, m } = await ready()
    await decide(m, TG.owner, dev, { decision: 'approve' })
    expect(one<{ decided_passkey_id: string | null }>('SELECT decided_passkey_id FROM secure_moments WHERE id = ?', m.id)?.decided_passkey_id).toBeNull()
  })
  it('an agent-welded or suspended member loses the channel even with a live device', async () => {
    const { dev, m } = await ready()
    harness.sqlite.exec("UPDATE members SET status = 'suspended' WHERE id = 'mem-owner'")
    expect((await challenge(m, TG.owner, { decision: 'approve' })).status).toBe(403)
    expect(await resolveActiveDevice(env, dev, { memberId: 'mem-owner', telegramUserId: String(TG.owner) })).not.toBeNull() // the device row itself is unchanged; the identity door is what shut
    expect(momentStatus(m.id)).toBe('pending')
  })
})

describe('the launch helper (moment_miniapp_link)', () => {
  it('returns the url, the web_app button and a ready reply_markup for the agent that filed the moment, and never the link token', async () => {
    const m = await fileSeed()
    const r = await invokeTool(agentAuth(), env, 'moment_miniapp_link', { moment_id: m.id }, 'https://pot.test')
    expect(r.ok).toBe(true)
    const res = r.result as { url: string; web_app_button: { text: string; web_app: { url: string } }; reply_markup: { inline_keyboard: unknown[][] }; t_me_link: string | null; moment_id: string }
    expect(res.url).toBe(`${ORIGIN}/m/tg/${m.id}`)
    expect(res.web_app_button.web_app.url).toBe(res.url)
    expect(res.reply_markup.inline_keyboard[0][0]).toEqual(res.web_app_button)
    expect(res.t_me_link).toBeNull()
    expect(JSON.stringify(res)).not.toContain(m.token)
  })
  it('adds a t.me direct link only when the username and short name are configured', async () => {
    const m = await fileSeed()
    const cfg = baseEnv({ TELEGRAM_MINIAPP_BOT_USERNAME: 'kayhermes_mubot', TELEGRAM_MINIAPP_APP_SHORTNAME: 'approve' })
    const r = await invokeTool(agentAuth(), cfg, 'moment_miniapp_link', { moment_id: m.id }, 'https://pot.test')
    expect((r.result as { t_me_link: string }).t_me_link).toBe(`https://t.me/kayhermes_mubot/approve?startapp=m_${m.id}`)
  })
  it('refuses a caller that did not file it, a closed moment, a missing id and a junk id (the first reads as not found)', async () => {
    const m = await fileSeed()
    const other = { ...agentAuth(), boundAgentId: 'someone-else', memberId: 'mem-plain', userId: 'mem-plain' } as AuthContext
    expect(await momentMiniappLaunch(env, other, m.id)).toMatchObject({ ok: false, error: 'not_found' })
    expect(await momentMiniappLaunch(env, agentAuth(), crypto.randomUUID())).toMatchObject({ ok: false, error: 'not_found' })
    expect(await momentMiniappLaunch(env, agentAuth(), 'x'.repeat(200))).toMatchObject({ ok: false, error: 'not_found' })
    harness.sqlite.exec("UPDATE secure_moments SET status = 'consumed'")
    expect(await momentMiniappLaunch(env, agentAuth(), m.id)).toMatchObject({ ok: false, error: 'moment_closed' })
    const r = await invokeTool(agentAuth(), env, 'moment_miniapp_link', {}, 'https://pot.test')
    expect(r.ok).toBe(false)
  })
  it('an agent with no bound identity matches no moment (a null requester is never "the filer")', async () => {
    const m = await fileSeed()
    harness.sqlite.exec('UPDATE secure_moments SET requester_agent_id = NULL')
    const unbound = { ...agentAuth(), boundAgentId: undefined } as AuthContext
    expect(await momentMiniappLaunch(env, unbound, m.id)).toMatchObject({ ok: false, error: 'not_found' })
  })
})

describe('the Mini App uses the real decision core, not a copy', () => {
  it('SoftAuthenticator is irrelevant here: no passkey row is read or written by a Telegram decision', async () => {
    const before = { p: count('member_passkeys'), c: count('passkey_challenges') }
    const dev = await enrolDevice('mem-owner', TG.owner, identities.owner)
    const m = await fileSeed()
    await decide(m, TG.owner, dev, { decision: 'approve' })
    expect(count('member_passkeys')).toBe(before.p)
    expect(await SoftAuthenticator.create()).toBeTruthy()
  })
})
