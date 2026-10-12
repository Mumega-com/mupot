// tests/telegram-miniapp-passkey-link.test.ts — secure moments W4.1: POST /m/tg/<moment>/passkey-link, the
// "Approve with passkey in your browser" fallback. Real migrated schema and the REAL routes. Telegram proves only WHO
// ASKED for the link; the W1 passkey page still decides. Contract: docs/architecture/secure-moments.md (W4.1).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { initData, newTestKey, type InitDataSpec } from './helpers/telegram-initdata'
import { momentsApp } from '../src/secure-moments/routes'
import { reserveRotation, ROTATE_MAX_PER_MOMENT, ROTATE_MIN_INTERVAL_MS } from '../src/secure-moments/rotate'
import { linkLoginIdentity } from '../src/auth/login-identity'

const TENANT = 'tenant-a'
const HOST = 'secure.example.test'
const ORIGIN = `https://${HOST}`
const COLONY = 'colony.example.test'
const MASTER = 'a1'.repeat(32)
const BOT = '123456789'
const BOT_TOKEN = `${BOT}:AAEhqMY-dedicated-miniapp-test-token`
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
    TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: BOT, TELEGRAM_MINIAPP_BOT_TOKEN: BOT_TOKEN, TELEGRAM_MINIAPP_EXTRA_PUBKEYS: key.publicKeyHex,
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
      ('mem-agent', 'agent@x.test', 'Agent Member', 'active', '${TENANT}', '${TG.agent}'),
      ('mem-other', 'other@y.test', 'Other Tenant', 'active', 'tenant-b', '${TG.other}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-x', 'mem-agent', datetime('now'));
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('tok-1', 'mem-agent', 'hash-1', 'primary', 'workspace', '${TENANT}', 'agent-x', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-p', 'mem-plain', 'squad', 'squad-a', 'member');
  `)
  env = baseEnv()
  identities.owner = await link('g-owner', 'mem-owner', 'owner@x.test')
})
afterEach(() => { harness.close(); vi.restoreAllMocks(); vi.useRealTimers() })

interface Req { origin?: string | null; host?: string }
async function hit(path: string, json: unknown, r: Req = {}, e: Env = env): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json' })
  const origin = r.origin === undefined ? ORIGIN : r.origin
  if (origin) headers.set('origin', origin)
  return momentsApp.fetch(new Request(`https://${r.host ?? HOST}${path}`, { method: 'POST', headers, body: JSON.stringify(json) }), e)
}
const plink = (id: string, json: unknown, e: Env = env): Promise<Response> => hit(`/m/tg/${id}/passkey-link`, json, {}, e)
type J = { ok?: boolean; title?: string; message?: string; url?: string; expires_at?: string }
const jbody = async (r: Response): Promise<J> => (await r.json()) as J
const init = (userId: number, spec: InitDataSpec = {}): string => initData({ botId: BOT, userId, ...spec }, key)

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
async function fileElevation(actions = ['action:project_status']): Promise<Moment> {
  await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.test')
  const r = await invokeTool(agentAuth(), env, 'request_elevation',
    { actions, scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 60, reason: 'need it' }, 'https://pot.test')
  if (!r.ok) throw new Error(`elevation failed ${JSON.stringify(r)}`)
  const res = r.result as { request: { id: string }; approve_url?: string }
  if (!res.approve_url) throw new Error('no approve_url')
  return { ...parseLink(res.approve_url), subject: res.request.id }
}
const tokenSha = (id: string): string => one<{ s: string }>('SELECT link_token_sha256 AS s FROM secure_moments WHERE id = ?', id)?.s ?? ''
const receipts = (id: string): number => count('mutation_audit_entries', `operation = 'moment_link_rotate' AND target_id = '${id}'`)
/** Move the clock past the per-minute throttle (receipts are append-only, so the clock moves, not the rows). */
const advanceClock = (): void => { vi.setSystemTime(Date.now() + 2 * ROTATE_MIN_INTERVAL_MS) }

describe('passkey-link: the happy path', () => {
  it('a bound human member who may decide gets a fresh link for a seed moment; the old link dies, the new one opens the W1 page; the receipt says telegram_initdata', async () => {
    const m = await fileSeed()
    const r = await plink(m.id, { init_data: init(TG.owner) })
    expect(r.status).toBe(200)
    const j = await jbody(r)
    expect(j.ok).toBe(true)
    const fresh = parseLink(j.url ?? '')
    expect(new URL(j.url ?? '').origin).toBe(ORIGIN)
    expect(fresh.id).toBe(m.id)
    expect(fresh.token).not.toBe(m.token)
    expect(r.headers.get('cache-control')).toBe('no-store')
    // rotation invalidated the previous link
    expect((await momentsApp.fetch(new Request(`https://${HOST}/m/${m.id}/${m.token}`), env)).status).not.toBe(200)
    expect((await momentsApp.fetch(new Request(`https://${HOST}/m/${m.id}/${fresh.token}`), env)).status).toBe(200)
    // the receipt: member principal, the moment id, via telegram_initdata
    const row = one<{ principal_kind: string; member_id: string; agent_id: string | null; evidence_json: string; target_id: string }>(
      "SELECT principal_kind, member_id, agent_id, evidence_json, target_id FROM mutation_audit_entries WHERE operation = 'moment_link_rotate'")
    expect(row).toMatchObject({ principal_kind: 'member', member_id: 'mem-owner', agent_id: null, target_id: m.id })
    expect(JSON.parse(row?.evidence_json ?? '{}')).toMatchObject({ moment_id: m.id, via: 'telegram_initdata' })
  })
  it('works for an elevation moment too (decided by a passkey on the page, not by this call)', async () => {
    const m = await fileElevation()
    const r = await plink(m.id, { init_data: init(TG.owner) })
    expect(r.status).toBe(200)
    expect(momentStatusOf(m.id)).toBe('pending') // asking for the link decides nothing
    expect(count('web_sessions')).toBe(0)
  })
})
const momentStatusOf = (id: string): string => one<{ status: string }>('SELECT status FROM secure_moments WHERE id = ?', id)?.status ?? 'missing'

describe('passkey-link: initData is verified by the existing verifier', () => {
  it('refuses a different bot id, stale, bad-signature, tampered and unsigned initData, and rotates nothing', async () => {
    const m = await fileSeed()
    const before = tokenSha(m.id)
    const bad: Array<[string, string]> = [
      ['other bot', init(TG.owner, { signedBotId: '987654321' })],
      ['stale', init(TG.owner, { authDate: Math.floor(Date.now() / 1000) - 3600 })],
      ['bad signature', init(TG.owner, { key: newTestKey() })],
      ['tampered user', init(TG.owner, { tamper: (f) => { f.user = JSON.stringify({ id: TG.plain }) } })],
      ['no signature', init(TG.owner, { omitSignature: true })],
    ]
    for (const [name, data] of bad) {
      const r = await plink(m.id, { init_data: data })
      expect(r.status, name).toBe(403)
    }
    expect((await plink(m.id, {})).status).toBe(403)
    expect(tokenSha(m.id)).toBe(before)
    expect(receipts(m.id)).toBe(0)
  })
  it('refuses a group-chat launch and a cross-origin or non-JSON request', async () => {
    const m = await fileSeed()
    expect((await plink(m.id, { init_data: init(TG.owner, { chatType: 'group' }) })).status).toBe(403)
    expect((await hit(`/m/tg/${m.id}/passkey-link`, { init_data: init(TG.owner) }, { origin: 'https://evil.example.test' })).status).toBe(403)
    expect((await hit(`/m/tg/${m.id}/passkey-link`, { init_data: init(TG.owner) }, { origin: null })).status).toBe(403)
    expect(receipts(m.id)).toBe(0)
  })
})

describe('passkey-link: who may ask', () => {
  it('an unbound Telegram user, another tenant\'s bound user, and an agent-bound member are refused (403) with no rotation', async () => {
    const m = await fileSeed()
    const before = tokenSha(m.id)
    for (const tg of [TG.stranger, TG.other, TG.agent]) expect((await plink(m.id, { init_data: init(tg) })).status).toBe(403)
    expect(tokenSha(m.id)).toBe(before)
    expect(receipts(m.id)).toBe(0)
  })
  it('a suspended or archived member is refused', async () => {
    const m = await fileSeed()
    harness.sqlite.exec("UPDATE members SET status = 'suspended' WHERE id = 'mem-owner'")
    expect((await plink(m.id, { init_data: init(TG.owner) })).status).toBe(403)
    harness.sqlite.exec("UPDATE members SET status = 'active', archived_at = datetime('now') WHERE id = 'mem-owner'")
    expect((await plink(m.id, { init_data: init(TG.owner) })).status).toBe(403)
    expect(receipts(m.id)).toBe(0)
  })
  it('a bound member WITHOUT authority over the moment reads exactly like an unknown moment (404) and gets no link', async () => {
    const m = await fileElevation()
    const before = tokenSha(m.id)
    const r = await plink(m.id, { init_data: init(TG.plain) })
    expect(r.status).toBe(404)
    expect(await jbody(r)).toMatchObject({ ok: false })
    expect((await plink('11111111-1111-4111-8111-111111111111', { init_data: init(TG.plain) })).status).toBe(404)
    expect(tokenSha(m.id)).toBe(before)
    expect(receipts(m.id)).toBe(0)
  })
  it('a moment addressed to a different named decider is refused (404)', async () => {
    const m = await fileSeed()
    harness.sqlite.exec(`UPDATE secure_moments SET decider_member_id = 'mem-plain' WHERE id = '${m.id}'`)
    expect((await plink(m.id, { init_data: init(TG.owner) })).status).toBe(404)
    expect(receipts(m.id)).toBe(0)
  })
  it('the member is the SIGNED id, never one the body claims', async () => {
    const m = await fileElevation()
    expect((await plink(m.id, { init_data: init(TG.plain), member_id: 'mem-owner', telegram_user_id: TG.owner })).status).toBe(404)
    expect(receipts(m.id)).toBe(0)
  })
})

describe('passkey-link: which moments', () => {
  it('refuses a decided moment, an expired moment, a credential-kind moment, and a malformed id', async () => {
    const decided = await fileSeed()
    harness.sqlite.exec(`UPDATE secure_moments SET status = 'consumed' WHERE id = '${decided.id}'`)
    expect((await plink(decided.id, { init_data: init(TG.owner) })).status).toBe(409)
    const expired = await fileElevation()
    harness.sqlite.exec(`UPDATE secure_moments SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = '${expired.id}'`)
    expect((await plink(expired.id, { init_data: init(TG.owner) })).status).toBe(409)
    harness.sqlite.exec(`INSERT INTO secure_moments (id, tenant, kind, subject_id, link_token_sha256, status, created_at, expires_at)
      VALUES ('33333333-3333-4333-8333-333333333333', '${TENANT}', 'credential', 'x', '${'c'.repeat(64)}', 'pending', datetime('now'), '2999-01-01T00:00:00.000Z')`)
    const cred = await plink('33333333-3333-4333-8333-333333333333', { init_data: init(TG.owner) })
    expect(cred.status).toBe(409)
    expect(tokenSha('33333333-3333-4333-8333-333333333333')).toBe('c'.repeat(64))
    expect((await plink('not-a-uuid', { init_data: init(TG.owner) })).status).toBe(404)
    expect(count('mutation_audit_entries', "operation = 'moment_link_rotate'")).toBe(0)
  })
  it('refuses a moment of another tenant and does not touch its token', async () => {
    harness.sqlite.exec(`INSERT INTO secure_moments (id, tenant, kind, subject_id, link_token_sha256, status, created_at, expires_at)
      VALUES ('44444444-4444-4444-8444-444444444444', 'tenant-b', 'seed_attach', 'x', '${'e'.repeat(64)}', 'pending', datetime('now'), '2999-01-01T00:00:00.000Z')`)
    expect((await plink('44444444-4444-4444-8444-444444444444', { init_data: init(TG.owner) })).status).toBe(404)
    expect(tokenSha('44444444-4444-4444-8444-444444444444')).toBe('e'.repeat(64))
    expect(count('mutation_audit_entries', "operation = 'moment_link_rotate'")).toBe(0)
  })
})

describe('passkey-link: the rate limit and the secrets', () => {
  it('a second call inside a minute is throttled (409) and writes nothing; the first link stays valid', async () => {
    const m = await fileSeed()
    const first = await jbody(await plink(m.id, { init_data: init(TG.owner) }))
    const r = await plink(m.id, { init_data: init(TG.owner) })
    expect(r.status).toBe(409)
    expect((await jbody(r)).url).toBeUndefined()
    expect(receipts(m.id)).toBe(1)
    expect((await momentsApp.fetch(new Request(`https://${HOST}/m/${m.id}/${parseLink(first.url ?? '').token}`), env)).status).toBe(200)
  })
  it('parallel calls rotate at most once', async () => {
    const m = await fileSeed()
    const rs = await Promise.all(Array.from({ length: 8 }, () => plink(m.id, { init_data: init(TG.owner) })))
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1)
    expect(receipts(m.id)).toBe(1)
  })
  it('the lifetime cap holds, and the cap is SHARED with the MCP fallback (same receipts)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const m = await fileSeed()
    // one slot is spent by the MCP plain-link fallback (default channel), the rest by Telegram
    expect(await reserveRotation(env, { momentId: m.id, memberId: 'mem-owner', agentId: 'agent-x', reason: 'elicitation_cancel' })).toBe('ok')
    for (let i = 1; i < ROTATE_MAX_PER_MOMENT; i++) {
      advanceClock()
      expect((await plink(m.id, { init_data: init(TG.owner) })).status).toBe(200)
    }
    advanceClock()
    const r = await plink(m.id, { init_data: init(TG.owner) })
    expect(r.status).toBe(409)
    expect((await jbody(r)).title).toBe('No more links')
    expect(receipts(m.id)).toBe(ROTATE_MAX_PER_MOMENT)
  })
  it('no token, link, or initData appears in any receipt, any console output, or any stored column', async () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error'), vi.spyOn(console, 'info'), vi.spyOn(console, 'debug')]
    const m = await fileSeed()
    const data = init(TG.owner)
    const j = await jbody(await plink(m.id, { init_data: data }))
    const token = parseLink(j.url ?? '').token
    const dump = JSON.stringify(harness.sqlite.prepare('SELECT * FROM mutation_audit_entries').all())
    for (const secret of [token, m.token, j.url ?? '', data]) {
      expect(secret.length).toBeGreaterThan(20)
      expect(dump).not.toContain(secret)
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(secret)
    }
    expect(JSON.stringify(harness.sqlite.prepare('SELECT * FROM secure_moments').all())).not.toContain(token)
  })
})

describe('passkey-link: flag off', () => {
  it('is a 404 (falls through), rotates nothing, writes nothing', async () => {
    const m = await fileSeed()
    const before = tokenSha(m.id)
    const off = baseEnv({ TELEGRAM_MINIAPP: undefined })
    const r = await plink(m.id, { init_data: init(TG.owner) }, off)
    expect(r.status).toBe(404)
    expect(await r.text()).not.toContain('url')
    expect(tokenSha(m.id)).toBe(before)
    expect(receipts(m.id)).toBe(0)
  })
})

describe('passkey-link: the client', () => {
  it('the page script offers the passkey button in the form and in the biometrics-unavailable branch, opens the link with openLink, and keeps the submit-once pattern', async () => {
    const m = await fileSeed()
    const html = await (await momentsApp.fetch(new Request(`https://${HOST}/m/tg/${m.id}`), env)).text()
    expect(html).toContain('Approve with passkey in your browser')
    expect(html).toContain("/passkey-link")
    expect(html).toContain('tg.openLink(')
    expect(html).toMatch(/Use your passkey in your browser instead/)
    expect(html).toMatch(/linkBusy=true;b\.disabled=true/)
  })
})
