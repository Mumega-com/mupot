// tests/named-intent-connect.test.ts — NAMED_INTENT_CONNECT: a connection that names an agent reaches it in one guided consent.
//
// REQUEST SHAPE. Every call is a real JSON-RPC `tools/call` through mcpApp (the production router, resolveAuth, the auto-seat
// middleware, invokeTool), carrying the `params._meta` keys the server's own readers accept (`openai/session` for ChatGPT,
// `threadId` for Codex; extractMetaFacts is the reader). FAKE-CLIENT ASSUMPTIONS (a live cold walk is the only proof of them):
// the session is built with buildAuthContextFromProps + mcpInternalRequest (no real OAuth transport, no Mcp-Session-Id), and
// the `_meta` key set is what the server reads, not a capture of what a given client build actually sends.
// Fixtures use PRODUCTION writers only (seat/auto-seat paths, the attach writer, the real /m/* passkey ceremony).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { SoftAuthenticator } from './helpers/webauthn-authenticator'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { advertisedTools, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { momentsApp } from '../src/secure-moments/routes'
import { mintEnrolmentToken } from '../src/secure-moments/store'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { MUPOT_MCP_ATTACH_INSTRUCTIONS, MUPOT_MCP_INITIALIZE_INSTRUCTIONS, MUPOT_MCP_NAMED_INTENT_INSTRUCTIONS, MUPOT_MCP_SEAT_INSTRUCTIONS, mcpInitializeInstructions } from '../src/mcp/instructions'
import { namedIntentEnabled } from '../src/members/named-intent'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const HUMAN2 = 'member-human-2'
const HOST = 'secure.example.test'
const ORIGIN = `https://${HOST}`
const COLONY = 'colony.example.test'
const MASTER = 'a1'.repeat(32)

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: `https://${COLONY}`, SESSIONS: memoryKv(), OAUTH_KV: { get: async () => null, put: async () => undefined },
    CONNECTOR_MASTER_KEY: MASTER, SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST,
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200', ...extra,
  } as unknown as Env
}

const OWNER = 'member-org-owner'
let h: SqliteD1Harness
let tokCounter = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined
/** TEST SCAFFOLDING for pre-#2054 multi-chat fixtures: a live admission is bound to the ONE chat that asked, so to model a
 *  second attached chat on the same admission the test re-points requested_seat_id at the next unattached seat. */
const bindAdm = (agentId: string, seatId?: string): void => {
  h.sqlite.exec(`DROP TRIGGER IF EXISTS agent_seat_admissions_requested_seat_immutable`) // fixture only
  h.sqlite.prepare(`UPDATE agent_seat_admissions SET requested_seat_id = COALESCE(?, (SELECT s.id FROM agent_seats s WHERE NOT EXISTS (SELECT 1 FROM agent_seat_attachments a WHERE a.seat_id = s.id AND a.detached_at IS NULL) ORDER BY s.created_at, s.rowid LIMIT 1)) WHERE agent_id = ? AND status IN ('pending', 'live')`).run(seatId ?? null, agentId)
}
/** The attach code a tool-made pending admission carries (the human types it on Admit). */
const codeOf = (id: string): string | null => one<{ attach_code: string | null }>(`SELECT attach_code FROM agent_seat_admissions WHERE id = ?`, id)?.attach_code ?? null

function seedHuman(id: string, email = `${id}@example.test`): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${email}', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

/** An existing, welded, named agent on a squad; `admin` lists the humans who administer that squad. */
function seedAgent(o: { id: string; slug: string; name: string; squad: string; admins: string[]; memberCap?: string }): void {
  const memberId = `mem-${o.id}`
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-${o.squad}', 'dept-${o.squad}', 'Dept ${o.squad}');
    INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${o.squad}', 'dept-${o.squad}', '${o.squad}', 'Squad ${o.squad}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${o.id}', '${o.squad}', '${o.slug}', '${o.name}', 'r', 'm', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', '${o.name}', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${o.id}', '${memberId}', '2026-10-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${o.id}', '${memberId}', 'squad', '${o.squad}', '${o.memberCap ?? 'member'}');
  `)
  for (const a of o.admins) h.sqlite.exec(`INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${a}-${o.squad}', '${a}', 'squad', '${o.squad}', 'admin')`)
}

interface Grant { memberId: string; tokenId: string; harnessId: string; ctx: AuthContext }

/** A human's unbound OAuth harness grant (a ChatGPT connector: "Me — auto per workspace"). */
async function grant(env: Env, memberId: string, clientId = 'client-chatgpt', name = 'ChatGPT'): Promise<Grant> {
  const tokenId = `tok-${memberId}-${++tokCounter}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:${clientId}', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const harness = await upsertHarness(env, memberId, clientId, name, tokenId) // anchored to its grant, as consent does (harness-scoped admissions prove it)
  if (!harness) throw new Error('harness fixture failed')
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return { memberId, tokenId, harnessId: harness.id, ctx }
}

interface RpcOpts { meta?: Record<string, unknown>; headers?: Record<string, string> }
interface Rpc { status: number; body: Record<string, unknown>; sc: Record<string, unknown> }

async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown> = {}, o: RpcOpts = {}): Promise<Rpc> {
  const params: Record<string, unknown> = { name, arguments: args }
  if (o.meta) params._meta = o.meta
  const req = new Request('https://pot.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(o.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
}

const thread = (session: string): Record<string, unknown> => ({ 'openai/session': session })
const boot = (env: Env, g: Grant, session: string): Promise<Rpc> => rpc(env, g.ctx, 'boot_context', {}, { meta: thread(session) })
const attach = (env: Env, g: Grant, session: string, agent: string): Promise<Rpc> => rpc(env, g.ctx, 'seat_attach', { agent, reason: 'This chat is assigned to operate the requested agent.' }, { meta: thread(session) })
const receiptOf = (r: Rpc): Record<string, unknown> => r.sc.identity_receipt as Record<string, unknown>
const errOf = (r: Rpc): string => String(((r.body.result ?? {}) as { structuredContent?: { error?: unknown } }).structuredContent?.error ?? (r.body.error as { message?: string } | undefined)?.message ?? '')

// ── the passkey ceremony through the REAL /m/* routes ───────────────────────────────────────────
async function hit(path: string, e: Env, r: { method?: string; json?: unknown } = {}): Promise<Response> {
  const headers = new Headers()
  const method = r.method ?? 'GET'
  let body: string | undefined
  if (method === 'POST') { headers.set('origin', ORIGIN); headers.set('content-type', 'application/json'); body = JSON.stringify(r.json ?? {}) }
  return momentsApp.fetch(new Request(`https://${HOST}${path}`, { method, headers, body }), e)
}
const csrfOf = (page: string): string => { const m = /data-csrf="([0-9a-f]{64})"/.exec(page); if (!m) throw new Error('no csrf'); return m[1] }
type J = { ok?: boolean; title?: string; message?: string; publicKey?: { challenge: string } }

async function enrolPasskey(e: Env, memberId: string, email: string): Promise<SoftAuthenticator> {
  const link = await linkLoginIdentity(e, { tenant: TENANT, provider: 'google', providerSubject: `g-${memberId}`, verifiedEmail: email, memberId })
  if (!link.ok) throw new Error('link failed')
  const a = await SoftAuthenticator.create()
  const { token } = await mintEnrolmentToken(e, memberId, link.identity.id)
  const page = await hit(`/m/enrol/${token}`, e)
  const csrf = csrfOf(await page.text())
  const opts = (await (await hit(`/m/enrol/${token}/options`, e, { method: 'POST', json: { csrf } })).json()) as J
  const credential = await a.register({ rpId: HOST, origin: ORIGIN, challenge: opts.publicKey?.challenge ?? '' })
  expect((await hit(`/m/enrol/${token}/finish`, e, { method: 'POST', json: { csrf, credential } })).status).toBe(200)
  return a
}

/** The attach code the human types on the /m/* page: default = the code of the pending admission; null = type nothing. */
const pendingCode = (c?: string | null): { attach_code?: string } => {
  const v = c === undefined ? one<{ attach_code: string | null }>(`SELECT attach_code FROM agent_seat_admissions ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 1`)?.attach_code : c
  return v ? { attach_code: v } : {}
}

async function decideMoment(e: Env, url: string, a: SoftAuthenticator, decision: 'approve' | 'deny', ceiling?: string, decideCeiling: string | undefined = ceiling, attachCode?: string | null): Promise<{ status: number; body: J }> {
  const path = new URL(url).pathname
  const csrf = csrfOf(await (await hit(path, e)).text())
  const ch = (await (await hit(`${path}/challenge`, e, { method: 'POST', json: { decision, csrf, ...(ceiling ? { ceiling } : {}), ...pendingCode(attachCode) } })).json()) as J
  const credential = await a.assert({ rpId: HOST, origin: ORIGIN, challenge: ch.publicKey?.challenge ?? '' })
  const res = await hit(`${path}/decide`, e, { method: 'POST', json: { decision, csrf, credential, ...(decideCeiling ? { ceiling: decideCeiling } : {}), ...pendingCode(attachCode) } })
  const raw = await res.text()
  let body: J = {} as J
  try { body = JSON.parse(raw) as J } catch { /* a 500 is plain text */ }
  return { status: res.status, body }
}


beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedHuman(HUMAN2)
  seedHuman(OWNER)
  h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-owner-org', '${OWNER}', 'org', NULL, 'admin')`)
  seedAgent({ id: 'agent-rava', slug: 'rava', name: 'Rava', squad: 'squad-core', admins: [HUMAN] })
  seedAgent({ id: 'agent-hadi-admin', slug: 'hadi-admin', name: 'Hadi Admin', squad: 'squad-core', admins: [HUMAN] })
  seedAgent({ id: 'agent-other', slug: 'other-ops', name: 'Other Ops', squad: 'squad-other', admins: [HUMAN2] })
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

const ON = { NAMED_INTENT_CONNECT: '1' }
const REASON = 'This chat was started to operate that agent.'
const codex = (thread: string): Record<string, unknown> => ({ threadId: thread })
const intent = (env: Env, g: Grant, agent: string, session = 'conv-a', extra: Record<string, unknown> = {}, args: Record<string, unknown> = {}): Promise<Rpc> =>
  rpc(env, g.ctx, 'connect_intent', { agent, reason: REASON, ...args }, { meta: thread(session), ...extra })
const rows = {
  seats: (): number => n(`SELECT COUNT(*) AS n FROM agent_seats`),
  autoSeats: (): number => n(`SELECT COUNT(*) AS n FROM agent_seats WHERE source = 'auto'`),
  agents: (): number => n(`SELECT COUNT(*) AS n FROM agents`),
  members: (): number => n(`SELECT COUNT(*) AS n FROM members`),
  admissions: (): number => n(`SELECT COUNT(*) AS n FROM agent_seat_admissions`),
  attachments: (): number => n(`SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL`),
}
const nextStep = (r: Rpc): string => String(((r.body.result ?? {}) as { structuredContent?: { detail?: { next_step?: string }; next_step?: string } }).structuredContent?.detail?.next_step
  ?? ((r.body.result ?? {}) as { structuredContent?: { next_step?: string } }).structuredContent?.next_step ?? JSON.stringify(r.body))

describe('(a) a new connection naming a permitted target reaches it in ONE guided consent', () => {
  it('first call (before any boot_context): resolves rava, makes ONE intent seat (no auto seat), files ONE pending admission; one passkey tap; the next call attaches; the handle then acts as rava', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const agentsBefore = rows.agents()
    const first = await intent(env, g, 'rava')
    expect(first.sc.status, JSON.stringify(first.body)).toBe('pending_admission')
    expect(first.sc.target).toMatchObject({ id: 'agent-rava', slug: 'rava' })
    expect(typeof first.sc.approve_url).toBe('string')
    // THIS chat's own conversation-keyed seat, made only after the target resolved; no handle needed (the chat's key is its identity)
    expect(first.sc.seat ?? null).toBeNull()
    expect(String(first.sc.instruction)).toMatch(/Nothing to pass/)
    expect(rows.autoSeats()).toBe(1)
    expect(rows.seats()).toBe(1)
    expect(rows.admissions()).toBe(1)
    expect(one<{ reason: string; status: string; scope: string; agent_id: string }>(`SELECT reason, status, scope, agent_id FROM agent_seat_admissions`)).toMatchObject({ reason: REASON, status: 'pending', scope: 'seat', agent_id: 'agent-rava' })
    // only the throwaway carrier agent was added (the seat's own), no named agent
    expect(rows.agents()).toBe(agentsBefore + 1)
    expect(rows.attachments()).toBe(0)
    // a pending ask grants nothing: the handle still acts as the seat agent, not rava
    expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).not.toBe('agent-rava')

    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    const tap = await decideMoment(env, String(first.sc.approve_url), key, 'approve')
    expect(tap.status, JSON.stringify(tap.body)).toBe(200)

    const second = await intent(env, g, 'rava')
    expect(second.sc.status, JSON.stringify(second.body)).toBe('attached')
    expect((second.sc.agent as { id: string }).id).toBe('agent-rava')
    expect(rows.attachments()).toBe(1)
    const after = await boot(env, g, 'conv-a') // NO handle: the next ordinary request of this chat acts as the agent
    expect(after.sc.bound_agent_id).toBe('agent-rava')
    expect((receiptOf(after).agent as { id: string }).id).toBe('agent-rava')
  })

  it('a thread that already has an auto seat (boot_context ran first) carries the intent on THAT seat: no second seat, no extra agent', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    expect(rows.autoSeats()).toBe(1)
    const agents = rows.agents()
    const r = await intent(env, g, 'rava', 'conv-a')
    expect(r.sc.status, JSON.stringify(r.body)).toBe('pending_admission')
    expect(rows.seats()).toBe(1)
    expect(rows.agents()).toBe(agents)
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    expect((await decideMoment(env, String(r.sc.approve_url), key, 'approve')).status).toBe(200)
    expect((await intent(env, g, 'rava', 'conv-a')).sc.status).toBe('attached')
    expect((await boot(env, g, 'conv-a')).sc.bound_agent_id).toBe('agent-rava')
  })

  it('works for a Codex-shaped request (_meta.threadId) exactly as for ChatGPT (_meta["openai/session"])', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN, 'client-codex', 'Codex')
    const r = await rpc(env, g.ctx, 'connect_intent', { agent: 'agent-rava', reason: REASON }, { meta: codex('thr-1') })
    expect(r.sc.status, JSON.stringify(r.body)).toBe('pending_admission')
    expect(rows.autoSeats()).toBe(1)
  })
})

describe('(b) a repeat or restart reuses it: same UUIDs, no duplicate', () => {
  it('repeat before the tap: same admission id, ONE seat, ONE admission, no second link; three spellings of the name reach the SAME seat', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const a = await intent(env, g, 'rava')
    const b = await intent(env, g, 'Rava')
    const c = await intent(env, g, 'agent-rava')
    expect([a, b, c].every((x) => x.sc.status === 'pending_admission' || x.sc.status === 'already_pending')).toBe(true)
    expect(rows.seats()).toBe(1)
    expect(rows.admissions()).toBe(1)
    expect(b.sc.admission_id).toBe(a.sc.admission_id)
    expect(c.sc.admission_id).toBe(a.sc.admission_id)
    expect(b.sc.approve_url ?? null).toBeNull() // never mints or rotates a second link
    expect(n(`SELECT COUNT(*) AS n FROM secure_moments WHERE status = 'pending'`)).toBe(1)
  })

  it('after attach: repeat, restart (a fresh request with no handle) and a changed reason all return the SAME attachment id, with no new rows', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const first = await intent(env, g, 'rava')
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    await decideMoment(env, String(first.sc.approve_url), key, 'approve')
    const done = await intent(env, g, 'rava')
    expect(done.sc.status).toBe('attached')
    const agents = rows.agents(); const seats = rows.seats(); const adms = rows.admissions()
    const again = await intent(env, g, 'rava')
    const other = await intent(env, g, 'rava', 'conv-a', {}, { reason: 'a different reason on a later run' })
    for (const x of [again, other]) { expect(x.sc.status, JSON.stringify(x.body)).toBe('attached'); expect(x.sc.attachment_id).toBe(done.sc.attachment_id) }
    expect([rows.agents(), rows.seats(), rows.admissions(), rows.attachments()]).toEqual([agents, seats, adms, 1])
  })

  it('an attached thread naming a DIFFERENT agent is refused (a move is the human\'s act)', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const first = await intent(env, g, 'rava')
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    await decideMoment(env, String(first.sc.approve_url), key, 'approve')
    await intent(env, g, 'rava')
    const seats = rows.seats(); const agents = rows.agents()
    // an attached chat naming ANOTHER agent (even one it may not attach, or one that does not exist) is the same already_attached: no oracle, no second seat
    for (const ref of ['hadi-admin', 'other-ops', 'ghost']) expect(errOf(await intent(env, g, ref)), ref).toBe('already_attached')
    expect([rows.attachments(), rows.seats(), rows.agents(), rows.admissions()]).toEqual([1, seats, agents, 1])
    expect((await intent(env, g, 'rava')).sc.status).toBe('attached')
  })
})

describe('(c) a name alone grants nothing', () => {
  it('another squad\'s agent, by name, slug and id: agent_not_found, ZERO rows written (no seat, agent, member, admission)', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const before = [rows.seats(), rows.agents(), rows.members(), rows.admissions(), rows.attachments()]
    for (const ref of ['Other Ops', 'other-ops', 'agent-other']) {
      const r = await intent(env, g, ref)
      expect(errOf(r), ref).toBe('agent_not_found')
    }
    expect([rows.seats(), rows.agents(), rows.members(), rows.admissions(), rows.attachments()]).toEqual(before)
  })

  it('a throwaway seat agent cannot be targeted by its name or id either', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    await boot(env, g, 'conv-a')
    const seatAgent = one<{ id: string; slug: string; name: string }>(`SELECT a.id, a.slug, a.name FROM agents a JOIN agent_seats s ON s.agent_id = a.id`)!
    for (const ref of [seatAgent.id, seatAgent.slug, seatAgent.name]) expect(errOf(await intent(env, g, ref, 'conv-b')), ref).toBe('agent_not_found')
    expect(rows.admissions()).toBe(0)
  })

  it('SEAT_ATTACH_DESIGNATED on: an agent nobody designated for the human is agent_not_found (a name is not designation); an org admin gets the guided refusal, still zero writes', async () => {
    const env = envFor(h, { ...ON, SEAT_ATTACH_DESIGNATED: '1' })
    const g = await grant(env, HUMAN)
    const before = [rows.seats(), rows.agents(), rows.admissions()]
    expect(errOf(await intent(env, g, 'rava'))).toBe('agent_not_found')
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h-org', '${HUMAN}', 'org', NULL, 'admin')`)
    const r = await intent(env, g, 'rava')
    expect(errOf(r)).toBe('agent_not_designated_for_you')
    expect(nextStep(r)).toMatch(/Allow for me/)
    expect([rows.seats(), rows.agents(), rows.admissions()]).toEqual(before)
    // designation by the real owner door, then the same call files the ask
    const { invokeTool } = await import('../src/mcp/index')
    const org = { userId: 'op', email: 'op@example.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: OWNER, capabilities: [{ member_id: OWNER, scope_type: 'org', scope_id: null, capability: 'admin' }], boundAgentId: null } as unknown as Parameters<typeof invokeTool>[0]
    expect((await invokeTool(org, env, 'update_agent', { agent: 'agent-rava', attach_designated_member_id: HUMAN }, 'https://pot.test')).ok).toBe(true)
    expect((await intent(env, g, 'rava')).sc.status).toBe('pending_admission')
  })

  it('a human with admin on the squad but NO passkey tap stays unattached: the pending ask never attaches by itself', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const first = await intent(env, g, 'rava')
    for (let i = 0; i < 3; i++) expect((await intent(env, g, 'rava')).sc.status).not.toBe('attached')
    expect(rows.attachments()).toBe(0)
    expect((await rpc(env, g.ctx, 'boot_context', { seat: String(first.sc.seat) })).sc.bound_agent_id).not.toBe('agent-rava')
  })
})

describe('(d) missing authority or bad input: a clear refusal and next step, never a silent mint', () => {
  it('an agent that does not exist: 404 with who/what/next, and NO agent, member, seat or admission is created', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const before = [rows.seats(), rows.agents(), rows.members(), rows.admissions()]
    const r = await intent(env, g, 'ghost-agent')
    expect(errOf(r)).toBe('agent_not_found')
    expect(nextStep(r)).toMatch(/never creates an agent/)
    expect(nextStep(r)).toMatch(/org admin/)
    expect([rows.seats(), rows.agents(), rows.members(), rows.admissions()]).toEqual(before)
  })

  it('reason is required and bounded; agent is required: invalid_args with a next step, nothing written', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    for (const bad of [{ agent: 'rava' }, { agent: 'rava', reason: '   ' }, { agent: 'rava', reason: 'x'.repeat(281) }, { agent: '', reason: REASON }, { agent: 'rava', reason: REASON, scope: 'org' }]) {
      const r = await rpc(env, g.ctx, 'connect_intent', bad, { meta: thread('conv-a') })
      expect(errOf(r), JSON.stringify(bad)).toBe('invalid_args')
    }
    expect([rows.seats(), rows.admissions()]).toEqual([0, 0])
  })

  it('a connector with no verified harness: harness_required with the re-consent step, and the ask is NOT filed', async () => {
    const env = envFor(h, ON)
    const ctx = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: 'tok-noharness', email: null, channel: 'directory', boundAgentId: null })
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-noharness', '${HUMAN}', 'hash-nh', 'oauth:x', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const ctx2 = ctx ?? (await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: 'tok-noharness', email: null, channel: 'directory', boundAgentId: null }))
    if (!ctx2) throw new Error('ctx')
    const r = await rpc(env, ctx2, 'connect_intent', { agent: 'rava', reason: REASON }, { meta: thread('conv-a') })
    expect(errOf(r)).toBe('harness_required')
    expect(nextStep(r)).toMatch(/re-consents/)
    expect([rows.seats(), rows.admissions()]).toEqual([0, 0])
  })
})

describe('(e) flag off is unchanged', () => {
  it('not advertised, not in the instructions, and a direct call refuses before any read or write', async () => {
    const env = envFor(h)
    expect(namedIntentEnabled(env)).toBe(false)
    expect(advertisedTools(env).map((t) => t.name)).not.toContain('connect_intent')
    expect(advertisedTools(envFor(h, ON)).map((t) => t.name)).toContain('connect_intent')
    expect(mcpInitializeInstructions(env)).toBe(MUPOT_MCP_INITIALIZE_INSTRUCTIONS + MUPOT_MCP_SEAT_INSTRUCTIONS + MUPOT_MCP_ATTACH_INSTRUCTIONS)
    expect(mcpInitializeInstructions(envFor(h, ON))).toBe(MUPOT_MCP_INITIALIZE_INSTRUCTIONS + MUPOT_MCP_SEAT_INSTRUCTIONS + MUPOT_MCP_ATTACH_INSTRUCTIONS + MUPOT_MCP_NAMED_INTENT_INSTRUCTIONS)
    const g = await grant(env, HUMAN)
    const r = await intent(env, g, 'rava')
    expect(errOf(r)).toBe('named_intent_disabled')
    // flag off => a refused connect_intent makes no seat at all (not even an auto seat), even with bad args
    expect(rows.autoSeats()).toBe(0)
    expect(errOf(await rpc(env, g.ctx, 'connect_intent', {}, { meta: thread('conv-x') }))).toBe('invalid_args') // schema refusal; still no seat
    expect(rows.autoSeats()).toBe(0)
    expect(rows.admissions()).toBe(0)
  })

  it('each prerequisite is required: NAMED_INTENT_CONNECT without SEAT_ATTACH or SEAT_AUTO_ENROLL is inert; only strict "1" counts', () => {
    expect(namedIntentEnabled(envFor(h, { ...ON, SEAT_ATTACH: undefined }))).toBe(false)
    expect(namedIntentEnabled(envFor(h, { ...ON, SEAT_AUTO_ENROLL: undefined }))).toBe(false)
    expect(namedIntentEnabled(envFor(h, { NAMED_INTENT_CONNECT: 'true' }))).toBe(false)
    expect(mcpInitializeInstructions({ SEAT_AUTO_ENROLL: '1', NAMED_INTENT_CONNECT: '1' })).toBe(MUPOT_MCP_INITIALIZE_INSTRUCTIONS + MUPOT_MCP_SEAT_INSTRUCTIONS)
  })

  it('flag ON changes nothing for the old doors: boot_context with a thread key still auto-seats and seat_attach still works', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const own = await boot(env, g, 'conv-a')
    expect(own.sc.bound_agent_id).not.toBe('agent-rava')
    expect(rows.autoSeats()).toBe(1)
    expect((await attach(env, g, 'conv-a', 'rava')).sc.status).toBe('pending_admission')
    expect(rows.seats()).toBe(1)
  })
})

describe('schema and instructions publish the same contract (reason is required wherever a named agent is attached)', () => {
  it('tools/list: connect_intent and seat_attach both declare reason; connect_intent requires agent and reason', async () => {
    const env = envFor(h, ON)
    const tools = advertisedTools(env)
    const ci = tools.find((t) => t.name === 'connect_intent')!
    expect(ci.inputSchema.required).toEqual(['agent', 'reason'])
    expect(Object.keys(ci.inputSchema.properties)).toEqual(expect.arrayContaining(['agent', 'reason', 'scope']))
    expect(Object.keys(tools.find((t) => t.name === 'seat_attach')!.inputSchema.properties)).toContain('reason')
    // the wire: a real tools/list through the router
    const res = await mcpApp.fetch(mcpInternalRequest(new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), (await grant(env, HUMAN)).ctx), env)
    const listed = ((await res.json()) as { result: { tools: Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }> } }).result.tools
    expect(listed.find((t) => t.name === 'connect_intent')?.inputSchema.required).toEqual(expect.arrayContaining(['agent', 'reason']))
    expect(Object.keys(listed.find((t) => t.name === 'seat_attach')!.inputSchema.properties)).toContain('reason')
  })

  it('every instruction line that shows a named-agent call shows reason (the mismatch: seat_attach { agent } with no reason is gone)', () => {
    const all = MUPOT_MCP_ATTACH_INSTRUCTIONS + MUPOT_MCP_NAMED_INTENT_INSTRUCTIONS
    const calls = [...all.matchAll(/'(seat_attach|connect_intent)' \{([^}]*)\}/g)]
    expect(calls.length).toBeGreaterThanOrEqual(2)
    for (const m of calls) if (m[2].includes('agent:')) expect(m[2], m[0]).toContain('reason')
  })
})

describe('round 2: "this chat only" is true (three chats: A asks, B and C must never gain the agent)', () => {
  it('B asking the same agent gets no handle/code/link of A\'s; after A\'s tap only A acts as rava', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const a = await intent(env, g, 'rava', 'chat-a')
    expect(a.sc.status, JSON.stringify(a.body)).toBe('pending_admission')
    const b = await intent(env, g, 'rava', 'chat-b')
    expect(b.sc.attach_code ?? null).toBeNull()
    expect(b.sc.approve_url ?? null).toBeNull()
    expect(b.sc.seat ?? null).not.toBe(a.sc.seat ?? 'none')
    await boot(env, g, 'chat-c')
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    expect((await decideMoment(env, String(a.sc.approve_url), key, 'approve')).status).toBe(200)
    expect((await boot(env, g, 'chat-a')).sc.bound_agent_id).toBe('agent-rava') // A: acts as rava with NO handle
    expect((await boot(env, g, 'chat-b')).sc.bound_agent_id).not.toBe('agent-rava')
    expect((await boot(env, g, 'chat-c')).sc.bound_agent_id).not.toBe('agent-rava')
    expect(errOf(await intent(env, g, 'rava', 'chat-b'))).toBe('approval_bound_to_other_chat')
    expect(rows.attachments()).toBe(1)
  })
})

const keyless = (env: Env, g: Grant, agent: string, args: Record<string, unknown> = {}): Promise<Rpc> =>
  rpc(env, g.ctx, 'connect_intent', { agent, reason: REASON, ...args })

describe('final cut: no per-conversation key => refuse, create nothing (Athena\'s four regression probes)', () => {
  const noRows = (): number[] => [rows.seats(), rows.agents(), rows.members(), rows.admissions(), rows.attachments(), n(`SELECT COUNT(*) AS n FROM secure_moments`)]

  it('probe 1 (control): two ChatGPT-shaped chats (distinct openai/session): B never receives A\'s code, and only A boots as the agent', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const a = await intent(env, g, 'rava', 'gpt-a')
    const b = await intent(env, g, 'rava', 'gpt-b')
    expect(b.sc.attach_code ?? null).toBeNull()
    expect(b.sc.approve_url ?? null).toBeNull()
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    expect((await decideMoment(env, String(a.sc.approve_url), key, 'approve')).status).toBe(200)
    expect((await boot(env, g, 'gpt-a')).sc.bound_agent_id).toBe('agent-rava')
    expect((await boot(env, g, 'gpt-b')).sc.bound_agent_id).not.toBe('agent-rava')
  })

  it('probe 2 (control): two Codex-shaped chats (distinct threadId): same isolation', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN, 'client-codex', 'Codex')
    const call = (tid: string): Promise<Rpc> => rpc(env, g.ctx, 'connect_intent', { agent: 'rava', reason: REASON }, { meta: codex(tid) })
    const a = await call('thr-a')
    const b = await call('thr-b')
    expect(a.sc.status, JSON.stringify(a.body)).toBe('pending_admission')
    expect(b.sc.attach_code ?? null).toBeNull()
    expect(b.sc.approve_url ?? null).toBeNull()
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    expect((await decideMoment(env, String(a.sc.approve_url), key, 'approve')).status).toBe(200)
    expect((await rpc(env, g.ctx, 'boot_context', {}, { meta: codex('thr-a') })).sc.bound_agent_id).toBe('agent-rava')
    expect((await rpc(env, g.ctx, 'boot_context', {}, { meta: codex('thr-b') })).sc.bound_agent_id).not.toBe('agent-rava')
  })

  it('probe 3: keyless caller A, then a second keyless caller repeating A\'s (now ignored) thread label: both refused, no code, no handle, no link, nothing created', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const before = noRows()
    for (const extra of [{ thread: 'chat-a' }, {}]) {
      const r = await keyless(env, g, 'rava', extra)
      expect(['conversation_key_required', 'invalid_args']).toContain(errOf(r)) // `thread` is no longer an argument: the schema refuses it, or the key check does
    }
    const r = await keyless(env, g, 'rava')
    expect(errOf(r)).toBe('conversation_key_required')
    expect(nextStep(r)).toMatch(/sends no per-conversation key/)
    const text = JSON.stringify(r.body)
    expect(text).not.toMatch(/attach_code|approve_url|mseat_/)
    expect(noRows()).toEqual(before)
  })

  it('probe 4: concurrent keyless requests with new labels cannot create seats: all refused, zero rows', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    const before = noRows()
    const out = await Promise.all(['t1', 't2', 't3', 't4'].map((t) => keyless(env, g, 'rava', { thread: t })))
    for (const r of out) expect(['conversation_key_required', 'invalid_args']).toContain(errOf(r))
    expect(noRows()).toEqual(before)
  })

  it('keyless refusal precedes resolution: a miss and a hit read the same, and the verdict never depends on the agent', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    expect(errOf(await keyless(env, g, 'ghost'))).toBe('conversation_key_required')
    expect(errOf(await keyless(env, g, 'rava'))).toBe('conversation_key_required')
    expect(errOf(await keyless(env, g, 'other-ops'))).toBe('conversation_key_required')
  })

  it('scope "harness" is recorded on the ask and, bound to the live grant, lets a LATER chat attach with no new tap; scope "seat" never does', async () => {
    const env = envFor(h, { ...ON, WORKSPACES: '1' }) // grant-anchored harness, as consent creates
    const g = await grant(env, HUMAN)
    const a = await intent(env, g, 'rava', 'chat-a', {}, { scope: 'harness' })
    expect(one<{ scope: string }>(`SELECT scope FROM agent_seat_admissions`)?.scope).toBe('harness')
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    expect((await decideMoment(env, String(a.sc.approve_url), key, 'approve')).status).toBe(200)
    expect((await intent(env, g, 'rava', 'chat-a')).sc.status).toBe('attached') // the grant token is proven in the attach INSERT
    const later = await intent(env, g, 'rava', 'chat-later')
    expect(later.sc.status, JSON.stringify(later.body)).toBe('attached')
    expect((await boot(env, g, 'chat-later')).sc.bound_agent_id).toBe('agent-rava')
    expect((await boot(env, g, 'chat-never-asked')).sc.bound_agent_id).not.toBe('agent-rava') // harness approval needs the chat to ask
  })

  it('scope "seat" (the default) is recorded as seat', async () => {
    const env = envFor(h, ON)
    const g = await grant(env, HUMAN)
    await intent(env, g, 'rava', 'chat-a', {}, { scope: 'seat' })
    expect(one<{ scope: string }>(`SELECT scope FROM agent_seat_admissions`)?.scope).toBe('seat')
  })

})
describe('round 2: the grant rides an EXISTING seat too', () => {
  it('a chat that booted first (own auto seat) files a harness-scoped ask and attaches after the tap', async () => {
    const env = envFor(h, { ...ON, WORKSPACES: '1' })
    const g = await grant(env, HUMAN)
    await boot(env, g, 'chat-a')
    const a = await intent(env, g, 'rava', 'chat-a', {}, { scope: 'harness' })
    const key = await enrolPasskey(env, HUMAN, `${HUMAN}@example.test`)
    expect((await decideMoment(env, String(a.sc.approve_url), key, 'approve')).status).toBe(200)
    const done = await intent(env, g, 'rava', 'chat-a', {}, { scope: 'harness' })
    expect(done.sc.status, JSON.stringify(done.body)).toBe('attached')
    // a LATER chat that already has its own seat (booted first) attaches with no new tap: the existing-seat carrier proves the grant
    await boot(env, g, 'chat-later')
    const later = await intent(env, g, 'rava', 'chat-later')
    expect(later.sc.status, JSON.stringify(later.body)).toBe('attached')
  })
})
