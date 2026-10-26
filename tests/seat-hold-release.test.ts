// tests/seat-hold-release.test.ts — #2060: HUMAN hold / release / return of observed seats + the seatBinding-less floor.
// Real sqlite D1 from the full migration chain; seats from the real OAuth auto-seat path; the dashboard routes through the real dashboardApp.
// MUTATIONS proven (see PR body): the owner scope (member_id) in changeSeatAdmission, the SEAT_TRANSITIONS table, the HELD floor list,
// the boundAgentId floor lookup, the flag gate.

import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
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
import { HELD_FLOOR_TOOLS, OBSERVED_FLOOR_TOOLS, instantObservedJoin, observedFloorRefusal } from '../src/members/vip-lane'
import { changeSeatAdmission } from '../src/members/seat-hold-release'
import type { AuthContext, Env } from '../src/types'
import { seedPasskey, throughGate } from './helpers/presence'

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


const status = (seatId: string): string | null => one<{ s: string | null }>(`SELECT admission_status AS s FROM agent_seats WHERE id = ?`, seatId)?.s ?? null
const setStatus = (seatId: string, s: string | null): void => { h.sqlite.prepare(`UPDATE agent_seats SET admission_status = ? WHERE id = ?`).run(s, seatId) }
const audit = (seatId: string): Array<{ member_id: string; action: string; from_status: string; to_status: string; at: string }> =>
  h.sqlite.prepare(`SELECT member_id, action, from_status, to_status, at FROM seat_admission_changes WHERE seat_id = ? ORDER BY rowid`).all(seatId) as never

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

async function session(e: Env, email: string): Promise<string> {
  const { authApp } = await import('../src/auth')
  const res = await authApp.request('/dev-login', {}, { ...e, LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email } as unknown as Env)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  const member = h.sqlite.prepare('SELECT id FROM members WHERE email = ?').get(email) as { id: string } | undefined
  if (member) seedPasskey(h.sqlite, TENANT, member.id) // widening transitions need the member's passkey; this suite tests the OTHER behaviour (tests/human-presence.test.ts has the real ceremony)
  return `mupot_session=${m[1]}`
}
async function dash(e: Env, cookie: string, path: string, origin: string | null = 'http://localhost', gated = true): Promise<Response> {
  const { dashboardApp } = await import('../src/dashboard/index')
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' }
  if (origin) headers.origin = origin
  const call = (qs: string): Promise<Response> => Promise.resolve(dashboardApp.request(`${path}${qs ? `?${qs}` : ''}`, { method: 'POST', headers, body: '{}' }, { ...e, LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'x' } as unknown as Env))
  return gated ? throughGate(h.sqlite, TENANT, call) : call('') // gated=false: the session alone, no passkey
}
const fresh = (): void => { h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run(new Date().toISOString()) }
const stale = (): void => { h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ?').run(new Date(Date.now() - (RECENT_REAUTH_WINDOW_MS + 60 * 1000)).toISOString()) }
const post = (cookie: string, seatId: string, action: string, e: Env = env): Promise<Response> => dash(e, cookie, `/connections/seats/${seatId}/${action}`)
/** The session alone (no passkey): what a program driving the browser has. */
const postSessionOnly = (cookie: string, seatId: string, action: string): Promise<Response> => dash(env, cookie, `/connections/seats/${seatId}/${action}`, 'http://localhost', false)

describe('transitions by the owner', () => {
  it('hold, return and release each move the status and write one audit row (who, from, to, at)', async () => {
    const s = await seatFor(OWNER)
    const cookie = await session(env, `${OWNER}@example.test`)
    setStatus(s.seatId, 'observed')
    stale() // hold needs only a real session
    expect((await post(cookie, s.seatId, 'hold')).status).toBe(200)
    expect(status(s.seatId)).toBe('held')
    fresh()
    expect((await post(cookie, s.seatId, 'return')).status).toBe(200)
    expect(status(s.seatId)).toBe('observed')
    await post(cookie, s.seatId, 'hold')
    expect((await post(cookie, s.seatId, 'release')).status).toBe(200) // held -> trusted
    expect(status(s.seatId)).toBe('trusted')
    expect(audit(s.seatId).map((a) => `${a.action}:${a.from_status}>${a.to_status}`)).toEqual(['hold:observed>held', 'return:held>observed', 'hold:observed>held', 'release:held>trusted'])
    expect(audit(s.seatId).every((a) => a.member_id === OWNER && a.at.length > 10)).toBe(true)
    setStatus(s.seatId, 'observed')
    expect((await post(cookie, s.seatId, 'release')).status).toBe(200) // observed -> trusted
    expect(status(s.seatId)).toBe('trusted')
  })

  it('the allowed set is exact: no hold of held/trusted/NULL, no return of observed, no release of trusted/NULL; no audit row on refusal', async () => {
    const s = await seatFor(OWNER)
    const cookie = await session(env, `${OWNER}@example.test`)
    fresh()
    const cases: Array<[string | null, string, boolean]> = [
      [null, 'hold', false], [null, 'release', false], [null, 'return', false],
      ['observed', 'hold', true], ['observed', 'return', false], ['observed', 'release', true],
      ['held', 'hold', false], ['held', 'return', true], ['held', 'release', true],
      ['trusted', 'hold', true], ['trusted', 'return', true], ['trusted', 'release', false],
    ]
    for (const [from, action, ok] of cases) {
      setStatus(s.seatId, from)
      const before = audit(s.seatId).length
      const res = await post(cookie, s.seatId, action)
      expect(res.status === 200, `${from} ${action}`).toBe(ok)
      expect(audit(s.seatId).length - before, `${from} ${action} audit`).toBe(ok ? 1 : 0)
      if (!ok) expect(status(s.seatId)).toBe(from)
    }
  })

  it('trusted is not a one-way door: hold and return from trusted work on a STALE session (they reduce reach); held -> observed needs the passkey', async () => {
    const s = await seatFor(OWNER)
    const cookie = await session(env, `${OWNER}@example.test`)
    stale()
    setStatus(s.seatId, 'trusted')
    expect((await post(cookie, s.seatId, 'hold')).status).toBe(200)
    expect(status(s.seatId)).toBe('held')
    setStatus(s.seatId, 'trusted')
    expect((await post(cookie, s.seatId, 'return')).status).toBe(200)
    expect(status(s.seatId)).toBe('observed')
    setStatus(s.seatId, 'held')
    expect((await postSessionOnly(cookie, s.seatId, 'return')).status).toBe(403)
    expect(status(s.seatId)).toBe('held')
    // the writer enforces freshness itself, not only the route
    expect(await changeSeatAdmission(env, { humanMemberId: OWNER, seatId: s.seatId, action: 'release', fresh: false })).toEqual({ ok: false, error: 'reauth_required' })
    setStatus(s.seatId, 'trusted')
    const { dashboardApp } = await import('../src/dashboard/index')
    const html = await (await dashboardApp.request('/connections', { headers: { cookie } }, { ...env, LOCAL_TEST_AUTH: '1' } as unknown as Env)).text()
    expect(html).toContain(`data-cx-hold="${s.seatId}"`)
    expect(html).toContain(`data-cx-return="${s.seatId}"`)
    expect(html).not.toContain(`data-cx-release="${s.seatId}"`)
  })

  it('a retired seat cannot be changed (kills the retired_at guard)', async () => {
    const s = await seatFor(OWNER)
    setStatus(s.seatId, 'observed')
    h.sqlite.prepare(`UPDATE agent_seats SET retired_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`).run(s.seatId)
    expect(await changeSeatAdmission(env, { humanMemberId: OWNER, seatId: s.seatId, action: 'release', fresh: true })).toEqual({ ok: false, error: 'seat_not_found' })
    expect(status(s.seatId)).toBe('observed')
  })

  it('release and return need the passkey, not a session (fresh or stale); hold does not; a cross-origin POST is refused', async () => {
    const s = await seatFor(OWNER)
    const cookie = await session(env, `${OWNER}@example.test`)
    stale()
    setStatus(s.seatId, 'held')
    expect((await postSessionOnly(cookie, s.seatId, 'release')).status).toBe(403)
    expect((await postSessionOnly(cookie, s.seatId, 'return')).status).toBe(403)
    expect(status(s.seatId)).toBe('held')
    fresh()
    expect((await postSessionOnly(cookie, s.seatId, 'release')).status).toBe(403) // a fresh sign-in is not the passkey either
    expect(status(s.seatId)).toBe('held')
    expect((await dash(env, cookie, `/connections/seats/${s.seatId}/return`, 'http://evil.test')).status).toBe(403)
    expect(status(s.seatId)).toBe('held')
  })
})

describe('only the seat\'s own human', () => {
  it('another human cannot hold, release or return it (404, status and audit untouched); GET lists only own seats', async () => {
    const s = await seatFor(OWNER)
    const other = await session(env, `${PLAIN}@example.test`)
    fresh()
    for (const [from, action] of [['observed', 'hold'], ['observed', 'release'], ['held', 'return'], ['held', 'release']] as const) {
      setStatus(s.seatId, from)
      expect((await post(other, s.seatId, action)).status, action).toBe(404)
      expect(status(s.seatId)).toBe(from)
    }
    expect(audit(s.seatId)).toEqual([])
    const { dashboardApp } = await import('../src/dashboard/index')
    const listFor = async (cookie: string): Promise<string> => (await dashboardApp.request('/connections', { headers: { cookie } }, { ...env, LOCAL_TEST_AUTH: '1' } as unknown as Env)).text()
    setStatus(s.seatId, 'observed')
    expect(await listFor(other)).not.toContain(`data-cx-hold="${s.seatId}"`)
    const mine = await listFor(await session(env, `${OWNER}@example.test`))
    expect(mine).toContain('Observed chats')
    expect(mine).toContain(`data-cx-hold="${s.seatId}"`)
  })

  it('an agent / MCP caller cannot reach it: no tool, no web session', async () => {
    const s = await seatFor(OWNER)
    setStatus(s.seatId, 'observed')
    for (const t of advertisedTools(env)) expect(t.name).not.toMatch(/admission_status|seat_(hold|release|status|trust)|^(hold|release)_/i)
    // an MCP session of the seat's own human has no dashboard web session: the route refuses it
    const { dashboardApp } = await import('../src/dashboard/index')
    const res = await dashboardApp.request(`/connections/seats/${s.seatId}/release`, { method: 'POST', headers: { origin: 'http://localhost', authorization: 'Bearer not-a-web-session' }, body: '{}' }, env)
    expect(res.status).not.toBe(200)
    expect(status(s.seatId)).toBe('observed')
    expect(audit(s.seatId)).toEqual([])
  })

  it('the audit table is append-only', async () => {
    const s = await seatFor(OWNER)
    setStatus(s.seatId, 'observed')
    const cookie = await session(env, `${OWNER}@example.test`)
    await post(cookie, s.seatId, 'hold')
    expect(() => h.sqlite.prepare(`UPDATE seat_admission_changes SET to_status = 'trusted'`).run()).toThrow()
    expect(() => h.sqlite.prepare(`DELETE FROM seat_admission_changes`).run()).toThrow()
  })
})

describe('single writer', () => {
  it('only the dashboard route imports the transition writer, and nothing outside it (and the NULL stamp) writes admission_status', () => {
    const files: string[] = []
    const walk = (d: string): void => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = pjoin(d, e.name); if (e.isDirectory()) walk(f); else if (f.endsWith('.ts')) files.push(f) } }
    walk(pjoin(__dirname, '..', 'src'))
    const importers = files.filter((f) => /seat-hold-release/.test(readFileSync(f, 'utf8')) && !f.endsWith('seat-hold-release.ts')).map((f) => f.replace(/.*\/src\//, ''))
    expect(importers.sort()).toEqual(['dashboard/connections.ts', 'members/vip-lane.ts']) // vip-lane only for the trusted -> observed rejoin reset
    const writers = files.filter((f) => /(\bSET\b[^`;]*\badmission_status\s*=|\bINSERT\b[^`;]*\bagent_seats\b[^`;]*\badmission_status)/is.test(readFileSync(f, 'utf8'))).map((f) => f.replace(/.*\/src\//, '')).sort()
    expect(writers).toEqual(['members/seat-hold-release.ts', 'members/vip-lane.ts'])
  })
})

describe('trust does not carry across squads (P1-b)', () => {
  it('a trusted seat joining ANOTHER squad is reset to observed with an audit row; re-joining a squad it is already in keeps trusted', async () => {
    const s = await seatFor(OWNER)
    const join = (squad: string) => rpc(s.ctx, 'join_squad', { squad }, s.session)
    setStatus(s.seatId, null)
    expect((await join('squad-target')).text).not.toContain('error')
    expect(status(s.seatId)).toBe('observed')
    setStatus(s.seatId, 'trusted')
    await join('squad-target') // already a member: no reset
    expect(status(s.seatId)).toBe('trusted')
    expect(audit(s.seatId)).toEqual([])
    await join('squad-second') // a new squad: back to observed
    expect(status(s.seatId)).toBe('observed')
    expect(audit(s.seatId).map((a) => `${a.action}:${a.from_status}>${a.to_status}`)).toEqual(['rejoin_reset:trusted>observed'])
    expect(audit(s.seatId)[0].member_id).toBe(OWNER)
  })
})

describe('rejoin ordering, liveness, and held-over-attach (CI + Codex fixes)', () => {
  it('a failed join leaves a trusted seat trusted (reset only after the eligibility re-check and the write succeed)', async () => {
    const s = await seatFor(OWNER)
    seedSquad('squad-nobody')
    setStatus(s.seatId, 'trusted')
    const squad = one<{ id: string; slug: string; name: string; department_id: string; kind: string; status: string }>(`SELECT id, slug, name, department_id, kind, status FROM squads WHERE id = 'squad-nobody'`)!
    const r = await instantObservedJoin(env, { humanMemberId: OWNER, seatId: s.seatId, seatAgentId: s.agentId, squad, grants: [] as never })
    expect(r).toEqual({ ok: false, error: 'standing_lost' })
    expect(status(s.seatId)).toBe('trusted')
    expect(audit(s.seatId)).toEqual([])
  })

  it('failure injection: a reset that fails never leaves trusted + a new membership; an add that fails after the reset leaves observed', async () => {
    const s = await seatFor(OWNER)
    setStatus(s.seatId, 'trusted')
    const squad = one<{ id: string; slug: string; name: string; department_id: string; kind: string; status: string }>(`SELECT id, slug, name, department_id, kind, status FROM squads WHERE id = 'squad-second'`)!
    const grants = await (await import('../src/auth/capability')).resolveCapabilities(env, OWNER)
    const args = { humanMemberId: OWNER, seatId: s.seatId, seatAgentId: s.agentId, squad, grants }
    const mems = (): number => n(`SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ? AND squad_id = 'squad-second'`, s.agentId)
    // reset batch fails: the add is never attempted
    h.sqlite.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON seat_admission_changes BEGIN SELECT RAISE(ABORT, 'injected'); END`)
    expect(await instantObservedJoin(env, args)).toEqual({ ok: false, error: 'write_refused' })
    expect(status(s.seatId)).toBe('trusted')
    expect(mems()).toBe(0)
    h.sqlite.exec('DROP TRIGGER fail_audit')
    // reset succeeds, membership add fails: observed (restrictive), no membership
    h.sqlite.exec(`CREATE TRIGGER fail_mem BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'injected'); END`)
    await instantObservedJoin(env, args).catch(() => undefined)
    expect(status(s.seatId)).toBe('observed')
    expect(mems()).toBe(0)
    h.sqlite.exec('DROP TRIGGER fail_mem')
  })

  it('an EXPIRED membership counts as absent: a trusted seat re-joining that squad is reset; a live one is not', async () => {
    const s = await seatFor(OWNER)
    h.sqlite.prepare(`INSERT INTO memberships (id, agent_id, squad_id, capability, expires_at) VALUES ('m-exp', ?, 'squad-second', 'member', '2026-01-02 00:00:00')`).run(s.agentId)
    setStatus(s.seatId, 'trusted')
    expect((await rpc(s.ctx, 'join_squad', { squad: 'squad-second' }, s.session)).sc.admission_status).toBe('observed')
    expect(audit(s.seatId).map((a) => a.action)).toEqual(['rejoin_reset'])
  })

  it('HELD overrides attach: an attached seat on hold is read-only; observed+attached stays lifted', async () => {
    const s = await seatFor(OWNER)
    const attached = { ...s.ctx, seatBinding: { seatId: s.seatId, label: 'x', harnessId: 'h', grantTokenId: 't', humanMemberId: OWNER, source: 'handle', attached: { attachmentId: 'a', admissionId: 'ad', agentId: 'other', seatAgentId: s.agentId, ceiling: 'member' } } } as AuthContext
    setStatus(s.seatId, 'observed')
    expect(await observedFloorRefusal(env, attached, 'request_elevation')).toBeNull()
    setStatus(s.seatId, 'held')
    expect(await observedFloorRefusal(env, attached, 'task_create')).toEqual({ status: 'held' })
    expect(await observedFloorRefusal(env, attached, 'task_list')).toBeNull()
    setStatus(s.seatId, 'trusted')
    expect(await observedFloorRefusal(env, attached, 'task_create')).toBeNull()
  })
})

describe('MCP bearer: seat status rides the token query (no fail-open read)', () => {
  async function bearerFor(agentId: string, raw: string): Promise<string> {
    const { hashMemberToken } = await import('../src/auth/member-bearer')
    const bound = one<{ member_id: string }>(`SELECT member_id FROM agent_member_bindings WHERE agent_id = ?`, agentId)
    if (!bound) throw new Error('no binding')
    h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id) VALUES (?, ?, ?, 'x', 'workspace', '2026-10-09T00:00:00.000Z', ?, ?)`).run(`tok-${raw}`, bound.member_id, await hashMemberToken(raw), TENANT, agentId)
    return raw
  }
  const authOf = async (e: Env, raw: string): Promise<AuthContext> => {
    const { authenticateMember } = await import('../src/mcp/index')
    const a = await authenticateMember({ req: { header: (k: string) => (k.toLowerCase() === 'authorization' ? `Bearer ${raw}` : undefined) }, env: e })
    if (!a) throw new Error('auth null')
    return a
  }
  const dbThatThrowsOnSeats = (e: Env): Env => ({ ...e, DB: new Proxy(e.DB, { get: (t, k) => (k === 'prepare' ? (sql: string) => { if (/agent_seats/.test(sql)) throw new Error('seat read down'); return t.prepare(sql) } : Reflect.get(t, k).bind(t)) }) }) as unknown as Env

  it('an observed/held seat agent on a bound-agent token is floored with every later agent_seats read failing; trusted and non-seat agents are not', async () => {
    const s = await seatFor(OWNER)
    const raw = await bearerFor(s.agentId, 'mcp-bound-1')
    for (const [st, tool, want] of [['observed', 'request_elevation', 'observed'], ['held', 'task_create', 'held'], ['trusted', 'request_elevation', null], [null, 'request_elevation', null]] as const) {
      setStatus(s.seatId, st)
      const a = await authOf(env, raw)
      expect(a.seatAgentStatus, String(st)).toBe(st)
      const r = await observedFloorRefusal(dbThatThrowsOnSeats(env), a, tool)
      expect(r?.status ?? null, String(st)).toBe(want)
    }
    // a non-seat bound agent: no seat row, never floored
    seedHuman('member-plainagent')
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-plain-x', 'squad-core', 'plain-x', 'Plain X', 'r', 'm', 'active')`)
    h.sqlite.prepare(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, 'agent-plain-x', 'member-plainagent', '2026-10-09T00:00:00.000Z')`).run(TENANT)
    const raw2 = await bearerFor('agent-plain-x', 'mcp-bound-2')
    setStatus(s.seatId, 'observed')
    const a2 = await authOf(env, raw2)
    expect(a2.seatAgentStatus).toBeNull()
    expect(await observedFloorRefusal(dbThatThrowsOnSeats(env), a2, 'request_elevation')).toBeNull()
  })

  it('flag off: authenticateMember carries no seat status and no floor', async () => {
    const s = await seatFor(OWNER)
    const raw = await bearerFor(s.agentId, 'mcp-bound-3')
    setStatus(s.seatId, 'observed')
    const off = envFor(h, { VIP_LANE: undefined })
    const a = await authOf(off, raw)
    expect(a.seatAgentStatus).toBeUndefined()
    expect(await observedFloorRefusal(off, a, 'request_elevation')).toBeNull()
  })
})

describe('REST bearer sweep (P1-c) and read-error posture', () => {
  it('resolveMemberByToken refuses a token bound to an observed/held seat agent, allows trusted/NULL, and is inert with the flag off', async () => {
    const { resolveMemberByToken, hashMemberToken } = await import('../src/auth/member-bearer')
    const s = await seatFor(OWNER)
    const raw = 'rest-token-1'
    const bound = one<{ member_id: string }>(`SELECT member_id FROM agent_member_bindings WHERE agent_id = ?`, s.agentId)
    if (!bound) throw new Error('seat agent has no member binding')
    h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id) VALUES ('tok-rest', ?, ?, 'x', 'workspace', '2026-10-09T00:00:00.000Z', ?, ?)`).run(bound.member_id, await hashMemberToken(raw), TENANT, s.agentId)
    for (const [st, ok] of [[null, true], ['trusted', true], ['observed', false], ['held', false]] as const) {
      setStatus(s.seatId, st)
      expect((await resolveMemberByToken(env, raw)) !== null, String(st)).toBe(ok)
    }
    setStatus(s.seatId, 'observed')
    expect(await resolveMemberByToken(envFor(h, { VIP_LANE: undefined }), raw)).not.toBeNull()
    // a token with no bound agent (an ordinary member/agent credential) is unaffected
    h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-plain', ?, ?, 'x', 'workspace', '2026-10-09T00:00:00.000Z', ?)`).run(OWNER, await hashMemberToken('plain-token'), TENANT)
    expect(await resolveMemberByToken(env, 'plain-token')).not.toBeNull()
  })

  it('by-agent floor: a retired seat is not floored; a read error floors a seat-like caller (harness) but never an ordinary agent', async () => {
    const s = await seatFor(OWNER)
    const bare = { ...s.ctx, boundAgentId: s.agentId } as AuthContext
    delete bare.seatBinding
    setStatus(s.seatId, 'observed')
    h.sqlite.prepare(`UPDATE agent_seats SET retired_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`).run(s.seatId)
    expect(await observedFloorRefusal(env, bare, 'request_elevation')).toBeNull()
    const broken = { ...env, DB: { prepare: () => { throw new Error('db down') } } } as unknown as Env
    expect(await observedFloorRefusal(broken, { ...bare, harnessId: 'h1' } as AuthContext, 'request_elevation')).toEqual({ status: 'held' })
    expect(await observedFloorRefusal(broken, { ...bare, harnessId: null } as AuthContext, 'request_elevation')).toBeNull()
  })
})

describe('what each state means at the chokepoint', () => {
  it('held refuses write/propose tools that observed allows; held tools are a strict subset of observed', async () => {
    const s = await seatFor(OWNER)
    for (const t of HELD_FLOOR_TOOLS) expect(OBSERVED_FLOOR_TOOLS.has(t), t).toBe(true)
    for (const t of ['remember', 'task_create', 'task_update', 'send', 'check_in', 'join_squad']) {
      expect(HELD_FLOOR_TOOLS.has(t), t).toBe(false)
      expect(OBSERVED_FLOOR_TOOLS.has(t), t).toBe(true)
    }
    setStatus(s.seatId, 'observed')
    expect((await rpc(s.ctx, 'task_create', { title: 'x' }, s.session)).text).not.toContain('observed_floor')
    setStatus(s.seatId, 'held')
    const refused = await rpc(s.ctx, 'task_create', { title: 'x' }, s.session)
    expect(refused.text).toContain('observed_floor')
    expect(refused.text).toContain('held')
    expect((await rpc(s.ctx, 'task_list', {}, s.session)).text).not.toContain('observed_floor')
  })

  it('trusted lifts the floor; observed holds it', async () => {
    const s = await seatFor(OWNER)
    setStatus(s.seatId, 'observed')
    expect((await rpc(s.ctx, 'request_elevation', {}, s.session)).text).toContain('observed_floor')
    setStatus(s.seatId, 'trusted')
    expect((await rpc(s.ctx, 'request_elevation', {}, s.session)).text).not.toContain('observed_floor')
  })

  it('a bound-agent session with NO seatBinding is still floored when its agent is an observed/held seat agent (#2060 P2)', async () => {
    const s = await seatFor(OWNER)
    const bare = { ...s.ctx, boundAgentId: s.agentId } as AuthContext
    delete bare.seatBinding
    setStatus(s.seatId, 'observed')
    expect(await observedFloorRefusal(env, bare, 'request_elevation')).toEqual({ status: 'observed' })
    expect(await observedFloorRefusal(env, bare, 'task_list')).toBeNull()
    setStatus(s.seatId, 'held')
    expect(await observedFloorRefusal(env, bare, 'task_create')).toEqual({ status: 'held' })
    setStatus(s.seatId, 'trusted')
    expect(await observedFloorRefusal(env, bare, 'request_elevation')).toBeNull()
    setStatus(s.seatId, null)
    expect(await observedFloorRefusal(env, bare, 'request_elevation')).toBeNull()
    // an ordinary (non-seat) bound agent is untouched
    expect(await observedFloorRefusal(env, { ...bare, boundAgentId: 'agent-not-a-seat' } as AuthContext, 'request_elevation')).toBeNull()
  })
})

describe('flag off', () => {
  it('VIP_LANE off: the writer refuses, nothing changes, no audit, the section is absent, the floor is not read', async () => {
    const s = await seatFor(OWNER)
    setStatus(s.seatId, 'observed')
    const off = envFor(h, { VIP_LANE: undefined })
    const cookie = await session(off, `${OWNER}@example.test`)
    fresh()
    expect((await post(cookie, s.seatId, 'release', off)).status).toBe(403)
    expect(status(s.seatId)).toBe('observed')
    expect(audit(s.seatId)).toEqual([])
    const { dashboardApp } = await import('../src/dashboard/index')
    expect(await (await dashboardApp.request('/connections', { headers: { cookie } }, { ...off, LOCAL_TEST_AUTH: '1' } as unknown as Env)).text()).not.toContain('Observed chats')
    const bare = { ...s.ctx, boundAgentId: s.agentId } as AuthContext
    delete bare.seatBinding
    expect(await observedFloorRefusal(off, bare, 'request_elevation')).toBeNull()
    expect(await changeSeatAdmission(off, { humanMemberId: OWNER, seatId: s.seatId, action: 'release', fresh: true })).toEqual({ ok: false, error: 'vip_lane_disabled' })
  })
})
