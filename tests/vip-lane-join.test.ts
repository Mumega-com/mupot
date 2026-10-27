// tests/vip-lane-join.test.ts — join_squad (#2035 wall 1, slice 1): an owner/org-admin's own seat joins instantly as OBSERVED; anyone
// else files ONE card. Real sqlite D1 from the full migration chain; the seat comes from the real OAuth-props -> mcpApp auto-seat path
// (exactly as tests/squad-join-request.test.ts), so the observed floor is proven through the real tool chokepoint.
//
// MUTATIONS proven (see PR body): humanMayInstantJoin (return true), the active-human check, the held guard, the NULL-only status
// stamp, the existing-membership idempotence guard, the floor list (OBSERVED_FLOOR_TOOLS), the flag gate, the pending-first dedupe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { runRouterTick } from '../src/router/engine'
import { runTaskExecution } from '../src/agents/execute'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { advertisedTools, invokeTool, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { OBSERVED_FLOOR_TOOLS, OBSERVED_TIER_RANK, instantObservedJoin, observedFloorRefusal, readSeatAdmissionStatus } from '../src/members/vip-lane'
import { capabilityRank } from '../src/auth/capability'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const OWNER = 'member-owner' // admin on squad-target + admin on its own home squad (squad-core hosts its seat agents)
const ORGADM = 'member-orgadmin'
const PLAIN = 'member-plain' // only a member on squad-target
const NOBODY = 'member-nobody' // no rows on squad-target
const STALE = 'member-stale' // owner grant on squad-target, EXPIRED
const HOST = 'secure.example.test'
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
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://colony.example.test', SESSIONS: memoryKv(), OAUTH_KV: { get: async () => null, put: async () => undefined },
    CONNECTOR_MASTER_KEY: MASTER, SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: HOST,
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', VIP_LANE: '1', SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
let env: Env
let tok = 0
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined

const seedHuman = (id: string): void => { h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`) }
function seedSquad(id: string, kind = 'work'): void {
  h.sqlite.exec(`INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-${id}', 'dept-${id}', 'Dept ${id}');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('${id}', 'dept-${id}', '${id}', 'Squad ${id}', '${kind}');`)
}
const cap = (member: string, scope: 'squad' | 'org', scopeId: string | null, capability: string, expires: string | null = null): void => {
  h.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).run(`cap-${member}-${scope}-${scopeId ?? 'org'}-${capability}`, member, scope, scopeId, capability, expires)
}

interface Seat { ctx: AuthContext; session: string; seatId: string; agentId: string }
async function seatFor(memberId: string, session = 'conv-a'): Promise<Seat> {
  const harness = await upsertHarness(env, memberId, 'client-chatgpt', 'ChatGPT')
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tok}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:client-chatgpt', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  const boot = await rpc(ctx, 'boot_context', {}, session)
  const row = one<{ id: string; agent_id: string }>(`SELECT id, agent_id FROM agent_seats WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`, memberId)
  if (!row) throw new Error(`no seat made: ${JSON.stringify(boot.body)}`)
  return { ctx, session, seatId: row.id, agentId: row.agent_id }
}
interface Rpc { body: Record<string, unknown>; sc: Record<string, unknown>; text: string }
async function rpc(ctx: AuthContext, name: string, args: Record<string, unknown>, session: string, e: Env = env): Promise<Rpc> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'openai/session': session } } }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), e)
  const body = (await res.json()) as Record<string, unknown>
  return { body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}, text: JSON.stringify(body) }
}
const join = (s: Seat, args: Record<string, unknown>, e: Env = env): Promise<Rpc> => rpc(s.ctx, 'join_squad', args, s.session, e)

const status = (seatId: string): string | null => one<{ s: string | null }>(`SELECT admission_status AS s FROM agent_seats WHERE id = ?`, seatId)?.s ?? null
const membership = (agent: string, squad: string): { capability: string } | undefined => one(`SELECT capability FROM memberships WHERE agent_id = ? AND squad_id = ?`, agent, squad)
const cards = (): number => n(`SELECT COUNT(*) AS n FROM squad_join_requests`)
const moments = (): number => n(`SELECT COUNT(*) AS n FROM secure_moments WHERE kind = 'squad_join'`)
const receipts = (): number => n(`SELECT COUNT(*) AS n FROM membership_receipts WHERE squad_id = 'squad-target'`)

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = envFor(h)
  for (const m of [OWNER, ORGADM, PLAIN, NOBODY, STALE]) seedHuman(m)
  seedSquad('squad-core')
  seedSquad('squad-target')
  seedSquad('squad-second')
  seedSquad('squad-home-x', 'home')
  for (const m of [OWNER, ORGADM, PLAIN, NOBODY, STALE]) cap(m, 'squad', 'squad-core', 'admin') // a seat needs its human admin on the seat agent's squad
  cap(OWNER, 'squad', 'squad-target', 'admin')
  cap(ORGADM, 'org', null, 'admin')
  cap(PLAIN, 'squad', 'squad-target', 'member')
  cap(STALE, 'squad', 'squad-target', 'owner', '2026-01-02T00:00:00.000Z')
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

describe('flag off', () => {
  it('the tool is not advertised, a direct call refuses, and nothing is written or enforced', async () => {
    const off = envFor(h, { VIP_LANE: undefined })
    expect(advertisedTools(off).some((t) => t.name === 'join_squad')).toBe(false)
    expect(advertisedTools(env).some((t) => t.name === 'join_squad')).toBe(true)
    const s = await seatFor(OWNER)
    const r = await join(s, { squad: 'squad-target' }, off)
    expect(r.text).toContain('vip_lane_disabled')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
    expect(status(s.seatId)).toBeNull()
    // an observed seat is NOT floored while the flag is off (total no-op)
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'observed' WHERE id = ?`).run(s.seatId)
    expect((await rpc(s.ctx, 'status', {}, s.session, off)).text).not.toContain('observed_floor')
  })
})

// Every seat holds exactly its OWN derived gate (seat_select mint parity, #2089); a join must add nothing beyond that.
function ownGateOnly(agentId: string): boolean {
  const grants = h.sqlite.prepare(`SELECT capability, principal_type, principal_id FROM gate_grants`).all() as Array<{ capability: string; principal_type: string; principal_id: string }>
  const slug = (h.sqlite.prepare(`SELECT slug FROM agents WHERE id = ?`).get(agentId) as { slug: string }).slug
  return slug.startsWith('seat-') && grants.length === 1 && grants[0].capability === `gate:${slug}` && grants[0].principal_type === 'agent' && grants[0].principal_id === agentId
}

describe('eligible: instant observed seat', () => {
  it('a squad admin/owner: joins at once, stamped observed, ONE membership at the observed tier with a receipt', async () => {
    const s = await seatFor(OWNER)
    const r = await join(s, { squad: 'squad-target' })
    expect(r.sc.status, r.text).toBe('joined')
    expect(r.sc.admission_status).toBe('observed')
    expect(status(s.seatId)).toBe('observed')
    expect(membership(s.agentId, 'squad-target')).toEqual({ capability: 'member' })
    expect(OBSERVED_TIER_RANK).toBeLessThanOrEqual(capabilityRank('member')) // never above the seat ceiling
    expect(receipts()).toBe(1)
    expect(cards()).toBe(0)
    expect(ownGateOnly(s.agentId)).toBe(true)
  })

  it('an org-admin (no row on the squad) joins instantly by slug or id', async () => {
    const s = await seatFor(ORGADM)
    expect((await join(s, { squad: 'squad-second' })).sc.status).toBe('joined')
    expect(membership(s.agentId, 'squad-second')).toEqual({ capability: 'member' })
    expect(status(s.seatId)).toBe('observed')
  })

  it('idempotent: a repeat join is the same membership, one receipt, no card', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const again = await join(s, { squad: 'squad-target' })
    expect(again.sc.status, again.text).toBe('joined')
    expect(again.sc.membership).toBe('already')
    expect(n(`SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND squad_id = 'squad-target'`, s.agentId)).toBe(1)
    expect(receipts()).toBe(1)
    expect(cards()).toBe(0)
  })

  it('the observed floor is ENFORCED after join: grant, gate, membership, token and elevation tools are refused; reads and proposals work', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const refused = [
      ['squad_member_add', { squad: 'squad-target', agent: s.agentId, capability: 'lead' }],
      ['task_verdict', { task_id: 'x', verdict: 'approve' }],
      ['request_elevation', {}],
      ['project_squad_set', { project_id: 'p', squad_id: 'squad-target', access_level: 'admin' }],
      ['mint_agent_token', {}],
    ] as const
    for (const [tool, args] of refused) {
      const r = await rpc(s.ctx, tool, { ...args }, s.session)
      expect(r.text, tool).toContain('observed_floor')
    }
    // seat_attach is on the floor on purpose (it only FILES a request; see observed-seat-request-admission.test.ts)
    expect((await rpc(s.ctx, 'seat_attach', { reason: 'This chat is assigned to operate the requested agent.', agent: 'x' }, s.session)).text).not.toContain('observed_floor')
    for (const tool of ['status', 'task_list', 'recall']) {
      expect((await rpc(s.ctx, tool, tool === 'recall' ? { query: 'x' } : {}, s.session)).text, tool).not.toContain('observed_floor')
    }
    // nothing was granted by any of those
    expect(membership(s.agentId, 'squad-target')).toEqual({ capability: 'member' })
    expect(ownGateOnly(s.agentId)).toBe(true)
    // the floor names only tools that exist (a typo would be a silent hole in the other direction)
    const all = new Set(advertisedTools(env).map((t) => t.name))
    for (const name of OBSERVED_FLOOR_TOOLS) expect(all.has(name) || name === 'whoami', name).toBe(true)
  })

  it('a seat that is NOT observed is not floored (no status = every pre-existing seat)', async () => {
    const s = await seatFor(OWNER)
    expect((await rpc(s.ctx, 'request_elevation', {}, s.session)).text).not.toContain('observed_floor')
  })

  it('a held seat cannot re-join its way out: status stays held, no membership', async () => {
    const s = await seatFor(OWNER)
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'held' WHERE id = ?`).run(s.seatId)
    const r = await join(s, { squad: 'squad-target' })
    expect(r.text).toContain('observed_floor') // #2060: held is read-only, so the floor refuses join_squad before the tool's own seat_held guard
    expect(status(s.seatId)).toBe('held')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
  })

  it('a trusted seat is not re-stamped by a repeat join to a squad it is already in (the stamp is NULL-only); a NEW squad resets it (#2060, audited)', async () => {
    const s = await seatFor(OWNER)
    h.sqlite.prepare(`INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-t', ?, 'squad-target', 'member')`).run(s.agentId)
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'trusted' WHERE id = ?`).run(s.seatId)
    expect((await join(s, { squad: 'squad-target' })).sc.admission_status).toBe('trusted')
    expect(status(s.seatId)).toBe('trusted')
    cap(OWNER, 'squad', 'squad-second', 'admin')
    expect((await join(s, { squad: 'squad-second' })).sc.admission_status).toBe('observed')
    expect(status(s.seatId)).toBe('observed')
  })

  it('a higher standing someone else gave the seat is kept, never lowered', async () => {
    const s = await seatFor(OWNER)
    h.sqlite.prepare(`INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-lead', ?, 'squad-target', 'lead')`).run(s.agentId)
    const r = await join(s, { squad: 'squad-target' })
    expect(r.sc.membership).toBe('kept')
    expect(membership(s.agentId, 'squad-target')).toEqual({ capability: 'lead' })
  })

  it('a home or archived squad is not joinable this way, even by an admin of it', async () => {
    cap(OWNER, 'squad', 'squad-home-x', 'admin')
    const s = await seatFor(OWNER)
    expect((await join(s, { squad: 'squad-home-x' })).text).not.toContain('"joined"')
    expect(membership(s.agentId, 'squad-home-x')).toBeUndefined()
    h.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = 'squad-second'`)
    cap(OWNER, 'squad', 'squad-second', 'admin')
    expect((await join(s, { squad: 'squad-second' })).text).toContain('squad_not_joinable')
    expect(membership(s.agentId, 'squad-second')).toBeUndefined()
  })
})

describe('not eligible: one card, never a bare refusal', () => {
  it('a plain member: ONE pending observer card, nothing granted, the same reply for a squad that does not exist', async () => {
    const s = await seatFor(PLAIN)
    const r = await join(s, { squad: 'squad-target' })
    expect(r.sc.status, r.text).toBe('join_requested')
    expect(cards()).toBe(1)
    expect(moments()).toBe(1)
    expect(one<{ capability: string; status: string }>(`SELECT capability, status FROM squad_join_requests`)).toEqual({ capability: 'observer', status: 'pending' })
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
    expect(status(s.seatId)).toBeNull()
    const ghost = await join(s, { squad: 'no-such-squad' })
    expect(Object.keys(ghost.sc).sort()).toEqual(Object.keys(r.sc).sort())
    expect(ghost.sc.status).toBe('join_requested')
  })

  it('a repeat does not file, rotate or re-notify: still one card, one moment', async () => {
    const s = await seatFor(PLAIN)
    await join(s, { squad: 'squad-target' })
    const link = one<{ id: string }>(`SELECT id FROM secure_moments WHERE kind = 'squad_join'`)!.id
    const again = await join(s, { squad: 'squad-target' })
    expect(again.sc.already_pending).toBe(true)
    expect(cards()).toBe(1)
    expect(moments()).toBe(1)
    expect(one<{ id: string }>(`SELECT id FROM secure_moments WHERE kind = 'squad_join'`)!.id).toBe(link)
  })

  it('a member with no rows at all is a card, not an admission (an email that matches an owner proves nothing)', async () => {
    h.sqlite.exec(`INSERT INTO users (id, email, role, created_at) VALUES ('u-own', '${NOBODY}@example.test', 'owner', '2026-10-01T00:00:00.000Z')`)
    const s = await seatFor(NOBODY)
    expect((await join(s, { squad: 'squad-target' })).sc.status).toBe('join_requested')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
    expect(status(s.seatId)).toBeNull()
  })

  it('DB rank vs effective grants: an EXPIRED owner row is not standing (a raw capabilities lookup would admit it)', async () => {
    expect(n(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ? AND scope_id = 'squad-target' AND capability = 'owner'`, STALE)).toBe(1)
    const s = await seatFor(STALE)
    expect((await join(s, { squad: 'squad-target' })).sc.status).toBe('join_requested')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
  })

  it('DB rank vs effective grants: the SEAT AGENT holding lead in the DB does not make a non-admin human eligible', async () => {
    const s = await seatFor(PLAIN)
    h.sqlite.prepare(`INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('m-lead2', ?, 'squad-target', 'lead')`).run(s.agentId)
    expect((await join(s, { squad: 'squad-target' })).sc.status).toBe('join_requested')
    expect(status(s.seatId)).toBeNull()
  })

  it('an inactive member is refused the instant path (card only), and no anchor is refused with the next step', async () => {
    const s = await seatFor(OWNER)
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    const r = await join(s, { squad: 'squad-target' })
    expect(r.text).not.toContain('"joined"')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
    const bare: AuthContext = { userId: OWNER, email: '', role: 'member', tenant: TENANT, channel: 'directory', memberId: OWNER, capabilities: [] }
    const none = await invokeTool(bare, env, 'join_squad', { squad: 'squad-target' }, 'https://pot.test')
    expect(none.ok).toBe(false)
    expect(none.ok ? '' : none.error).toBe('identity_anchor_required')
    expect(cards()).toBe(0)
  })
})

describe('projects map to squads through their access edges', () => {
  beforeEach(() => {
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'gaf', 'GAF', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', 'squad-target', 'write');`)
  })
  it('a project with one owned squad edge joins that squad instantly', async () => {
    const s = await seatFor(OWNER)
    const r = await join(s, { project: 'gaf' })
    expect(r.sc.status, r.text).toBe('joined')
    expect((r.sc.squad as { id: string }).id).toBe('squad-target')
    expect(membership(s.agentId, 'squad-target')).toEqual({ capability: 'member' })
  })
  it('a project whose edges include two squads you own asks you to name one', async () => {
    h.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', 'squad-second', 'write')`)
    cap(OWNER, 'squad', 'squad-second', 'admin')
    const s = await seatFor(OWNER)
    expect((await join(s, { project: 'proj-1' })).text).toContain('ambiguous_project')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
  })
  it('a non-owner of a one-squad project files the card to that squad', async () => {
    const s = await seatFor(PLAIN)
    expect((await join(s, { project: 'gaf' })).sc.status).toBe('join_requested')
    expect(one<{ squad_id: string }>(`SELECT squad_id FROM squad_join_requests`)?.squad_id).toBe('squad-target')
  })
  it('exactly one of squad|project is required', async () => {
    const s = await seatFor(OWNER)
    expect((await join(s, {})).text).toContain('invalid_args')
    expect((await join(s, { squad: 'squad-target', project: 'gaf' })).text).toContain('invalid_args')
  })
})

describe('P1 floor: shared memory and task_update', () => {
  const addTask = (id: string, assignee: string | null, gate: string | null = null): void => {
    h.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id, gate_owner) VALUES (?, 'squad-target', ?, 'open', ?, ?)`).run(id, `T ${id}`, assignee, gate)
  }
  it('squad_remember and project_remember are refused for an observed seat (no seat-scoped variant exists); plain remember is not', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    expect((await rpc(s.ctx, 'squad_remember', { squad_id: 'squad-target', text: 'x' }, s.session)).text).toContain('observed_floor')
    expect((await rpc(s.ctx, 'project_remember', { project_id: 'proj-1', text: 'x' }, s.session)).text).toContain('observed_floor')
    expect((await rpc(s.ctx, 'remember', { text: 'x' }, s.session)).text).not.toContain('observed_floor')
    expect(OBSERVED_FLOOR_TOOLS.has('squad_remember') || OBSERVED_FLOOR_TOOLS.has('project_remember')).toBe(false)
  })
  it('task_update: only a task assigned to the seat; never gate/assignee fields; never closes a gated task', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    addTask('t-other', null)
    addTask('t-mine', s.agentId)
    addTask('t-mine-gated', s.agentId, 'gate:hadi')
    const taskStatus = (id: string): string => one<{ status: string }>(`SELECT status FROM tasks WHERE id = ?`, id)!.status
    const other = await rpc(s.ctx, 'task_update', { task_id: 't-other', status: 'in_progress' }, s.session)
    expect(other.text).toContain('observed_floor')
    expect(taskStatus('t-other')).toBe('open')
    expect((await rpc(s.ctx, 'task_update', { task_id: 't-mine', status: 'in_progress' }, s.session)).text).not.toContain('observed_floor')
    expect(taskStatus('t-mine')).toBe('in_progress')
    for (const args of [{ gate_owner: 'gate:x' }, { assignee_agent_id: 'someone' }, { assignee_member_id: OWNER }, { gate_owner_reason: 'r' }]) {
      expect((await rpc(s.ctx, 'task_update', { task_id: 't-mine', ...args }, s.session)).text, JSON.stringify(args)).toContain('observed_floor')
    }
    expect((await rpc(s.ctx, 'task_update', { task_id: 't-mine-gated', status: 'done' }, s.session)).text).toContain('observed_floor')
    expect(taskStatus('t-mine-gated')).toBe('open')
    // a seat with no status is not touched by this rule
    const free = await seatFor(PLAIN, 'conv-free')
    addTask('t-free', null)
    expect((await rpc(free.ctx, 'task_update', { task_id: 't-free', status: 'in_progress' }, free.session)).text).not.toContain('observed_floor')
  })
})

describe('P1 floor: observed task_create is proposal-only (#2059 P1)', () => {
  const tasks = (): number => n(`SELECT COUNT(*) AS n FROM tasks`)
  const mk = (): { send: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn>; e: Env } => {
    const send = vi.fn(async () => undefined)
    const f = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', f)
    return { send, fetch: f, e: envFor(h, { BUS: { send } }) }
  }
  afterEach(() => { vi.unstubAllGlobals() })
  const create = (s: Seat, e: Env, extra: Record<string, unknown> = {}): Promise<Rpc> =>
    rpc(s.ctx, 'task_create', { squad_id: 'squad-target', title: 'T', done_when: 'the proposal is reviewed', ...extra }, s.session, e)

  it('refuses assignee_agent_id, assignee_member_id, gate_owner and dispatch:true; nothing is written, emitted or rung', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const { send, fetch: f, e } = mk()
    for (const extra of [{ assignee_agent_id: s.agentId }, { assignee_agent_id: 'other-agent' }, { assignee_member_id: OWNER }, { gate_owner: 'gate:hadi' }, { dispatch: true }]) {
      const r = await create(s, e, extra)
      expect(r.text, JSON.stringify(extra)).toContain('observed_floor')
    }
    expect(tasks()).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(f).not.toHaveBeenCalled()
  })

  it('a plain create (and dispatch:false) is created with dispatch forced off: no task.created event, no doorbell', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const { send, fetch: f, e } = mk()
    const r = await create(s, e)
    expect(r.text).not.toContain('observed_floor')
    expect(r.text, r.text).toContain('marked external (observed-seat)')
    expect((await create(s, e, { dispatch: false })).text).not.toContain('observed_floor')
    expect(tasks()).toBe(2)
    expect(send).not.toHaveBeenCalled()
    expect(f).not.toHaveBeenCalled()
  })

  it('dyad default never applies to an observed seat: even when the seat agent is pinned with a gated peer, gate_owner stays null', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const { e } = mk()
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('dy-peer', 'squad-target', 'dypeer', 'Peer', 'active')`)
    h.sqlite.prepare(`UPDATE agents SET squad_id = 'squad-target' WHERE id = ?`).run(s.agentId)
    h.sqlite.prepare(`UPDATE squads SET dyad_agent_a = ?, dyad_agent_b = 'dy-peer' WHERE id = 'squad-target'`).run(s.agentId)
    h.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg-dy', 'gate:dypeer', 'agent', 'dy-peer', '${OWNER}', '2026-10-09T00:00:00.000Z')`)
    const r = await create(s, e)
    expect(r.text, r.text).toContain('marked external (observed-seat)')
    expect(one<{ gate_owner: string | null }>(`SELECT gate_owner FROM tasks`)!.gate_owner).toBeNull()
  })

  it('the task is stamped observed-seat:<seatId> (server-set, args cannot override) and NO poller picks it up; a normal task still is', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const { e } = mk()
    const r = await create(s, e, { external_source: 'forged:marker' })
    expect(r.text).not.toContain('observed_floor')
    const row = one<{ id: string; external_source: string | null; assignee_agent_id: string | null }>(`SELECT id, external_source, assignee_agent_id FROM tasks WHERE title = 'T'`)!
    expect(row.external_source).toBe(`observed-seat:${s.seatId}`)
    expect(row.assignee_agent_id).toBeNull()
    // a live squad agent exists: router_tick must not assign the observed task, but must assign a normal one
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-live', 'squad-target', 'live', 'Live', 'active');
      INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at) VALUES ('${TENANT}', 'seat-live', 'L', 'test', 'seat-live', 'agent-live', datetime('now'), datetime('now'))`)
    const tick = (): ReturnType<typeof runRouterTick> => runRouterTick(e, { ok: true, tenant: TENANT, squadId: 'squad-target', agentId: null, source: 'principal' }, { squadId: 'squad-target' }, { memberId: OWNER })
    const first = await tick()
    expect(first.assigned).toBe(0)
    expect(one<{ a: string | null }>(`SELECT assignee_agent_id AS a FROM tasks WHERE id = ?`, row.id)!.a).toBeNull()
    // canAgentExecuteTask (via runTaskExecution): refused as task_not_found, model never runs
    const model = { chat: vi.fn(async () => 'must not run') }
    const agent = { id: 'agent-live', squad_id: 'squad-target', slug: 'live', name: 'Live', role: null, model: null, status: 'active', created_at: 'now' }
    const ex = await runTaskExecution(e, agent, row.id, { model, emit: async () => {} })
    expect(ex.ok).toBe(false)
    expect(model.chat).not.toHaveBeenCalled()
    // control: an ordinary unmarked task is routed
    h.sqlite.prepare(`INSERT INTO tasks (id, squad_id, title, done_when, status) VALUES ('t-normal', 'squad-target', 'N', 'the work is done', 'open')`).run()
    expect((await tick()).assigned).toBe(1)
    expect(one<{ a: string | null }>(`SELECT assignee_agent_id AS a FROM tasks WHERE id = 't-normal'`)!.a).toBe('agent-live')
  })

  it('no GitHub issue is mirrored from an observed create (GITHUB_REPO + token set); a normal create still mirrors', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const { fetch: f } = mk()
    const e = envFor(h, { BUS: { send: vi.fn(async () => undefined) }, GITHUB_REPO: 'o/r', GITHUB_TOKEN: 'ghp_test' })
    await create(s, e)
    expect(tasks()).toBe(1)
    expect(f).not.toHaveBeenCalled()
    const free = await seatFor(PLAIN, 'conv-gh')
    await create(free, e)
    expect(f.mock.calls.some((c) => new URL(String(c[0])).hostname === 'api.github.com')).toBe(true)
  })

  it('router dry_run never plans would_assign for a marked task (SELECT guard alone)', async () => {
    const { e } = mk()
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-live', 'squad-target', 'live', 'Live', 'active');
      INSERT INTO presence (tenant, member_id, display_name, source, label, agent_id, first_seen_at, last_seen_at) VALUES ('${TENANT}', 'seat-live', 'L', 'test', 'seat-live', 'agent-live', datetime('now'), datetime('now'));
      INSERT INTO tasks (id, squad_id, title, done_when, status, external_source) VALUES ('t-marked', 'squad-target', 'M', 'the work is done', 'open', 'observed-seat:x')`)
    const r = await runRouterTick(e, { ok: true, tenant: TENANT, squadId: 'squad-target', agentId: null, source: 'principal' }, { squadId: 'squad-target', dryRun: true }, { memberId: OWNER })
    expect(r.decisions).toEqual([])
  })

  it('doorbell gate pinned: the observed create never reaches scheduleTaskAssignedDoorbell (no fetch even with a webhook-registered agent)', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const { send, fetch: f, e } = mk()
    await create(s, e)
    expect(f).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('a non-observed seat is unaffected (assignee allowed, task.created emitted), and flag off is a no-op', async () => {
    const free = await seatFor(PLAIN, 'conv-free')
    const { send, e } = mk()
    const r = await create(free, e, { squad_id: 'squad-target' })
    expect(r.text, r.text).toContain('task')
    expect(r.text).not.toContain('observed_floor')
    expect(send).toHaveBeenCalledTimes(1)
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const off = envFor(h, { BUS: { send }, VIP_LANE: undefined })
    send.mockClear()
    const r2 = await create(s, off, { gate_owner: 'gate:hadi' })
    expect(r2.text).not.toContain('observed_floor')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('squad_message (wakes the squad coordinator) is refused for an observed seat; send is message-only and stays', async () => {
    const s = await seatFor(OWNER)
    await join(s, { squad: 'squad-target' })
    const { send, e } = mk()
    expect((await rpc(s.ctx, 'squad_message', { squad_id: 'squad-target', message: 'wake' }, s.session, e)).text).toContain('observed_floor')
    expect(send).not.toHaveBeenCalled()
    expect(OBSERVED_FLOOR_TOOLS.has('squad_message')).toBe(false)
    expect(OBSERVED_FLOOR_TOOLS.has('send')).toBe(true)
  })
})

describe('P1 card caps per HUMAN', () => {
  it('two seats of one human share ONE cap: pending cards across both stop at the limit; a repeat of an existing card still answers', async () => {
    for (let i = 1; i <= 6; i++) seedSquad(`squad-c${i}`)
    const a = await seatFor(PLAIN, 'conv-a')
    const b = await seatFor(PLAIN, 'conv-b')
    expect(a.agentId).not.toBe(b.agentId)
    for (const sq of ['squad-c1', 'squad-c2', 'squad-c3']) expect((await join(a, { squad: sq })).sc.status).toBe('join_requested')
    for (const sq of ['squad-c4', 'squad-c5']) expect((await join(b, { squad: sq })).sc.status).toBe('join_requested')
    const over = await join(b, { squad: 'squad-c6' })
    expect(over.text).toContain('too_many_cards')
    expect(cards()).toBe(5)
    expect((await join(b, { squad: 'squad-c4' })).sc.already_pending).toBe(true)
    expect((await join(a, { squad: 'squad-c6' })).text).toContain('too_many_cards')
    // another human is unaffected
    const other = await seatFor(NOBODY, 'conv-n')
    expect((await join(other, { squad: 'squad-c6' })).sc.status).toBe('join_requested')
  })
})

describe('P1 card with no link is not reported complete', () => {
  it('link failure: honest link_pending (row kept), and the repeat creates the link and does not file a second card', async () => {
    const s = await seatFor(PLAIN)
    h.sqlite.exec(`CREATE TRIGGER block_moment BEFORE INSERT ON secure_moments BEGIN SELECT RAISE(ABORT, 'blocked'); END;`)
    const first = await join(s, { squad: 'squad-target' })
    expect(first.sc.status, first.text).toBe('join_requested')
    expect(first.sc.card).toBe('link_pending')
    expect(String(first.sc.agent_prompt)).toContain('could not be made')
    expect(cards()).toBe(1)
    expect(moments()).toBe(0)
    const still = await join(s, { squad: 'squad-target' })
    expect(still.sc.card).toBe('link_pending')
    expect(still.sc.already_pending).toBe(true)
    expect(cards()).toBe(1)
    h.sqlite.exec(`DROP TRIGGER block_moment`)
    const again = await join(s, { squad: 'squad-target' })
    expect(again.sc.card).toBe('filed')
    expect(cards()).toBe(1)
    expect(moments()).toBe(1)
    expect((await join(s, { squad: 'squad-target' })).sc.already_pending).toBe(true)
    expect(moments()).toBe(1)
  })
})

describe('P2 fail-closed pins', () => {
  it('a project whose only edge is an archived squad is not found (archived squads are not counted)', async () => {
    h.sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'arch', 'Arch', 'active');
      UPDATE squads SET status = 'archived' WHERE id = 'squad-second';
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-a', 'squad-second', 'write');`)
    const s = await seatFor(OWNER)
    expect((await join(s, { project: 'arch' })).text).toContain('project_not_found')
    // an archived edge does not make a second target either
    h.sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-a', 'squad-target', 'write')`)
    expect((await join(s, { project: 'arch' })).sc.status).toBe('joined')
  })

  it('standing is re-derived at the write: grants that were true at check time but are gone now refuse and write nothing', async () => {
    const s = await seatFor(OWNER)
    const stale = [{ member_id: OWNER, scope_type: 'squad' as const, scope_id: 'squad-target', capability: 'admin' as const }]
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${OWNER}' AND scope_id = 'squad-target'`)
    const sq = one<{ id: string; slug: string; name: string; department_id: string; kind: string; status: string }>(`SELECT id, slug, name, department_id, kind, status FROM squads WHERE id = 'squad-target'`)!
    const r = await instantObservedJoin(env, { humanMemberId: OWNER, seatId: s.seatId, seatAgentId: s.agentId, squad: sq, grants: stale })
    expect(r).toEqual({ ok: false, error: 'standing_lost' })
    expect(status(s.seatId)).toBeNull()
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
  })

  it('a held seat is floored (read tools pass, everything else is refused)', async () => {
    const s = await seatFor(OWNER)
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'held' WHERE id = ?`).run(s.seatId)
    expect((await rpc(s.ctx, 'request_elevation', {}, s.session)).text).toContain('observed_floor')
    expect((await rpc(s.ctx, 'status', {}, s.session)).text).not.toContain('observed_floor')
  })

  it('an unknown stored status reads as held; a read error reads as held', async () => {
    const fake = (first: () => unknown): Env => ({ TENANT_SLUG: TENANT, DB: { prepare: () => ({ bind: () => ({ first: async () => first() }) }) } } as unknown as Env)
    expect(await readSeatAdmissionStatus(fake(() => ({ s: 'bogus' })), 'x')).toBe('held')
    expect(await readSeatAdmissionStatus(fake(() => { throw new Error('d1 down') }), 'x')).toBe('held')
    expect(await readSeatAdmissionStatus(fake(() => ({ s: null })), 'x')).toBeNull()
    expect(await readSeatAdmissionStatus(fake(() => null), 'x')).toBeNull()
    const seatCtx = { seatBinding: { seatId: 's', label: '', harnessId: '', grantTokenId: '', humanMemberId: 'm', source: 'handle' } } as unknown as AuthContext
    const down = { ...fake(() => { throw new Error('d1 down') }), VIP_LANE: '1' } as Env
    expect(await observedFloorRefusal(down, seatCtx, 'request_elevation')).toEqual({ status: 'held' })
  })

  it('flag off: the floor never reads the seat row', async () => {
    const boom = { VIP_LANE: undefined, TENANT_SLUG: TENANT, DB: { prepare: () => { throw new Error('must not be read') } } } as unknown as Env
    const seatCtx = { seatBinding: { seatId: 's', label: '', harnessId: '', grantTokenId: '', humanMemberId: 'm', source: 'handle' } } as unknown as AuthContext
    expect(await observedFloorRefusal(boom, seatCtx, 'request_elevation')).toBeNull()
  })

  it('an ATTACHED seat can never instant-join, even for its owner-human: it gets the card, no membership, no status', async () => {
    const s = await seatFor(OWNER)
    const bind = { seatId: s.seatId, label: 'x', harnessId: 'h', grantTokenId: 't', humanMemberId: OWNER, source: 'handle' as const }
    const attached: AuthContext = { ...s.ctx, boundAgentId: s.agentId, seatBinding: { ...bind, attached: { attachmentId: 'att', admissionId: 'adm', agentId: s.agentId, seatAgentId: s.agentId, ceiling: 'member' } } }
    const r = await invokeTool(attached, env, 'join_squad', { squad: 'squad-target' }, 'https://pot.test')
    expect(r.ok && (r.result as { status: string }).status, JSON.stringify(r)).toBe('join_requested')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
    expect(status(s.seatId)).toBeNull()
  })

  it('a home squad is refused by the write itself (squad_not_joinable) and by the tool (no membership)', async () => {
    const s = await seatFor(OWNER)
    cap(OWNER, 'squad', 'squad-home-x', 'admin')
    const sq = one<{ id: string; slug: string; name: string; department_id: string; kind: string; status: string }>(`SELECT id, slug, name, department_id, kind, status FROM squads WHERE id = 'squad-home-x'`)!
    const grants = [{ member_id: OWNER, scope_type: 'squad' as const, scope_id: 'squad-home-x', capability: 'admin' as const }]
    expect(await instantObservedJoin(env, { humanMemberId: OWNER, seatId: s.seatId, seatAgentId: s.agentId, squad: sq, grants })).toEqual({ ok: false, error: 'squad_not_joinable' })
    expect(status(s.seatId)).toBeNull()
    expect((await join(s, { squad: 'squad-home-x' })).text).not.toContain('"joined"')
    expect(membership(s.agentId, 'squad-home-x')).toBeUndefined()
    expect(status(s.seatId)).toBeNull()
  })
})
