// tests/onboarding-funnel-teaching.test.ts — docs/architecture/agent-onboarding-funnel.md, Phase 2 fixes.
//
// Every refusal or empty answer a brand-new agent meets must name its next call. This file pins the teaching text that
// was added for that, on the real request path (OAuth props -> mcpApp -> tool), with real SQL from the committed
// migration chain. None of it changes who may do what: the status codes and error codes are asserted unchanged.
//
// MUTATIONS proven (see PR body): drop the seatBinding/attached guard on the seat_attach door; drop the
// `alreadyTeaches` guard in refusalNextStep; revert the SEAT_ATTACH instruction gate; revert emptyWorkLine.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp, mcpActionsApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { attachSeatToAgent } from '../src/members/seat-attach'
import { GUIDANCE_TABLE, refusalGuidance, refusalNextStep, renderStep, type ConnKind, type GuideCtx, type WhoActs } from '../src/mcp/refusal-next-step'
import { hashMemberToken } from '../src/auth/member-bearer'
import { checkBootstrapSelfRateLimit } from '../src/members/bootstrap-self'
import {
  MUPOT_MCP_ATTACH_INSTRUCTIONS, MUPOT_MCP_INITIALIZE_INSTRUCTIONS, MUPOT_MCP_SEAT_INSTRUCTIONS, mcpInitializeInstructions,
} from '../src/mcp/instructions'
import { renderBrief, type OrientData } from '../src/orient/service'
import { sha256Hex } from '../src/members/service'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://colony.example.test', SESSIONS: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    OAUTH_KV: { get: async () => null, put: async () => undefined }, SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1',
    SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200', ...extra,
  } as unknown as Env // harness D1 adapter + KV stubs satisfy the bindings these paths read
}

let h: SqliteD1Harness
let tokCounter = 0

function seedHuman(id: string): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

function seedAgent(o: { id: string; slug: string; name: string; squad: string; admins: string[] }): void {
  const memberId = `mem-${o.id}`
  h.sqlite.exec(`
    INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-${o.squad}', 'dept-${o.squad}', 'Dept ${o.squad}');
    INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${o.squad}', 'dept-${o.squad}', '${o.squad}', 'Squad ${o.squad}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${o.id}', '${o.squad}', '${o.slug}', '${o.name}', 'r', 'm', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${memberId}', '${o.name}', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${o.id}', '${memberId}', '2026-10-01T00:00:00.000Z');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${o.id}', '${memberId}', 'squad', '${o.squad}', 'member');
  `)
  for (const a of o.admins) h.sqlite.exec(`INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-${a}-${o.squad}', '${a}', 'squad', '${o.squad}', 'admin')`)
}

interface Grant { memberId: string; tokenId: string; harnessId: string; ctx: AuthContext }

/** A human's unbound OAuth harness grant: the "Many chats" consent choice of a ChatGPT connector. */
async function grant(env: Env, memberId: string): Promise<Grant> {
  const harness = await upsertHarness(env, memberId, 'client-chatgpt', 'ChatGPT')
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tokCounter}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:client-chatgpt', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return { memberId, tokenId, harnessId: harness.id, ctx }
}

interface Rpc { status: number; sc: Record<string, unknown> }

async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown> = {}, session: string | null = 'conv-a', headers: Record<string, string> = {}): Promise<Rpc> {
  const params: Record<string, unknown> = { name, arguments: args }
  if (session) params._meta = { 'openai/session': session }
  const req = new Request('https://pot.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as { result?: { structuredContent?: Record<string, unknown> } }
  return { status: res.status, sc: body.result?.structuredContent ?? {} }
}

const doorTools = (r: Rpc): Array<string | null> => (r.sc.available_doors as Array<{ tool: string | null }>).map((d) => d.tool)

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedAgent({ id: 'agent-rava', slug: 'rava', name: 'Rava', squad: 'squad-core', admins: [HUMAN] })
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => h.close())

describe('refusalNextStep (pure)', () => {
  it('teaches a bare capability-floor refusal and names the grant path (DE12), not a bounce to boot_context', () => {
    const t = refusalNextStep('forbidden', 403, { need: 'admin' })
    expect(t).toContain('grant_agent_capability')
    expect(t).toContain('grant_gate_capability')
    expect(t).toMatch(/ask the owner/)
    expect(t).not.toContain('Call boot_context and follow')
  })

  it('never overwrites a refusal that already teaches (hint, reason or its own next_step)', () => {
    expect(refusalNextStep('forbidden', 403, { need: 'admin', hint: 'x' })).toBeUndefined()
    expect(refusalNextStep('forbidden', 403, { reason: 'no_squad_access', need: 'member' })).toBeUndefined()
    expect(refusalNextStep('forbidden', 403, { need: 'admin', next_step: 'y' })).toBeUndefined()
  })

  it('stays silent where there is no universal next step, and for non-403 statuses of a 403 code', () => {
    expect(refusalNextStep('agent_not_found', 404, undefined)).toBeUndefined()
    expect(refusalNextStep('forbidden', 404, { need: 'admin' })).toBeUndefined()
    expect(refusalNextStep('forbidden', 403, 'a bare string detail')).toBeUndefined()
  })

  it('covers the not-bound, seat and flag-off refusals and the rate limit', () => {
    expect(refusalNextStep('not_agent_bound', 403, 'x')).not.toContain('seat_attach')
    expect(refusalNextStep('not_agent_bound', 403, 'x')).toContain('an admin to mint')
    expect(refusalNextStep('not_agent_bound', 403, 'x')).toContain('mint_agent_token')
    expect(refusalNextStep('seat_required', 403, undefined)).toContain('workspace bearer')
    // Agrees with connect DOOR A: seat_select only when a harness is present, otherwise re-consent with "Many chats".
    expect(refusalNextStep('seat_required', 403, undefined, undefined, { choiceLabels: true })).toContain('A chat you drive')
    expect(refusalNextStep('seat_required', 403, undefined)).not.toContain('Do not call seat_select')
    expect(refusalNextStep('seat_attach_disabled', 403, undefined)).toMatch(/not enabled/)
    expect(refusalNextStep('rate_limited', 429, undefined)).toMatch(/wait/)
  })

  it('is static: it interpolates nothing from the detail (a refusal teaches a stranger nothing about what exists)', () => {
    const a = refusalNextStep('forbidden', 403, { need: 'admin', scope: 'squad-secret-1' })
    const b = refusalNextStep('forbidden', 403, { need: 'owner', scope: 'squad-secret-2' })
    expect(a).toBe(b)
    expect(a).not.toContain('secret')
  })
})

describe('the MCP refusal envelope carries next_step; the decision is unchanged', () => {
  async function memberToken(): Promise<string> {
    // A member with NO grant at all, so the refusal comes from the central capability floor (not a handler's own check).
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('plain-member', NULL, 'Plain member', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const hash = await sha256Hex('member-tok')
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('tok-m', 'plain-member', '${hash}', 't', 'workspace', '2026-10-09T00:00:00.000Z', NULL, '${TENANT}')`)
    return 'member-tok'
  }
  const call = (app: typeof mcpApp, url: string, payload: unknown, bearer: string) =>
    app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(payload) }, envFor(h))

  it('a member calling an admin tool: same 403 forbidden need, plus who_acts admin and a next_step naming the grant path', async () => {
    const tok = await memberToken()
    const res = await call(mcpApp, 'https://pot.example/', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pot_list', arguments: {} } }, tok)
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } }
    expect(body.result.isError).toBe(true)
    expect(body.result.structuredContent).toMatchObject({ ok: false, tool: 'pot_list', error: 'forbidden', status: 403, need: 'admin' })
    expect(body.result.structuredContent.who_acts).toBe('admin')
    expect(String(body.result.structuredContent.next_step)).toContain('grant_agent_capability')
  })

  it('REST /actions keeps its plain body: no next_step added there', async () => {
    const tok = await memberToken()
    const res = await call(mcpActionsApp as unknown as typeof mcpApp, 'https://pot.example/actions/pot_list', {}, tok)
    expect(res.status).toBe(403)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).not.toHaveProperty('next_step')
  })
})

describe('initialize instructions name the attach door only while it exists', () => {
  it('base text: flag off is the canonical constant, and it now tells the agent how to find work', () => {
    expect(mcpInitializeInstructions({})).toBe(MUPOT_MCP_INITIALIZE_INSTRUCTIONS)
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('FINDING WORK')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('inbox')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('task_list')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('task_board')
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).not.toContain('seat_attach')
    // item 1 no longer sends an agent-less session to a tool that refuses it
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/'orient' with no argument answers only once you act as an agent/)
  })

  it('SEAT_AUTO_ENROLL alone: seat section, no attach section', () => {
    const t = mcpInitializeInstructions({ SEAT_AUTO_ENROLL: '1' })
    expect(t).toBe(MUPOT_MCP_INITIALIZE_INSTRUCTIONS + MUPOT_MCP_SEAT_INSTRUCTIONS)
    expect(t).not.toContain('seat_attach')
  })

  it('SEAT_ATTACH without SEAT_AUTO_ENROLL is inert (seat_attach is not advertised either)', () => {
    expect(mcpInitializeInstructions({ SEAT_ATTACH: '1' })).toBe(MUPOT_MCP_INITIALIZE_INSTRUCTIONS)
  })

  it('both flags: the attach section names seat_attach, the passkey tap and why bootstrap_self is wrong from a seat', () => {
    const t = mcpInitializeInstructions({ SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1' })
    expect(t).toBe(MUPOT_MCP_INITIALIZE_INSTRUCTIONS + MUPOT_MCP_SEAT_INSTRUCTIONS + MUPOT_MCP_ATTACH_INSTRUCTIONS)
    expect(t).toContain('seat_attach')
    expect(t).toContain('approve_url')
    expect(t).toMatch(/passkey/)
    expect(t).toMatch(/Do NOT call bootstrap_self from a seat session/)
    expect(t).toMatch(/never registered a passkey/)
    // covers the pot with no approval links too: the link is conditional, the Connections page is the fallback
    expect(t).toMatch(/If it includes an approve_url/)
    expect(t).toMatch(/Connections page/)
  })
})

describe('orient names where work comes from when the agent has none', () => {
  const data: OrientData = {
    agent: { id: 'a1', slug: 'a', name: 'A', role: 'r', status: 'active', okr: null, kpi_target: null, kpi_progress: 0, effort: 'medium', autonomy: 'draft', budget_cap_cents: null, budget_window: 'month' },
    department: null, squad: { id: 's1', name: 'S', charter: null, okr: null }, supervisor: null, squadmates: [], tasks: [],
    capability: 'member', mcpEndpoint: 'https://pot.test/mcp', field: { present: false, stale: false, coherence: null, regime: null, trust_tier: null, trust_score: null, spin: null, age_human: null },
    induction: false,
  }

  it('an empty task list points at task_board and task_list, and still names the supervisor', () => {
    const brief = renderBrief(data)
    expect(brief).toContain('task_board')
    expect(brief).toContain('task_list')
    expect(brief).toMatch(/ask your supervisor/i)
  })

  it('a non-empty list does not print the empty-state line', () => {
    expect(renderBrief({ ...data, tasks: [{ id: 't1', title: 'Do the thing', status: 'open' }] })).not.toContain('none assigned yet')
  })
})

describe('a chat with a seat is shown the attach door, and told what to do when bootstrap_self / seat_select refuse it', () => {
  it('boot_context: a seat session gets seat_attach in available_doors, right after orient', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const b = await rpc(env, g.ctx, 'boot_context')
    expect(doorTools(b)[0]).toBe('orient')
    expect(doorTools(b)[1]).toBe('seat_attach')
    const door = (b.sc.available_doors as Array<{ tool: string; does: string; requires: string }>)[1]
    expect(door.does).toMatch(/passkey/)
    expect(door.requires).toMatch(/nothing is attached until they tap/)
  })

  it('boot_context: no seat_attach door with the flag off', async () => {
    const env = envFor(h, { SEAT_ATTACH: undefined })
    const g = await grant(env, HUMAN)
    const b = await rpc(env, g.ctx, 'boot_context')
    expect(doorTools(b)).not.toContain('seat_attach')
  })

  it('boot_context: no seat_attach door once the thread is attached', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await rpc(env, g.ctx, 'boot_context')
    const seat = h.sqlite.prepare('SELECT id FROM agent_seats').get() as { id: string }
    expect((await attachSeatToAgent(env, { humanMemberId: HUMAN, seatId: seat.id, agentRef: 'rava', via: 'dashboard' })).ok).toBe(true)
    const b = await rpc(env, g.ctx, 'boot_context')
    expect(b.sc.bound_agent_id).toBe('agent-rava')
    expect(doorTools(b)).not.toContain('seat_attach')
  })

  it('bootstrap_self from a seat session: same 403/not_unbound_directory_session, now naming seat_attach', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await rpc(env, g.ctx, 'boot_context')
    const before = h.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number } // rava + this conversation's seat agent
    const r = await rpc(env, g.ctx, 'bootstrap_self', { agent_name: 'second-agent' })
    expect(r.sc).toMatchObject({ ok: false, error: 'not_unbound_directory_session', status: 403 })
    expect(String(r.sc.detail)).toContain('seat_attach')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual(before) // nothing was created
  })

  it('bootstrap_self from an ATTACHED chat does not tell it to seat_attach (that would 409 already_attached)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await rpc(env, g.ctx, 'boot_context')
    const seat = h.sqlite.prepare('SELECT id FROM agent_seats').get() as { id: string }
    expect((await attachSeatToAgent(env, { humanMemberId: HUMAN, seatId: seat.id, agentRef: 'rava', via: 'dashboard' })).ok).toBe(true)
    const r = await rpc(env, g.ctx, 'bootstrap_self', { agent_name: 'second-agent' })
    expect(r.sc).toMatchObject({ ok: false, error: 'not_unbound_directory_session', status: 403 })
    expect(String(r.sc.detail)).not.toContain('call seat_attach')
    expect(String(r.sc.detail)).toContain('already attached')
  })

  it('bootstrap_self from a seat session with the attach flag off does not advertise seat_attach', async () => {
    const env = envFor(h, { SEAT_ATTACH: undefined })
    const g = await grant(env, HUMAN)
    await rpc(env, g.ctx, 'boot_context')
    const r = await rpc(env, g.ctx, 'bootstrap_self', { agent_name: 'second-agent' })
    expect(r.sc).toMatchObject({ ok: false, error: 'not_unbound_directory_session', status: 403 })
    expect(String(r.sc.detail)).not.toContain('seat_attach')
    expect(String(r.sc.detail)).toContain('boot_context')
  })

  it('seat_select from a session that already has a seat: same refusal, now naming seat_attach', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    // seat_select is exempt from auto-seat binding, so call it seatless first to get a handle, then again WITH the handle.
    const first = await rpc(env, g.ctx, 'seat_select', { project: 'p' }, null)
    const handle = String(first.sc.seat_handle)
    expect(handle.startsWith('mseat_')).toBe(true)
    const r = await rpc(env, g.ctx, 'seat_select', { project: 'p' }, null, { 'x-mupot-seat': handle })
    expect(r.sc).toMatchObject({ ok: false, error: 'not_unbound_directory_session', status: 403 })
    expect(String(r.sc.detail)).toContain('seat_attach')
  })

  it('a workspace agent-bound bearer calling seat_select is not told to seat_attach (it would loop back via seat_required)', async () => {
    const env = envFor(h)
    const hash = await sha256Hex('agent-bearer')
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('tok-ag', 'mem-agent-rava', '${hash}', 't', 'workspace', '2026-10-09T00:00:00.000Z', 'agent-rava', '${TENANT}')`)
    const res = await mcpApp.request('https://pot.example/', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer agent-bearer' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'seat_select', arguments: { project: 'p' } } }) }, env)
    const sc = ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent
    expect(sc).toMatchObject({ ok: false, status: 403 })
    expect(JSON.stringify(sc)).not.toContain('seat_attach')
  })

  it('seat_select with the attach flag off does not advertise seat_attach', async () => {
    const env = envFor(h, { SEAT_ATTACH: undefined })
    const g = await grant(env, HUMAN)
    const handle = String((await rpc(env, g.ctx, 'seat_select', { project: 'p' }, null)).sc.seat_handle)
    const r = await rpc(env, g.ctx, 'seat_select', { project: 'p' }, null, { 'x-mupot-seat': handle })
    expect(r.sc).toMatchObject({ ok: false, error: 'not_unbound_directory_session', status: 403 })
    expect(String(r.sc.detail)).not.toContain('seat_attach')
  })
})

// ── lane B: ONE refusal envelope on the door (door map 2026-10-18 §3) ─────────────────────────────────────────
// { error, need?, who_acts, next_step, next_tool?, link? } for every code, and no advertised step the same session
// cannot take. MUTATIONS proven (see PR body): drop a table row (guard test fails); restore the old DE2/DE7/DE8/DE12 text.
describe('one refusal envelope: who_acts + next_step on every door code (lane B)', () => {
  const WHO: WhoActs[] = ['self', 'owner', 'admin', 'org_admin']

  it('GUARD: every table row carries a non-empty who_acts and next_step, and resolves to itself', () => {
    expect(GUIDANCE_TABLE.length).toBeGreaterThan(20)
    for (const row of GUIDANCE_TABLE) {
      expect(WHO, row.error).toContain(row.who_acts)
      expect(row.next_step.trim().length, row.error).toBeGreaterThan(20)
      // A row must be reachable: feed it the detail it needs and expect its own text back.
      const detail = row.reasonIs ? { reason: row.reasonIs, need: 'x' } : row.needsNeed ? { need: 'x' } : row.detailMatch ? 'poll requires an agent-bound credential agent required' : undefined
      const ctx: GuideCtx = { kind: row.kinds?.[0], choiceLabels: true, origin: 'https://pot.example' }
      const g = refusalGuidance(row.error, row.status ?? 403, detail, row.tool, ctx)
      expect(g.who_acts, `${row.tool ?? '*'}:${row.error}:${row.kinds?.join('|') ?? '*'}`).toBe(row.who_acts)
      expect(g.next_step, `${row.tool ?? '*'}:${row.error}`).toBe(renderStep(row.next_step, ctx))
      expect(g.next_step).not.toMatch(/\{(many|one|reach|full_mcp)\}/) // every token is rendered
    }
  })

  it('who_acts is present even where the detail already teaches (the skip rule keeps next_step only)', () => {
    expect(refusalGuidance('forbidden', 403, { need: 'admin', hint: 'x' })).toEqual({ who_acts: 'admin' })
    const dir = refusalGuidance('forbidden', 403, { reason: 'directory_channel_zero_capability', need: 'workspace-channel token' })
    expect(dir.who_acts).toBe('owner') // connect-after-bootstrap: the human binds; the reason no longer suppresses the step
    expect(dir.next_step).toMatch(/Existing agent.*A chat you drive/) // SEAT_ATTACH off (prod): the labels the consent page actually shows
    expect(dir.next_step).not.toMatch(/Many chats|One agent/)
    expect(refusalGuidance('forbidden', 403, { reason: 'directory_channel_zero_capability', need: 'x' }, undefined, { choiceLabels: true }).next_step).toMatch(/Background agent.*A chat you drive/)
    expect(dir.next_step).toContain('mint_agent_token')
    expect(refusalGuidance('forbidden', 403, { reason: 'no_squad_access', need: 'member' }).who_acts).toBe('org_admin')
    expect(refusalGuidance('some_unknown_code', 409, undefined).who_acts).toBe('self')
    expect(refusalGuidance('some_unknown_code', 403, undefined).who_acts).toBe('admin')
  })

  it('one case per code: who_acts + next_step on the door codes of map §3', () => {
    const FULL: GuideCtx = { choiceLabels: true, origin: 'https://pot.example' }
    // [error, status, detail, tool, kind, who_acts, step]
    const cases: Array<[string, number, unknown, string | undefined, ConnKind | undefined, WhoActs, RegExp]> = [
      ['harness_session_seat_required', 403, 'msg', undefined, undefined, 'self', /seat_select \{ project/],
      ['not_unbound_directory_session', 403, 'msg', 'seat_select', 'chat_bound', 'self', /already an agent/],
      ['not_unbound_directory_session', 403, 'msg', 'seat_select', 'bearer_unbound', 'admin', /mint_agent_token/],
      ['harness_required', 403, 'msg', 'seat_select', 'chat_plain', 'owner', /A chat you drive/],
      ['member_not_active', 403, undefined, 'seat_select', undefined, 'org_admin', /reactivates/],
      ['seat_cap_reached', 409, { cap: 3 }, 'seat_select', undefined, 'self', /same project/],
      ['seat_agent_inactive', 409, { reason: 'seat_retired' }, 'seat_select', undefined, 'self', /different thread label/],
      ['seat_key_source_conflict', 409, 'x', 'seat_select', undefined, 'self', /different project or thread/],
      ['provisioning_failed', 500, undefined, 'seat_select', undefined, 'self', /Retry seat_select once/],
      ['seat_required', 403, undefined, 'seat_attach', 'chat_harness', 'self', /seat_select \{ project/],
      ['seat_required', 403, undefined, 'seat_attach', 'chat_plain', 'owner', /re-consents.*A chat you drive/],
      ['seat_required', 403, undefined, 'seat_attach', 'chat_bound', 'self', /already that agent|already is that agent/],
      ['seat_required', 403, undefined, 'seat_attach', 'bearer_unbound', 'admin', /mint_agent_token/],
      ['rate_limited', 429, undefined, 'bootstrap_self', undefined, 'self', /bootstrap rate limit/],
      ['not_unbound_directory_session', 403, 'x', 'bootstrap_self', 'bearer_unbound', 'admin', /mint_agent_token/],
      ['not_unbound_directory_session', 403, 'x', 'bootstrap_self', 'chat_bound', 'self', /boot_context/],
      ['agent_bound_credential_required', 403, undefined, 'verify_agent_connection', 'chat_bound', 'owner', /daemon/],
      ['agent_bound_credential_required', 403, undefined, 'verify_agent_connection', 'bearer_unbound', 'admin', /mint_agent_token/],
      ['not_agent_bound', 403, undefined, 'inbox', 'chat_bound', 'owner', /re-consents/],
      ['not_agent_bound', 403, undefined, 'inbox', 'bearer_unbound', 'admin', /mint_agent_token/],
      ['agent_bound_workspace_credential_required', 403, undefined, 'runtime_seat_register_pending', 'bearer_bound', 'self', /token_binding_attest/],
      ['agent_bound_workspace_credential_required', 403, undefined, 'runtime_seat_register_pending', 'chat_bound', 'owner', /daemon/],
      ['consumer_fenced', 409, undefined, 'inbox', undefined, 'self', /inbox \{ peek: true \}/],
      ['not_member_bound', 403, 'check_in requires a member-token principal', 'check_in', undefined, 'org_admin', /org admin issues/],
      ['invalid_args', 400, 'presence_mode: poll requires an agent-bound credential', 'check_in', undefined, 'self', /without presence_mode/],
      ['attached_seat_cannot_set_presence_mode', 403, undefined, 'check_in', undefined, 'self', /without presence_mode/],
      ['tool_not_in_profile', 403, { profile: 'needs-you' }, 'send', undefined, 'owner', /https:\/\/pot\.example\/mcp/],
      ['invalid_args', 400, 'agent required: this session is not an agent yet.', 'orient', 'chat_harness', 'self', /seat_select/],
      ['invalid_args', 400, 'agent required: this session is not an agent yet.', 'orient', 'chat_plain', 'owner', /re-consents/],
      ['forbidden', 403, { need: 'admin' }, 'pot_list', undefined, 'admin', /grant_agent_capability/],
      ['forbidden', 403, { need: 'observer' }, 'orient', undefined, 'owner', /slug of an agent you can observe/],
    ]
    for (const [error, status, detail, tool, kind, who, step] of cases) {
      const g = refusalGuidance(error, status, detail, tool, { ...FULL, kind })
      const label = `${tool}:${error}:${kind ?? '*'}`
      expect(g.who_acts, label).toBe(who)
      expect(g.next_step, label).toMatch(step)
      if (who !== 'self') expect(g.next_step, label).toContain('To reach them') // every admin/owner row says how to reach them
    }
  })

  it('P1-1: with SEAT_ATTACH off (prod) the labels are the ones the consent page shows, never "Many chats"/"One agent"', () => {
    const off: GuideCtx = { choiceLabels: false, kind: 'chat_plain' }
    for (const [error, detail, tool] of [
      ['harness_required', 'x', 'seat_select'], ['seat_required', undefined, 'seat_attach'],
      ['invalid_args', 'agent required: x', 'orient'], ['forbidden', { reason: 'directory_channel_zero_capability', need: 'x' }, undefined],
      ['not_agent_bound', undefined, 'inbox'],
    ] as Array<[string, unknown, string | undefined]>) {
      const t = String(refusalGuidance(error, 403, detail, tool, off).next_step)
      expect(t, `${tool}:${error}`).not.toMatch(/Many chats|One agent/)
      expect(t, `${tool}:${error}`).toMatch(/A chat you drive|Existing agent/)
    }
  })

  it('P2: link comes only from a dedicated detail field, never scraped from prose', () => {
    expect(refusalGuidance('harness_required', 403, 'see https://evil.example/x for more', 'seat_select').link).toBeUndefined()
    expect(refusalGuidance('harness_required', 403, { link: 'https://pot.example/connections' }, 'seat_select').link).toBe('https://pot.example/connections')
    expect(refusalGuidance('harness_required', 403, { link: 'javascript:alert(1)' }, 'seat_select').link).toBeUndefined()
  })

  it('DE7: seat_select from an already-bound credential says it IS an agent, not "retry unbound" (real path)', async () => {
    const env = envFor(h)
    const hash = await sha256Hex('agent-bearer-b')
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('tok-ag-b', 'mem-agent-rava', '${hash}', 't', 'workspace', '2026-10-09T00:00:00.000Z', 'agent-rava', '${TENANT}')`)
    const res = await mcpApp.request('https://pot.example/', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer agent-bearer-b' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'seat_select', arguments: { project: 'p' } } }) }, env)
    const sc = ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent
    expect(sc).toMatchObject({ ok: false, error: 'not_unbound_directory_session', status: 403, who_acts: 'self', next_tool: 'boot_context' })
    const text = JSON.stringify(sc)
    expect(text).toContain('already an agent')
    expect(text).not.toMatch(/unbound session: send no seat handle/)
    expect(text).not.toMatch(/retry unbound/i)
  })

  it('seat_select with no verified harness: owner re-consents with "Many chats" (real path)', async () => {
    const env = envFor(h)
    const hash = 'hash-noharness'
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-nh', '${HUMAN}', '${hash}', 'oauth:x', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const ctx = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: 'tok-nh', email: null, channel: 'directory', boundAgentId: null })
    if (!ctx) throw new Error('ctx null')
    const r = await rpc(env, ctx, 'seat_select', { project: 'p' }, null)
    expect(r.sc).toMatchObject({ ok: false, error: 'harness_required', who_acts: 'owner' })
    expect(String(r.sc.next_step)).toContain('A chat you drive')
  })

  it('DE8: verify_agent_connection from a seat session says it needs a workspace token an admin mints', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await rpc(env, g.ctx, 'boot_context') // auto seat
    const r = await rpc(env, g.ctx, 'verify_agent_connection', { receipt_id: 'r', challenge: 'c' })
    // A seat session is a CHAT connector: it cannot use a minted bearer, so the step must not point it at mint_agent_token.
    expect(r.sc).toMatchObject({ ok: false, error: 'agent_bound_credential_required', status: 403, who_acts: 'owner' })
    expect(r.sc).not.toHaveProperty('next_tool')
    expect(String(r.sc.next_step)).toContain('daemon')
    expect(String(r.sc.next_step)).not.toContain('mint_agent_token')
    expect(String(r.sc.next_step)).not.toContain('this session is not one')
  })

  it('DE2: orient {} from an unbound directory session names orient {agent} / seat_select, never "call connect" (real path)', async () => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: undefined, SEAT_ATTACH: undefined })
    const g = await grant(env, HUMAN)
    const res = await mcpApp.fetch(mcpInternalRequest(new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'orient', arguments: {} } }) }), g.ctx), env)
    const body = (await res.json()) as { error: { message: string; data: string; who_acts: string; next_step: string } }
    expect(body.error.message).toBe('invalid_args')
    expect(typeof body.error.data).toBe('string') // data keeps its old shape (P1-3); the envelope is a sibling of data
    expect(body.error.who_acts).toBe('owner') // seat flags off in this env: a plain connector, its human re-consents
    expect(body.error.data).toMatch(/orient \{ agent:/)
    expect(body.error.data).toMatch(/seat_select/)
    expect(JSON.stringify(body.error)).not.toMatch(/call connect/)
  })

  it('DE2 other half: connect on a session-local claim says orient {agent: <slug>}, not "orient {}"', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const r = await rpc(env, g.ctx, 'connect', { agent_name: 'rava' }, null)
    const step = String((r.sc.result as { next_step?: string } | undefined)?.next_step ?? r.sc.next_step ?? '')
    expect(step).toContain('orient { agent: "rava" }')
    expect(step).not.toContain('orient {}')
  })

  it('connect DOOR A agrees with seat_required: a harnessless connector is told to re-consent, not seat_select (map §2 fix 2)', async () => {
    const env = envFor(h)
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-nh2', '${HUMAN}', 'hash-nh2', 'oauth:x', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const ctx = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: 'tok-nh2', email: null, channel: 'directory', boundAgentId: null })
    if (!ctx) throw new Error('ctx null')
    const r = await rpc(env, ctx, 'connect', { agent_name: 'rava' }, null)
    const text = JSON.stringify(r.sc)
    expect(text).toContain('A chat you drive')
    expect(text).not.toMatch(/Claude \(web\) calls seat_select and sends the handle/)
  })

  it('connect-after-bootstrap: connect refused directory_channel_zero_capability carries who_acts owner + the real next step, with SEAT_ATTACH off', async () => {
    const env = envFor(h, { SEAT_ATTACH: undefined })
    seedHuman('member-plain')
    const g = await grant(env, 'member-plain')
    const r = await rpc(env, g.ctx, 'connect', { agent_name: 'rava' }, null)
    expect(r.sc).toMatchObject({ ok: false, error: 'forbidden', status: 403, who_acts: 'owner' })
    expect((r.sc.detail as { reason?: string }).reason).toBe('directory_channel_zero_capability')
    expect(String(r.sc.next_step)).toMatch(/Existing agent.*A chat you drive/) // prod labels (SEAT_ATTACH off), P1-1
    expect(String(r.sc.next_step)).not.toMatch(/Many chats|One agent/)
    expect(String(r.sc.next_step)).toContain('mint_agent_token')
    expect(JSON.stringify(r.sc)).not.toContain('seat_attach') // flag off: nothing may advertise it
  })

  it('DE11: bootstrap_self rate limit is a 429 with a wait-and-retry step, not a 403', async () => {
    const store = new Map<string, string>()
    const kv = { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) } }
    const env = envFor(h, { SESSIONS: kv })
    for (let i = 0; i < 5; i += 1) await checkBootstrapSelfRateLimit(env, HUMAN)
    // Unbound plain directory grant (no harness, no seat): the only door bootstrap_self runs on.
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-rl', '${HUMAN}', 'hash-rl', 'oauth:x', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const ctx = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: 'tok-rl', email: null, channel: 'directory', boundAgentId: null })
    if (!ctx) throw new Error('ctx null')
    const r = await rpc(env, ctx, 'bootstrap_self', { agent_name: 'Aria' }, null)
    expect(r.sc).toMatchObject({ ok: false, error: 'rate_limited', status: 429, who_acts: 'self' })
    expect(String(r.sc.next_step)).toMatch(/wait/)
  })

  it('harness_session_seat_required (K5 harness bearer) carries the exact seat_select args (real path)', async () => {
    const env = envFor(h)
    const raw = 'mupot_' + 'a'.repeat(64)
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id, harness_kind) VALUES ('tok-k5', '${HUMAN}', '${await hashMemberToken(raw)}', 'x', 'directory', '2026-10-10', '${TENANT}', NULL, 'ci')`)
    h.sqlite.exec(`INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind, credential_kind, token_id) VALUES ('h-k5', '${TENANT}', '${HUMAN}', 'token:tok-k5', 'n', 'ci', 'token', 'tok-k5')`)
    const res = await mcpApp.request('https://pot.example/', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }) }, env)
    const sc = ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent
    expect(sc).toMatchObject({ ok: false, error: 'harness_session_seat_required', status: 403, who_acts: 'self', next_tool: 'seat_select' })
    expect(String(sc.next_step)).toContain('seat_select { project: "<workspace name>" }')
    expect(String(sc.next_step)).toContain('X-Mupot-Seat')
  })

  it('DE12: a capability floor names the grant path, not a bounce to boot_context', () => {
    const t = String(refusalNextStep('forbidden', 403, { need: 'observer' }))
    expect(t).toContain('grant_agent_capability')
    expect(t).not.toMatch(/^.*Call boot_context and follow its next_step/)
  })
})
