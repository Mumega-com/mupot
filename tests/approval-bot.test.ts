// tests/approval-bot.test.ts — the "/muapprove" bot. Real migrated schema + the REAL request_elevation / elevation_status tools
// + the REAL webhook handler; only the Bot API (global fetch) is stubbed. Every guard in src/approval-bot has a test here that
// fails when the guard is removed (see the PR body's mutation table).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp/index' // first: the mcp/seeds modules form an import cycle that only resolves from mcp/index
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { approvalBotApp } from '../src/approval-bot/routes'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleApprovalBotUpdate } from '../src/approval-bot/decide'
import { approvalBotStatus } from '../src/approval-bot/config'

const TENANT = 'tenant-a'
const BOT_TOKEN = '987654321:AAEhqMY-approval-bot-test-token-xyz'
const WEBHOOK_SECRET = 'approval-webhook-secret-0123456789'
const USERNAME = 'muapprove_test_bot'
const TG = { owner: 1001, plain: 1002, sqadmin: 1003, agent: 1004, stranger: 1999 }
const HOST = 'secure.example.test'
const MINIAPP_BOT = '123456789'

let harness: SqliteD1Harness
let env: Env
const baseEnv = (over: Partial<Env> = {}): Env => ({
  DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: 'a1'.repeat(32), PUBLIC_ORIGIN: 'https://colony.example.test',
  SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST,
  APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET, APPROVAL_BOT_USERNAME: USERNAME, ...over,
}) as Env
const one = <T>(sql: string, ...p: unknown[]): T => harness.sqlite.prepare(sql).get(...p) as T
const count = (t: string, where = '1=1'): number => one<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`).n
const setOwner = (m: string | null): void => { harness.sqlite.prepare("UPDATE agents SET owner_member_id = ? WHERE id = 'agent-x'").run(m) }

interface BotCall { url: string; method: string; body: Record<string, unknown> }
let calls: BotCall[]
function stubBot(mode: 'ok' | 'fail' = 'ok'): void {
  calls = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    calls.push({ url, method: url.split('/').pop() ?? '', body })
    if (mode === 'fail') return new Response('{"ok":false}', { status: 403 })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + calls.length } }), { status: 200 })
  })
}
const approvalCalls = (): BotCall[] => calls.filter((c) => c.url.includes(BOT_TOKEN))
const sentTo = (method: string): BotCall[] => approvalCalls().filter((c) => c.method === method)

const agentAuth = (): AuthContext => ({
  userId: 'mem-agent', email: 'agent@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-agent', tokenId: 'tok-1',
  capabilities: [{ member_id: 'mem-agent', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' } as CapabilityGrant], boundAgentId: 'agent-x',
})
interface Filed { telegram: string; requestId: string; shortId: string | null; approve_url?: string }
async function file(args: Record<string, unknown> = {}, e: Env = env): Promise<Filed> {
  await invokeTool(agentAuth(), e, 'check_in', {}, 'https://pot.test')
  const r = await invokeTool(agentAuth(), e, 'request_elevation',
    { actions: ['action:project_status'], scope_type: 'squad', scope_id: 'squad-a', duration_minutes: 60, reason: 'need it', ...args }, 'https://pot.test')
  if (!r.ok) throw new Error(`elevation failed ${JSON.stringify(r)}`)
  const res = r.result as { telegram: string; request: { id: string }; approve_url?: string }
  const row = one<{ short_id: string | null }>('SELECT short_id FROM elevation_requests WHERE id = ?', res.request.id)
  return { telegram: res.telegram, requestId: res.request.id, shortId: row.short_id, approve_url: res.approve_url }
}

let updateSeq = 100
interface Who { from: number; chat?: number; chatType?: string; messageId?: number; forwarded?: boolean }
const cmdUpdate = (text: string, w: Who) => ({
  update_id: ++updateSeq,
  message: { message_id: 7, from: { id: w.from }, chat: { id: w.chat ?? w.from, type: w.chatType ?? 'private' }, text, ...(w.forwarded ? { forward_origin: { type: 'user' } } : {}) },
})
const tapUpdate = (data: string, w: Who) => ({
  update_id: ++updateSeq,
  callback_query: { id: `cb-${updateSeq}`, from: { id: w.from }, data, message: { message_id: w.messageId ?? 501, chat: { id: w.chat ?? w.from, type: w.chatType ?? 'private' } } },
})
const deliveredMessageId = (reqId: string): number => Number(one<{ message_id: string }>('SELECT message_id FROM approval_bot_deliveries WHERE request_id = ?', reqId).message_id)
const status = (id: string): { status: string; decided_by_member_id: string | null; decided_via: string | null; decision_note: string | null } =>
  one('SELECT status, decided_by_member_id, decided_via, decision_note FROM elevation_requests WHERE id = ?', id)
const grants = (id: string): number => count('elevation_grants', `elevation_request_id = '${id}'`)
async function activeElevations(): Promise<Array<{ action: string; live: boolean }>> {
  const r = await invokeTool(agentAuth(), env, 'elevation_status', {}, 'https://pot.test')
  if (!r.ok) throw new Error('status failed')
  return (r.result as { active_elevations: Array<{ action: string; live: boolean }> }).active_elevations
}
async function post(secret: string | null, body: unknown, e: Env = env): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (secret !== null) headers['X-Telegram-Bot-Api-Secret-Token'] = secret
  const init = { method: 'POST', headers, body: JSON.stringify(body) }
  return approvalBotApp.request('/webhook', init, e)
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
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES
      ('hli-owner', '${TENANT}', 'email', 'owner@x.test', 'owner@x.test', 'mem-owner', datetime('now')),
      ('hli-plain', '${TENANT}', 'email', 'plain@x.test', 'plain@x.test', 'mem-plain', datetime('now')),
      ('hli-sqadmin', '${TENANT}', 'email', 'sqadmin@x.test', 'sqadmin@x.test', 'mem-sqadmin', datetime('now'));
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-x', 'squad-a', 'agent-x', 'Agent X', 'r', 'm', 'active');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-x', 'mem-agent', datetime('now'));
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('tok-1', 'mem-agent', 'hash-1', 'primary', 'workspace', '${TENANT}', 'agent-x', datetime('now'));
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-o', 'mem-owner', 'org', NULL, 'owner'),
      ('cap-p', 'mem-plain', 'squad', 'squad-a', 'member'),
      ('cap-sa', 'mem-sqadmin', 'squad', 'squad-a', 'admin');
  `)
  env = baseEnv()
  setOwner('mem-owner')
  stubBot()
})
afterEach(() => { harness.close(); vi.unstubAllGlobals() })

describe('config: off by default, dedicated, fail closed', () => {
  it('token unset = off', () => expect(approvalBotStatus({})).toEqual({ state: 'off' }))
  it('a token with a missing / malformed secret or username is misconfigured, never on', () => {
    expect(approvalBotStatus({ APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_USERNAME: USERNAME }).state).toBe('misconfigured')
    expect(approvalBotStatus({ APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: 'short', APPROVAL_BOT_USERNAME: USERNAME }).state).toBe('misconfigured')
    expect(approvalBotStatus({ APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET }).state).toBe('misconfigured')
    expect(approvalBotStatus({ APPROVAL_BOT_TOKEN: 'not-a-token', APPROVAL_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET, APPROVAL_BOT_USERNAME: USERNAME }).state).toBe('misconfigured')
  })
  it('must not share a token with the notification bot or the Mini App bot, nor a secret with the IM webhook (KayHermes)', () => {
    const base = { APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET, APPROVAL_BOT_USERNAME: USERNAME }
    expect(approvalBotStatus({ ...base, TELEGRAM_BOT_TOKEN: BOT_TOKEN }).state).toBe('misconfigured')
    expect(approvalBotStatus({ ...base, TELEGRAM_BOT_TOKEN: '987654321:AAother-secret-part-of-same-bot-id' }).state).toBe('misconfigured')
    expect(approvalBotStatus({ ...base, TELEGRAM_MINIAPP_BOT_TOKEN: BOT_TOKEN }).state).toBe('misconfigured')
    expect(approvalBotStatus({ ...base, TELEGRAM_MINIAPP_BOT_ID: '987654321' }).state).toBe('misconfigured')
    expect(approvalBotStatus({ ...base, IM_WEBHOOK_SECRET: WEBHOOK_SECRET }).state).toBe('misconfigured')
    expect(approvalBotStatus({ ...base, TELEGRAM_BOT_TOKEN: '555555555:AAnotification-bot-other-token-00' }).state).toBe('on')
  })
})

const call_ = (tool: string): Promise<unknown> => invokeTool(agentAuth(), env, tool, {}, 'https://pot.test')

describe('small fixes', () => {
  it('bot usernames of 5 and 6 characters are accepted; 4 is not (Telegram minimum is 5)', () => {
    const base = { APPROVAL_BOT_TOKEN: BOT_TOKEN, APPROVAL_BOT_WEBHOOK_SECRET: WEBHOOK_SECRET }
    for (const u of ['mubot', 'mu_bot', 'abbot']) expect(approvalBotStatus({ ...base, APPROVAL_BOT_USERNAME: u }).state, u).toBe('on')
    expect(approvalBotStatus({ ...base, APPROVAL_BOT_USERNAME: 'xbot' }).state).toBe('misconfigured')
    expect(approvalBotStatus({ ...base, APPROVAL_BOT_USERNAME: 'notabo' }).state).toBe('misconfigured')
  })
  it('short ids are 8 symbols from the alphabet and unbiased: rejection sampling never maps a byte >= 240', async () => {
    const { newShortId, SHORT_ID_RE } = await import('../src/approval-bot/policy')
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) { const id = newShortId(); expect(id).toMatch(SHORT_ID_RE); for (const c of id) seen.add(c) }
    expect(seen.size).toBe(30)
    // all-0xFF randomness is rejected (>= 240) and the generator still terminates once real bytes arrive
    let calls_ = 0
    const real = crypto.getRandomValues.bind(crypto)
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(((a: Uint8Array) => { calls_++; if (calls_ <= 3) a.fill(255); else real(a); return a }) as typeof crypto.getRandomValues)
    expect(newShortId()).toMatch(SHORT_ID_RE)
    expect(calls_).toBeGreaterThan(3)
    vi.restoreAllMocks()
  })
})

describe('delivery: ONE message from the approval bot', () => {
  it('names the agent, exact action, scope, duration, reason and recommendation; Approve/Deny buttons; fallback commands; telegram "sent"', async () => {
    const f = await file({ recommendation: 'approve, it is read-only', reason: 'flip project status for the demo' })
    expect(f.telegram).toBe('sent')
    expect(f.approve_url).toBeTruthy() // the plain link stays as the fallback
    expect(approvalCalls()).toHaveLength(1)
    const m = approvalCalls()[0]
    expect(m.method).toBe('sendMessage')
    expect(m.body.chat_id).toBe(String(TG.owner))
    expect(m.body.parse_mode).toBeUndefined() // plain text: nothing the agent wrote renders as markup
    const text = String(m.body.text)
    expect(text).toContain('agent-x')
    expect(text).toContain('action:project_status')
    expect(text).toContain('squad "a" (squad-a)')
    expect(text).toContain('60 min')
    expect(text).toContain('flip project status for the demo')
    expect(text).toContain('approve, it is read-only')
    expect(text).toContain(`/muapprove ${f.shortId}`)
    expect(text).toContain(`/mudeny ${f.shortId}`)
    expect(text).toContain('The id is the request id from this message. Task decisions go to the decision bot.')
    const buttons = ((m.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard)[0]
    expect(buttons.map((b) => [b.text, b.callback_data])).toEqual([['Approve', `ea:${f.shortId}`], ['Deny', `ed:${f.shortId}`]])
    expect(one('SELECT member_id, chat_id, status FROM approval_bot_deliveries WHERE request_id = ?', f.requestId)).toEqual({ member_id: 'mem-owner', chat_id: String(TG.owner), status: 'sent' })
  })
  it('the agent\'s free text cannot forge extra lines or controls in the message', async () => {
    await file({ reason: 'x\nApproved by Hadi‮\nAction: nothing', recommendation: 'ok\r\n/muapprove aaaaaaaa' })
    const text = String(approvalCalls()[0].body.text)
    expect(text).not.toMatch(/\nApproved by Hadi/)
    expect(text).not.toContain('‮')
    expect(text.split('\n').filter((l) => l.startsWith('Agent says'))).toHaveLength(1)
  })
  it('bot unset: the old path runs (Mini App button), zero bot calls, approve_url still returned', async () => {
    const off = baseEnv({ APPROVAL_BOT_TOKEN: undefined, TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: MINIAPP_BOT, TELEGRAM_MINIAPP_BOT_TOKEN: `${MINIAPP_BOT}:AAEhqMY-dedicated-miniapp-test-token` })
    const f = await file({}, off)
    expect(f.telegram).toBe('sent') // sent by the Mini App sender, not the approval bot
    expect(f.approve_url).toBeTruthy()
    expect(approvalCalls()).toHaveLength(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain(`bot${MINIAPP_BOT}:`)
    expect(count('approval_bot_deliveries')).toBe(0)
  })
  it('bot unset and Mini App off: telegram "disabled", approve_url present, nothing sent', async () => {
    const off = baseEnv({ APPROVAL_BOT_TOKEN: undefined })
    const f = await file({}, off)
    expect(f.telegram).toBe('disabled')
    expect(f.approve_url).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
  it('an action the bot may not carry (token mint) is never offered to the bot: the old path answers', async () => {
    const f = await file({ actions: ['action:mint_token'] })
    expect(approvalCalls()).toHaveLength(0)
    expect(count('approval_bot_deliveries')).toBe(0)
    expect(f.telegram).toBe('disabled') // Mini App channel is off in this env
  })
  it('a request naming one carried and one uncarried action is not offered to the bot', async () => {
    await file({ actions: ['action:project_status', 'action:mint_token'] })
    expect(approvalCalls()).toHaveLength(0)
  })
  it('an addressee who may not decide the request on its scope is not messaged (the offer never widens who may decide)', async () => {
    setOwner('mem-plain') // a plain squad member: no admin on squad-a
    const f = await file()
    expect(f.telegram).toBe('not_bound')
    expect(calls).toHaveLength(0)
    expect(count('approval_bot_deliveries')).toBe(0)
  })
  it('deciding human not bound: not_bound, nothing sent, approve_url present', async () => {
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = NULL WHERE id = 'mem-owner'")
    const f = await file()
    expect(f.telegram).toBe('not_bound')
    expect(f.approve_url).toBeTruthy()
    expect(calls).toHaveLength(0)
  })
  it('a Bot API failure is reported as failed and the request stays pending with its link', async () => {
    stubBot('fail')
    const f = await file()
    expect(f.telegram).toBe('failed')
    expect(status(f.requestId).status).toBe('pending')
    expect(one<{ status: string }>('SELECT status FROM approval_bot_deliveries WHERE request_id = ?', f.requestId).status).toBe('failed')
  })
  it('a 2xx with a body that is not Telegram JSON is NOT sent', async () => {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { calls.push({ url, method: url.split('/').pop() ?? '', body: JSON.parse(String(init.body)) as Record<string, unknown> }); return new Response('<html>proxy ok</html>', { status: 200 }) })
    const f = await file()
    expect(f.telegram).toBe('failed')
    expect(one<{ status: string }>('SELECT status FROM approval_bot_deliveries WHERE request_id = ?', f.requestId).status).toBe('failed')
  })
  it('a 2xx {ok:false} is NOT sent', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"ok":false,"description":"x"}', { status: 200 }))
    expect((await file()).telegram).toBe('failed')
  })
  it('a reservation DB error is not "sent" (nothing is sent either)', async () => {
    harness.sqlite.exec('DROP TABLE approval_bot_deliveries')
    const f = await file()
    expect(f.telegram).not.toBe('sent')
    expect(approvalCalls()).toHaveLength(0)
  })
  it('an existing reserved (in-flight) slot answers pending, a failed one failed, only a sent one sent', async () => {
    const f = await file()
    const { deliverElevationToApprovalBot } = await import('../src/approval-bot/deliver')
    const { loadElevationRequestById } = await import('../src/auth/elevation')
    const req = (await loadElevationRequestById(env, TENANT, f.requestId))!
    harness.sqlite.exec("UPDATE approval_bot_deliveries SET status = 'reserved'")
    expect(await deliverElevationToApprovalBot(env, req)).toBe('pending')
    harness.sqlite.exec("UPDATE approval_bot_deliveries SET status = 'failed'")
    expect(await deliverElevationToApprovalBot(env, req)).toBe('failed')
  })
  it('pending past the wait and then SUCCEEDING does not fall back to the Mini App', async () => {
    const f = await file()
    const { deliverElevationToApprovalBot } = await import('../src/approval-bot/deliver')
    const { loadElevationRequestById } = await import('../src/auth/elevation')
    const req = (await loadElevationRequestById(env, TENANT, f.requestId))!
    harness.sqlite.exec('DELETE FROM approval_bot_deliveries')
    vi.stubGlobal('fetch', async () => { await new Promise((r) => setTimeout(r, 150)); return new Response('{"ok":true,"result":{"message_id":3}}', { status: 200 }) })
    let fellBack = false
    expect(await deliverElevationToApprovalBot(env, req, { timeoutMs: 20, fallback: async () => { fellBack = true } })).toBe('pending')
    await new Promise((x) => setTimeout(x, 500))
    expect(fellBack).toBe(false)
    expect(one<{ status: string }>('SELECT status FROM approval_bot_deliveries WHERE request_id = ?', f.requestId).status).toBe('sent')
  })
  it('pending past the wait and then failing falls back to the Mini App button', async () => {
    const mini = baseEnv({ TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: MINIAPP_BOT, TELEGRAM_MINIAPP_BOT_TOKEN: `${MINIAPP_BOT}:AAEhqMY-dedicated-miniapp-test-token` })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, method: url.split('/').pop() ?? '', body: JSON.parse(String(init.body)) as Record<string, unknown> })
      if (url.includes(BOT_TOKEN)) { await new Promise((r) => setTimeout(r, 300)); return new Response('{"ok":false}', { status: 403 }) }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 })
    })
    await call_('check_in')
    const { deliverElevationToApprovalBot } = await import('../src/approval-bot/deliver')
    const { deliverMomentToTelegram } = await import('../src/secure-moments/telegram-miniapp-auto')
    const { loadElevationRequestById } = await import('../src/auth/elevation')
    const f = await file({}, mini)
    // the tool already answered 'pending' or 'failed'; drive the helper directly with a short bound to pin the fallback contract
    const req = (await loadElevationRequestById(mini, TENANT, f.requestId))!
    harness.sqlite.exec('DELETE FROM approval_bot_deliveries')
    calls.length = 0
    let fellBack = false
    const r = await deliverElevationToApprovalBot(mini, req, { timeoutMs: 20, fallback: async () => { fellBack = true } })
    expect(r).toBe('pending')
    for (let i = 0; i < 100 && !fellBack; i++) await new Promise((x) => setTimeout(x, 20))
    expect(fellBack).toBe(true)
    void deliverMomentToTelegram
  })
  it('a second delivery attempt for the same request sends nothing more (once-only slot)', async () => {
    const f = await file()
    const { deliverElevationToApprovalBot } = await import('../src/approval-bot/deliver')
    const { loadElevationRequestById } = await import('../src/auth/elevation')
    const req = await loadElevationRequestById(env, TENANT, f.requestId)
    expect(await deliverElevationToApprovalBot(env, req!)).toBe('sent')
    expect(approvalCalls()).toHaveLength(1)
  })
})

describe('webhook: the secret is enforced', () => {
  const upd = (): unknown => cmdUpdate('/muhelp', { from: TG.owner })
  it('bot off: 404 and nothing runs', async () => {
    const off = baseEnv({ APPROVAL_BOT_TOKEN: undefined })
    expect((await post(WEBHOOK_SECRET, upd(), off)).status).toBe(404)
    expect(calls).toHaveLength(0)
  })
  it('misconfigured: 503', async () => {
    expect((await post(WEBHOOK_SECRET, upd(), baseEnv({ APPROVAL_BOT_WEBHOOK_SECRET: 'short' }))).status).toBe(503)
  })
  it('no header, wrong header, the IM secret, a prefix and a longer value: all 401, nothing sent', async () => {
    const withIm = baseEnv({ IM_WEBHOOK_SECRET: 'some-other-im-secret-0123456789ab' })
    for (const s of [null, '', 'wrong', 'some-other-im-secret-0123456789ab', WEBHOOK_SECRET.slice(0, -1), `${WEBHOOK_SECRET}x`]) {
      expect((await post(s, upd(), withIm)).status).toBe(401)
    }
    expect(calls).toHaveLength(0)
  })
  it('the right secret: 200 and the update is handled', async () => {
    const r = await post(WEBHOOK_SECRET, upd(), env)
    expect(r.status).toBe(200)
    expect(sentTo('sendMessage')).toHaveLength(1)
  })
  it('is mounted at /im/approve/webhook, before the IM sub-app can shadow it (the Worker entry cannot be imported outside workerd)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')
    const mount = src.indexOf('app.route(`${ROUTES.im}/approve`, approvalBotApp)')
    expect(mount).toBeGreaterThan(0)
    expect(mount).toBeLessThan(src.indexOf('app.route(ROUTES.im, imApp)'))
  })
  it('a body that is not JSON is 400 after the secret check, never before', async () => {
    const r = await approvalBotApp.request('/webhook', { method: 'POST', headers: { 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET }, body: '{nope' }, env)
    expect(r.status).toBe(400)
    const unauth = await approvalBotApp.request('/webhook', { method: 'POST', body: '{nope' }, env)
    expect(unauth.status).toBe(401)
  })
})

describe('decision: approve and deny land once, from the bound private chat only', () => {
  it('help distinguishes approval request ids from task decisions', async () => {
    await handleApprovalBotUpdate(env, cmdUpdate('/muhelp', { from: TG.owner }))
    expect(String(sentTo('sendMessage')[0].body.text)).toContain('The id is the request id from this message. Task decisions go to the decision bot.')
  })
  it.each(['/start secret-pairing-code', '/needs', '/login', '/mureject abcdef12 no', '/unknown'])('routes private %s without deciding or echoing its payload', async (text) => {
    const f = await file()
    for (const from of [TG.owner, TG.stranger]) {
      calls.length = 0
      expect(await handleApprovalBotUpdate(env, cmdUpdate(text, { from }))).toEqual({ kind: 'ignored', reason: 'not_our_command' })
      expect(sentTo('sendMessage')).toHaveLength(1)
      expect(sentTo('sendMessage')[0].body).toMatchObject({ chat_id: String(from), text: 'This chat is only for approval requests. Pairing codes and task decisions go to the decision bot.' })
      expect(sentTo('sendMessage')[0].body.parse_mode).toBeUndefined()
      expect(status(f.requestId).status).toBe('pending')
      expect(grants(f.requestId)).toBe(0)
      expect(one<{ n: number }>('SELECT COUNT(*) AS n FROM task_verdicts').n).toBe(0)
    }
  })
  const ID_ONLY = 'Send the id only: /muapprove <id> or /mudeny <id>. Add any reason on the approval page.'
  const START_WELCOME = 'This bot sends you approval requests. When one arrives, tap a button or reply /muapprove <id>.'
  const ROUTING = 'This chat is only for approval requests. Pairing codes and task decisions go to the decision bot.'
  const ROUTING_NAMED = 'This chat is only for approval requests. Pairing codes and task decisions go to @kayhermes_mubot.'
  it('bare /start welcomes and does not send the routing sentence', async () => {
    const f = await file()
    for (const text of ['/start', '/start@muapprove_test_bot']) {
      calls.length = 0
      expect(await handleApprovalBotUpdate(env, cmdUpdate(text, { from: TG.owner }))).toEqual({ kind: 'ignored', reason: 'not_our_command' })
      expect(sentTo('sendMessage')).toHaveLength(1)
      expect(sentTo('sendMessage')[0].body).toMatchObject({ chat_id: String(TG.owner), text: START_WELCOME })
      expect(sentTo('sendMessage')[0].body.parse_mode).toBeUndefined()
      expect(String(sentTo('sendMessage')[0].body.text)).not.toContain('decision bot')
      expect(status(f.requestId).status).toBe('pending')
      expect(grants(f.requestId)).toBe(0)
    }
  })
  it('/start with a payload keeps the routing sentence and does not echo the payload', async () => {
    const f = await file()
    calls.length = 0
    const payload = 'secret-pairing-code'
    expect(await handleApprovalBotUpdate(env, cmdUpdate(`/start ${payload}`, { from: TG.owner }))).toEqual({ kind: 'ignored', reason: 'not_our_command' })
    expect(sentTo('sendMessage')[0].body).toMatchObject({ chat_id: String(TG.owner), text: ROUTING })
    expect(sentTo('sendMessage')[0].body.parse_mode).toBeUndefined()
    expect(String(sentTo('sendMessage')[0].body.text)).not.toContain(payload)
    expect(status(f.requestId).status).toBe('pending')
    expect(grants(f.requestId)).toBe(0)
  })
  it.each([
    ['extra words', (id: string) => `/mudeny ${id} secret-reason-do-not-echo`],
    ['id too long', (id: string) => `/muapprove ${id}${'a'.repeat(17)}`],
    ['wrong bot', (id: string) => `/muapprove@some_other_bot ${id}`],
    ['revoke extra', (id: string) => `/murevoke ${id} everything`],
  ])('a malformed decision command (%s) gets the id-only reply and writes no state', async (_label, build) => {
    const f = await file()
    calls.length = 0
    const text = build(f.shortId ?? 'abcdefgh')
    expect(await handleApprovalBotUpdate(env, cmdUpdate(text, { from: TG.owner }))).toEqual({ kind: 'ignored', reason: 'not_our_command' })
    expect(sentTo('sendMessage')).toHaveLength(1)
    expect(sentTo('sendMessage')[0].body).toMatchObject({ chat_id: String(TG.owner), text: ID_ONLY })
    expect(sentTo('sendMessage')[0].body.parse_mode).toBeUndefined()
    expect(String(sentTo('sendMessage')[0].body.text)).not.toContain('secret-reason-do-not-echo')
    expect(String(sentTo('sendMessage')[0].body.text)).not.toContain('decision bot')
    expect(String(sentTo('sendMessage')[0].body.text)).not.toContain(f.shortId)
    expect(status(f.requestId).status).toBe('pending')
    expect(grants(f.requestId)).toBe(0)
  })
  it('a group /mudeny <id> reason stays silent', async () => {
    const f = await file()
    calls.length = 0
    expect(await handleApprovalBotUpdate(env, cmdUpdate(`/mudeny ${f.shortId} not now`, { from: TG.owner, chat: -100123, chatType: 'group' }))).toEqual({ kind: 'ignored', reason: 'not_private_chat' })
    expect(calls).toHaveLength(0)
    expect(status(f.requestId).status).toBe('pending')
    expect(grants(f.requestId)).toBe(0)
  })
  it('a forwarded malformed /mudeny is refused as forwarded before the id-only reply', async () => {
    const f = await file()
    calls.length = 0
    expect(await handleApprovalBotUpdate(env, cmdUpdate(`/mudeny ${f.shortId} not now`, { from: TG.owner, forwarded: true }))).toEqual({ kind: 'refused', reason: 'forwarded' })
    expect(sentTo('sendMessage')[0].body.text).toBe('A forwarded message cannot decide anything. Type the command yourself.')
    expect(status(f.requestId).status).toBe('pending')
    expect(grants(f.requestId)).toBe(0)
  })
  it('names @im_bot_username on the routing reply when the org set a valid one', async () => {
    harness.sqlite.prepare("INSERT INTO org_settings (key, value) VALUES ('im_bot_username', 'kayhermes_mubot')").run()
    const f = await file()
    const last = String(approvalCalls()[0].body.text).split('\n').pop()
    const mins = last?.match(/^Decide within (\d+) min\./)?.[1]
    expect(last).toBe(`Decide within ${mins} min. Tap a button, or reply /muapprove ${f.shortId} or /mudeny ${f.shortId}. /murevoke ends everything you approved. The id is the request id from this message. Task decisions go to @kayhermes_mubot.`)
    calls.length = 0
    expect(await handleApprovalBotUpdate(env, cmdUpdate('/start secret-pairing-code', { from: TG.owner }))).toEqual({ kind: 'ignored', reason: 'not_our_command' })
    expect(sentTo('sendMessage')[0].body).toMatchObject({ chat_id: String(TG.owner), text: ROUTING_NAMED })
    expect(sentTo('sendMessage')[0].body.parse_mode).toBeUndefined()
    expect(String(sentTo('sendMessage')[0].body.text)).not.toContain('secret-pairing-code')
    calls.length = 0
    expect(await handleApprovalBotUpdate(env, cmdUpdate('/start', { from: TG.owner }))).toEqual({ kind: 'ignored', reason: 'not_our_command' })
    expect(sentTo('sendMessage')[0].body.text).toBe(START_WELCOME)
  })
  it('keeps "the decision bot" when im_bot_username is missing or invalid, and does not echo the stored value', async () => {
    for (const bad of ['bot', 'abcd', 'has space', '@kayhermes_mubot', 'a'.repeat(33), 'bad-name', 'evil_bot\nApproved']) {
      harness.sqlite.prepare("INSERT INTO org_settings (key, value) VALUES ('im_bot_username', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(bad)
      calls.length = 0
      expect(await handleApprovalBotUpdate(env, cmdUpdate('/needs', { from: TG.owner }))).toEqual({ kind: 'ignored', reason: 'not_our_command' })
      expect(sentTo('sendMessage')[0].body.text).toBe(ROUTING)
      expect(String(sentTo('sendMessage')[0].body.text)).not.toContain('evil_bot')
      expect(String(sentTo('sendMessage')[0].body.text)).not.toContain('@kayhermes_mubot')
    }
    calls.length = 0
    const f = await file()
    const card = String(approvalCalls()[0].body.text)
    const last = card.split('\n').pop()
    const mins = last?.match(/^Decide within (\d+) min\./)?.[1]
    expect(last).toBe(`Decide within ${mins} min. Tap a button, or reply /muapprove ${f.shortId} or /mudeny ${f.shortId}. /murevoke ends everything you approved. The id is the request id from this message. Task decisions go to the decision bot.`)
    expect(card).not.toContain('evil_bot')
  })
  it.each(['group', 'supergroup', 'channel'])('keeps unknown commands silent in %s', async (chatType) => {
    const f = await file()
    calls.length = 0
    for (const text of ['/start secret-pairing-code', '/unknown']) {
      expect((await handleApprovalBotUpdate(env, cmdUpdate(text, { from: TG.owner, chat: TG.owner, chatType }))).kind).toBe('ignored')
    }
    expect(calls).toHaveLength(0)
    expect(status(f.requestId).status).toBe('pending')
    expect(grants(f.requestId)).toBe(0)
  })
  it('keeps plain text and sender/chat mismatch silent', async () => {
    const f = await file()
    calls.length = 0
    expect(await handleApprovalBotUpdate(env, cmdUpdate('hello /start', { from: TG.owner }))).toEqual({ kind: 'ignored', reason: 'not_a_command' })
    expect(await handleApprovalBotUpdate(env, cmdUpdate('/start code', { from: TG.owner, chat: TG.plain }))).toEqual({ kind: 'ignored', reason: 'not_private_chat' })
    expect(calls).toHaveLength(0)
    expect(status(f.requestId).status).toBe('pending')
    expect(grants(f.requestId)).toBe(0)
  })
  it('Approve tap: grants created, decided by the owner via approval_bot, receipt written, message edited, grant live for the agent', async () => {
    const f = await file()
    const r = await handleApprovalBotUpdate(env, tapUpdate(`ea:${f.shortId}`, { from: TG.owner, messageId: deliveredMessageId(f.requestId) }))
    expect(r.kind).toBe('approved')
    expect(status(f.requestId)).toMatchObject({ status: 'approved', decided_by_member_id: 'mem-owner', decided_via: 'approval_bot', decision_note: 'via:approval_bot' })
    expect(grants(f.requestId)).toBe(1)
    expect(one('SELECT handler, operation, member_id FROM mutation_audit_entries WHERE target_id = ? AND operation = ?', f.requestId, 'elevation_approve'))
      .toEqual({ handler: 'approval_bot', operation: 'elevation_approve', member_id: 'mem-owner' })
    expect(sentTo('answerCallbackQuery')).toHaveLength(1)
    expect(sentTo('editMessageText')).toHaveLength(1)
    expect(String(sentTo('editMessageText')[0].body.text)).toContain('Approved')
    expect((sentTo('editMessageText')[0].body.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard).toEqual([])
    expect((await activeElevations()).filter((g) => g.live).map((g) => g.action)).toEqual(['action:project_status'])
  })
  it('/muapprove <id> typed in the chat approves too, and replies in that chat', async () => {
    const f = await file()
    calls.length = 0
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('approved')
    expect(grants(f.requestId)).toBe(1)
    expect(sentTo('sendMessage')[0].body.chat_id).toBe(String(TG.owner))
    expect(String(sentTo('sendMessage')[0].body.text)).toContain('Approved')
    // the command may carry our own @username; it still counts
    const g = await file({ actions: ['action:routine_policy'], reason: 'second' })
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove@${USERNAME} ${g.shortId}`, { from: TG.owner }))).kind).toBe('approved')
  })
  it('Deny tap and /mudeny: denied, no grant, recorded via approval_bot', async () => {
    const f = await file()
    expect((await handleApprovalBotUpdate(env, tapUpdate(`ed:${f.shortId}`, { from: TG.owner, messageId: deliveredMessageId(f.requestId) }))).kind).toBe('denied')
    expect(status(f.requestId)).toMatchObject({ status: 'denied', decided_by_member_id: 'mem-owner', decided_via: 'approval_bot' })
    expect(grants(f.requestId)).toBe(0)
    const g = await file({ reason: 'again' })
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/mudeny ${g.shortId}`, { from: TG.owner }))).kind).toBe('denied')
    expect(status(g.requestId).status).toBe('denied')
  })
  it('REPLAY: the same approve twice lands once; a later deny cannot flip it; a deny then approve cannot flip it either', async () => {
    const f = await file()
    const mid = deliveredMessageId(f.requestId)
    expect((await handleApprovalBotUpdate(env, tapUpdate(`ea:${f.shortId}`, { from: TG.owner, messageId: mid }))).kind).toBe('approved')
    expect((await handleApprovalBotUpdate(env, tapUpdate(`ea:${f.shortId}`, { from: TG.owner, messageId: mid }))).kind).toBe('closed')
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/mudeny ${f.shortId}`, { from: TG.owner }))).kind).toBe('closed')
    expect(status(f.requestId).status).toBe('approved')
    expect(grants(f.requestId)).toBe(1)
    const g = await file({ reason: 'second' })
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/mudeny ${g.shortId}`, { from: TG.owner }))).kind).toBe('denied')
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${g.shortId}`, { from: TG.owner }))).kind).toBe('closed')
    expect(status(g.requestId).status).toBe('denied')
    expect(grants(g.requestId)).toBe(0)
  })
  it('concurrent approves of one request: one decision, one grant set', async () => {
    const f = await file()
    const rs = await Promise.all(Array.from({ length: 6 }, () => handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))))
    expect(rs.filter((r) => r.kind === 'approved')).toHaveLength(1)
    expect(grants(f.requestId)).toBe(1)
  })
})

describe('decision: every wrong way in is refused and changes nothing', () => {
  const untouched = (id: string): void => {
    expect(status(id).status).toBe('pending')
    expect(grants(id)).toBe(0)
  }
  it('WRONG CHAT: another bound member tapping this request\'s button, or typing its id, is refused', async () => {
    const f = await file()
    for (const from of [TG.plain, TG.sqadmin]) {
      expect((await handleApprovalBotUpdate(env, tapUpdate(`ea:${f.shortId}`, { from, messageId: deliveredMessageId(f.requestId) }))).kind).toBe('refused')
      expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from }))).kind).toBe('refused')
    }
    untouched(f.requestId)
  })
  it('an unbound Telegram account (a stranger) is refused', async () => {
    const f = await file()
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.stranger }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('GROUP CHAT: the owner\'s own id in a supergroup / group / channel decides nothing and gets no reply there', async () => {
    const f = await file()
    calls.length = 0
    for (const chatType of ['supergroup', 'group', 'channel']) {
      const r = await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner, chat: -100123, chatType }))
      expect(r.kind).toBe('ignored')
    }
    expect((await handleApprovalBotUpdate(env, tapUpdate(`ea:${f.shortId}`, { from: TG.owner, chat: -100123, chatType: 'supergroup', messageId: deliveredMessageId(f.requestId) }))).kind).toBe('ignored')
    expect(sentTo('sendMessage')).toHaveLength(0)
    untouched(f.requestId)
  })
  it('a private-typed chat whose id is not the sender\'s own id is refused (sender == chat)', async () => {
    const f = await file()
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner, chat: TG.plain }))).kind).toBe('ignored')
    untouched(f.requestId)
  })
  it('a FORWARDED command decides nothing', async () => {
    const f = await file()
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner, forwarded: true }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('STALE: a request past its decision window cannot be approved (and is not left approvable)', async () => {
    const f = await file()
    harness.sqlite.prepare("UPDATE elevation_requests SET decision_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), f.requestId)
    const r = await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))
    expect(r.kind === 'closed' || r.kind === 'refused').toBe(true)
    expect(status(f.requestId).status).not.toBe('approved')
    expect(grants(f.requestId)).toBe(0)
  })
  it('MISMATCHED ID: unknown id, malformed id, no id, and a callback with the wrong id are refused', async () => {
    const f = await file()
    for (const text of ['/muapprove zzzzzzzz', '/muapprove ABC', '/muapprove', `/muapprove ${f.shortId}0`]) {
      expect((await handleApprovalBotUpdate(env, cmdUpdate(text, { from: TG.owner }))).kind).toBe('refused')
    }
    expect((await handleApprovalBotUpdate(env, tapUpdate('ea:aaaaaaaa', { from: TG.owner, messageId: deliveredMessageId(f.requestId) }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('an id addressed to ANOTHER member is refused even for an admin who could decide it', async () => {
    setOwner('mem-sqadmin')
    const f = await file() // delivered to mem-sqadmin
    expect(one<{ member_id: string }>('SELECT member_id FROM approval_bot_deliveries WHERE request_id = ?', f.requestId).member_id).toBe('mem-sqadmin')
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('refused') // the org owner, who has authority
    untouched(f.requestId)
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.sqadmin }))).kind).toBe('approved')
  })
  it('the offer was made to ONE chat: if the member rebinds to another Telegram account afterwards, the old offer cannot be decided from the new one', async () => {
    const f = await file()
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = '2001' WHERE id = 'mem-owner'")
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: 2001 }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('a request whose offer never reached the human (send failed) cannot be decided by typing its id', async () => {
    stubBot('fail')
    const f = await file()
    expect(f.telegram).toBe('failed')
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('a chat whose id equals the sender\'s but whose TYPE is not private is refused (type is checked, not just the id)', async () => {
    const f = await file()
    for (const chatType of ['supergroup', 'group', 'channel']) {
      expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner, chat: TG.owner, chatType }))).kind).toBe('ignored')
    }
    untouched(f.requestId)
  })
  it('a delivery row that names a DIFFERENT member than the sender is refused even when the chat id matches the sender', async () => {
    const f = await file()
    harness.sqlite.prepare('UPDATE approval_bot_deliveries SET member_id = ? WHERE request_id = ?').run('mem-sqadmin', f.requestId)
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('IDENTITY: the bot writes NOTHING into human_login_identities; the session anchors on the member\'s own sign-in, and unlinking their last real login is still refused', async () => {
    const f = await file()
    const before = count('human_login_identities')
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('approved')
    expect(count('human_login_identities')).toBe(before)
    expect(count('human_login_identities', "provider = 'telegram_approval_bot'")).toBe(0)
    expect(one<{ login_identity_id: string }>('SELECT login_identity_id FROM web_sessions ORDER BY rowid DESC LIMIT 1').login_identity_id).toBe('hli-owner')
    const { unlinkSignIn } = await import('../src/auth/link-signin')
    const ownerAuth: AuthContext = { userId: 'u-owner', email: 'owner@x.test', role: 'owner', tenant: TENANT, channel: 'dashboard', memberId: 'mem-owner' }
    expect(await unlinkSignIn(env, ownerAuth, 'hli-owner')).toEqual({ ok: false, error: 'last_identity' })
    // the bot keeps working afterwards
    const g = await file({ reason: 'again', actions: ['action:routine_policy'] })
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${g.shortId}`, { from: TG.owner }))).kind).toBe('approved')
  })
  it('ROLE at decision time: authority proven only by members.email (verified identity gone after the offer) cannot approve', async () => {
    const f = await file()
    harness.sqlite.exec("UPDATE human_login_identities SET verified_email = NULL WHERE id = 'hli-owner'")
    harness.sqlite.exec("DELETE FROM capabilities WHERE id = 'cap-o'")
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('a member who has never signed in (no live login identity) approves nothing and gets told why', async () => {
    const f = await file()
    harness.sqlite.exec("UPDATE human_login_identities SET revoked_at = datetime('now') WHERE member_id = 'mem-owner'")
    calls.length = 0
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('refused')
    expect(String(sentTo('sendMessage')[0].body.text)).toContain('Sign in')
    untouched(f.requestId)
    expect(count('human_login_identities', "provider = 'telegram_approval_bot'")).toBe(0)
  })
  it('ROLE: an approver whose members.email matches the owner but who has NO verified identity is not the owner', async () => {
    harness.sqlite.exec("UPDATE human_login_identities SET verified_email = NULL WHERE id = 'hli-owner'")
    harness.sqlite.exec("DELETE FROM capabilities WHERE id = 'cap-o'")
    const f = await file()
    expect(f.telegram).toBe('not_bound') // not even offered: email-derived 'owner' no longer counts
    expect(calls).toHaveLength(0)
  })
  it('STEP-UP: the broad action:manage_access is never offered to the bot, and a tap on it is refused even with a forged delivery row', async () => {
    const f = await file({ actions: ['action:manage_access'] })
    expect(approvalCalls()).toHaveLength(0)
    harness.sqlite.exec("UPDATE elevation_requests SET short_id = 'mnpqrstv' WHERE id = '" + f.requestId + "'")
    harness.sqlite.prepare("INSERT INTO approval_bot_deliveries (id, tenant, request_id, member_id, chat_id, message_id, status, created_at) VALUES ('d9', ?, ?, 'mem-owner', ?, '1', 'sent', datetime('now'))").run(TENANT, f.requestId, String(TG.owner))
    expect((await handleApprovalBotUpdate(env, cmdUpdate('/muapprove mnpqrstv', { from: TG.owner }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('STEP-UP core: even if the carry check were bypassed, the core refuses a bot tap for a sensitive action (reauth_required)', async () => {
    const { decideElevation } = await import('../src/access/decision-core')
    const { buildAuth } = await import('../src/access/identity')
    const f = await file({ actions: ['action:manage_access'] })
    const out = await decideElevation(env, {
      id: f.requestId, decision: 'approve', selectedActions: ['action:manage_access'], durationMinutes: undefined,
      auth: await buildAuth(env, 'mem-owner', undefined, { verifiedRole: true }), proof: { memberId: 'mem-owner', via: 'approval_bot', evidence: {} },
      mintSession: async () => { throw new Error('must not be reached') },
    })
    expect(out.status).not.toBe(200)
    untouched(f.requestId)
  })
  it('a request from an ATTACHED chat is not offered to the bot (it is approved with a passkey)', async () => {
    harness.sqlite.exec('PRAGMA foreign_keys = OFF')
    harness.sqlite.prepare(
      `INSERT INTO agent_seat_attachments (id, tenant, seat_id, human_member_id, harness_id, agent_id, admission_id, seat_token_id, created_at, detached_at, detach_reason)
       VALUES ('att-1', ?, 'seat-1', 'mem-owner', 'h-1', 'agent-x', 'adm-1', 'tok-1', datetime('now'), datetime('now'), 'human')`,
    ).run(TENANT)
    await file({ actions: ['action:org_structure'], scope_type: 'squad', scope_id: 'squad-a' }).catch(() => undefined)
    expect(approvalCalls()).toHaveLength(0)
    expect(count('approval_bot_deliveries')).toBe(0)
  })
  it('a button on a DIFFERENT message than the one delivered is refused', async () => {
    const f = await file()
    expect((await handleApprovalBotUpdate(env, tapUpdate(`ea:${f.shortId}`, { from: TG.owner, messageId: 9999 }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('SELF-APPROVAL: the requesting agent\'s own Telegram binding resolves to nobody; its request is never approved through it', async () => {
    const f = await file()
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.agent }))).kind).toBe('refused')
    // even with a delivery row forged to name the agent's own member + chat, the core's requester fence holds
    harness.sqlite.prepare('UPDATE approval_bot_deliveries SET member_id = ?, chat_id = ? WHERE request_id = ?').run('mem-agent', String(TG.agent), f.requestId)
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.agent }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('a member WITHOUT authority on the request scope cannot decide it even with a delivery row naming them (core authority predicate)', async () => {
    const f = await file()
    harness.sqlite.prepare('UPDATE approval_bot_deliveries SET member_id = ?, chat_id = ? WHERE request_id = ?').run('mem-plain', String(TG.plain), f.requestId)
    const r = await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.plain }))
    expect(r.kind).toBe('refused')
    untouched(f.requestId)
  })
  it('a request whose actions the bot may not carry cannot be APPROVED through it, even with a forged delivery row', async () => {
    const f = await file({ actions: ['action:mint_token'] })
    harness.sqlite.exec("UPDATE elevation_requests SET short_id = 'mnpqrstv' WHERE id = '" + f.requestId + "'")
    harness.sqlite.prepare("INSERT INTO approval_bot_deliveries (id, tenant, request_id, member_id, chat_id, message_id, status, created_at) VALUES ('d1', ?, ?, 'mem-owner', ?, '1', 'sent', datetime('now'))").run(TENANT, f.requestId, String(TG.owner))
    expect((await handleApprovalBotUpdate(env, cmdUpdate('/muapprove mnpqrstv', { from: TG.owner }))).kind).toBe('refused')
    untouched(f.requestId)
    // deny is always available
    expect((await handleApprovalBotUpdate(env, cmdUpdate('/mudeny mnpqrstv', { from: TG.owner }))).kind).toBe('denied')
  })
  it('a command addressed to ANOTHER bot is not ours; the bot off ignores everything', async () => {
    const f = await file()
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove@some_other_bot ${f.shortId}`, { from: TG.owner }))).kind).toBe('ignored')
    expect((await handleApprovalBotUpdate(baseEnv({ APPROVAL_BOT_TOKEN: undefined }), cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('ignored')
    untouched(f.requestId)
  })
  it('a suspended or archived approver is refused', async () => {
    const f = await file()
    harness.sqlite.exec("UPDATE members SET status = 'suspended' WHERE id = 'mem-owner'")
    expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).toBe('refused')
    untouched(f.requestId)
  })
  it('the agent session ending before the decision: nothing is granted', async () => {
    const f = await file()
    harness.sqlite.exec("UPDATE agent_sessions SET revoked_at = datetime('now')")
    const r = await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))
    expect(r.kind).not.toBe('approved')
    expect(grants(f.requestId)).toBe(0)
  })
})

describe('/murevoke and expiry end an approval', () => {
  it('/murevoke revokes every live approval the member gave; the agent loses the access on the very next call', async () => {
    const f = await file()
    await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))
    expect((await activeElevations()).some((g) => g.live)).toBe(true)
    expect((await handleApprovalBotUpdate(env, cmdUpdate('/murevoke', { from: TG.owner }))).kind).toBe('revoked')
    expect((await activeElevations()).some((g) => g.live)).toBe(false)
    expect(one<{ revoke_reason: string }>('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', f.requestId).revoke_reason).toBe('revoked_via_approval_bot')
    expect(one('SELECT handler, operation FROM mutation_audit_entries WHERE operation = ?', 'elevation_revoke')).toEqual({ handler: 'approval_bot', operation: 'elevation_revoke' })
  })
  it('/murevoke <id> ends only that request\'s grants', async () => {
    const f = await file({ actions: ['action:project_status'] })
    const g = await file({ actions: ['action:routine_policy'], reason: 'second' })
    await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))
    await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${g.shortId}`, { from: TG.owner }))
    await handleApprovalBotUpdate(env, cmdUpdate(`/murevoke ${f.shortId}`, { from: TG.owner }))
    expect((await activeElevations()).filter((x) => x.live).map((x) => x.action)).toEqual(['action:routine_policy'])
  })
  it('a member can revoke only what THEY approved (another admin\'s approval survives); a stranger revokes nothing', async () => {
    setOwner('mem-sqadmin')
    const f = await file()
    await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.sqadmin }))
    expect((await handleApprovalBotUpdate(env, cmdUpdate('/murevoke', { from: TG.owner }))).kind).toBe('revoked')
    expect((await activeElevations()).some((x) => x.live)).toBe(true)
    expect((await handleApprovalBotUpdate(env, cmdUpdate('/murevoke', { from: TG.stranger }))).kind).toBe('refused')
    expect((await activeElevations()).some((x) => x.live)).toBe(true)
  })
  it('a revoke from a group chat does nothing', async () => {
    const f = await file()
    await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))
    expect((await handleApprovalBotUpdate(env, cmdUpdate('/murevoke', { from: TG.owner, chat: -1001, chatType: 'supergroup' }))).kind).toBe('ignored')
    expect((await activeElevations()).some((x) => x.live)).toBe(true)
  })
  it('an approval ends at its duration with nothing else done', async () => {
    const f = await file()
    await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))
    harness.sqlite.prepare('UPDATE elevation_grants SET expires_at = ? WHERE elevation_request_id = ?').run(new Date(Date.now() - 1000).toISOString(), f.requestId)
    expect((await activeElevations()).some((x) => x.live)).toBe(false)
  })
})

// #2100: exercise the real unbind route, decision core and live authorization.
async function unbind(memberId = 'mem-owner', actor = 'owner'): Promise<Response> {
  const { membersApp } = await import('../src/members')
  const session = JSON.stringify({ userId: `u-${actor}`, email: `${actor}@x.test`, role: actor === 'owner' ? 'owner' : 'member', createdAt: new Date().toISOString() })
  const e = { ...env, SESSIONS: { get: async (key: string) => key === 'sess:unbind' ? session : null, put: async () => undefined, delete: async () => undefined } } as Env
  return membersApp.request(`/members/${memberId}/telegram`, { method: 'DELETE', headers: { 'content-type': 'application/json', cookie: 'mupot_session=unbind' } }, e)
}
async function approve(f: Filed, from = TG.owner): Promise<void> {
  expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from }))).kind).toBe('approved')
}

describe('Telegram unbind ends only that member’s bot approvals (#2100)', () => {
  it('revokes the bot grant with a reason, refuses its next use, and repeats without another receipt', async () => {
    const { hasElevatedAction } = await import('../src/auth/elevation')
    const f = await file()
    // Channel provenance must commit even if the best-effort receipt write fails.
    harness.sqlite.exec("CREATE TRIGGER fail_bot_audit BEFORE INSERT ON mutation_audit_entries WHEN NEW.operation = 'elevation_approve' BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END")
    await approve(f)
    harness.sqlite.exec('DROP TRIGGER fail_bot_audit')
    expect((await hasElevatedAction(env, agentAuth(), 'action:project_status', 'squad', 'squad-a')).granted).toBe(true)
    expect(status(f.requestId).decided_via).toBe('approval_bot')
    expect(count('mutation_audit_entries', "operation = 'elevation_approve'")).toBe(0)
    const res = await unbind()
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual({ member_id: 'mem-owner', telegram_unbound: true })
    expect(one('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', f.requestId)).toEqual({ revoke_reason: 'telegram_unbound' })
    expect((await hasElevatedAction(env, agentAuth(), 'action:project_status', 'squad', 'squad-a')).granted).toBe(false)
    const ended = one('SELECT revoked_at FROM elevation_grants WHERE elevation_request_id = ?', f.requestId)
    expect((await unbind()).status).toBe(200)
    expect(one('SELECT revoked_at FROM elevation_grants WHERE elevation_request_id = ?', f.requestId)).toEqual(ended)
    expect(count('telegram_unbind_receipts')).toBe(1)
  })

  it('also revokes legacy approvals whose channel tail write failed but bot receipt exists', async () => {
    const f = await file()
    await approve(f)
    harness.sqlite.prepare('UPDATE elevation_requests SET decided_via = NULL WHERE id = ?').run(f.requestId)
    expect((await unbind()).status).toBe(200)
    expect(one('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', f.requestId)).toEqual({ revoke_reason: 'telegram_unbound' })
  })

  it('preserves the same member’s passkey approval and another member’s bot approval (admin unbind)', async () => {
    const { decideElevation } = await import('../src/access/decision-core')
    const { buildAuth, mintApproverSession } = await import('../src/access/identity')
    const web = await file({ actions: ['action:project_status'] })
    const auth = await buildAuth(env, 'mem-owner', undefined, { verifiedRole: true })
    expect((await decideElevation(env, {
      id: web.requestId, decision: 'approve', selectedActions: ['action:project_status'], auth,
      proof: { memberId: 'mem-owner', via: 'webauthn', evidence: {} },
      mintSession: async () => { const s = await mintApproverSession(env, { memberId: 'mem-owner', auth, identityId: 'hli-owner', verifiedRole: true }); return { auth: s.approver.auth, webSessionHash: s.webSessionHash } },
    })).status).toBe(200)
    // The legacy web endpoint accepts an arbitrary note: this text is not channel proof.
    harness.sqlite.prepare("UPDATE elevation_requests SET decision_note = 'via:approval_bot' WHERE id = ?").run(web.requestId)
    const ownBot = await file({ actions: ['action:project_lifecycle'] })
    await approve(ownBot)
    setOwner('mem-sqadmin')
    const other = await file({ actions: ['action:workspace_project'] })
    await approve(other, TG.sqadmin)
    expect((await unbind()).status).toBe(200)
    expect(one('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', ownBot.requestId)).toEqual({ revoke_reason: 'telegram_unbound' })
    expect(one('SELECT revoked_at FROM elevation_grants WHERE elevation_request_id = ?', other.requestId)).toEqual({ revoked_at: null })
    // An org admin uses the same cleanup path for another member.
    expect((await unbind('mem-sqadmin')).status).toBe(200)
    expect(one('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', other.requestId)).toEqual({ revoke_reason: 'telegram_unbound' })
    expect(one('SELECT revoked_at FROM elevation_grants WHERE elevation_request_id = ?', web.requestId)).toEqual({ revoked_at: null })
  })

  it('leaves another member’s bot grant active while unbinding self', async () => {
    setOwner('mem-sqadmin')
    const other = await file()
    await approve(other, TG.sqadmin)
    expect((await unbind()).status).toBe(200)
    expect((await activeElevations()).some((g) => g.live)).toBe(true)
  })

  it('old-chat callbacks and commands decide no pending request after unbind', async () => {
    const f = await file()
    expect((await unbind()).status).toBe(200)
    for (const update of [tapUpdate(`ea:${f.shortId}`, { from: TG.owner, messageId: deliveredMessageId(f.requestId) }), cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner })]) {
      expect(await handleApprovalBotUpdate(env, update)).toEqual({ kind: 'refused', reason: 'not_bound' })
    }
    expect(status(f.requestId).status).toBe('pending')
    expect(grants(f.requestId)).toBe(0)
  })

  it('an in-flight approval cannot commit after unbind clears the binding', async () => {
    const f = await file()
    const batch = env.DB.batch.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      expect((await unbind()).status).toBe(200)
      return batch(statements)
    })
    try {
      expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).not.toBe('approved')
      expect(status(f.requestId).status).toBe('pending')
      expect(grants(f.requestId)).toBe(0)
    } finally { spy.mockRestore() }
  })

  it('an in-flight renewal cannot resurrect an ended slot after unbind', async () => {
    const old = await file()
    await approve(old)
    harness.sqlite.prepare("UPDATE elevation_grants SET revoked_at = '2020-01-01T00:00:00.000Z', revoke_reason = 'ended' WHERE elevation_request_id = ?").run(old.requestId)
    const ended = one('SELECT * FROM elevation_grants WHERE elevation_request_id = ?', old.requestId)
    const f = await file()
    const batch = env.DB.batch.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      expect((await unbind()).status).toBe(200)
      return batch(statements)
    })
    try {
      expect((await handleApprovalBotUpdate(env, cmdUpdate(`/muapprove ${f.shortId}`, { from: TG.owner }))).kind).not.toBe('approved')
      expect(status(f.requestId).status).toBe('pending')
      expect(one('SELECT * FROM elevation_grants WHERE elevation_request_id = ?', old.requestId)).toEqual(ended)
      expect(grants(f.requestId)).toBe(0)
    } finally { spy.mockRestore() }
  })

  it('an in-flight deny cannot decide after unbind', async () => {
    const f = await file()
    const prepare = env.DB.prepare.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql)
      if (sql.includes("SET status = 'denied', decided_at")) {
        const bind = statement.bind.bind(statement)
        statement.bind = (...values) => {
          const bound = bind(...values)
          const run = bound.run.bind(bound)
          bound.run = async () => {
            expect((await unbind()).status).toBe(200)
            return run()
          }
          return bound
        }
      }
      return statement
    })
    try {
      expect((await handleApprovalBotUpdate(env, cmdUpdate(`/mudeny ${f.shortId}`, { from: TG.owner }))).kind).not.toBe('denied')
      expect(status(f.requestId).status).toBe('pending')
      expect(grants(f.requestId)).toBe(0)
    } finally { spy.mockRestore() }
  })

  it('preserves a bot grant in another tenant for the same approver', async () => {
    const foreign = await file()
    await approve(foreign)
    harness.sqlite.prepare("UPDATE elevation_grants SET tenant = 'tenant-b' WHERE elevation_request_id = ?").run(foreign.requestId)
    harness.sqlite.prepare("UPDATE elevation_requests SET tenant = 'tenant-b' WHERE id = ?").run(foreign.requestId)
    const local = await file({ actions: ['action:project_lifecycle'] })
    await approve(local)
    expect((await unbind()).status).toBe(200)
    expect(one('SELECT revoked_at FROM elevation_grants WHERE elevation_request_id = ?', foreign.requestId)).toEqual({ revoked_at: null })
    expect(one('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', local.requestId)).toEqual({ revoke_reason: 'telegram_unbound' })
  })

  it('never exposes a committed unbound member with live bot grants', async () => {
    const f = await file()
    await approve(f)
    const batch = env.DB.batch.bind(env.DB)
    let observed = false
    const spy = vi.spyOn(env.DB, 'batch').mockImplementation(async (statements) => {
      const result = await batch(statements)
      observed = true
      expect(one<{ n: number }>(`SELECT COUNT(*) AS n FROM members m JOIN elevation_grants g ON g.approved_by_member_id = m.id
        WHERE m.id = 'mem-owner' AND m.telegram_chat_id IS NULL AND g.revoked_at IS NULL`).n).toBe(0)
      return result
    })
    try {
      expect((await unbind()).status).toBe(200)
      expect(observed).toBe(true)
      expect(one("SELECT telegram_chat_id FROM members WHERE id = 'mem-owner'")).toEqual({ telegram_chat_id: null })
    } finally { spy.mockRestore() }
  })

  it('accepts a concurrent unbind of a legacy NULL-tenant member', async () => {
    const batch = env.DB.batch.bind(env.DB)
    const spy = vi.spyOn(env.DB, 'batch').mockImplementationOnce(async (statements) => {
      harness.sqlite.exec("UPDATE members SET tenant = NULL, telegram_chat_id = NULL WHERE id = 'mem-owner'")
      return batch(statements)
    })
    try {
      expect((await unbind()).status).toBe(200)
      expect(count('telegram_unbind_receipts')).toBe(0)
    } finally { spy.mockRestore() }
  })

  it('concurrent unbinds both succeed and write only one receipt', async () => {
    const f = await file()
    await approve(f)
    const responses = await Promise.all([unbind(), unbind()])
    expect(responses.map((r) => r.status)).toEqual([200, 200])
    expect(count('telegram_unbind_receipts')).toBe(1)
    expect(one('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', f.requestId)).toEqual({ revoke_reason: 'telegram_unbound' })
  })

  it('fails closed on revoke failure, then retries cleanup without double-logging', async () => {
    const f = await file()
    await approve(f)
    harness.sqlite.prepare(`INSERT INTO tg_miniapp_devices
      (id, tenant, member_id, telegram_user_id, enrolment_token_id, secret_sha256, created_at, confirmed_at)
      VALUES ('device-unbind', ?, 'mem-owner', '1001', 'enrol-unbind', ?, '2026-01-01', '2026-01-01')`).run(TENANT, 'a'.repeat(64))
    harness.sqlite.exec("CREATE TRIGGER fail_unbind_revoke BEFORE UPDATE OF revoked_at ON elevation_grants BEGIN SELECT RAISE(ABORT, 'injected revoke failure'); END")
    expect((await unbind()).status).toBe(500)
    expect(one('SELECT revoked_at FROM elevation_grants WHERE elevation_request_id = ?', f.requestId)).toEqual({ revoked_at: null })
    expect(one("SELECT telegram_chat_id FROM members WHERE id = 'mem-owner'")).toEqual({ telegram_chat_id: String(TG.owner) })
    expect(count('telegram_unbind_receipts')).toBe(0)
    expect(one("SELECT revoked_at FROM tg_miniapp_devices WHERE id = 'device-unbind'")).toEqual({ revoked_at: null })
    harness.sqlite.exec('DROP TRIGGER fail_unbind_revoke')
    expect((await unbind()).status).toBe(200)
    expect(one('SELECT revoke_reason FROM elevation_grants WHERE elevation_request_id = ?', f.requestId)).toEqual({ revoke_reason: 'telegram_unbound' })
    expect(count('telegram_unbind_receipts')).toBe(1)
    expect(one("SELECT revoked_reason FROM tg_miniapp_devices WHERE id = 'device-unbind'")).toEqual({ revoked_reason: 'telegram_unbound' })
    expect(count('mutation_audit_entries', "operation = 'tg_device_revoke'")).toBe(1)
    expect((await unbind()).status).toBe(200)
    expect(count('telegram_unbind_receipts')).toBe(1)
    expect(count('mutation_audit_entries', "operation = 'tg_device_revoke'")).toBe(1)
  })
})
