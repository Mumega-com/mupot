// tests/seat-clamp-legacy-plane.test.ts — PR-A (design-installer-window-and-owner-dispatch S2-0 + finding 5).
//
// (1) S2-0: a seat session (non-attached) of a human whose home squad has a project_squad_access edge to a project
//     must see that project through project_list and project_get on the real MCP path.
// (2) The seat clamp must read the human's rank from BOTH authority planes (capability rows AND the legacy role
//     plane users.role owner/admin), the way projectReadAccessFromGrants / actorRankOnScopeFor already do.
//
// Real sqlite D1 over the full migration chain; requests go OAuth props -> buildAuthContextFromProps -> mcpApp.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seatSelect, seatTotalCap, type SeatSelectAuth } from '../src/members/seat-select'
import { upsertHarness } from '../src/members/harness'
import {
  applySeatHandle, hashSeatHandle, isWellFormedSeatHandle, mintSeatHandle, resolveSeatCapabilities,
  SEAT_HANDLE_MAX_LIVE_PER_SEAT, NO_HINTS,
} from '../src/members/seat-handle'
import { buildAuthContextFromProps, resolveConsentedAgentCapabilities } from '../src/mcp/oauth-authorize'
import { mcpApp, invokeTool, TOOLS, SEAT_ARG_TOOLS, SEAT_ARG_WORK_LOOP } from '../src/mcp/index'
import { SEAT_SELECT_STEP, LOST_SEAT_STEP } from '../src/mcp/refusal-next-step'
import { mcpInitializeInstructions } from '../src/mcp/instructions'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { canOnSquad } from '../src/auth/capability'
import { createHomeForMember } from '../src/org/service'
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

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return { DB: h.db, TENANT_SLUG: TENANT, SESSIONS: memoryKv(), SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '100', ...extra } as unknown as Env
}

let h: SqliteD1Harness
let tokCounter = 0

function seedHuman(id: string): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

interface Grant { memberId: string; tokenId: string; harnessId: string; ctx: AuthContext }

/** A human's unbound directory grant on one harness (client), as the OAuth handler would build it. */
async function grant(env: Env, memberId: string, clientId = 'client-cursor', name = 'Cursor'): Promise<Grant> {
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

/** Drive the real internal-header -> mcpApp path with a pre-built OAuth context. */
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
  const result = (body.result ?? {}) as { structuredContent?: Record<string, unknown> }
  return { status: res.status, body, sc: result.structuredContent ?? {} }
}

const receiptOf = (r: Rpc): Record<string, unknown> => r.sc.identity_receipt as Record<string, unknown>

async function select(env: Env, g: Grant, folder: string, o: RpcOpts = {}): Promise<{ handle: string; agentId: string; seatId: string; sc: Record<string, unknown> }> {
  const r = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder }, o)
  const sc = r.sc
  if (typeof sc.seat_handle !== 'string') throw new Error(`no handle: ${JSON.stringify(r.body)}`)
  return { handle: sc.seat_handle, agentId: (sc.agent as { id: string }).id, seatId: (sc.seat_row as { id: string }).id, sc }
}

const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)
void n

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedHuman(HUMAN2)
  resetHarnessProbeSampling()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

function seedWorkSquad(id: string): void {
  h.sqlite.exec(`INSERT OR IGNORE INTO departments (id, slug, name, created_at) VALUES ('d-clamp', 'd-clamp', 'DC', datetime('now'))`)
  h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('${id}', 'd-clamp', '${id}', '${id}', datetime('now'))`)
}
function seedUserRole(memberId: string, role: 'owner' | 'admin' | 'member'): void {
  h.sqlite.exec(`INSERT INTO users (id, email, role) VALUES ('u-${memberId}', '${memberId}@example.test', '${role}')`)
}
function giveAgent(agentMemberId: string, scopeType: string, scopeId: string | null, capability: string): void {
  h.sqlite.exec(`INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${agentMemberId}', '${scopeType}', ${scopeId ? `'${scopeId}'` : 'NULL'}, '${capability}')`)
}
const SEAT = (handle: string): RpcOpts => ({ headers: { 'x-mupot-seat': handle } })

// ════════════════════════════════════════════════════════════════════════════
describe('S2-0: seat session sees a project linked to its home squad', () => {
  it('project_list and project_get return the project for a non-attached seat (edge on the agent home squad)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const homeSquad = (a.sc.agent as { squad_id: string }).squad_id
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('proj-edge', 'proj-edge', 'Edge', 'active')`)
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('proj-noedge', 'proj-noedge', 'NoEdge', 'active')`)
    // before the edge: not visible (control)
    const before = await rpc(env, g.ctx, 'project_get', { project_id: 'proj-edge' }, SEAT(a.handle))
    expect(JSON.stringify(before.body)).toContain('project_not_found')
    h.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-edge', '${homeSquad}', 'write')`)
    const list = await rpc(env, g.ctx, 'project_list', {}, SEAT(a.handle))
    const listText = JSON.stringify(list.body)
    expect(listText).toContain('proj-edge')
    expect(listText).not.toContain('proj-noedge')
    const got = await rpc(env, g.ctx, 'project_get', { project_id: 'proj-edge' }, SEAT(a.handle))
    expect(JSON.stringify(got.body)).not.toContain('project_not_found')
    expect(JSON.stringify(got.body)).toContain('proj-edge')
    // and the unlinked project stays dark (the edge is the only door)
    const other = await rpc(env, g.ctx, 'project_get', { project_id: 'proj-noedge' }, SEAT(a.handle))
    expect(JSON.stringify(other.body)).toContain('project_not_found')
  })

  it('an edge on a DIFFERENT squad than agents.squad_id does not show (candidate cause (a) pinned)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    seedWorkSquad('sq-elsewhere')
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('proj-else', 'proj-else', 'Else', 'active')`)
    h.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-else', 'sq-elsewhere', 'write')`)
    const got = await rpc(env, g.ctx, 'project_get', { project_id: 'proj-else' }, SEAT(a.handle))
    expect(JSON.stringify(got.body)).toContain('project_not_found')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('seat clamp honours the legacy role plane (finding 5)', () => {
  async function seatAgent(env: Env): Promise<{ agentMemberId: string; agentId: string; homeSquad: string }> {
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    return { agentMemberId: a.sc.member_id as string, agentId: a.agentId, homeSquad: (a.sc.agent as { squad_id: string }).squad_id }
  }
  const resolveFor = (env: Env, s: { agentMemberId: string; agentId: string; homeSquad: string }) =>
    resolveSeatCapabilities(env, { humanMemberId: HUMAN, agentId: s.agentId, agentSquadId: s.homeSquad, agentMemberId: s.agentMemberId })
  const has = (caps: Array<{ scope_type: string; scope_id: string | null; capability: string }>, type: string, id: string | null) =>
    caps.find((c) => c.scope_type === type && c.scope_id === id)

  it('legacy owner (users.role=owner, no row on the scope): the agent grant on a work squad is KEPT, at member', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedWorkSquad('sq-w')
    seedUserRole(HUMAN, 'owner')
    giveAgent(s.agentMemberId, 'squad', 'sq-w', 'lead')
    const caps = await resolveFor(env, s)
    expect(has(caps, 'squad', 'sq-w')?.capability).toBe('member') // clamped by the seat ceiling, never above
  })

  it('legacy owner: an agent ORG grant is kept at member; admin/owner is never produced', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedUserRole(HUMAN, 'owner')
    giveAgent(s.agentMemberId, 'org', null, 'admin')
    const caps = await resolveFor(env, s)
    expect(has(caps, 'org', null)?.capability).toBe('member')
    expect(caps.every((c) => c.capability === 'observer' || c.capability === 'member')).toBe(true)
  })

  it('legacy owner does NOT reach another member\'s home squad via the role plane (planeCoversScope)', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedUserRole(HUMAN, 'owner')
    const other = await createHomeForMember(env, HUMAN2)
    if (!other.ok) throw new Error('home fixture')
    giveAgent(s.agentMemberId, 'squad', other.squad.id, 'member')
    const caps = await resolveFor(env, s)
    expect(has(caps, 'squad', other.squad.id)).toBeUndefined()
  })

  it('legacy owner: a grant on a squad row that does not exist fails closed', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedUserRole(HUMAN, 'owner')
    giveAgent(s.agentMemberId, 'squad', 'sq-ghost', 'member')
    const caps = await resolveFor(env, s)
    expect(has(caps, 'squad', 'sq-ghost')).toBeUndefined()
  })

  it('a plain member (users.role=member) is NOT widened: the agent grant outside their rows is still dropped', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedWorkSquad('sq-w')
    seedUserRole(HUMAN, 'member')
    giveAgent(s.agentMemberId, 'squad', 'sq-w', 'member')
    expect(has(await resolveFor(env, s), 'squad', 'sq-w')).toBeUndefined()
  })

  it('a human with no users row at all is NOT widened (absence of the bridge is never elevation)', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedWorkSquad('sq-w')
    giveAgent(s.agentMemberId, 'squad', 'sq-w', 'member')
    expect(has(await resolveFor(env, s), 'squad', 'sq-w')).toBeUndefined()
  })

  it('legacy owner: a human-ROW-sourced observer grant is not lifted to member (role plane counts for agent grants only)', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedWorkSquad('sq-w')
    seedUserRole(HUMAN, 'owner')
    h.sqlite.exec(`INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${HUMAN}', 'squad', 'sq-w', 'observer')`)
    const caps = await resolveFor(env, s)
    expect(has(caps, 'squad', 'sq-w')?.capability).toBe('observer')
  })

  it('capability-row admin (no users row) is unchanged: agent grant clamped to member where the human holds a row', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedWorkSquad('sq-w')
    h.sqlite.exec(`INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${HUMAN}', 'squad', 'sq-w', 'admin')`)
    giveAgent(s.agentMemberId, 'squad', 'sq-w', 'lead')
    expect(has(await resolveFor(env, s), 'squad', 'sq-w')?.capability).toBe('member')
  })

  it('an agent grant of lower own rank still caps a legacy owner (observer stays observer)', async () => {
    const env = envFor(h)
    const s = await seatAgent(env)
    seedWorkSquad('sq-w')
    seedUserRole(HUMAN, 'owner')
    giveAgent(s.agentMemberId, 'squad', 'sq-w', 'observer')
    const caps = await resolveFor(env, s)
    expect(has(caps, 'squad', 'sq-w')?.capability).toBe('observer')
  })

  it('end to end: a legacy owner seat sees a project linked to a work squad the agent was granted', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    seedWorkSquad('sq-w')
    seedUserRole(HUMAN, 'owner')
    giveAgent(a.sc.member_id as string, 'squad', 'sq-w', 'member')
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('proj-w', 'proj-w', 'W', 'active')`)
    h.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-w', 'sq-w', 'write')`)
    const got = await rpc(env, g.ctx, 'project_get', { project_id: 'proj-w' }, SEAT(a.handle))
    expect(JSON.stringify(got.body)).not.toContain('project_not_found')
    // control: the same grant for a non-owner stays dark
    h.sqlite.exec(`UPDATE users SET role = 'member'`)
    const dark = await rpc(env, g.ctx, 'project_get', { project_id: 'proj-w' }, SEAT(a.handle))
    expect(JSON.stringify(dark.body)).toContain('project_not_found')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('consent-time clamp (resolveConsentedAgentCapabilities) honours the legacy plane', () => {
  async function setup(role: 'owner' | 'member' | null) {
    const env = envFor(h)
    seedWorkSquad('sq-w')
    seedWorkSquad('sq-agent')
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, status) VALUES ('ag1', 'sq-agent', 'ag1', 'Ag1', 'member', 'active')`)
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('m-ag1', 'ag1@agents.test', 'Ag1', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    h.sqlite.exec(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'ag1', 'm-ag1', datetime('now'))`)
    // the human stands as admin on the agent's squad by ROW (the consent floor); NOTHING on sq-w
    h.sqlite.exec(`INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${HUMAN}', 'squad', 'sq-agent', 'admin')`)
    if (role) seedUserRole(HUMAN, role)
    giveAgent('m-ag1', 'squad', 'sq-w', 'member')
    return env
  }
  it('legacy owner keeps the agent grant outside their rows', async () => {
    const env = await setup('owner')
    const caps = await resolveConsentedAgentCapabilities(env, 'ag1', HUMAN)
    expect(caps.find((c) => c.scope_id === 'sq-w')?.capability).toBe('member')
  })
  it('plain member and no-users-row humans are not widened', async () => {
    for (const role of ['member', null] as const) {
      h.close(); h = createSqliteD1(); applyAllMigrations(h.sqlite); seedHuman(HUMAN); seedHuman(HUMAN2)
      const env = await setup(role)
      const caps = await resolveConsentedAgentCapabilities(env, 'ag1', HUMAN)
      expect(caps.find((c) => c.scope_id === 'sq-w')).toBeUndefined()
    }
  })
})
