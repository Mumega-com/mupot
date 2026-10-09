// tests/seat-select.test.ts — mupot#1794 W1: harness seats (seat_select, harness upsert,
// boot_context identity receipt) behind SEAT_AUTO_ENROLL.
//
// Drives the real code against a REAL sqlite D1 built from the full committed migration chain
// (tests/helpers/migrations.ts) — never a hand-written schema. See src/members/seat-select.ts for
// the design and the atomicity argument (seat row LAST in ONE batch; per-member cap is a BEFORE
// INSERT trigger so a refused seat rolls the whole batch back).
//
// What this harness does NOT prove: it is a real SQLite transaction per batch, not Cloudflare D1's
// production execution; the cross-isolate interleaving of two Workers is approximated by
// Promise.all over async calls (each batch is atomic, the awaits between them interleave).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seatSelect, seatCap, type SeatSelectAuth, type SeatSelectDeps, defaultSeatSelectDeps } from '../src/members/seat-select'
import { normalizeSeatKey, normalizeFolderPath, seatKeyHash, canonicalSeatKeyString } from '../src/members/seat-key'
import { upsertHarness, seatAutoEnrollEnabled, classifyHarnessKind } from '../src/members/harness'
import { bootstrapSelf, findExistingBootstrap } from '../src/members/bootstrap-self'
import { buildAuthContextFromProps, handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { invokeTool } from '../src/mcp/index'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const HUMAN2 = 'member-human-2'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) {
      const v = store.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
    _store: store,
  }
}

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db,
    TENANT_SLUG: TENANT,
    SESSIONS: memoryKv(),
    SEAT_AUTO_ENROLL: '1',
    ...extra,
  } as unknown as Env
}

function seedHuman(sqlite: SqliteD1Harness['sqlite'], memberId: string): void {
  sqlite.exec(
    `INSERT INTO members (id, email, display_name, status, created_at, tenant)
     VALUES ('${memberId}', '${memberId}@example.test', 'Human ${memberId}', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`,
  )
}

function authFor(memberId: string, harnessId: string | undefined, over: Partial<SeatSelectAuth> = {}): SeatSelectAuth {
  return { channel: 'directory', boundAgentId: null, memberId, harnessId, ...over }
}

async function harnessFor(env: Env, memberId: string, clientId = 'client-cursor', name = 'Cursor'): Promise<string> {
  const row = await upsertHarness(env, memberId, clientId, name)
  if (!row) throw new Error('harness upsert failed in fixture')
  return row.id
}

const TABLES = [
  'agents', 'members', 'member_tokens', 'agent_member_bindings', 'capabilities', 'memberships',
  'agent_audit', 'agent_seats', 'harnesses', 'squads', 'departments',
] as const

function snapshot(h: SqliteD1Harness): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of TABLES) out[t] = Number(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n)
  return out
}

function n(h: SqliteD1Harness, sql: string, ...params: unknown[]): number {
  return Number(h.sqlite.prepare(sql).get(...params)!.n)
}

let h: SqliteD1Harness

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(h.sqlite, HUMAN)
  seedHuman(h.sqlite, HUMAN2)
})
afterEach(() => { h.close() })

// ════════════════════════════════════════════════════════════════════════════
// 1. The flag — off means NOTHING, not even a read-shaped side effect
// ════════════════════════════════════════════════════════════════════════════
describe('SEAT_AUTO_ENROLL flag', () => {
  it.each([undefined, '', '0', 'true', 'on', ' 1', '1 '])('flag %j -> refused, zero writes', async (flag) => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: flag })
    const harnessId = await harnessFor(envFor(h), HUMAN) // fixture row written with the flag ON
    const before = snapshot(h)
    const out = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot' })
    expect(out).toEqual({ ok: false, error: 'seat_auto_enroll_disabled' })
    expect(snapshot(h)).toEqual(before)
  })

  it('only the exact string "1" enables it', () => {
    expect(seatAutoEnrollEnabled({ SEAT_AUTO_ENROLL: '1' })).toBe(true)
    expect(seatAutoEnrollEnabled({ SEAT_AUTO_ENROLL: undefined })).toBe(false)
    expect(seatAutoEnrollEnabled({ SEAT_AUTO_ENROLL: 'true' })).toBe(false)
  })

  it('the MCP tool refuses 403 seat_auto_enroll_disabled with the flag off', async () => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const auth = { userId: HUMAN, email: null, role: 'member', tenant: TENANT, memberId: HUMAN, channel: 'directory', capabilities: [], boundAgentId: null } as AuthContext
    const out = await invokeTool(auth, env, 'seat_select', { project: 'mupot' }, 'https://pot.test')
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('unreachable')
    expect(out.status).toBe(403)
    expect(out.error).toBe('seat_auto_enroll_disabled')
  })

  it('seatCap defaults to 16, honours the var, clamps to 1..256, ignores garbage', () => {
    expect(seatCap({})).toBe(16)
    expect(seatCap({ SEAT_MAX_PER_MEMBER: '3' })).toBe(3)
    expect(seatCap({ SEAT_MAX_PER_MEMBER: '99999' })).toBe(16) // >4 digits is garbage, not a clamp
    expect(seatCap({ SEAT_MAX_PER_MEMBER: '1000' })).toBe(256)
    expect(seatCap({ SEAT_MAX_PER_MEMBER: '0' })).toBe(16)
    expect(seatCap({ SEAT_MAX_PER_MEMBER: '-2' })).toBe(16)
    expect(seatCap({ SEAT_MAX_PER_MEMBER: 'abc' })).toBe(16)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. The gates
// ════════════════════════════════════════════════════════════════════════════
describe('gates', () => {
  it('a bound session is refused (tool: 403), nothing written', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const before = snapshot(h)
    const out = await seatSelect(env, authFor(HUMAN, harnessId, { boundAgentId: 'agent-x' }), { project: 'mupot' })
    expect(out).toEqual({ ok: false, error: 'not_unbound_directory_session' })
    expect(snapshot(h)).toEqual(before)

    const auth = { userId: HUMAN, email: null, role: 'member', tenant: TENANT, memberId: HUMAN, channel: 'directory', capabilities: [], boundAgentId: 'agent-x', harnessId } as AuthContext
    const viaTool = await invokeTool(auth, env, 'seat_select', { project: 'mupot' }, 'https://pot.test')
    expect(viaTool.ok).toBe(false)
    if (viaTool.ok) throw new Error('unreachable')
    expect(viaTool.status).toBe(403)
    expect(viaTool.error).toBe('not_unbound_directory_session')
  })

  it.each(['workspace', 'im', 'dashboard'] as const)('%s channel is refused', async (channel) => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const out = await seatSelect(env, authFor(HUMAN, harnessId, { channel }), { project: 'mupot' })
    expect(out).toEqual({ ok: false, error: 'not_unbound_directory_session' })
  })

  it('no harness pointer -> harness_required, nothing written', async () => {
    const env = envFor(h)
    const before = snapshot(h)
    expect(await seatSelect(env, authFor(HUMAN, undefined), { project: 'mupot' })).toEqual({ ok: false, error: 'harness_required' })
    expect(snapshot(h)).toEqual(before)
  })

  it("another human's harness id is NOT accepted (pointer is re-verified against the member)", async () => {
    const env = envFor(h)
    const theirs = await harnessFor(env, HUMAN2)
    const before = snapshot(h)
    expect(await seatSelect(env, authFor(HUMAN, theirs), { project: 'mupot' })).toEqual({ ok: false, error: 'harness_required' })
    expect(await seatSelect(env, authFor(HUMAN, 'no-such-harness'), { project: 'mupot' })).toEqual({ ok: false, error: 'harness_required' })
    expect(snapshot(h)).toEqual(before)
  })

  it('an offboarded human cannot enrol', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${HUMAN}'`)
    const out = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot' })
    expect(out).toEqual({ ok: false, error: 'member_not_active' })
  })

  it('invalid args are a 400-shaped refusal with no writes', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const before = snapshot(h)
    for (const args of [{}, { project: '' }, { project: 7 }, { project: 'ok', folder: '../up' }, { project: 'a\nb' }]) {
      const out = await seatSelect(env, authFor(HUMAN, harnessId), args as never)
      expect(out.ok).toBe(false)
      if (out.ok) throw new Error('unreachable')
      expect(out.error).toBe('invalid_args')
    }
    expect(snapshot(h)).toEqual(before)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Creation: what a seat IS
// ════════════════════════════════════════════════════════════════════════════
describe('creation', () => {
  it('creates one welded member-capability agent on the HUMAN home squad, no workspace token, own audit action', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const out = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder: '/home/x/work/mupot-deploy', thread: 't1' })
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.disposition).toBe('created')

    // Slug is SERVER-derived.
    expect(out.agent.slug).toMatch(/^seat-[0-9a-f]{12}$/)
    expect(out.seat.label).toBe('mupot-deploy')

    // Lives on the human's own home squad; the human is admin there; the agent is exactly member.
    const home = h.sqlite.prepare(`SELECT s.id AS id, s.kind AS kind FROM squads s JOIN capabilities c ON c.scope_id = s.id WHERE c.member_id = ? AND c.scope_type = 'squad'`).get(HUMAN)!
    expect(home.kind).toBe('home')
    expect(out.agent.squad_id).toBe(home.id)
    expect(h.sqlite.prepare(`SELECT capability FROM capabilities WHERE member_id = ? AND scope_id = ?`).get(HUMAN, home.id)!.capability).toBe('admin')
    expect(h.sqlite.prepare(`SELECT capability FROM capabilities WHERE member_id = ? AND scope_id = ?`).get(out.member_id, home.id)!.capability).toBe('member')
    // Agent kind is home (plan-exempt), status active, never an org/dept grant.
    expect(n(h, `SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ? AND scope_type != 'squad'`, out.member_id)).toBe(0)

    // Weld: binding exists, dedicated member has no email, token is a directory token welded to the agent.
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_member_bindings WHERE agent_id = ? AND member_id = ?`, out.agent.id, out.member_id)).toBe(1)
    const toks = h.sqlite.prepare(`SELECT channel, agent_id, member_id FROM member_tokens WHERE agent_id = ?`).all(out.agent.id)
    expect(toks).toHaveLength(1)
    expect(toks[0]).toMatchObject({ channel: 'directory', agent_id: out.agent.id, member_id: out.member_id })
    // NO workspace token anywhere for this agent or its member.
    expect(n(h, `SELECT COUNT(*) AS n FROM member_tokens WHERE channel = 'workspace' AND (agent_id = ? OR member_id = ?)`, out.agent.id, out.member_id)).toBe(0)

    // Audit: its own action, actor = the human; bootstrap_self's once-per-member world is untouched.
    const audit = h.sqlite.prepare(`SELECT actor_id, actor_type, action FROM agent_audit WHERE agent_id = ?`).all(out.agent.id)
    expect(audit).toEqual([{ actor_id: HUMAN, actor_type: 'user', action: 'seat_select' }])
    expect(await findExistingBootstrap(env, HUMAN)).toBeNull()

    // Only a hash + basename are stored — never the path.
    const seatRow = h.sqlite.prepare(`SELECT * FROM agent_seats WHERE agent_id = ?`).get(out.agent.id)!
    expect(String(seatRow.key_hash)).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(seatRow)).not.toContain('/home/x/work')
  })

  it('the caller cannot choose the slug or name', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const out = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'kasra', slug: 'kasra', name: 'river' } as never)
    if (!out.ok) throw new Error(JSON.stringify(out))
    expect(out.agent.slug).not.toBe('kasra')
    expect(out.agent.slug).toMatch(/^seat-[0-9a-f]{12}$/)
    expect(out.agent.name).not.toBe('river')
  })

  it('refuses home_rank_insufficient when the human is below admin on their own home squad; writes nothing', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    // Stand the home up, then demote the human on it.
    const first = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'one' })
    expect(first.ok).toBe(true)
    h.sqlite.exec(`UPDATE capabilities SET capability = 'member' WHERE member_id = '${HUMAN}' AND scope_type = 'squad'`)
    const before = snapshot(h)
    const out = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'two' })
    expect(out).toEqual({ ok: false, error: 'home_rank_insufficient' })
    expect(snapshot(h)).toEqual(before)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. Idempotency, isolation, concurrency
// ════════════════════════════════════════════════════════════════════════════
describe('idempotency and isolation', () => {
  it('same key twice -> same agent, second call is the fast path (no batch), counts unchanged', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder: '/w/x' })
    const batch = vi.fn(defaultSeatSelectDeps().batch)
    const before = snapshot(h)
    const b = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder: '/w/x' }, { batch } satisfies SeatSelectDeps)
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.disposition).toBe('created')
    expect(b.disposition).toBe('existing')
    expect(b.agent.id).toBe(a.agent.id)
    expect(batch).not.toHaveBeenCalled()
    expect(snapshot(h)).toEqual(before)
  })

  it('different key -> different agent (same human, same harness)', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder: '/w/a' })
    const b = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder: '/w/b' })
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.agent.id).not.toBe(b.agent.id)
    expect(a.agent.squad_id).toBe(b.agent.squad_id) // same home squad
  })

  it("another human's identical key -> a different agent, on THEIR home squad", async () => {
    const env = envFor(h)
    const h1 = await harnessFor(env, HUMAN)
    const h2 = await harnessFor(env, HUMAN2)
    const a = await seatSelect(env, authFor(HUMAN, h1), { project: 'mupot', folder: '/w/a' })
    const b = await seatSelect(env, authFor(HUMAN2, h2), { project: 'mupot', folder: '/w/a' })
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.agent.id).not.toBe(b.agent.id)
    expect(a.agent.slug).not.toBe(b.agent.slug)
    expect(a.agent.squad_id).not.toBe(b.agent.squad_id)
  })

  it('the same key under a DIFFERENT harness (another install) is a different seat', async () => {
    const env = envFor(h)
    const hc = await harnessFor(env, HUMAN, 'client-cursor', 'Cursor')
    const hg = await harnessFor(env, HUMAN, 'client-chatgpt', 'ChatGPT')
    const a = await seatSelect(env, authFor(HUMAN, hc), { project: 'mupot', folder: '/w/a' })
    const b = await seatSelect(env, authFor(HUMAN, hg), { project: 'mupot', folder: '/w/a' })
    if (!a.ok || !b.ok) throw new Error('unreachable')
    expect(a.agent.id).not.toBe(b.agent.id)
  })

  it('path spellings that normalise equal resolve to ONE agent', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const ids = new Set<string>()
    for (const folder of ['/w/a/b', '/w/a/./b', '/w//a//b', '/w/a/b/', '\\w\\a\\b', '/w/x/../a/b']) {
      const out = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder })
      if (!out.ok) throw new Error(JSON.stringify(out))
      ids.add(out.agent.id)
    }
    expect(ids.size).toBe(1)
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_seats`)).toBe(1)
  })

  it('N concurrent calls for the SAME key -> exactly one agent and no orphans', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const outs = await Promise.all(
      Array.from({ length: 8 }, () => seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder: '/w/race' })),
    )
    for (const o of outs) if (!o.ok) throw new Error(JSON.stringify(o))
    const ok = outs as Array<Extract<typeof outs[number], { ok: true }>>
    expect(new Set(ok.map((o) => o.agent.id)).size).toBe(1)
    expect(ok.filter((o) => o.disposition === 'created')).toHaveLength(1)
    expect(n(h, `SELECT COUNT(*) AS n FROM agents`)).toBe(1)
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_seats`)).toBe(1)
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_member_bindings`)).toBe(1)
    expect(n(h, `SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id IS NOT NULL`)).toBe(1)
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'seat_select'`)).toBe(1)
    // members: the two humans + exactly one agent-dedicated member
    expect(n(h, `SELECT COUNT(*) AS n FROM members`)).toBe(3)
  })

  it('cap + 3 concurrent DISTINCT keys -> exactly cap seats, no orphan agents/members/tokens/bindings/audit', async () => {
    const CAP = 3
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: String(CAP) })
    const harnessId = await harnessFor(env, HUMAN)
    const outs = await Promise.all(
      Array.from({ length: CAP + 3 }, (_, i) => seatSelect(env, authFor(HUMAN, harnessId), { project: 'mupot', folder: `/w/k${i}` })),
    )
    const okOuts = outs.filter((o) => o.ok)
    const refused = outs.filter((o) => !o.ok)
    expect(okOuts).toHaveLength(CAP)
    expect(refused).toHaveLength(3)
    for (const r of refused) expect(r).toMatchObject({ ok: false, error: 'seat_cap_reached' })
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_seats`)).toBe(CAP)
    expect(n(h, `SELECT COUNT(*) AS n FROM agents`)).toBe(CAP)
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_member_bindings`)).toBe(CAP)
    expect(n(h, `SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id IS NOT NULL`)).toBe(CAP)
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'seat_select'`)).toBe(CAP)
    expect(n(h, `SELECT COUNT(*) AS n FROM members`)).toBe(2 + CAP)
    expect(n(h, `SELECT COUNT(*) AS n FROM memberships`)).toBe(CAP)
  })

  it('sequential: at cap the call refuses BEFORE any write (pre-check), but an existing key still resolves', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '2' })
    const harnessId = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/b' })
    const batch = vi.fn(defaultSeatSelectDeps().batch)
    const before = snapshot(h)
    const over = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/c' }, { batch })
    expect(over).toMatchObject({ ok: false, error: 'seat_cap_reached' })
    expect(batch).not.toHaveBeenCalled()
    expect(snapshot(h)).toEqual(before)
    const again = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    if (!a.ok || !again.ok) throw new Error('unreachable')
    expect(again.agent.id).toBe(a.agent.id)
  })

  it('the cap is enforced by the DB itself: a raw over-cap seat INSERT aborts', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    if (!a.ok) throw new Error('unreachable')
    // A second agent to hang a seat on, then try to insert with max_live = 1 (already 1 live).
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('raw-agent', '${a.agent.squad_id}', 'raw-agent', 'Raw', 'active')`)
    expect(() => h.sqlite.exec(
      `INSERT INTO agent_seats (id, tenant, member_id, harness_id, key_hash, agent_id, label_basename, max_live)
       VALUES ('raw-seat', '${TENANT}', '${HUMAN}', '${harnessId}', '${'a'.repeat(64)}', 'raw-agent', 'x', 1)`,
    )).toThrow(/seat_cap_exceeded/)
  })

  it('a seat is immutable except a one-way retire; and cannot be deleted', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    if (!a.ok) throw new Error('unreachable')
    expect(() => h.sqlite.exec(`UPDATE agent_seats SET key_hash = '${'b'.repeat(64)}' WHERE id = '${a.seat.id}'`)).toThrow(/agent_seat_immutable/)
    expect(() => h.sqlite.exec(`UPDATE agent_seats SET agent_id = 'other' WHERE id = '${a.seat.id}'`)).toThrow()
    expect(() => h.sqlite.exec(`DELETE FROM agent_seats WHERE id = '${a.seat.id}'`)).toThrow(/agent_seat_immutable/)
    h.sqlite.exec(`UPDATE agent_seats SET retired_at = '2026-10-09T00:00:00.000Z' WHERE id = '${a.seat.id}'`)
    expect(() => h.sqlite.exec(`UPDATE agent_seats SET retired_at = NULL WHERE id = '${a.seat.id}'`)).toThrow(/agent_seat_immutable/)
  })

  it('an inactive seat agent is never resurrected: seat_agent_inactive, no new agent', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    if (!a.ok) throw new Error('unreachable')
    h.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = '${a.agent.id}'`)
    const before = snapshot(h)
    const again = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    expect(again).toMatchObject({ ok: false, error: 'seat_agent_inactive' })
    expect(snapshot(h)).toEqual(before)
  })

  it('a retired seat key is never resurrected either', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    if (!a.ok) throw new Error('unreachable')
    h.sqlite.exec(`UPDATE agent_seats SET retired_at = '2026-10-09T00:00:00.000Z' WHERE id = '${a.seat.id}'`)
    const again = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    expect(again).toMatchObject({ ok: false, error: 'seat_agent_inactive' })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. bootstrap_self is unchanged and does not collide
// ════════════════════════════════════════════════════════════════════════════
describe('bootstrap_self coexistence', () => {
  it('seat first, then bootstrap_self creates once and refuses a second time (already_bootstrapped unchanged)', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const seat = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    expect(seat.ok).toBe(true)
    const auth = { channel: 'directory', boundAgentId: null, memberId: HUMAN } as const
    const first = await bootstrapSelf(env, auth, 'Aria')
    expect(first.ok).toBe(true)
    const second = await bootstrapSelf(env, auth, 'Aria')
    expect(second).toMatchObject({ ok: false, error: 'already_bootstrapped' })
    expect(n(h, `SELECT COUNT(*) AS n FROM agent_audit WHERE action = 'bootstrap_self'`)).toBe(1)
  })

  it('bootstrap_self first, then seat_select adopts the same home squad', async () => {
    const env = envFor(h)
    const harnessId = await harnessFor(env, HUMAN)
    const boot = await bootstrapSelf(env, { channel: 'directory', boundAgentId: null, memberId: HUMAN }, 'Aria')
    if (!boot.ok) throw new Error(JSON.stringify(boot))
    const seat = await seatSelect(env, authFor(HUMAN, harnessId), { project: 'p', folder: '/a' })
    if (!seat.ok) throw new Error(JSON.stringify(seat))
    expect(seat.agent.squad_id).toBe(boot.squad.id)
    expect(n(h, `SELECT COUNT(*) AS n FROM squads WHERE kind = 'home'`)).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. Key normalisation (pure)
// ════════════════════════════════════════════════════════════════════════════
describe('seat key normalisation', () => {
  const key = (a: Parameters<typeof normalizeSeatKey>[0]) => {
    const r = normalizeSeatKey(a)
    if (!r.ok) throw new Error(`${r.field}:${r.error}`)
    return r.key
  }
  const hash = async (a: Parameters<typeof normalizeSeatKey>[0], member = 'm1', harness = 'h1') =>
    seatKeyHash(member, harness, key(a))

  it('collapses equivalent folder spellings', async () => {
    const base = await hash({ project: 'p', folder: 'a/b' })
    for (const f of ['a/./b', 'a//b', 'a/b/', 'a\\b', 'x/../a/b', ' a/b ']) {
      expect(await hash({ project: 'p', folder: f }), f).toBe(base)
    }
    expect(normalizeFolderPath('/a/../..')).toBe('/')
    expect(normalizeFolderPath('/a/b/../c/')).toBe('/a/c')
    expect(normalizeFolderPath('../x')).toBeNull()
  })

  it('does NOT collapse genuinely different workspaces', async () => {
    const base = await hash({ project: 'p', folder: '/a/b' })
    expect(await hash({ project: 'p', folder: '/a/c' })).not.toBe(base)
    expect(await hash({ project: 'p', folder: '/A/b' })).not.toBe(base) // case-sensitive folder
    expect(await hash({ project: 'p', folder: 'a/b' })).not.toBe(base) // relative vs absolute
    expect(await hash({ project: 'q', folder: '/a/b' })).not.toBe(base)
    expect(await hash({ project: 'p', folder: '/a/b', thread: 't' })).not.toBe(base)
    expect(await hash({ project: 'p', folder: '/a/b', squad: 's' })).not.toBe(base)
    expect(await hash({ project: 'p', folder: '/a/b' }, 'm2')).not.toBe(base) // other human
    expect(await hash({ project: 'p', folder: '/a/b' }, 'm1', 'h2')).not.toBe(base) // other harness
  })

  it('project and squad are case-insensitive; thread is not; harness_kind is a hint, not key material', async () => {
    expect(await hash({ project: 'MuPot', squad: 'Core' })).toBe(await hash({ project: 'mupot', squad: 'core' }))
    expect(await hash({ project: 'p', thread: 'T' })).not.toBe(await hash({ project: 'p', thread: 't' }))
    expect(await hash({ project: 'p', harness_kind: 'cursor' })).toBe(await hash({ project: 'p', harness_kind: 'grok' }))
  })

  it('NFC-equivalent strings are one key', async () => {
    expect(await hash({ project: 'café' })).toBe(await hash({ project: 'café' }))
  })

  it('rejects controls, NUL, newline, percent-escapes, relative escapes, over-long values', () => {
    for (const bad of [{ project: 'a\u0000b' }, { project: 'a\nb' }, { project: 'a b' }, { project: 'a%2e%2e' }, { project: 'a<b>' }]) {
      expect(normalizeSeatKey(bad).ok, JSON.stringify(bad)).toBe(false)
    }
    expect(normalizeSeatKey({ project: 'p', folder: '../x' })).toMatchObject({ ok: false, error: 'folder_escapes_root' })
    expect(normalizeSeatKey({ project: 'p', folder: 'a/%2e%2e/b' }).ok).toBe(false)
    expect(normalizeSeatKey({ project: 'x'.repeat(201) })).toMatchObject({ ok: false, error: 'component_too_long' })
    expect(normalizeSeatKey({ project: 'p', folder: 'x'.repeat(513) })).toMatchObject({ ok: false, error: 'component_too_long' })
    expect(normalizeSeatKey({ project: 'p', thread: 5 as never })).toMatchObject({ ok: false, error: 'invalid_component' })
    expect(normalizeSeatKey({ project: '   ' })).toMatchObject({ ok: false, error: 'project_required' })
  })

  it('field values cannot forge a neighbouring field in the canonical string', () => {
    // A thread containing "folder=" text cannot become a folder field: newlines are rejected outright.
    expect(normalizeSeatKey({ project: 'p', thread: 'x\nfolder=/etc' }).ok).toBe(false)
    const k = key({ project: 'p', thread: 'folder=/etc' })
    expect(canonicalSeatKeyString('h', k).split('\n').filter((l) => l.startsWith('folder=')).length).toBe(1)
  })

  it('label is the last folder segment (else project) and never the full path', () => {
    expect(key({ project: 'proj', folder: '/home/u/secret/place' }).labelBasename).toBe('place')
    expect(key({ project: 'proj' }).labelBasename).toBe('proj')
  })

  it('harness kind labels', () => {
    expect(classifyHarnessKind('Cursor')).toBe('cursor')
    expect(classifyHarnessKind('ChatGPT')).toBe('chatgpt')
    expect(classifyHarnessKind('Claude Code')).toBe('claude')
    expect(classifyHarnessKind('Something Else')).toBe('other')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. OAuth consent: harness upsert on the UNBOUND path only; legacy path untouched
// ════════════════════════════════════════════════════════════════════════════
function stubOAuthProvider(clientName: string | null = 'Cursor') {
  return {
    parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
    completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
    ...(clientName === null ? {} : { lookupClient: vi.fn(async () => ({ clientName })) }),
  }
}

function stubGoogleFetch(email: string) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
    if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
      return new Response(JSON.stringify({ id: 'google-sub-1', name: 'Human', email, verified_email: true }), { status: 200 })
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
}

function httpEnv(oauthProvider: ReturnType<typeof stubOAuthProvider>, extra: Record<string, unknown> = {}): Env {
  return {
    DB: h.db,
    TENANT_SLUG: TENANT,
    BRAND: 'mupot',
    POT_TIER: 'scale',
    GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    SESSIONS: memoryKv(),
    OAUTH_PROVIDER: oauthProvider,
    BUS: { send: async () => {} },
    ...extra,
  } as unknown as Env
}

async function consent(env: Env, agentId: string): Promise<Response> {
  const authorizeRes = await handleOAuthAuthorize(
    new Request('https://pot.test/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256'),
    env,
  )
  const nonce = /mupot_oauth_nonce=([^;]+)/.exec(authorizeRes.headers.get('Set-Cookie') ?? '')![1]
  stubGoogleFetch(`${HUMAN}@example.test`)
  const cb = await handleOAuthAuthorize(
    new Request(`https://pot.test/oauth/google-callback?code=abc&state=${nonce}`, { headers: { Cookie: `mupot_oauth_nonce=${nonce}` } }),
    env,
  )
  const cookies = cb.headers.getSetCookie ? cb.headers.getSetCookie() : [cb.headers.get('Set-Cookie') ?? '']
  const consentNonce = /mupot_oauth_consent=([^;]+)/.exec(cookies.find((c) => c.startsWith('mupot_oauth_consent=')) ?? '')![1]
  return handleOAuthAuthorize(
    new Request('https://pot.test/oauth/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentNonce}` },
      body: new URLSearchParams({ consent_nonce: consentNonce, action: 'continue', agent_id: agentId }).toString(),
    }),
    env,
  )
}

describe('OAuth consent harness upsert', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('flag ON + unbound consent: harness row written, props.harnessId set, label from the OAuth client', async () => {
    const p = stubOAuthProvider('Cursor')
    const env = httpEnv(p, { SEAT_AUTO_ENROLL: '1' })
    const res = await consent(env, '')
    expect(res.status).toBe(302)
    const props = (p.completeAuthorization.mock.calls[0] as unknown as [{ props: Record<string, unknown> }])[0].props
    const row = h.sqlite.prepare(`SELECT * FROM harnesses`).all()
    expect(row).toHaveLength(1)
    expect(row[0]).toMatchObject({ tenant: TENANT, member_id: HUMAN, oauth_client_id: 'client-1', client_name: 'Cursor', kind: 'cursor' })
    expect(props.harnessId).toBe(row[0].id)
    expect(props.boundAgentId).toBeNull()
  })

  it('re-consent through the same client reuses the harness row (no duplicate)', async () => {
    const p = stubOAuthProvider('Cursor')
    const env = httpEnv(p, { SEAT_AUTO_ENROLL: '1' })
    await consent(env, '')
    await consent(env, '')
    expect(n(h, `SELECT COUNT(*) AS n FROM harnesses`)).toBe(1)
  })

  it('flag ON but the OAuth client has no lookup: harness still written (label empty)', async () => {
    const p = stubOAuthProvider(null)
    const env = httpEnv(p, { SEAT_AUTO_ENROLL: '1' })
    expect((await consent(env, '')).status).toBe(302)
    expect(h.sqlite.prepare(`SELECT client_name, kind FROM harnesses`).get()).toMatchObject({ client_name: '', kind: 'other' })
  })

  it('flag OFF: no harness read/write and props carry NO harnessId key at all (legacy shape)', async () => {
    const p = stubOAuthProvider('Cursor')
    const env = httpEnv(p, {})
    expect((await consent(env, '')).status).toBe(302)
    const props = (p.completeAuthorization.mock.calls[0] as unknown as [{ props: Record<string, unknown> }])[0].props
    expect('harnessId' in props).toBe(false)
    expect(Object.keys(props).sort()).toEqual(['boundAgentId', 'channel', 'consentedByMemberId', 'email', 'memberId', 'tokenId'])
    expect(n(h, `SELECT COUNT(*) AS n FROM harnesses`)).toBe(0)
  })

  it('flag ON but an agent-BOUND consent: legacy path, no harness row, no harnessId', async () => {
    // A consentable agent for the human: home squad + welded seat agent (created via the seat path
    // only as a convenient fixture), human is admin there.
    const envSeat = envFor(h)
    const hid = await harnessFor(envSeat, HUMAN)
    const seat = await seatSelect(envSeat, authFor(HUMAN, hid), { project: 'p', folder: '/a' })
    if (!seat.ok) throw new Error(JSON.stringify(seat))
    const harnessesBefore = n(h, `SELECT COUNT(*) AS n FROM harnesses`)
    const p = stubOAuthProvider('Cursor')
    const env = httpEnv(p, { SEAT_AUTO_ENROLL: '1' })
    const res = await consent(env, seat.agent.id)
    expect(res.status).toBe(302)
    const props = (p.completeAuthorization.mock.calls[0] as unknown as [{ props: Record<string, unknown> }])[0].props
    expect(props.boundAgentId).toBe(seat.agent.id)
    expect('harnessId' in props).toBe(false)
    expect(n(h, `SELECT COUNT(*) AS n FROM harnesses`)).toBe(harnessesBefore)
  })

  it('buildAuthContextFromProps carries harnessId only for flag-on UNBOUND directory sessions', async () => {
    const envOn = envFor(h)
    const hid = await harnessFor(envOn, HUMAN)
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-u', '${HUMAN}', 'hash-u', 'oauth:x', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const props = { memberId: HUMAN, tokenId: 'tok-u', email: null, channel: 'directory' as const, boundAgentId: null, harnessId: hid }
    expect((await buildAuthContextFromProps(envOn, props))!.harnessId).toBe(hid)
    const envOff = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const off = (await buildAuthContextFromProps(envOff, props))!
    expect('harnessId' in off).toBe(false)
    // a consent-BOUND directory token (props smuggling a harnessId) never carries it
    const seat = await seatSelect(envOn, authFor(HUMAN, hid), { project: 'p', folder: '/a' })
    if (!seat.ok) throw new Error('unreachable')
    const boundTok = h.sqlite.prepare(`SELECT id FROM member_tokens WHERE agent_id = ?`).get(seat.agent.id)!.id as string
    const bound = (await buildAuthContextFromProps(envOn, {
      memberId: seat.member_id, tokenId: boundTok, email: null, channel: 'directory', boundAgentId: seat.agent.id,
      consentedByMemberId: HUMAN, harnessId: hid,
    }))!
    expect('harnessId' in bound).toBe(false)
    // a workspace-channel token never carries it, flag on or not
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-w', '${HUMAN}', 'hash-w', 'ws', 'workspace', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const ws = (await buildAuthContextFromProps(envOn, { ...props, tokenId: 'tok-w' }))!
    expect('harnessId' in ws).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8. boot_context identity receipt
// ════════════════════════════════════════════════════════════════════════════
describe('boot_context identity receipt', () => {
  function unboundAuth(harnessId?: string): AuthContext {
    return { userId: HUMAN, email: null, role: 'member', tenant: TENANT, memberId: HUMAN, channel: 'directory', capabilities: [], boundAgentId: null, ...(harnessId ? { harnessId } : {}) } as AuthContext
  }
  async function boot(auth: AuthContext, env: Env, args: Record<string, unknown> = {}, seat?: string) {
    const out = await invokeTool(auth, env, 'boot_context', args, { origin: 'https://pot.test', seat, sideEffectFree: true })
    if (!out.ok) throw new Error(JSON.stringify(out))
    return out.result as Record<string, unknown>
  }

  it('flag OFF: no identity_receipt key (response unchanged)', async () => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const res = await boot(unboundAuth(), env)
    expect('identity_receipt' in res).toBe(false)
  })

  it('unbound + harness: human, harness (client_name, kind), binding_source none, no conflict', async () => {
    const env = envFor(h)
    const hid = await harnessFor(env, HUMAN, 'client-cursor', 'Cursor')
    const res = await boot(unboundAuth(hid), env)
    expect(res.identity_receipt).toMatchObject({
      human: { member_id: HUMAN },
      harness: { id: hid, client_name: 'Cursor', kind: 'cursor' },
      agent: null,
      binding_source: 'none',
      effective_capabilities: { count: 0, highest: null },
      seat_label_conflict: false,
    })
  })

  it("another human's harness id is not echoed into the receipt", async () => {
    const env = envFor(h)
    const theirs = await harnessFor(env, HUMAN2)
    const res = await boot(unboundAuth(theirs), env)
    expect((res.identity_receipt as { harness: unknown }).harness).toBeNull()
  })

  it('legacy consent-bound session: agent + uuid, binding_source legacy_consent, conflict flag on a different agent label', async () => {
    const env = envFor(h)
    const hid = await harnessFor(env, HUMAN)
    const a = await seatSelect(env, authFor(HUMAN, hid), { project: 'p', folder: '/a' })
    const b = await seatSelect(env, authFor(HUMAN, hid), { project: 'p', folder: '/b' })
    if (!a.ok || !b.ok) throw new Error('unreachable')
    const bound: AuthContext = {
      userId: a.member_id, email: null, role: 'member', tenant: TENANT, memberId: a.member_id, channel: 'directory',
      capabilities: [{ member_id: a.member_id, scope_type: 'squad', scope_id: a.agent.squad_id, capability: 'member' }],
      boundAgentId: a.agent.id, consentedByMemberId: HUMAN,
    }
    const clean = await boot(bound, env, {}, a.agent.slug)
    expect(clean.identity_receipt).toMatchObject({
      human: { member_id: HUMAN },
      agent: { id: a.agent.id, uuid: a.agent.id, slug: a.agent.slug },
      binding_source: 'legacy_consent',
      effective_capabilities: { count: 1, highest: 'member' },
      seat_label_conflict: false,
    })
    // x-mupot-seat naming the OTHER agent -> conflict
    expect((await boot(bound, env, {}, b.agent.slug)).identity_receipt).toMatchObject({ seat_label_conflict: true })
    // label arg naming the other agent by id -> conflict
    expect((await boot(bound, env, { label: b.agent.id })).identity_receipt).toMatchObject({ seat_label_conflict: true })
    // a label that names no agent at all (a folder/project) -> NOT a conflict
    expect((await boot(bound, env, { label: 'my-project-folder' }, 'some-folder')).identity_receipt).toMatchObject({ seat_label_conflict: false })
  })
})
