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
import { refusalNextStep } from '../src/mcp/refusal-next-step'
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
  it('teaches a bare capability-floor refusal and points at boot_context', () => {
    const t = refusalNextStep('forbidden', 403, { need: 'admin' })
    expect(t).toContain('boot_context')
    expect(t).toMatch(/human act/)
  })

  it('never overwrites a refusal that already teaches (hint, reason or its own next_step)', () => {
    expect(refusalNextStep('forbidden', 403, { need: 'admin', hint: 'x' })).toBeUndefined()
    expect(refusalNextStep('forbidden', 403, { reason: 'directory_channel_zero_capability', need: 'workspace-channel token' })).toBeUndefined()
    expect(refusalNextStep('forbidden', 403, { need: 'admin', next_step: 'y' })).toBeUndefined()
  })

  it('stays silent where there is no universal next step, and for non-403 statuses of a 403 code', () => {
    expect(refusalNextStep('agent_not_found', 404, undefined)).toBeUndefined()
    expect(refusalNextStep('forbidden', 404, { need: 'admin' })).toBeUndefined()
    expect(refusalNextStep('forbidden', 403, 'a bare string detail')).toBeUndefined()
  })

  it('covers the not-bound, seat and flag-off refusals and the rate limit', () => {
    expect(refusalNextStep('not_agent_bound', 403, 'x')).toContain('seat_attach')
    expect(refusalNextStep('seat_required', 403, undefined)).toContain('seat_select')
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

  it('a member calling an admin tool: same 403 forbidden need, plus a next_step naming boot_context', async () => {
    const tok = await memberToken()
    const res = await call(mcpApp, 'https://pot.example/', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pot_list', arguments: {} } }, tok)
    const body = (await res.json()) as { result: { isError: boolean; structuredContent: Record<string, unknown> } }
    expect(body.result.isError).toBe(true)
    expect(body.result.structuredContent).toMatchObject({ ok: false, tool: 'pot_list', error: 'forbidden', status: 403, need: 'admin' })
    expect(String(body.result.structuredContent.next_step)).toContain('boot_context')
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
    expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toMatch(/'orient' answers only once you act as an agent/)
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

  it('seat_select with the attach flag off does not advertise seat_attach', async () => {
    const env = envFor(h, { SEAT_ATTACH: undefined })
    const g = await grant(env, HUMAN)
    const handle = String((await rpc(env, g.ctx, 'seat_select', { project: 'p' }, null)).sc.seat_handle)
    const r = await rpc(env, g.ctx, 'seat_select', { project: 'p' }, null, { 'x-mupot-seat': handle })
    expect(r.sc).toMatchObject({ ok: false, error: 'not_unbound_directory_session', status: 403 })
    expect(String(r.sc.detail)).not.toContain('seat_attach')
  })
})
