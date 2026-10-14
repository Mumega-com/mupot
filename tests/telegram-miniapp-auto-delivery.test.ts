// tests/telegram-miniapp-auto-delivery.test.ts — mupot#1893: a filed approval reaches the deciding human's Telegram WITHOUT a
// second tool call. Real migrated schema + the REAL request tools; only the Bot API (global fetch) is stubbed.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { deliverMomentToTelegram } from '../src/secure-moments/telegram-miniapp-auto'

const TENANT = 'tenant-a'
const HOST = 'secure.example.test'
const BOT = '123456789'
const BOT_TOKEN = `${BOT}:AAEhqMY-dedicated-miniapp-test-token`
const seedText = readFileSync(join(__dirname, '..', 'docs', 'examples', 'seeds', 'mumega-com.seed.yaml'), 'utf8')
const TG = { owner: 1001, plain: 1002, sqadmin: 1003, agent: 1004 }

let harness: SqliteD1Harness
let env: Env
const baseEnv = (over: Partial<Env> = {}): Env => ({
  DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: 'a1'.repeat(32), PUBLIC_ORIGIN: 'https://colony.example.test',
  SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST, TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: BOT, TELEGRAM_MINIAPP_BOT_TOKEN: BOT_TOKEN, ...over,
}) as Env
const count = (t: string, where = '1=1'): number => (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).get() as { n: number }).n
const setOwner = (m: string | null): void => { harness.sqlite.prepare("UPDATE agents SET owner_member_id = ? WHERE id = 'agent-x'").run(m) }

interface BotCall { url: string; body: { chat_id: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> } } }
function stubBot(mode: 'ok' | number | 'throw' | 'hang' = 'ok'): BotCall[] {
  const calls: BotCall[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as BotCall['body'] })
    if (mode === 'throw') throw new Error('network down')
    if (mode === 'hang') return new Promise<Response>(() => undefined)
    return new Response(JSON.stringify(mode === 'ok' ? { ok: true, result: { message_id: 7 } } : { ok: false }), { status: mode === 'ok' ? 200 : mode })
  })
  return calls
}
const agentAuth = (): AuthContext => ({
  userId: 'mem-agent', email: 'agent@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-agent', tokenId: 'tok-1',
  capabilities: [{ member_id: 'mem-agent', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
interface Filed { telegram: string; approve_url: string; momentId: string }
async function fileElevation(e: Env = env): Promise<Filed> {
  await invokeTool(agentAuth(), e, 'check_in', {}, 'https://pot.test')
  const r = await invokeTool(agentAuth(), e, 'request_elevation',
    { actions: ['action:project_status'], scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 60, reason: 'need it' }, 'https://pot.test')
  if (!r.ok) throw new Error(`elevation failed ${JSON.stringify(r)}`)
  const res = r.result as { telegram: string; approve_url: string }
  return { telegram: res.telegram, approve_url: res.approve_url, momentId: new URL(res.approve_url).pathname.split('/')[2] }
}
async function fileSeed(e: Env = env): Promise<Filed> {
  const r = await invokeTool(agentAuth(), e, 'seed_attach_request', { seed: seedText }, 'https://pot.test')
  if (!r.ok) throw new Error(`seed failed ${JSON.stringify(r)}`)
  const res = r.result as { telegram: string; approve_url: string }
  return { telegram: res.telegram, approve_url: res.approve_url, momentId: new URL(res.approve_url).pathname.split('/')[2] }
}

beforeEach(() => {
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
  setOwner('mem-sqadmin')
})
afterEach(() => { harness.close(); vi.unstubAllGlobals() })

describe('request_elevation delivers to Telegram by itself', () => {
  it('bound deciding human + flag on: exactly one send, status sent, plain link kept, raw token never in the message', async () => {
    const calls = stubBot()
    const f = await fileElevation()
    expect(f.telegram).toBe('sent')
    expect(f.approve_url).toMatch(/\/m\/[^/]+\/[^/]+$/)
    expect(calls).toHaveLength(1)
    expect(calls[0].body.chat_id).toBe(String(TG.sqadmin))
    const token = new URL(f.approve_url).pathname.split('/')[3]
    expect(JSON.stringify(calls[0])).not.toContain(token)
    expect(calls[0].body.reply_markup.inline_keyboard[0][0].web_app.url).toBe(`https://${HOST}/m/tg/${f.momentId}`)
    expect(harness.sqlite.prepare('SELECT * FROM tg_miniapp_deliveries').get()).toMatchObject({ kind: 'moment', subject_id: f.momentId, member_id: 'mem-sqadmin', status: 'sent' })
  })
  it('a repeat or a rotated link on the SAME moment never double-sends', async () => {
    const calls = stubBot()
    const f = await fileElevation()
    expect(await deliverMomentToTelegram(env, { momentId: f.momentId, requesterMemberId: null })).toBe('sent')
    // rotate the link the way a re-issue does (same moment id, new token), then ask again
    harness.sqlite.prepare("UPDATE secure_moments SET link_token_sha256 = '"+'b'.repeat(64)+"' WHERE id = ?").run(f.momentId)
    expect(await deliverMomentToTelegram(env, { momentId: f.momentId, requesterMemberId: null })).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(count('tg_miniapp_deliveries')).toBe(1)
  })
  it('concurrent deliveries of one moment produce ONE message', async () => {
    const calls = stubBot()
    const f = await fileElevation()
    harness.sqlite.exec('DELETE FROM tg_miniapp_deliveries')
    calls.length = 0
    const r = await Promise.all(Array.from({ length: 10 }, () => deliverMomentToTelegram(env, { momentId: f.momentId, requesterMemberId: null })))
    expect(calls).toHaveLength(1)
    expect(r.every((s) => s === 'sent')).toBe(true)
  })
  it('not bound: status not_bound, the tool still returns approve_url, nothing is sent', async () => {
    const calls = stubBot()
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = NULL WHERE id = 'mem-sqadmin'")
    const f = await fileElevation()
    expect(f.telegram).toBe('not_bound')
    expect(f.approve_url).toBeTruthy()
    expect(calls).toHaveLength(0)
    expect(count('tg_miniapp_deliveries')).toBe(0)
  })
  it('no owner on the agent: nobody is addressed (no broadcast to admins), not_bound', async () => {
    const calls = stubBot()
    setOwner(null)
    expect((await fileElevation()).telegram).toBe('not_bound')
    expect(calls).toHaveLength(0)
  })
  it('an ownerless agent: the tenant\'s SINGLE human org admin is addressed; two human org admins or only an agent-welded admin address nobody', async () => {
    const calls = stubBot()
    setOwner(null)
    harness.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-o', 'mem-owner', 'org', NULL, 'owner')`)
    // an agent-welded member holding org admin is NOT a human and must never be counted or addressed
    harness.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-ag', 'mem-agent', 'org', NULL, 'admin')`)
    const one = await fileElevation()
    expect(one.telegram).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0].body.chat_id).toBe(String(TG.owner))
    // a SECOND human org admin makes the target ambiguous: nobody is addressed, no fan-out
    harness.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-p2', 'mem-plain', 'org', NULL, 'admin')`)
    harness.sqlite.exec('DELETE FROM tg_miniapp_deliveries')
    calls.length = 0
    expect((await fileElevation()).telegram).toBe('not_bound')
    expect(calls).toHaveLength(0)
  })
  it('an owner who has no authority over the decision is not sent the button (authority is not widened)', async () => {
    const calls = stubBot()
    setOwner('mem-plain')
    expect((await fileElevation()).telegram).toBe('not_bound')
    expect(calls).toHaveLength(0)
  })
  it('flag off: disabled, zero sends, zero rows, link still returned', async () => {
    const calls = stubBot()
    const off = baseEnv({ TELEGRAM_MINIAPP: undefined })
    const f = await fileElevation(off)
    expect(f.telegram).toBe('disabled')
    expect(f.approve_url).toBeTruthy()
    expect(calls).toHaveLength(0)
    expect(count('tg_miniapp_deliveries')).toBe(0)
  })
  it.each([['http 500', 500], ['chat refused 403', 403], ['network error', 'throw']] as const)('Telegram failure (%s): the tool still succeeds with failed and the link', async (_n, mode) => {
    stubBot(mode)
    const f = await fileElevation()
    expect(f.telegram).toBe('failed')
    expect(f.approve_url).toBeTruthy()
    expect(harness.sqlite.prepare('SELECT status FROM tg_miniapp_deliveries').get()).toMatchObject({ status: 'failed' })
  })
  it('a Telegram that never answers is bounded: the tool answers failed within the default timeout and still returns the link', async () => {
    stubBot('hang')
    const t0 = Date.now()
    const f = await fileElevation()
    expect(f.telegram).toBe('failed')
    expect(f.approve_url).toBeTruthy()
    expect(Date.now() - t0).toBeLessThan(9000)
  }, 15000)
  it('rate limit: a human at the per-window cap gets rate_limited and no send', async () => {
    const calls = stubBot()
    const now = new Date().toISOString()
    for (let i = 0; i < 5; i++) harness.sqlite.prepare("INSERT INTO tg_miniapp_deliveries (id, tenant, kind, subject_id, member_id, requested_by, status, created_at) VALUES (?, ?, 'moment', ?, 'mem-sqadmin', 'agent-x', 'sent', ?)").run(`r-${i}`, TENANT, `s-${i}`, now)
    const f = await fileElevation()
    expect(f.telegram).toBe('rate_limited')
    expect(f.approve_url).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
})

describe('the bound and the best-effort contract', () => {
  it('times out to failed without throwing, and hands the work to waitUntil', async () => {
    stubBot('hang')
    const f = await (async () => { stubBot('ok'); return fileElevation() })()
    harness.sqlite.exec('DELETE FROM tg_miniapp_deliveries')
    stubBot('hang')
    const handed: Promise<unknown>[] = []
    const t0 = Date.now()
    const s = await deliverMomentToTelegram(env, { momentId: f.momentId, requesterMemberId: null }, { timeoutMs: 150, waitUntil: (p) => { handed.push(p) } })
    expect(s).toBe('failed')
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(handed).toHaveLength(1)
  })
  it('never throws even when the database is gone', async () => {
    stubBot()
    const f = await fileElevation()
    const broken = { ...env, DB: { prepare: () => { throw new Error('boom') } } } as unknown as Env
    expect(await deliverMomentToTelegram(broken, { momentId: f.momentId, requesterMemberId: null })).toBe('failed')
  })
  it('a moment kind the Mini App cannot decide (seat_admit/credential) is never sent', async () => {
    const calls = stubBot()
    const f = await fileElevation()
    harness.sqlite.exec('DELETE FROM tg_miniapp_deliveries')
    calls.length = 0
    harness.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    harness.sqlite.exec("UPDATE secure_moments SET kind = 'seat_admit'")
    harness.sqlite.exec('PRAGMA ignore_check_constraints = OFF')
    expect(await deliverMomentToTelegram(env, { momentId: f.momentId, requesterMemberId: null })).toBe('disabled')
    expect(calls).toHaveLength(0)
  })
})

describe('seed_attach_request', () => {
  it('goes to the owner of the filing agent when that owner may decide a seed; a repeat (rotated link) does not double-send', async () => {
    const calls = stubBot()
    setOwner('mem-owner')
    const a = await fileSeed()
    expect(a.telegram).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0].body.chat_id).toBe(String(TG.owner))
    const b = await fileSeed() // same seed: reused request, moment rotated, same moment id
    expect(b.momentId).toBe(a.momentId)
    expect(b.telegram).toBe('sent')
    expect(calls).toHaveLength(1)
  })
  it('no owner and an agent-welded requester: not_bound, link returned; flag off: disabled', async () => {
    const calls = stubBot()
    setOwner(null)
    const a = await fileSeed()
    expect(a.telegram).toBe('not_bound')
    expect(a.approve_url).toBeTruthy()
    const off = await fileSeed(baseEnv({ TELEGRAM_MINIAPP: undefined }))
    expect(off.telegram).toBe('disabled')
    expect(calls).toHaveLength(0)
  })
})
