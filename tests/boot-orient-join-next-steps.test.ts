// tests/boot-orient-join-next-steps.test.ts — #2035 wall 5: boot_context/orient add next_steps.join (read-only, reuses humanMayInstantJoin).
// Fixtures copied from tests/vip-lane-join.test.ts (real sqlite D1, real OAuth-props auto-seat path).

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
import { joinNextSteps } from '../src/members/vip-lane'
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
  for (const m of [OWNER, PLAIN]) seedHuman(m)
  for (const id of ['squad-core', 'squad-target', 'squad-second', 'squad-secret']) seedSquad(id)
  seedSquad('squad-home-x', 'home')
  for (const m of [OWNER, PLAIN]) cap(m, 'squad', 'squad-core', 'admin')
  cap(OWNER, 'squad', 'squad-target', 'admin')
  cap(OWNER, 'squad', 'squad-second', 'admin')
  cap(PLAIN, 'squad', 'squad-target', 'member')
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

const joinOf = (r: Rpc): { note: string; squads?: Array<{ slug: string; call: string }> } =>
  ((r.sc.next_steps ?? {}) as { join: { note: string; squads?: Array<{ slug: string; call: string }> } }).join

describe('next_steps.join', () => {
  it('flag on: lists the squads the human administers with the exact call; omits non-admin and home squads', async () => {
    const s = await seatFor(OWNER)
    for (const tool of ['boot_context', 'orient'] as const) {
      const j = joinOf(await rpc(s.ctx, tool, {}, s.session))
      const slugs = (j.squads ?? []).map((x) => x.slug)
      expect(slugs, tool).toContain('squad-target')
      expect(slugs).toContain('squad-second')
      expect(slugs).not.toContain('squad-secret')
      expect(slugs).not.toContain('squad-home-x')
      expect((j.squads ?? []).find((x) => x.slug === 'squad-target')?.call).toBe('join_squad {squad:"squad-target"}')
      expect(j.note).toContain('join_squad files a request')
    }
  })
  it('an already-joined squad is omitted', async () => {
    const s = await seatFor(OWNER)
    expect((await join(s, { squad: 'squad-target' })).sc.status).toBe('joined')
    const slugs = (joinOf(await rpc(s.ctx, 'boot_context', {}, s.session)).squads ?? []).map((x) => x.slug)
    expect(slugs).not.toContain('squad-target')
    expect(slugs).toContain('squad-second')
  })
  it('a human with only member standing sees no list and no squad names', async () => {
    const s = await seatFor(PLAIN)
    const r = await rpc(s.ctx, 'boot_context', {}, s.session)
    // squad-core is the seat host squad where every fixture human is admin; nothing else may appear
    expect((joinOf(r).squads ?? []).map((x) => x.slug)).toEqual(['squad-core'])
    expect(r.text).not.toContain('squad-secret')
    expect(r.text).not.toContain('squad-second')
  })
  it('flag off: a single line, no list', async () => {
    const s = await seatFor(OWNER)
    const off = envFor(h, { VIP_LANE: undefined })
    const j = joinOf(await rpc(s.ctx, 'boot_context', {}, s.session, off))
    expect(j.squads).toBeUndefined()
    expect(j.note).toContain('squad_join_request')
  })
  it('an attached or bound (non-seat) caller gets no list', async () => {
    const s = await seatFor(OWNER)
    const bind = { seatId: s.seatId, label: 'x', harnessId: 'h', grantTokenId: 't', humanMemberId: OWNER, source: 'handle' as const }
    const attached: AuthContext = { ...s.ctx, boundAgentId: s.agentId, seatBinding: { ...bind, attached: { attachmentId: 'att', admissionId: 'adm', agentId: s.agentId, seatAgentId: s.agentId, ceiling: 'member' } } }
    const bound: AuthContext = { ...s.ctx, boundAgentId: s.agentId, seatBinding: undefined }
    for (const ctx of [attached, bound]) {
      const r = await invokeTool(ctx, env, 'boot_context', {}, 'https://pot.test')
      const j = (r.ok ? (r.result as { next_steps: { join: { squads?: unknown } } }) : { next_steps: { join: {} } }).next_steps.join
      expect(j.squads).toBeUndefined()
    }
  })
  it('caps the list at 10', async () => {
    for (let i = 0; i < 14; i++) { seedSquad(`squad-x${i}`); cap(OWNER, 'squad', `squad-x${i}`, 'admin') }
    const s = await seatFor(OWNER)
    expect((joinOf(await rpc(s.ctx, 'boot_context', {}, s.session)).squads ?? []).length).toBe(10)
  })
  it('archived squads are absent', async () => {
    h.sqlite.exec(`UPDATE squads SET status = 'archived' WHERE id = 'squad-second'`)
    const s = await seatFor(OWNER)
    const slugs = (joinOf(await rpc(s.ctx, 'boot_context', {}, s.session)).squads ?? []).map((x) => x.slug)
    expect(slugs).toContain('squad-target')
    expect(slugs).not.toContain('squad-second')
  })
  it('the seat host squad is excluded', async () => {
    const s = await seatFor(OWNER)
    const host = one<{ squad_id: string }>(`SELECT squad_id FROM agents WHERE id = ?`, s.agentId)!.squad_id
    const slugs = (joinOf(await rpc(s.ctx, 'boot_context', {}, s.session)).squads ?? []).map((x) => x.slug)
    expect(slugs).not.toContain(h.sqlite.prepare(`SELECT slug FROM squads WHERE id = ?`).get(host)!.slug)
  })
  it('a welded agent member is not an active human: no list', async () => {
    const s = await seatFor(OWNER)
    const other = await seatFor(OWNER, 'conv-b')
    h.sqlite.exec(`INSERT OR REPLACE INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${other.agentId}', '${OWNER}', '2026-10-09T00:00:00.000Z')`)
    const seatBinding = { seatId: s.seatId, label: '', harnessId: '', grantTokenId: '', humanMemberId: OWNER, source: 'handle' } as unknown as AuthContext['seatBinding']
    const j = await joinNextSteps(env, { seatBinding, boundAgentId: s.agentId })
    expect(j.squads).toBeUndefined()
    expect(j.note).toContain('join_squad files a request')
  })
  it('flag off: joinNextSteps makes zero DB queries', async () => {
    const prepare = vi.fn(() => { throw new Error('must not query') })
    const off = { VIP_LANE: undefined, DB: { prepare } } as unknown as Env
    const seatBinding = { seatId: 's', label: '', harnessId: '', grantTokenId: '', humanMemberId: OWNER, source: 'handle' } as unknown as AuthContext['seatBinding']
    expect((await joinNextSteps(off, { seatBinding, boundAgentId: 'a' })).squads).toBeUndefined()
    expect(prepare).not.toHaveBeenCalled()
  })
})
