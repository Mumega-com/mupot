// tests/vip-lane-join.test.ts — join_squad (#2035 wall 1, slice 1): an owner/org-admin's own seat joins instantly as OBSERVED; anyone
// else files ONE card. Real sqlite D1 from the full migration chain; the seat comes from the real OAuth-props -> mcpApp auto-seat path
// (exactly as tests/squad-join-request.test.ts), so the observed floor is proven through the real tool chokepoint.
//
// MUTATIONS proven (see PR body): humanMayInstantJoin (return true), the active-human check, the held guard, the NULL-only status
// stamp, the existing-membership idempotence guard, the floor list (OBSERVED_FLOOR_TOOLS), the flag gate, the pending-first dedupe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { advertisedTools, invokeTool, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { OBSERVED_FLOOR_TOOLS, OBSERVED_TIER_RANK } from '../src/members/vip-lane'
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
    expect(n(`SELECT COUNT(*) AS n FROM gate_grants`)).toBe(0)
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
      ['seat_attach', { agent: 'x' }],
      ['mint_agent_token', {}],
    ] as const
    for (const [tool, args] of refused) {
      const r = await rpc(s.ctx, tool, { ...args }, s.session)
      expect(r.text, tool).toContain('observed_floor')
    }
    for (const tool of ['status', 'task_list', 'recall']) {
      expect((await rpc(s.ctx, tool, tool === 'recall' ? { query: 'x' } : {}, s.session)).text, tool).not.toContain('observed_floor')
    }
    // nothing was granted by any of those
    expect(membership(s.agentId, 'squad-target')).toEqual({ capability: 'member' })
    expect(n(`SELECT COUNT(*) AS n FROM gate_grants`)).toBe(0)
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
    expect(r.text).toContain('seat_held')
    expect(status(s.seatId)).toBe('held')
    expect(membership(s.agentId, 'squad-target')).toBeUndefined()
  })

  it('a trusted seat keeps trusted (the stamp is NULL-only)', async () => {
    const s = await seatFor(OWNER)
    h.sqlite.prepare(`UPDATE agent_seats SET admission_status = 'trusted' WHERE id = ?`).run(s.seatId)
    expect((await join(s, { squad: 'squad-target' })).sc.admission_status).toBe('trusted')
    expect(status(s.seatId)).toBe('trusted')
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
