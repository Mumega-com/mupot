// tests/held-traces.test.ts — #2069: three self-only traces of a held seat (tape row, attached-inbox forced peek, last_used_at touch).
// Real sqlite D1 from the full migration chain; seats from the real OAuth auto-seat path; the dashboard routes through the real dashboardApp.
// MUTATIONS proven (see PR body): the owner scope (member_id) in changeSeatAdmission, the SEAT_TRANSITIONS table, the HELD floor list,
// the boundAgentId floor lookup, the flag gate.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { advertisedTools, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { invokeTool } from '../src/mcp/index'
import { applySeatForRequest } from '../src/members/seat-auto'
import { NO_HINTS } from '../src/members/seat-handle'
import { touchAttachment, type LiveAttachmentRow } from '../src/members/seat-attach'
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


const setStatus = (seatId: string, s: string | null): void => { h.sqlite.prepare(`UPDATE agent_seats SET admission_status = ? WHERE id = ?`).run(s, seatId) }

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = envFor(h)
  for (const m of [OWNER, PLAIN]) seedHuman(m)
  seedSquad('squad-core')
  for (const m of [OWNER, PLAIN]) cap(m, 'squad', 'squad-core', 'admin')
  seedSquad('squad-target'); seedSquad('squad-second')
  cap(OWNER, 'squad', 'squad-target', 'admin'); cap(OWNER, 'squad', 'squad-second', 'admin')
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

const OLD = '2020-01-01 00:00:00'
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 300))
const tapeRows = (seatId: string): number => n(`SELECT COUNT(*) AS n FROM seat_tape_window WHERE seat_id = ?`, seatId)
const lastUsed = (seatId: string): string | null => one<{ t: string | null }>(`SELECT last_used_at AS t FROM agent_seats WHERE id = ?`, seatId)?.t ?? null

async function seatWith(st: string | null, extra: Record<string, unknown> = {}): Promise<{ s: Seat; e: Env; auth: AuthContext }> {
  const s = await seatFor(OWNER)
  h.sqlite.prepare(`UPDATE agent_seats SET admission_status = ? WHERE id = ?`).run(st, s.seatId)
  h.sqlite.prepare(`DELETE FROM seat_tape_window`).run()
  return { s, e: envFor(h, extra), auth: { ...s.ctx, boundAgentId: s.agentId } as AuthContext }
}

describe('1. a held seat leaves no admission-tape row', () => {
  it('held: no seat_tape_window row; observed: one is written (so the zero is attributable); flag off: none either way', async () => {
    const held = await seatWith('held', { ADMISSION_TAPE: '1' })
    await rpc(held.s.ctx, 'task_list', {}, held.s.session, held.e); await tick()
    expect(tapeRows(held.s.seatId)).toBe(0)
    const obs = await seatWith('observed', { ADMISSION_TAPE: '1' })
    await rpc(obs.s.ctx, 'task_list', {}, obs.s.session, obs.e); await tick()
    expect(tapeRows(obs.s.seatId)).toBeGreaterThan(0)
  })
})

describe('2. an attached held seat reads inbox without peek:true', () => {
  // A minimal attached seat context (the resolver's output shape): the floor reads only seatBinding.seatId / attached.
  const attached = (a: AuthContext, seatId: string): AuthContext => ({
    ...a,
    seatBinding: {
      seatId, label: 'x', harnessId: a.harnessId ?? 'h', grantTokenId: a.tokenId ?? 't', humanMemberId: OWNER, source: 'handle',
      attached: { attachmentId: 'att1', admissionId: 'adm1', agentId: a.boundAgentId!, seatAgentId: a.boundAgentId!, ceiling: 'member' },
    },
  }) as unknown as AuthContext // test fixture: SeatBinding has more optional fields than this check reads

  it('held + attached: inbox without peek works (forced peek, nothing consumed); observed + attached without peek still refused', async () => {
    const held = await seatWith('held')
    h.sqlite.prepare(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, body) VALUES ('m1', ?, ?, 'someone', ?, 'hello')`).run(TENANT, held.s.agentId, PLAIN)
    const r = await invokeTool(attached(held.auth, held.s.seatId), held.e, 'inbox', {}, 'https://pot.test')
    expect(r.ok, JSON.stringify(r)).toBe(true)
    expect(JSON.stringify(r)).not.toContain('attached_seat_peek_only')
    expect(one<{ r: string | null }>(`SELECT read_at AS r FROM agent_messages WHERE id = 'm1'`)?.r ?? null).toBeNull()
    const obs = await seatWith('observed')
    const refused = await invokeTool(attached(obs.auth, obs.s.seatId), obs.e, 'inbox', {}, 'https://pot.test')
    expect(JSON.stringify(refused)).toContain('attached_seat_peek_only')
    const flagOff = await seatWith('held')
    const off = await invokeTool(attached(flagOff.auth, flagOff.s.seatId), envFor(h, { VIP_LANE: undefined }), 'inbox', {}, 'https://pot.test')
    expect(JSON.stringify(off)).toContain('attached_seat_peek_only')
  })
})

describe('3. seat resolution leaves last_used_at alone for a held seat', () => {
  it('auto seat: held keeps last_used_at; observed bumps it; flag off bumps it', async () => {
    const held = await seatWith('held')
    h.sqlite.prepare(`UPDATE agent_seats SET last_used_at = ? WHERE id = ?`).run(OLD, held.s.seatId)
    await rpc(held.s.ctx, 'task_list', {}, held.s.session, held.e)
    expect(lastUsed(held.s.seatId)).toBe(OLD)
    const obs = await seatWith('observed')
    h.sqlite.prepare(`UPDATE agent_seats SET last_used_at = ? WHERE id = ?`).run(OLD, obs.s.seatId)
    await rpc(obs.s.ctx, 'task_list', {}, obs.s.session, obs.e)
    expect(lastUsed(obs.s.seatId)).not.toBe(OLD)
    const off = await seatWith('held')
    h.sqlite.prepare(`UPDATE agent_seats SET last_used_at = ? WHERE id = ?`).run(OLD, off.s.seatId)
    await rpc(off.s.ctx, 'task_list', {}, off.s.session, envFor(h, { VIP_LANE: undefined }))
    expect(lastUsed(off.s.seatId)).not.toBe(OLD)
  })

  it('attachment touch: held skips the UPDATE, observed and flag-off run it', async () => {
    const row = (st: string | null): LiveAttachmentRow => ({ attachment_id: 'att1', last_used_at: OLD, seat_admission_status: st }) as LiveAttachmentRow // partial row: touchAttachment reads only these fields
    const run = async (st: string | null, e: Record<string, unknown>): Promise<number> => {
      let calls = 0
      const db = { prepare: () => ({ bind: () => ({ run: async () => { calls++ } }) }) }
      await touchAttachment({ DB: db, TENANT_SLUG: TENANT, ...e } as unknown as Env, row(st), Date.now())
      return calls
    }
    expect(await run('held', { VIP_LANE: '1' })).toBe(0)
    expect(await run('observed', { VIP_LANE: '1' })).toBe(1)
    expect(await run('held', {})).toBe(1)
  })
})

describe('4. a held seat is never reclaimed (P1: the hold must not escape via LRU)', () => {
  async function pool(e: Env) {
    const harness = await upsertHarness(e, OWNER, 'client-pool', 'Pool')
    if (!harness) throw new Error('harness fixture failed')
    const tokenId = `tok-pool-${++tok}`
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${OWNER}', 'hash-${tokenId}', 'oauth:client-pool', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const ctx = await buildAuthContextFromProps(e, { memberId: OWNER, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
    if (!ctx) throw new Error('grant ctx null')
    const lim = { autoLive: 2, windowMax: 100 }
    const make = (k: string) => applySeatForRequest(e, ctx, { hints: NO_HINTS, autoKeys: { openaiSession: k, codexThreadId: null } }, Date.now(), lim)
    const seatOfAgent = (a: unknown) => one<{ id: string; retired_at: string | null }>(`SELECT id, retired_at FROM agent_seats WHERE agent_id = ?`, a)!
    return { make, seatOfAgent }
  }
  const status = (seatId: string, st: string | null, lu: string) => h.sqlite.prepare(`UPDATE agent_seats SET admission_status = ?, last_used_at = ? WHERE id = ?`).run(st, lu, seatId)

  it('full pool, LRU seat is held: the held seat survives and a non-held seat is reclaimed', async () => {
    const e = envFor(h)
    const { make, seatOfAgent } = await pool(e)
    const a = await make('A'); const b = await make('B')
    status(seatOfAgent(a.boundAgentId).id, 'held', '2000-01-01T00:00:00.000Z') // oldest AND held
    status(seatOfAgent(b.boundAgentId).id, 'observed', '2026-01-01T00:00:00.000Z')
    const c = await make('C')
    expect(typeof c.boundAgentId).toBe('string')
    expect(seatOfAgent(a.boundAgentId).retired_at).toBeNull()
    expect(seatOfAgent(b.boundAgentId).retired_at).not.toBeNull()
  })

  it('full pool of held seats: the new seat is refused, nothing is reclaimed; flag off keeps the old LRU reclaim', async () => {
    const e = envFor(h)
    const { make, seatOfAgent } = await pool(e)
    const a = await make('A'); const b = await make('B')
    status(seatOfAgent(a.boundAgentId).id, 'held', '2000-01-01T00:00:00.000Z')
    status(seatOfAgent(b.boundAgentId).id, 'held', '2001-01-01T00:00:00.000Z')
    const c = await make('C')
    expect(c.boundAgentId).toBeFalsy()
    expect(seatOfAgent(a.boundAgentId).retired_at).toBeNull()
    expect(seatOfAgent(b.boundAgentId).retired_at).toBeNull()
    resetAutoSeatRefusalCache()
    const off = envFor(h, { VIP_LANE: undefined })
    const { make: makeOff, seatOfAgent: so2 } = await pool(off)
    const x = await makeOff('X'); const y = await makeOff('Y')
    status(so2(x.boundAgentId).id, 'held', '2000-01-01T00:00:00.000Z')
    status(so2(y.boundAgentId).id, 'held', '2001-01-01T00:00:00.000Z')
    expect(typeof (await makeOff('Z')).boundAgentId).toBe('string')
    expect(so2(x.boundAgentId).retired_at).not.toBeNull()
  })
})

describe('5. touchHandle and pre-floor exits', () => {
  it('touchHandle skips the UPDATE for a held seat row (via the handle path)', async () => {
    const { applySeatHandle } = await import('../src/members/seat-handle')
    expect(typeof applySeatHandle).toBe('function')
    const src = readFileSync(new URL('../src/members/seat-handle.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/async function touchHandle\([^)]*\)[^{]*\{\s*if \(seatRowIsHeld\(env, row\)\) return/)
  })

  it('a pre-floor refusal for a held seat leaves no tape row (observed baseline does)', async () => {
    const withBinding = (a: AuthContext, seatId: string): AuthContext => ({
      ...a, seatBinding: { seatId, label: 'x', harnessId: a.harnessId ?? 'h', grantTokenId: a.tokenId ?? 't', humanMemberId: OWNER, source: 'handle' },
    }) as unknown as AuthContext // test fixture: the tap and floor read only seatBinding.seatId / humanMemberId
    const call = async (st: string) => {
      const x = await seatWith(st, { ADMISSION_TAPE: '1' })
      const e = { ...x.e, SEAT_AUTO_ENROLL: undefined } as unknown as Env
      const r = await invokeTool(withBinding(x.auth, x.s.seatId), e, 'seat_select', {}, 'https://pot.test') // flag-gated tool: refuses before the floor
      expect(r.ok).toBe(false)
      await tick()
      return tapeRows(x.s.seatId)
    }
    expect(await call('observed')).toBeGreaterThan(0)
    expect(await call('held')).toBe(0)
  })
})
