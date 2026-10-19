// tests/held-no-writes.test.ts — #2064 follow-up: a HELD seat leaves no trace (inbox peek, no presence, no boot self-report).
// Real sqlite D1 from the full migration chain; seats from the real OAuth auto-seat path; the dashboard routes through the real dashboardApp.
// MUTATIONS proven (see PR body): the owner scope (member_id) in changeSeatAdmission, the SEAT_TRANSITIONS table, the HELD floor list,
// the boundAgentId floor lookup, the flag gate.

import { readdirSync, readFileSync } from 'node:fs'
import { join as pjoin } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { advertisedTools, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
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
const OLD_ISO = '2020-01-01T00:00:00.000Z'

/** A seat session whose agent receives mail, with its fleet/presence rows reset to a known old state. */
async function fixture(st: string | null): Promise<{ s: Seat; auth: AuthContext; e: Env }> {
  const s = await seatFor(OWNER)
  setStatus(s.seatId, st)
  const auth = { ...s.ctx, boundAgentId: s.agentId } as AuthContext
  h.sqlite.prepare(`INSERT OR REPLACE INTO fleet_agents (agent_id, tenant, presence_mode, status, last_reported_at, updated_at) VALUES (?, ?, 'poll', 'running', ?, ?)`).run(s.agentId, TENANT, OLD, OLD)
  h.sqlite.prepare(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, body) VALUES ('m1', ?, ?, 'someone', ?, 'hello')`).run(TENANT, s.agentId, PLAIN)
  h.sqlite.prepare(`DELETE FROM presence`).run()
  // A FRESH env (fresh KV): the seat's own boot_context already set the presence debounce key, which would make 'no presence write' vacuous.
  return { s, auth, e: envFor(h) }
}
const readAt = (): string | null => one<{ r: string | null }>(`SELECT read_at AS r FROM agent_messages WHERE id = 'm1'`)?.r ?? null
const fleetSeen = (agentId: string): string | undefined => one<{ t: string }>(`SELECT last_reported_at AS t FROM fleet_agents WHERE agent_id = ?`, agentId)?.t
const presenceRows = (): number => n(`SELECT COUNT(*) AS n FROM presence`)
const fleetRows = (agentId: string): number => n(`SELECT COUNT(*) AS n FROM fleet_agents WHERE agent_id = ?`, agentId)

describe('held seats leave no trace (#2064)', () => {
  it('held inbox never consumes: read_at stays NULL, consumed:false, even when the caller asks for consume', async () => {
    const { s, auth, e } = await fixture('held')
    const r = await rpc(auth, 'inbox', {}, s.session, e)
    expect(r.text).toContain('hello')
    expect(r.text).not.toContain('observed_floor')
    expect(r.sc.consumed).toBe(false)
    expect(readAt()).toBeNull()
    expect((await rpc(auth, 'inbox', { peek: false }, s.session, e)).sc.consumed).toBe(false)
    expect(readAt()).toBeNull()
  })

  it('held inbox does not refresh poll presence; held task_list does not either', async () => {
    const { s, auth, e } = await fixture('held')
    await rpc(auth, 'inbox', {}, s.session, e)
    await rpc(auth, 'task_list', {}, s.session, e)
    expect(fleetSeen(s.agentId)).toBe(OLD)
  })

  it('a held read bumps no presence row', async () => {
    const { s, auth, e } = await fixture('held')
    for (const t of ['task_list', 'inbox', 'whoami', 'status']) await rpc(auth, t, {}, s.session, e)
    expect(presenceRows()).toBe(0)
  })

  it('held boot_context writes no fleet_agents row and no presence, and does not claim runtime/model', async () => {
    const { s, auth, e } = await fixture('held')
    h.sqlite.prepare(`DELETE FROM fleet_agents WHERE agent_id = ?`).run(s.agentId)
    const r = await rpc(auth, 'boot_context', { runtime: 'codex', model: 'm-claimed' }, s.session, e)
    expect(r.text).not.toContain('observed_floor')
    expect(fleetRows(s.agentId)).toBe(0)
    expect(presenceRows()).toBe(0)
  })

  it('observed is unchanged: inbox consumes, poll presence and presence refresh, boot_context self-reports', async () => {
    const { s, auth, e } = await fixture('observed')
    const r = await rpc(auth, 'inbox', {}, s.session, e)
    expect(r.sc.consumed).toBe(true)
    expect(readAt()).not.toBeNull()
    expect(fleetSeen(s.agentId)).not.toBe(OLD)
    expect(presenceRows()).toBeGreaterThan(0)
    h.sqlite.prepare(`DELETE FROM fleet_agents WHERE agent_id = ?`).run(s.agentId)
    await rpc(auth, 'boot_context', { runtime: 'codex' }, s.session, e)
    expect(fleetRows(s.agentId)).toBe(1)
  })

  it('flag off is unchanged: a status-held row is not read, so inbox consumes and presence is written', async () => {
    const { s, auth, e } = await fixture('held')
    const off = envFor(h, { VIP_LANE: undefined })
    const r = await rpc(auth, 'inbox', {}, s.session, off)
    expect(r.sc.consumed).toBe(true)
    expect(readAt()).not.toBeNull()
    expect(fleetSeen(s.agentId)).not.toBe(OLD)
  })
})
