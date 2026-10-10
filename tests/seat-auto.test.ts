// tests/seat-auto.test.ts — W5a: server-side AUTO-SEAT from a per-thread client key (ChatGPT first).
//
// Real sqlite D1 from the full committed migration chain. Requests go through the real path:
// OAuth props -> buildAuthContextFromProps -> internal header -> mcpApp (resolveAuth ->
// resolveSeatSession -> applySeatForRequest -> tool). Token-harness sessions go through the real
// bearer door (authenticateMember). Not proven here: the cloudflare:workers entrypoint; real D1
// cross-isolate concurrency (Promise.all over a serialized sqlite proves per-statement atomicity).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { membersApp } from '../src/members'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { NO_HINTS } from '../src/members/seat-handle'
import { applySeatForRequest, autoSeatKey, pickAutoSeatKey, findLiveAutoSeat, resetAutoSeatRefusalCache, AUTO_SEAT_KEY_MAX_LEN } from '../src/members/seat-auto'
import { seatKeyHash } from '../src/members/seat-key'
import { AUTO_SEAT_HARNESS_WINDOW_MAX } from '../src/members/seat-select'
import { canReleaseExecutionHold } from '../src/agents/execution-release-policy'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const HUMAN2 = 'member-human-2'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

const ADMIN_SESSION = JSON.stringify({ userId: 'u-admin', email: 'admin@x.test', role: 'admin', createdAt: '2026-01-01T00:00:00Z' })

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  const kv = memoryKv()
  void kv.put('sess:admin-sid', ADMIN_SESSION)
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: kv, OAUTH_KV: { get: async () => null, put: async () => undefined },
    SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
let tokCounter = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

function seedHuman(id: string): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

interface Grant { memberId: string; tokenId: string; harnessId: string; ctx: AuthContext }

/** A human's unbound OAuth harness grant (a ChatGPT connector: "Me — auto per workspace"). */
async function grant(env: Env, memberId: string, clientId = 'client-chatgpt', name = 'ChatGPT'): Promise<Grant> {
  const harness = await upsertHarness(env, memberId, clientId, name)
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tokCounter}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:${clientId}', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return { memberId, tokenId, harnessId: harness.id, ctx }
}

interface RpcOpts { path?: string; headers?: Record<string, string>; meta?: Record<string, unknown>; argsMeta?: Record<string, unknown> }
interface Rpc { status: number; body: Record<string, unknown>; sc: Record<string, unknown> }

async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown> = {}, o: RpcOpts = {}): Promise<Rpc> {
  const params: Record<string, unknown> = { name, arguments: o.argsMeta ? { ...args, _meta: o.argsMeta } : args }
  if (o.meta) params._meta = o.meta
  const req = new Request(`https://pot.test${o.path ?? '/mcp'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
}

const receiptOf = (r: Rpc): Record<string, unknown> => r.sc.identity_receipt as Record<string, unknown>
const boot = (env: Env, g: Grant, meta?: Record<string, unknown>, o: RpcOpts = {}): Promise<Rpc> => rpc(env, g.ctx, 'boot_context', {}, { ...o, meta })
const chatgpt = (session: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ 'openai/session': session, ...extra })
const seatCount = (): number => n(`SELECT COUNT(*) AS n FROM agent_seats`)

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedHuman(HUMAN2)
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

// ════════════════════════════════════════════════════════════════════════════
describe('ChatGPT-shaped request: _meta["openai/session"] -> its own seat agent', () => {
  it('binds a seat agent, distinct per session value, stable for the same value; receipt says auto:openai_session', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a1 = await boot(env, g, chatgpt('conv-aaa'))
    const b1 = await boot(env, g, chatgpt('conv-bbb'))
    const a2 = await boot(env, g, chatgpt('conv-aaa'))
    expect(typeof a1.sc.bound_agent_id).toBe('string')
    expect(a1.sc.bound_agent_id).not.toBe(b1.sc.bound_agent_id)
    expect(a2.sc.bound_agent_id).toBe(a1.sc.bound_agent_id)
    expect(seatCount()).toBe(2)
    expect(receiptOf(a1)).toMatchObject({ binding_source: 'auto_seat', seat: { source: 'auto:openai_session' }, seat_handle_rejected: false, auto_seat_refused: null })
    expect(String(a1.sc.next_step)).toContain('no seat_select and no handle needed')
    // it is a SEAT agent of the HUMAN's harness, welded to its own member, never the human
    expect(a1.sc.member_id).not.toBe(HUMAN)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats s WHERE s.member_id = ? AND s.harness_id = ?`, HUMAN, g.harnessId)).toBe(2)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles`)).toBe(0) // no handle is issued or needed
  })

  it('a key present ONLY in arguments._meta (model-written) never auto-seats; params._meta (client-written) does', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const viaArgs = await rpc(env, g.ctx, 'boot_context', {}, { argsMeta: chatgpt('conv-arg') })
    expect(viaArgs.sc.bound_agent_id).toBeNull()
    expect(receiptOf(viaArgs)).toMatchObject({ seat: null, hints: { openai_session: true } })
    expect(seatCount()).toBe(0)
    const viaParams = await boot(env, g, chatgpt('conv-arg'))
    expect(typeof viaParams.sc.bound_agent_id).toBe('string')
    // a model putting a DIFFERENT key in arguments cannot override the client's params key
    const both = await rpc(env, g.ctx, 'boot_context', {}, { meta: chatgpt('conv-arg'), argsMeta: chatgpt('model-chosen') })
    expect(both.sc.bound_agent_id).toBe(viaParams.sc.bound_agent_id)
    expect(seatCount()).toBe(1)
  })

  it('the raw client key is never stored anywhere in the database', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const raw = 'conv-SECRET-RAW-KEY-0123456789'
    await boot(env, g, chatgpt(raw, { threadId: 'thread-SECRET-RAW-9876' }))
    const dump = h.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()
      .map((t) => JSON.stringify(h.sqlite.prepare(`SELECT * FROM "${String(t.name)}"`).all())).join('\n')
    expect(dump).not.toContain('SECRET-RAW-KEY')
    expect(dump).not.toContain('SECRET-RAW-9876')
  })

  it('names the agent with member + client label + a short stable suffix (a LABEL), never the raw key', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const r = await boot(env, g, chatgpt('conv-name'))
    const agent = (receiptOf(r).agent as { name: string; slug: string })
    expect(agent.name).toMatch(/^Human member-human-1 · ChatGPT · thread-[0-9a-f]{6}$/)
    expect(agent.slug).toMatch(/^seat-[0-9a-f]{12}$/)
    expect(agent.name).not.toContain('conv-name')
    const again = await boot(env, g, chatgpt('conv-name'))
    expect((receiptOf(again).agent as { name: string }).name).toBe(agent.name)
  })

  it('capability ceiling: never above member', async () => {
    const env = envFor(h)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-o', '${HUMAN}', 'org', NULL, 'owner')`)
    const g = await grant(env, HUMAN)
    const r = await boot(env, g, chatgpt('conv-cap'))
    const eff = receiptOf(r).effective_capabilities as { highest: string | null }
    expect(eff.highest).toBe('member')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('Codex threadId (second choice) and key precedence', () => {
  it('threadId binds a seat labelled auto:codex_thread; openai/session wins when both are present', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN, 'client-codex', 'Codex')
    const t = await boot(env, g, { threadId: 'thr-1' })
    expect(receiptOf(t)).toMatchObject({ seat: { source: 'auto:codex_thread' } })
    const o = await boot(env, g, chatgpt('conv-1'))
    const both = await boot(env, g, chatgpt('conv-1', { threadId: 'thr-1' }))
    expect(both.sc.bound_agent_id).toBe(o.sc.bound_agent_id)
    expect(both.sc.bound_agent_id).not.toBe(t.sc.bound_agent_id)
    expect(receiptOf(both)).toMatchObject({ seat: { source: 'auto:openai_session' } })
  })

  it('the same string as an openai session and as a Codex thread are different seats (domain-separated)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await boot(env, g, chatgpt('same-value'))
    const b = await boot(env, g, { threadId: 'same-value' })
    expect(a.sc.bound_agent_id).not.toBe(b.sc.bound_agent_id)
  })

  it('pickAutoSeatKey: openai first, codex second; empty and over-long values are not keys', () => {
    expect(pickAutoSeatKey(undefined)).toBeNull()
    expect(pickAutoSeatKey({ openaiSession: null, codexThreadId: null })).toBeNull()
    expect(pickAutoSeatKey({ openaiSession: '', codexThreadId: '' })).toBeNull()
    expect(pickAutoSeatKey({ openaiSession: 'x'.repeat(AUTO_SEAT_KEY_MAX_LEN + 1), codexThreadId: null })).toBeNull()
    expect(pickAutoSeatKey({ openaiSession: 'x'.repeat(AUTO_SEAT_KEY_MAX_LEN), codexThreadId: null })).toMatchObject({ source: 'auto:openai_session' })
    expect(pickAutoSeatKey({ openaiSession: 'a', codexThreadId: 'b' })).toEqual({ source: 'auto:openai_session', raw: 'a' })
    expect(pickAutoSeatKey({ openaiSession: null, codexThreadId: 'b' })).toEqual({ source: 'auto:codex_thread', raw: 'b' })
  })

  it('autoSeatKey is deterministic and never contains the raw value', async () => {
    const k1 = await autoSeatKey({ source: 'auto:openai_session', raw: 'RAW-VALUE' })
    const k2 = await autoSeatKey({ source: 'auto:openai_session', raw: 'RAW-VALUE' })
    expect(k1).toEqual(k2)
    expect(JSON.stringify(k1)).not.toContain('RAW-VALUE')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('trust boundary', () => {
  it('a client key can never reach another member\'s seat: same key, two members -> two different agents', async () => {
    const env = envFor(h)
    const g1 = await grant(env, HUMAN); const g2 = await grant(env, HUMAN2)
    const a = await boot(env, g1, chatgpt('shared-conv'))
    const b = await boot(env, g2, chatgpt('shared-conv'))
    expect(a.sc.bound_agent_id).not.toBe(b.sc.bound_agent_id)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE member_id = ?`, HUMAN)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE member_id = ?`, HUMAN2)).toBe(1)
    // and the second member's seat agent is welded to ITS owner's home, not the first member's
    expect(a.sc.member_id).not.toBe(b.sc.member_id)
  })

  it('a client key can never reach another harness\'s seat: same member + key under two harnesses -> two agents', async () => {
    const env = envFor(h)
    const gc = await grant(env, HUMAN, 'client-chatgpt', 'ChatGPT')
    const gx = await grant(env, HUMAN, 'client-codex', 'Codex')
    expect(gc.harnessId).not.toBe(gx.harnessId)
    const a = await boot(env, gc, chatgpt('conv-x'))
    const b = await boot(env, gx, chatgpt('conv-x'))
    expect(a.sc.bound_agent_id).not.toBe(b.sc.bound_agent_id)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ?`, gc.harnessId)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ?`, gx.harnessId)).toBe(1)
  })

  it('a key equal to an EXISTING non-seat agent\'s id/slug/name never adopts it: a fresh seat agent is created', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    h.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-r', 'dr', 'DR');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-r', 'dept-r', 'sq-r', 'SqR');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('rava-id', 'sq-r', 'rava', 'Rava', 'active');`)
    for (const k of ['rava-id', 'rava', 'Rava']) {
      const r = await boot(env, g, chatgpt(k))
      expect(r.sc.bound_agent_id).not.toBe('rava-id')
      expect(String(r.sc.bound_agent_id)).not.toBe('')
    }
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = 'rava-id'`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM agent_member_bindings WHERE agent_id = 'rava-id'`)).toBe(0)
  })

  it('Mcp-Session-Id and openai/subject alone never select a seat', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const r = await boot(env, g, { 'openai/subject': 'subj-1' }, { headers: { 'mcp-session-id': 'sess-1' } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(seatCount()).toBe(0)
  })

  it('an empty or over-long key is ignored (no seat, no refusal noise)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await boot(env, g, { 'openai/session': '' })
    const b = await boot(env, g, chatgpt('x'.repeat(AUTO_SEAT_KEY_MAX_LEN + 1)))
    expect(a.sc.bound_agent_id).toBeNull()
    expect(b.sc.bound_agent_id).toBeNull()
    expect(seatCount()).toBe(0)
  })

  it('a seat-bound blob cannot be forged through the internal header (seatBinding with an auto source is stripped)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const forged = { ...g.ctx, seatBinding: { seatId: 's', label: 'l', harnessId: g.harnessId, grantTokenId: g.tokenId, humanMemberId: HUMAN, source: 'auto:openai_session' }, boundAgentId: 'x' }
    const r = await rpc(env, forged as AuthContext, 'boot_context')
    expect(receiptOf(r)).not.toMatchObject({ seat: { source: 'auto:openai_session' } })
    expect(seatCount()).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('explicit handle wins; a rejected handle never falls back to an auto-seat', () => {
  async function selectHandle(env: Env, g: Grant, folder: string): Promise<{ handle: string; agentId: string }> {
    const r = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder })
    if (typeof r.sc.seat_handle !== 'string') throw new Error(JSON.stringify(r.body))
    return { handle: r.sc.seat_handle, agentId: (r.sc.agent as { id: string }).id }
  }

  it('a valid handle + a session key -> the HANDLE\'s seat, source handle, no auto seat created', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const s = await selectHandle(env, g, '/work/a')
    const r = await boot(env, g, chatgpt('conv-h'), { headers: { 'x-mupot-seat': s.handle } })
    expect(r.sc.bound_agent_id).toBe(s.agentId)
    expect(receiptOf(r)).toMatchObject({ seat: { source: 'handle' } })
    expect(seatCount()).toBe(1)
    const viaMeta = await boot(env, g, { ...chatgpt('conv-h'), 'mupot/seat': s.handle })
    expect(viaMeta.sc.bound_agent_id).toBe(s.agentId)
    expect(seatCount()).toBe(1)
  })

  it('a well-formed but unknown handle + a session key -> unbound, flagged rejected, NO seat created', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const bogus = `mseat_${'A'.repeat(43)}`
    for (const o of [{ headers: { 'x-mupot-seat': bogus } }, {}] as RpcOpts[]) {
      const r = await boot(env, g, o.headers ? chatgpt('conv-r') : { ...chatgpt('conv-r'), 'mupot/seat': bogus }, o)
      expect(r.sc.bound_agent_id).toBeNull()
      expect(receiptOf(r)).toMatchObject({ seat_handle_rejected: true, auto_seat_refused: null })
    }
    const malformed = await boot(env, g, { ...chatgpt('conv-r'), 'mupot/seat': 'mseat_short' })
    expect(malformed.sc.bound_agent_id).toBeNull()
    expect(seatCount()).toBe(0)
  })

  it('a cosmetic X-Mupot-Seat LABEL (no mseat_ prefix) is not a handle: the auto-seat still applies', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const r = await boot(env, g, chatgpt('conv-l'), { headers: { 'x-mupot-seat': 'cursor-mac' } })
    expect(typeof r.sc.bound_agent_id).toBe('string')
    expect(receiptOf(r)).toMatchObject({ seat: { source: 'auto:openai_session' } })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('where the auto-seat must NOT apply', () => {
  it('flag off: unchanged (unbound, nothing created, same object back)', async () => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const g = await grant(env, HUMAN)
    const r = await boot(env, g, chatgpt('conv-off'))
    expect(r.sc.bound_agent_id).toBeNull()
    expect(seatCount()).toBe(0)
    const ctx = { ...g.ctx }
    expect(await applySeatForRequest(env, ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'k', codexThreadId: null } })).toBe(ctx)
  })

  it('a NON-harness session (OAuth grant without a harness pointer) carrying openai/session: unchanged', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const { harnessId: _drop, ...noHarness } = g.ctx
    const r = await rpc(env, noHarness as AuthContext, 'boot_context', {}, { meta: chatgpt('conv-nh') })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(seatCount()).toBe(0)
  })

  it('a legacy agent-bound grant (Rava-style) carrying openai/session stays that agent: no seat', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const bound = { ...g.ctx, boundAgentId: 'some-agent' } as AuthContext
    const out = await applySeatForRequest(env, bound, { hints: NO_HINTS, autoKeys: { openaiSession: 'k', codexThreadId: null } })
    expect(out).toBe(bound)
    expect(seatCount()).toBe(0)
  })

  it('a workspace-channel context carrying openai/session: unchanged', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const ws = { ...g.ctx, channel: 'workspace' } as AuthContext
    expect(await applySeatForRequest(env, ws, { hints: NO_HINTS, autoKeys: { openaiSession: 'k', codexThreadId: null } })).toBe(ws)
    expect(seatCount()).toBe(0)
  })

  it('the curated needs-you profile door never auto-seats', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const r = await boot(env, g, chatgpt('conv-pd'), { path: '/mcp/profile/needs-you' })
    expect(r.status).toBe(200)
    expect(r.sc.bound_agent_id).toBeNull()
    expect(seatCount()).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('caps and throttle (refusal never fails the request)', () => {
  it('auto seats are a SEPARATE budget: they never consume the member live / lifetime / harness-lifetime caps that seat_select uses', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '2', SEAT_MAX_TOTAL_PER_MEMBER: '2', SEAT_MAX_TOTAL_PER_HARNESS: '2' })
    const gc = await grant(env, HUMAN, 'client-chatgpt', 'ChatGPT')
    for (let i = 0; i < 8; i++) expect(typeof (await boot(env, gc, chatgpt(`t${i}`))).sc.bound_agent_id).toBe('string')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE source = 'auto'`)).toBe(8)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE source = 'auto' AND retired_at IS NULL`)).toBe(8) // below the pool cap nothing is reclaimed
    // explicit seats, same harness AND another harness of the same member, still get their full caps
    const gx = await grant(env, HUMAN, 'client-claude-code', 'Claude Code')
    for (const [g, f] of [[gx, '/a'], [gx, '/b']] as const) {
      const r = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: f })
      expect(typeof r.sc.seat_handle).toBe('string')
    }
    expect(JSON.stringify((await rpc(env, gx.ctx, 'seat_select', { project: 'mupot', folder: '/c' })).body)).toContain('seat_cap_reached')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE source = 'select'`)).toBe(2)
  })

  it('refused conversations never spend the member\'s seat_select throttle: 20 refused calls, then seat_select from another harness succeeds', async () => {
    const env = envFor(h)
    const gc = await grant(env, HUMAN, 'client-chatgpt', 'ChatGPT')
    // exhaust the harness window, then hammer with new conversations
    for (let i = 0; i < AUTO_SEAT_HARNESS_WINDOW_MAX; i++) await boot(env, gc, chatgpt(`ok-${i}`))
    for (let i = 0; i < 20; i++) {
      const r = await boot(env, gc, chatgpt('refused-conv'))
      expect(receiptOf(r)).toMatchObject({ auto_seat_refused: 'rate_limited' })
    }
    expect(await env.SESSIONS.get(`seat-select-rl:${HUMAN}`)).toBeNull() // not even a successful auto create spends it
    const gx = await grant(env, HUMAN, 'client-claude-code', 'Claude Code')
    const r = await rpc(env, gx.ctx, 'seat_select', { project: 'mupot', folder: '/x' })
    expect(typeof r.sc.seat_handle).toBe('string')
  })

  it('a refused conversation is cached: repeat calls run no creation queries and no window spend', async () => {
    const env = envFor(h)
    const gc = await grant(env, HUMAN)
    for (let i = 0; i < AUTO_SEAT_HARNESS_WINDOW_MAX; i++) await boot(env, gc, chatgpt(`ok-${i}`))
    await boot(env, gc, chatgpt('refused-conv')) // first refusal: does the work, fills the cache
    const sqls: string[] = []
    const spy = { ...env, DB: { ...h.db, prepare: (sql: string) => { sqls.push(sql); return h.db.prepare(sql) }, batch: h.db.batch.bind(h.db) } } as unknown as Env
    const out = await applySeatForRequest(spy, gc.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'refused-conv', codexThreadId: null } })
    expect(out.seatInputs?.autoSeatRefused).toBe('rate_limited')
    expect(sqls.filter((q) => q.includes('auto_seat_windows') || q.includes('agent_seats') || q.includes('harnesses'))).toEqual([])
  })

  it('the creation window is ONE atomic D1 counter and fails CLOSED when its statement errors', async () => {
    const env = envFor(h)
    const gc = await grant(env, HUMAN)
    await boot(env, gc, chatgpt('a'))
    expect(n(`SELECT count AS n FROM auto_seat_windows WHERE harness_id = ?`, gc.harnessId)).toBe(1)
    const broken = { ...env, DB: { ...h.db, prepare: (sql: string) => { if (sql.includes('auto_seat_windows')) throw new Error('window down'); return h.db.prepare(sql) }, batch: h.db.batch.bind(h.db) } } as unknown as Env
    const out = await applySeatForRequest(broken, gc.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'brand-new', codexThreadId: null } })
    expect(out.seatBinding).toBeUndefined()
    expect(out.seatInputs?.autoSeatRefused).toBe('rate_limited')
    expect(seatCount()).toBe(1)
  })

  it('a creation that loses a race refunds its window spend (10 concurrent first calls do not eat 10 of 12)', async () => {
    const env = envFor(h)
    const gc = await grant(env, HUMAN)
    await Promise.all(Array.from({ length: 10 }, () => boot(env, gc, chatgpt('same'))))
    expect(seatCount()).toBe(1)
    expect(n(`SELECT count AS n FROM auto_seat_windows WHERE harness_id = ?`, gc.harnessId)).toBe(1)
  })

  it('RECLAIM: a full auto pool retires the least-recently-used live auto seat of THAT harness instead of refusing', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const other = await grant(env, HUMAN, 'client-codex', 'Codex')
    const lim = { autoLive: 3, windowMax: 100 }
    const make = (gr: Grant, k: string) => applySeatForRequest(env, gr.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: k, codexThreadId: null } }, Date.now(), lim)
    const s1 = await make(g, 'k1'); const s2 = await make(g, 'k2'); const s3 = await make(g, 'k3')
    const o1 = await make(other, 'k1')
    h.sqlite.exec(`UPDATE agent_seats SET last_used_at = '2026-01-0${'2'}T00:00:00.000Z' WHERE agent_id = '${String(s1.boundAgentId)}'`)
    h.sqlite.exec(`UPDATE agent_seats SET last_used_at = '2026-01-01T00:00:00.000Z' WHERE agent_id = '${String(s2.boundAgentId)}'`) // LRU
    h.sqlite.exec(`UPDATE agent_seats SET last_used_at = '2026-01-03T00:00:00.000Z' WHERE agent_id = '${String(s3.boundAgentId)}'`)
    const s4 = await make(g, 'k4')
    expect(typeof s4.boundAgentId).toBe('string')
    const seatOf = (agentId: string) => h.sqlite.prepare(`SELECT retired_at, seat_token_id FROM agent_seats WHERE agent_id = ?`).get(agentId)!
    expect(seatOf(String(s2.boundAgentId)).retired_at).not.toBeNull()
    expect(seatOf(String(s1.boundAgentId)).retired_at).toBeNull()
    expect(seatOf(String(s3.boundAgentId)).retired_at).toBeNull()
    expect(seatOf(String(o1.boundAgentId)).retired_at).toBeNull() // another harness untouched
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE id = ? AND status = 'inactive'`, s2.boundAgentId)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens WHERE id = ? AND revoked_at IS NOT NULL`, seatOf(String(s2.boundAgentId)).seat_token_id)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ? AND action = 'seat_auto_retire' AND actor_type = 'system'`, s2.boundAgentId)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ? AND source = 'auto' AND retired_at IS NULL`, g.harnessId)).toBe(3)
  })

  it('RECLAIM never retires an explicit seat_select seat on the SAME harness, even when it is the oldest / least-recently-used row', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const sel = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: '/explicit' })
    expect(typeof sel.sc.seat_handle).toBe('string')
    const explicitAgent = String(h.sqlite.prepare(`SELECT agent_id AS v FROM agent_seats WHERE harness_id = ? AND source = 'select'`).get(g.harnessId)!.v)
    // Make the explicit seat the oldest, least-recently-used row on the harness — the row an unfiltered LRU would pick first.
    h.sqlite.exec(`UPDATE agent_seats SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE agent_id = '${explicitAgent}'`)
    const lim = { autoLive: 2, windowMax: 100 }
    const make = (k: string) => applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: k, codexThreadId: null } }, Date.now(), lim)
    await make('x1'); await make('x2')
    const x3 = await make('x3') // pool full -> reclaim must pick an AUTO seat
    expect(typeof x3.boundAgentId).toBe('string')
    expect(h.sqlite.prepare(`SELECT retired_at AS v FROM agent_seats WHERE agent_id = ?`).get(explicitAgent)!.v).toBeNull()
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE id = ? AND status = 'active'`, explicitAgent)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ? AND source = 'auto' AND retired_at IS NOT NULL`, g.harnessId)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ? AND action = 'seat_auto_retire'`, explicitAgent)).toBe(0)
  })

  it('a reclaimed conversation is never resurrected: when it returns it gets a FRESH seat (new agent), and keeps it', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const lim = { autoLive: 2, windowMax: 100 }
    const make = (k: string) => applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: k, codexThreadId: null } }, Date.now(), lim)
    const a = await make('A'); await make('B')
    h.sqlite.exec(`UPDATE agent_seats SET last_used_at = '2026-01-01T00:00:00.000Z' WHERE agent_id = '${String(a.boundAgentId)}'`)
    await make('C') // reclaims A
    const a2 = await make('A') // A returns: fresh generation
    expect(typeof a2.boundAgentId).toBe('string')
    expect(a2.boundAgentId).not.toBe(a.boundAgentId)
    expect((await make('A')).boundAgentId).toBe(a2.boundAgentId) // stable afterwards
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ? AND source = 'auto' AND retired_at IS NULL`, g.harnessId)).toBeLessThanOrEqual(2)
  })

  it('10 concurrent creates at a FULL pool: pool stays at its cap, every call bound, no orphans', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const lim = { autoLive: 3, windowMax: 100 }
    const make = (k: string) => applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: k, codexThreadId: null } }, Date.now(), lim)
    for (const k of ['a', 'b', 'c']) await make(k)
    const outs = await Promise.all(Array.from({ length: 10 }, (_, i) => make(`n${i}`)))
    expect(outs.every((o) => typeof o.boundAgentId === 'string')).toBe(true)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ? AND source = 'auto' AND retired_at IS NULL`, g.harnessId)).toBe(3)
    expect(n(`SELECT COUNT(*) AS n FROM agents a WHERE a.slug LIKE 'seat-%' AND NOT EXISTS (SELECT 1 FROM agent_seats s WHERE s.agent_id = a.id)`)).toBe(0)
  })

  it('the raw trigger is the hard backstop for the auto pool and leaves explicit seats alone', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await boot(env, g, chatgpt('seed'))
    const agentSquad = (await env.DB.prepare(`SELECT squad_id FROM agents WHERE id = ?`).bind(String(a.sc.bound_agent_id)).first<{ squad_id: string }>())!.squad_id
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('raw-1', '${agentSquad}', 'raw-1', 'Raw', 'active')`)
    expect(() => h.sqlite.exec(
      `INSERT INTO agent_seats (id, tenant, member_id, harness_id, key_hash, agent_id, label_basename, max_live, source, max_auto_live)
       VALUES ('raw-seat', '${TENANT}', '${HUMAN}', '${g.harnessId}', '${'e'.repeat(64)}', 'raw-1', 'x', 100, 'auto', 1)`,
    )).toThrow(/seat_auto_cap_exceeded/)
  })

  it('short-window per-harness creation cap: a loop of random keys stalls at the window max, and resolving existing keys spends nothing', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const refused: string[] = []
    for (let i = 0; i < AUTO_SEAT_HARNESS_WINDOW_MAX + 3; i++) {
      const r = await boot(env, g, chatgpt(`loop-${i}`))
      if (r.sc.bound_agent_id === null) refused.push(String((receiptOf(r) as { auto_seat_refused: unknown }).auto_seat_refused))
    }
    expect(seatCount()).toBe(AUTO_SEAT_HARNESS_WINDOW_MAX)
    expect(refused).toEqual(['rate_limited', 'rate_limited', 'rate_limited'])
    // existing keys still resolve (fast path, no creation budget)
    expect(typeof (await boot(env, g, chatgpt('loop-0'))).sc.bound_agent_id).toBe('string')
    // another harness of the same member is not throttled by this harness's window
    const g2 = await grant(env, HUMAN, 'client-codex', 'Codex')
    expect(typeof (await boot(env, g2, chatgpt('fresh'))).sc.bound_agent_id).toBe('string')
  })

  it('a deactivated seat is never resurrected by its key: refused with seat_agent_inactive', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await boot(env, g, chatgpt('conv-dead'))
    h.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = '${String(a.sc.bound_agent_id)}'`)
    const r = await boot(env, g, chatgpt('conv-dead'))
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r)).toMatchObject({ auto_seat_refused: 'seat_agent_inactive' })
    expect(seatCount()).toBe(1)
  })

  it('a suspended human creates no seat (creation path re-checks the member)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${HUMAN}'`)
    const out = await applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-susp', codexThreadId: null } })
    expect(out.seatBinding).toBeUndefined()
    expect(out.seatInputs?.autoSeatRefused).toBe('member_not_active')
    expect(seatCount()).toBe(0)
  })

  it('a retired auto seat is never resurrected: its key gets a fresh seat under a new generation', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await boot(env, g, chatgpt('conv-ret'))
    h.sqlite.exec(`UPDATE agent_seats SET retired_at = '2026-10-10T00:00:00.000Z' WHERE agent_id = '${String(a.sc.bound_agent_id)}'`)
    const r = await boot(env, g, chatgpt('conv-ret'))
    expect(typeof r.sc.bound_agent_id).toBe('string')
    expect(r.sc.bound_agent_id).not.toBe(a.sc.bound_agent_id)
    expect(seatCount()).toBe(2)
    expect((await boot(env, g, chatgpt('conv-ret'))).sc.bound_agent_id).toBe(r.sc.bound_agent_id)
  })

  it('an internal error never fails the request: the human context comes back with auto_seat_refused=error', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const broken = { ...env, DB: { ...h.db, prepare: (sql: string) => { if (sql.includes('FROM agent_seats s')) throw new Error('boom'); return h.db.prepare(sql) }, batch: h.db.batch.bind(h.db) } } as unknown as Env
    const out = await applySeatForRequest(broken, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-err', codexThreadId: null } })
    expect(out.seatBinding).toBeUndefined()
    expect(out.seatInputs?.autoSeatRefused).toBe('error')
  })

  it('a revoked human grant token resolves no seat (the key alone is not a credential)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, chatgpt('conv-rv'))
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-10-10T00:00:00.000Z' WHERE id = '${g.tokenId}'`)
    const out = await applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-rv', codexThreadId: null } })
    expect(out.boundAgentId ?? null).toBeNull()
    expect(out.seatBinding).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('release policy and concurrency', () => {
  it('an auto-seat session cannot release an execution hold (seatBinding / harnessId)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const bound = await applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: 'conv-rel', codexThreadId: null } })
    expect(bound.seatBinding?.source).toBe('auto:openai_session')
    expect(await canReleaseExecutionHold(env, bound, 'any-squad')).toBe(false)
    // even stripped of boundAgentId and handed workspace admin, the seat markers alone refuse it
    const stripped = { ...bound, boundAgentId: null, capabilities: [{ member_id: bound.memberId as string, scope_type: 'org', scope_id: null, capability: 'owner' }] } as AuthContext
    expect(await canReleaseExecutionHold(env, stripped, 'any-squad')).toBe(false)
    const onlySeat = { ...stripped, harnessId: undefined } as AuthContext
    expect(await canReleaseExecutionHold(env, onlySeat, 'any-squad')).toBe(false)
  })

  it('10 concurrent FIRST calls with the same key -> exactly one seat, one agent, every call bound to it', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const rs = await Promise.all(Array.from({ length: 10 }, () => boot(env, g, chatgpt('conv-race'))))
    const ids = new Set(rs.map((r) => r.sc.bound_agent_id))
    expect(ids.size).toBe(1)
    expect([...ids][0]).not.toBeNull()
    expect(seatCount()).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE slug LIKE 'seat-%'`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_member_bindings`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'seat_auto' AND actor_type = 'system'`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'seat_select'`)).toBe(0)
  })

  it('concurrent first calls on DIFFERENT keys all succeed and stay distinct (no orphans)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => boot(env, g, chatgpt(`race-${i}`))))
    expect(new Set(rs.map((r) => r.sc.bound_agent_id)).size).toBe(6)
    expect(n(`SELECT COUNT(*) AS n FROM agents a WHERE a.slug LIKE 'seat-%' AND NOT EXISTS (SELECT 1 FROM agent_seats s WHERE s.agent_id = a.id)`)).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('round 2: seat_select exemption, audit clarity, member pin', () => {
  it('seat_select is exempt from auto-binding: a client that ALWAYS sends a conversation key (Codex threadId) can still get a handle', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN, 'client-codex', 'Codex')
    const auto = await boot(env, g, { threadId: 'thr-always' })
    expect(typeof auto.sc.bound_agent_id).toBe('string') // the conversation is auto-seated for ordinary tools
    const r = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: '/w' }, { meta: { threadId: 'thr-always' } })
    expect(r.status).toBe(200)
    expect(typeof r.sc.seat_handle).toBe('string')
    expect(r.sc.disposition).toBe('created')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE source = 'select'`)).toBe(1)
    // and the handle then wins over the key on later calls
    const viaHandle = await boot(env, g, { threadId: 'thr-always' }, { headers: { 'x-mupot-seat': String(r.sc.seat_handle) } })
    expect(viaHandle.sc.bound_agent_id).toBe((r.sc.agent as { id: string }).id)
    expect(receiptOf(viaHandle)).toMatchObject({ binding_source: 'seat_handle', seat: { source: 'handle' } })
  })

  it('an already-bound session calling seat_select gets an accurate message (not "agent-bound token")', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const sel = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: '/w' })
    const again = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: '/w2' }, { headers: { 'x-mupot-seat': String(sel.sc.seat_handle) } })
    const text = JSON.stringify(again.body)
    expect(text).toContain('not_unbound_directory_session')
    expect(text).toContain('seat handle you sent')
    expect(text).toContain('send no seat handle')
  })

  it('audit: an auto seat is created as action seat_auto by a system actor naming the human; seat_select rows keep seat_select/user', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await boot(env, g, chatgpt('conv-audit'))
    const row = h.sqlite.prepare(`SELECT action, actor_type, actor_id FROM agent_audit WHERE agent_id = ?`).get(String(a.sc.bound_agent_id))!
    expect(row).toMatchObject({ action: 'seat_auto', actor_type: 'system', actor_id: `system:seat_auto:${HUMAN}` })
    const sel = await rpc(env, g.ctx, 'seat_select', { project: 'p', folder: '/f' })
    const row2 = h.sqlite.prepare(`SELECT action, actor_type, actor_id FROM agent_audit WHERE agent_id = ?`).get((sel.sc.agent as { id: string }).id)!
    expect(row2).toMatchObject({ action: 'seat_select', actor_type: 'user', actor_id: HUMAN })
  })

  it('member pin (defence in depth): the live-seat match is pinned to the human member, independent of the key hash and the harness pin', async () => {
    const env = envFor(h)
    const g1 = await grant(env, HUMAN); const g2 = await grant(env, HUMAN2)
    await boot(env, g1, chatgpt('conv-pin'))
    const key = await autoSeatKey({ source: 'auto:openai_session', raw: 'conv-pin' })
    const hash = await seatKeyHash(HUMAN, g1.harnessId, key)
    expect(await findLiveAutoSeat(env, hash, g1.tokenId, HUMAN, g1.harnessId)).not.toBeNull()
    // HUMAN2's own live grant token + member, but HUMAN's harness and HUMAN's real key hash: must not match
    expect(await findLiveAutoSeat(env, hash, g2.tokenId, HUMAN2, g1.harnessId)).toBeNull()
  })

  it('explicit seats on the SAME harness keep the per-harness lifetime cap, whatever auto seats exist there', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_HARNESS: '2' })
    const gc = await grant(env, HUMAN, 'client-chatgpt', 'ChatGPT')
    for (let i = 0; i < 6; i++) await boot(env, gc, chatgpt(`t${i}`))
    for (const f of ['/a', '/b']) expect(typeof (await rpc(env, gc.ctx, 'seat_select', { project: 'mupot', folder: f })).sc.seat_handle).toBe('string')
    expect(JSON.stringify((await rpc(env, gc.ctx, 'seat_select', { project: 'mupot', folder: '/c' })).body)).toContain('harness_total_cap')
  })

  it('LRU bookkeeping: the first bound call stamps last_used_at, and a second call inside the touch interval does not rewrite it', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await boot(env, g, chatgpt('conv-lru'))
    const stamp = () => String(h.sqlite.prepare(`SELECT last_used_at AS v FROM agent_seats WHERE agent_id = ?`).get(String(a.sc.bound_agent_id))!.v)
    const first = stamp()
    expect(first).not.toBe('null')
    await new Promise((r) => setTimeout(r, 15))
    await boot(env, g, chatgpt('conv-lru'))
    expect(stamp()).toBe(first)
  })

  it('an auto key never reaches an explicit seat_select seat, even one crafted to hash to the same key', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const key = await autoSeatKey({ source: 'auto:openai_session', raw: 'conv-craft' })
    const sel = await rpc(env, g.ctx, 'seat_select', { project: key.project, thread: key.thread })
    expect(typeof sel.sc.seat_handle).toBe('string')
    const r = await boot(env, g, chatgpt('conv-craft'))
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r)).toMatchObject({ auto_seat_refused: 'seat_key_source_conflict' })
  })

  it('an auto seat is reachable from ANY live unbound grant of the same member + harness (e.g. after a re-consent), never from another member\'s', async () => {
    const env = envFor(h)
    const g1 = await grant(env, HUMAN)
    const a = await boot(env, g1, chatgpt('conv-reconsent'))
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-re', '${HUMAN}', 'hash-re', 'oauth:client-chatgpt', 'directory', '2026-10-10T00:00:00.000Z', '${TENANT}')`)
    const reconsent = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: 'tok-re', email: null, channel: 'directory', boundAgentId: null, harnessId: g1.harnessId })
    const r = await rpc(env, reconsent as AuthContext, 'boot_context', {}, { meta: chatgpt('conv-reconsent') })
    expect(r.sc.bound_agent_id).toBe(a.sc.bound_agent_id)
    expect(seatCount()).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('harness TOKEN credential (Codex / CI): threadId auto-seats through the bearer door', () => {
  async function mintToken(env: Env, memberId: string, kind: string): Promise<{ raw: string; tokenId: string; harnessId: string }> {
    const res = await membersApp.request(`/members/${memberId}/tokens`, {
      method: 'POST',
      headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'codex-env', harness_kind: kind }),
    }, env)
    const j = (await res.json()) as { token: { raw: string; id: string }; harness: { id: string } }
    if (res.status !== 201) throw new Error(`mint ${res.status}`)
    return { raw: j.token.raw, tokenId: j.token.id, harnessId: j.harness.id }
  }
  async function bearer(env: Env, raw: string, meta: Record<string, unknown>): Promise<Rpc> {
    const res = await mcpApp.fetch(new Request('https://pot.test/', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boot_context', arguments: {}, _meta: meta } }),
    }), env)
    const body = (await res.json()) as Record<string, unknown>
    return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
  }

  it('a harness token + Codex threadId -> its own seat per thread; another member\'s token with the same threadId -> a different agent', async () => {
    const env = envFor(h)
    const t1 = await mintToken(env, HUMAN, 'codex')
    const t2 = await mintToken(env, HUMAN2, 'codex')
    const a = await bearer(env, t1.raw, { threadId: 'thr-A' })
    const b = await bearer(env, t1.raw, { threadId: 'thr-B' })
    const a2 = await bearer(env, t1.raw, { threadId: 'thr-A' })
    const other = await bearer(env, t2.raw, { threadId: 'thr-A' })
    expect(typeof a.sc.bound_agent_id).toBe('string')
    expect(a.sc.bound_agent_id).not.toBe(b.sc.bound_agent_id)
    expect(a2.sc.bound_agent_id).toBe(a.sc.bound_agent_id)
    expect(other.sc.bound_agent_id).not.toBe(a.sc.bound_agent_id)
    expect(receiptOf(a)).toMatchObject({ seat: { source: 'auto:codex_thread' } })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ?`, t1.harnessId)).toBe(2)
  })

  it('a revoked harness token never auto-seats', async () => {
    const env = envFor(h)
    const t = await mintToken(env, HUMAN, 'codex')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-10-10T00:00:00.000Z' WHERE id = '${t.tokenId}'`)
    const r = await bearer(env, t.raw, { threadId: 'thr-A' })
    expect(r.sc.bound_agent_id ?? null).toBeNull()
    expect(seatCount()).toBe(0)
  })

  it('a TOKEN harness is only ever the credential that IS it: another live unbound token naming it neither resolves nor creates a seat', async () => {
    const env = envFor(h)
    const t = await mintToken(env, HUMAN, 'codex')
    await bearer(env, t.raw, { threadId: 'thr-A' }) // seat exists
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-other', '${HUMAN}', 'hash-other', 'oauth:x', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const wrong = { userId: HUMAN, memberId: HUMAN, email: null, role: 'member', tenant: TENANT, channel: 'directory', capabilities: [], boundAgentId: null, tokenId: 'tok-other', harnessId: t.harnessId } as unknown as AuthContext
    const hit = await applySeatForRequest(env, wrong, { hints: NO_HINTS, autoKeys: { openaiSession: null, codexThreadId: 'thr-A' } })
    expect(hit.seatBinding).toBeUndefined()
    const before = seatCount()
    const miss = await applySeatForRequest(env, wrong, { hints: NO_HINTS, autoKeys: { openaiSession: null, codexThreadId: 'thr-NEW' } })
    expect(miss.seatBinding).toBeUndefined()
    expect(miss.seatInputs?.autoSeatRefused).toBe('harness_required')
    expect(seatCount()).toBe(before)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('#1818: a seat row is only handed back by the pool whose source matches it', () => {
  const craft = (raw: string) => autoSeatKey({ source: 'auto:openai_session', raw })
  const counts = () => ({
    seats: seatCount(),
    agents: n(`SELECT COUNT(*) AS n FROM agents`),
    handles: n(`SELECT COUNT(*) AS n FROM seat_handles`),
    audit: n(`SELECT COUNT(*) AS n FROM agent_audit`),
    windows: n(`SELECT COALESCE(SUM(count), 0) AS n FROM auto_seat_windows`),
  })

  it('select -> auto: seat_select with args that normalise to an auto seat\'s key is refused: no handle, no new row, no writes', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const auto = await boot(env, g, chatgpt('conv-a'))
    expect(typeof auto.sc.bound_agent_id).toBe('string')
    const key = await craft('conv-a')
    const before = counts()
    const r = await rpc(env, g.ctx, 'seat_select', { project: key.project, thread: key.thread })
    expect(JSON.stringify(r.body)).toContain('seat_key_source_conflict')
    expect(r.sc.seat_handle).toBeUndefined()
    expect(counts()).toEqual(before)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE source = 'select'`)).toBe(0)
  })

  it('auto -> select: an auto key crafted onto an explicit seat is refused with the typed error: no binding, no new seat, no window spend', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const key = await craft('conv-b')
    const sel = await rpc(env, g.ctx, 'seat_select', { project: key.project, thread: key.thread })
    expect(typeof sel.sc.seat_handle).toBe('string')
    const before = counts()
    const r = await boot(env, g, chatgpt('conv-b'))
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r)).toMatchObject({ auto_seat_refused: 'seat_key_source_conflict' })
    expect(counts()).toEqual(before)
  })

  it('reclaim never retires a seat that was handed out through seat_select: the refused select holds no handle on the auto seat it collided with', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const lim = { autoLive: 2, windowMax: 100 }
    const make = (k: string) => applySeatForRequest(env, g.ctx, { hints: NO_HINTS, autoKeys: { openaiSession: k, codexThreadId: null } }, Date.now(), lim)
    const a1 = await make('r1')
    const autoSeatId = String(h.sqlite.prepare(`SELECT id AS v FROM agent_seats WHERE agent_id = ?`).get(a1.boundAgentId)!.v)
    h.sqlite.exec(`UPDATE agent_seats SET last_used_at = '2000-01-01T00:00:00.000Z' WHERE id = '${autoSeatId}'`)
    const key = await craft('r1')
    const sel = await rpc(env, g.ctx, 'seat_select', { project: key.project, thread: key.thread })
    expect(sel.sc.seat_handle).toBeUndefined()
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE seat_id = ?`, autoSeatId)).toBe(0)
    // The auto pool then reclaims its own LRU row (r1): nobody holds it as explicit.
    await make('r2'); await make('r3')
    expect(h.sqlite.prepare(`SELECT retired_at AS v FROM agent_seats WHERE id = ?`).get(autoSeatId)!.v).not.toBeNull()
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE seat_id = ? AND revoked_at IS NULL`, autoSeatId)).toBe(0)
  })

  it('race path: a concurrent winner of the other pool (UNIQUE loser re-read) is refused too, never handed back', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await boot(env, g, chatgpt('conv-race'))
    const key = await craft('conv-race')
    // Hide the seat from the FIRST lookup only (as if the other pool's insert landed after it): the create
    // batch then loses on UNIQUE and re-reads the winner, which belongs to the auto pool.
    let hidden = false
    const realPrepare = h.db.prepare.bind(h.db)
    const db = new Proxy(h.db, {
      get(target, prop, recv) {
        if (prop !== 'prepare') return Reflect.get(target, prop, recv)
        return (sql: string) => {
          const st = realPrepare(sql)
          if (!hidden && /FROM agent_seats\s+WHERE tenant = \?1 AND member_id = \?2 AND harness_id = \?3 AND key_hash = \?4/.test(sql)) {
            hidden = true
            return { bind: () => ({ first: async () => null }) }
          }
          return st
        }
      },
    })
    const before = counts()
    const r = await rpc({ ...env, DB: db } as Env, g.ctx, 'seat_select', { project: key.project, thread: key.thread })
    expect(hidden).toBe(true)
    expect(JSON.stringify(r.body)).toContain('seat_key_source_conflict')
    expect(r.sc.seat_handle).toBeUndefined()
    expect(counts()).toEqual(before)
  })

  it('same-source idempotent path is unchanged: seat_select twice on one key returns existing; auto twice returns the same agent', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const s1 = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: '/same' })
    const s2 = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: '/same' })
    expect(s1.sc.disposition).toBe('created')
    expect(s2.sc.disposition).toBe('existing')
    expect((s2.sc.agent as { id: string }).id).toBe((s1.sc.agent as { id: string }).id)
    const a1 = await boot(env, g, chatgpt('conv-same'))
    const a2 = await boot(env, g, chatgpt('conv-same'))
    expect(a1.sc.bound_agent_id).toBe(a2.sc.bound_agent_id)
    expect(typeof a1.sc.bound_agent_id).toBe('string')
  })
})
