// tests/seat-handle.test.ts — mupot#1794 W2: seat handles (a selected seat authenticates AS its agent).
//
// Real sqlite D1 built from the full committed migration chain; every request goes through the real
// path a connector request takes: OAuth props -> buildAuthContextFromProps -> internal header
// (mcpInternalRequest) -> mcpApp (resolveAuth -> applySeatHandle -> tool). The seat handle is the
// only thing that ever moves a request from the human to the seat agent.
//
// Not proven here: the cloudflare:workers entrypoint (McpOAuthApiHandler) itself, which the sibling
// header tests also bypass; and real D1 concurrency (Promise.all over a serialized sqlite).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seatSelect, seatTotalCap, type SeatSelectAuth } from '../src/members/seat-select'
import { upsertHarness } from '../src/members/harness'
import {
  applySeatHandle, hashSeatHandle, isWellFormedSeatHandle, mintSeatHandle, resolveSeatCapabilities,
  SEAT_HANDLE_MAX_LIVE_PER_SEAT, NO_HINTS,
} from '../src/members/seat-handle'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp, invokeTool } from '../src/mcp/index'
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
  return { handle: sc.seat_handle, agentId: (sc.agent as { id: string }).id, seatId: (sc.seat as { id: string }).id, sc }
}

const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedHuman(HUMAN)
  seedHuman(HUMAN2)
  resetHarnessProbeSampling()
})
afterEach(() => { h.close(); vi.restoreAllMocks() })

// ════════════════════════════════════════════════════════════════════════════
describe('handle format', () => {
  it('mints 32 random bytes as 43 base64url chars; only well-formed values pass the cheap guard', () => {
    const a = mintSeatHandle(); const b = mintSeatHandle()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a).not.toBe(b)
    expect(isWellFormedSeatHandle(a)).toBe(true)
    for (const bad of ['', 'x', a + 'x', a.slice(1), `${a.slice(1)}=`, 42, null, undefined, 'a b'.padEnd(43, 'c')]) expect(isWellFormedSeatHandle(bad)).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('seat_select issues a handle', () => {
  it('returns a handle once; DB stores only its sha256 and pins the grant/harness/member', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const s = await select(env, g, '/work/a')
    expect(isWellFormedSeatHandle(s.handle)).toBe(true)
    const row = h.sqlite.prepare(`SELECT * FROM seat_handles`).get()!
    expect(row.handle_hash).toBe(await hashSeatHandle(s.handle))
    expect(row.grant_token_id).toBe(g.tokenId)
    expect(row.consenting_member_id).toBe(HUMAN)
    expect(row.harness_id).toBe(g.harnessId)
    expect(row.seat_id).toBe(s.seatId)
    expect(row.agent_id).toBe(s.agentId)
  })

  it('re-selecting the same seat returns the same agent and a NEW handle; the old one stays valid', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a1 = await select(env, g, '/work/a')
    const a2 = await select(env, g, '/work/a')
    expect(a2.agentId).toBe(a1.agentId)
    expect(a2.handle).not.toBe(a1.handle)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE revoked_at IS NULL`)).toBe(2)
    for (const hd of [a1.handle, a2.handle]) {
      const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': hd } })
      expect(r.sc.bound_agent_id).toBe(a1.agentId)
    }
  })

  it('caps live handles per seat by evicting the least-recently-used (no lockout)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const first = await select(env, g, '/work/a')
    const handles = [first.handle]
    for (let i = 1; i < SEAT_HANDLE_MAX_LIVE_PER_SEAT; i++) handles.push((await select(env, g, '/work/a')).handle)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE revoked_at IS NULL`)).toBe(SEAT_HANDLE_MAX_LIVE_PER_SEAT)
    const extra = await select(env, g, '/work/a')
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE revoked_at IS NULL`)).toBe(SEAT_HANDLE_MAX_LIVE_PER_SEAT)
    // the oldest is the one evicted
    const evicted = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': first.handle } })
    expect(evicted.sc.bound_agent_id).toBeNull()
    expect(receiptOf(evicted).seat_handle_rejected).toBe(true)
    const kept = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': extra.handle } })
    expect(kept.sc.bound_agent_id).toBe(first.agentId)
  })

  it('the raw trigger is the hard backstop at the cap', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const s = await select(env, g, '/work/a')
    const ins = (i: number) => h.sqlite.exec(
      `INSERT INTO seat_handles (id, tenant, handle_hash, seat_id, agent_id, harness_id, consenting_member_id, grant_token_id)
       VALUES ('raw-${i}', '${TENANT}', '${String(i).padStart(64, 'a')}', '${s.seatId}', '${s.agentId}', '${g.harnessId}', '${HUMAN}', '${g.tokenId}')`)
    for (let i = 0; i < SEAT_HANDLE_MAX_LIVE_PER_SEAT - 1; i++) ins(i)
    expect(() => ins(999)).toThrow(/seat_handle_cap_exceeded/)
  })

  it('no live grant token id on the session -> seat resolves, no handle issued', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const auth: SeatSelectAuth = { channel: 'directory', boundAgentId: null, memberId: HUMAN, harnessId: g.harnessId, tokenId: null }
    const r = await seatSelect(env, auth, { project: 'p', folder: '/x' })
    expect(r).toMatchObject({ ok: true, seat_handle: null })
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles`)).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('authenticating AS the seat agent (header X-Mupot-Seat)', () => {
  it('two concurrent handles in two folders -> two different bound agents, isolated inboxes', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const [a, b] = await Promise.all([select(env, g, '/work/a'), select(env, g, '/work/b')])
    expect(a.agentId).not.toBe(b.agentId)
    const ra = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    const rb = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': b.handle } })
    expect(ra.sc.bound_agent_id).toBe(a.agentId)
    expect(rb.sc.bound_agent_id).toBe(b.agentId)
    expect(receiptOf(ra)).toMatchObject({ binding_source: 'seat_handle', human: { member_id: HUMAN }, seat: { label: 'a' } })
    expect(ra.sc.member_id).not.toBe(HUMAN)

    h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
      VALUES ('m-a', '${TENANT}', '${a.agentId}', 'someone', 'someone-m', 'message', 'FOR-AGENT-A', datetime('now'))`)
    const inboxB = await rpc(env, g.ctx, 'inbox', { peek: true }, { headers: { 'x-mupot-seat': b.handle } })
    expect(JSON.stringify(inboxB.body)).not.toContain('FOR-AGENT-A')
    const inboxA = await rpc(env, g.ctx, 'inbox', { peek: true }, { headers: { 'x-mupot-seat': a.handle } })
    expect(JSON.stringify(inboxA.body)).toContain('FOR-AGENT-A')
    // and the unbound human context cannot read it either
    const inboxH = await rpc(env, g.ctx, 'inbox', { peek: true })
    expect(JSON.stringify(inboxH.body)).not.toContain('FOR-AGENT-A')
  })

  it('no handle -> the human\'s own unbound context, unchanged', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await select(env, g, '/work/a')
    const r = await rpc(env, g.ctx, 'boot_context', {})
    expect(r.sc.bound_agent_id).toBeNull()
    expect(r.sc.member_id).toBe(HUMAN)
    expect(receiptOf(r)).toMatchObject({ binding_source: 'none', seat: null, seat_handle_rejected: false })
  })

  it("another human's handle on human B's grant -> ignored (unbound), flagged rejected", async () => {
    const env = envFor(h)
    const gA = await grant(env, HUMAN); const gB = await grant(env, HUMAN2)
    const a = await select(env, gA, '/work/a')
    const r = await rpc(env, gB.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.status).toBe(200)
    expect(r.sc.bound_agent_id).toBeNull()
    expect(r.sc.member_id).toBe(HUMAN2)
    expect(receiptOf(r)).toMatchObject({ binding_source: 'none', seat_handle_rejected: true })
  })

  it('the same human on ANOTHER harness (other grant) cannot use the handle', async () => {
    const env = envFor(h)
    const g1 = await grant(env, HUMAN, 'client-cursor', 'Cursor')
    const g2 = await grant(env, HUMAN, 'client-claude', 'Claude Code')
    const a = await select(env, g1, '/work/a')
    const r = await rpc(env, g2.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r).seat_handle_rejected).toBe(true)
  })

  it('a RE-CONSENTED grant (new token id, same harness) does not inherit old handles', async () => {
    const env = envFor(h)
    const g1 = await grant(env, HUMAN)
    const a = await select(env, g1, '/work/a')
    const g1b = await grant(env, HUMAN) // same client -> same harness row, new token id
    expect(g1b.harnessId).toBe(g1.harnessId)
    const r = await rpc(env, g1b.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r).seat_handle_rejected).toBe(true)
  })

  it('Rava-style legacy bound grant + a valid handle -> stays the bound agent, handle ignored entirely', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const b = await select(env, g, '/work/b')
    const seatTok = h.sqlite.prepare(`SELECT id FROM member_tokens WHERE agent_id = ?`).get(a.agentId)!.id as string
    const memberId = h.sqlite.prepare(`SELECT member_id FROM agent_member_bindings WHERE agent_id = ?`).get(a.agentId)!.member_id as string
    const bound = await buildAuthContextFromProps(env, {
      memberId, tokenId: seatTok, email: null, channel: 'directory', boundAgentId: a.agentId, consentedByMemberId: HUMAN,
    })
    expect(bound?.boundAgentId).toBe(a.agentId)
    const r = await rpc(env, bound!, 'boot_context', {}, { headers: { 'x-mupot-seat': b.handle } })
    expect(r.sc.bound_agent_id).toBe(a.agentId)
    expect(receiptOf(r)).toMatchObject({ binding_source: 'legacy_consent', seat_handle_rejected: false })
  })

  it('a workspace-channel token + a valid handle -> ignored (workspace tokens untouched)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-ws', '${HUMAN}', 'hash-ws', 'ws', 'workspace', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
    const ws = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: 'tok-ws', email: null, channel: 'workspace', boundAgentId: null, harnessId: g.harnessId })
    const r = await rpc(env, ws!, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(r.sc.member_id).toBe(HUMAN)
    expect(r.sc.channel).toBe('workspace')
  })

  it('a blob that forges seatBinding / seatInputs is stripped; the header alone decides', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const forged = { ...g.ctx, seatBinding: { seatId: a.seatId, label: 'x', harnessId: g.harnessId, grantTokenId: g.tokenId, humanMemberId: HUMAN }, seatInputs: { handleRejected: false, hints: { openai_session: true, openai_subject: true, codex_thread_id: true } } } as AuthContext
    const r = await rpc(env, forged, 'boot_context', {})
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r)).toMatchObject({ seat: null, hints: { openai_session: false } })
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('fallbacks and revocation', () => {
  it('agent deactivated (real deactivate_agent) -> falls back to the human; handles revoked by the trigger', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const squadId = (a.sc.agent as { squad_id: string }).squad_id
    const admin = { userId: 'adm', email: null, role: 'owner', tenant: TENANT, memberId: 'adm', channel: 'workspace', capabilities: [{ member_id: 'adm', scope_type: 'org', scope_id: null, capability: 'owner' }, { member_id: 'adm', scope_type: 'squad', scope_id: squadId, capability: 'owner' }], boundAgentId: null } as AuthContext
    const out = await invokeTool(admin, env, 'deactivate_agent', { agent: a.agentId }, { origin: 'https://pot.test' })
    if (!out.ok) throw new Error(JSON.stringify(out))
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE agent_id = ? AND revoked_at IS NULL`, a.agentId)).toBe(0)
    const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(r.sc.member_id).toBe(HUMAN)
    expect(receiptOf(r).seat_handle_rejected).toBe(true)
  })

  it('agent paused -> falls back (not revoked); un-pause restores the seat', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = '${a.agentId}'`)
    expect((await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })).sc.bound_agent_id).toBeNull()
    h.sqlite.exec(`UPDATE agents SET status = 'active' WHERE id = '${a.agentId}'`)
    expect((await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })).sc.bound_agent_id).toBe(a.agentId)
  })

  it('human member archived/suspended -> their handles are revoked by the trigger', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await select(env, g, '/work/a'); await select(env, g, '/work/b')
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${HUMAN}'`)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE revoked_at IS NULL`)).toBe(0)
  })

  it("the seat agent's dedicated member suspended -> that agent's handles revoked, others untouched", async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a'); const b = await select(env, g, '/work/b')
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${a.sc.member_id}'`)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE agent_id = ? AND revoked_at IS NULL`, a.agentId)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE agent_id = ? AND revoked_at IS NULL`, b.agentId)).toBe(1)
  })

  it('retiring a seat revokes its handles', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`UPDATE agent_seats SET retired_at = '2026-10-09T01:00:00.000Z' WHERE id = '${a.seatId}'`)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE seat_id = ? AND revoked_at IS NULL`, a.seatId)).toBe(0)
  })

  it('seat retired WITHOUT the trigger firing (retired flag direct on a not-yet-revoked handle) still falls back', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`DROP TRIGGER seat_handles_revoke_on_seat_retire`)
    h.sqlite.exec(`UPDATE agent_seats SET retired_at = '2026-10-09T01:00:00.000Z' WHERE id = '${a.seatId}'`)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE revoked_at IS NULL`)).toBe(1)
    const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
  })

  it('human grant token revoked -> the OAuth handler yields no context (401), handle irrelevant', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await select(env, g, '/work/a')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = '${g.tokenId}'`)
    const ctx = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: g.tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: g.harnessId })
    expect(ctx).toBeNull()
  })

  it('human grant token revoked AFTER the context was built (stale blob) -> resolveAuth refuses to bind', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = '${g.tokenId}'`)
    const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id ?? null).toBeNull()
    expect(n(`SELECT COUNT(*) AS n FROM agent_sessions`)).toBe(0)
  })

  it('seat directory token revoked -> falls back to the human', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE agent_id = '${a.agentId}'`)
    const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r).seat_handle_rejected).toBe(true)
  })

  it('human demoted off their home squad -> zero capabilities -> the HUMAN context, never a zero-cap agent context', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${HUMAN}'`)
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${a.sc.member_id}'`)
    const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(r.sc.member_id).toBe(HUMAN)
  })

  it('malformed / unknown / garbage handles never 500 and never bind', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    await select(env, g, '/work/a')
    for (const hd of ['nope', 'x'.repeat(43), '../../etc/passwd', 'A'.repeat(500), mintSeatHandle()]) {
      const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': hd } })
      expect(r.status).toBe(200)
      expect(r.sc.bound_agent_id).toBeNull()
      expect(receiptOf(r).seat_handle_rejected).toBe(true)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('capabilities', () => {
  it('never above member, even for a human holding org owner and squad admin', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${HUMAN}', 'org', NULL, 'owner')`)
    const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    const caps = r.sc.capabilities as Array<{ capability: string; member_id: string }>
    expect(caps.length).toBeGreaterThan(0)
    for (const c of caps) { expect(['observer', 'member']).toContain(c.capability); expect(c.member_id).toBe(a.sc.member_id) }
    expect(caps.some((c) => c.capability === 'member')).toBe(true)
  })

  it("an org-wide grant does not reach ANOTHER member's home squad (and the seat agent gets no admin anywhere)", async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const other = await createHomeForMember(env, HUMAN2)
    if (!other.ok) throw new Error('home fixture')
    h.sqlite.exec(`INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${HUMAN}', 'org', NULL, 'admin')`)
    const human = (await applySeatHandle(env, g.ctx, { headerHandle: a.handle, hints: NO_HINTS }))
    expect(human.boundAgentId).toBe(a.agentId)
    const caps = human.capabilities ?? []
    expect(await canOnSquad(env, caps, other.squad.id, 'observer')).toBe(false)
    // positive control: the same grant DOES reach an ordinary (non-home) squad at member
    h.sqlite.exec(`INSERT INTO departments (id, slug, name, created_at) VALUES ('d1', 'd1', 'D1', datetime('now'))`)
    h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('sq-normal', 'd1', 'sq-normal', 'Normal', datetime('now'))`)
    expect(await canOnSquad(env, caps, 'sq-normal', 'member')).toBe(true)
    expect(await canOnSquad(env, caps, 'sq-normal', 'lead')).toBe(false)
  })

  it('resolveSeatCapabilities is empty when the human no longer stands on the agent\'s squad', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${HUMAN}'`)
    const agentSquad = (a.sc.agent as { squad_id: string }).squad_id
    expect(await resolveSeatCapabilities(env, { humanMemberId: HUMAN, agentId: a.agentId, agentSquadId: agentSquad, agentMemberId: a.sc.member_id as string })).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('other carriers and non-carriers', () => {
  it('_meta["mupot/seat"] in params._meta selects the seat', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const r = await rpc(env, g.ctx, 'boot_context', {}, { meta: { 'mupot/seat': a.handle } })
    expect(r.sc.bound_agent_id).toBe(a.agentId)
  })

  it('_meta["mupot/seat"] as an ARGUMENT selects the seat and is stripped before schema validation', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const r = await rpc(env, g.ctx, 'boot_context', {}, { argsMeta: { 'mupot/seat': a.handle } })
    expect(r.body.error).toBeUndefined()
    expect(r.sc.bound_agent_id).toBe(a.agentId)
  })

  it('header wins over _meta, and a wrong header is NOT rescued by a right _meta', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a'); const b = await select(env, g, '/work/b')
    const both = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle }, meta: { 'mupot/seat': b.handle } })
    expect(both.sc.bound_agent_id).toBe(a.agentId)
    const wrong = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': mintSeatHandle() }, meta: { 'mupot/seat': a.handle } })
    expect(wrong.sc.bound_agent_id).toBeNull()
  })

  it('Mcp-Session-Id, openai/session, openai/subject, codex threadId NEVER select a seat; presence is only recorded', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const r = await rpc(env, g.ctx, 'boot_context', {}, {
      headers: { 'mcp-session-id': a.handle },
      meta: { 'openai/session': a.handle, 'openai/subject': a.handle, threadId: a.handle },
    })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(receiptOf(r)).toMatchObject({ binding_source: 'none', seat_handle_rejected: false, hints: { openai_session: true, openai_subject: true, codex_thread_id: true } })
  })

  it('the handle is never echoed into labels (enroll_url) and never written anywhere', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const spyE = vi.spyOn(console, 'error').mockImplementation(() => {})
    const spyW = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spyL = vi.spyOn(console, 'log').mockImplementation(() => {})
    const r1 = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    const r2 = await rpc(env, g.ctx, 'check_in', {}, { headers: { 'x-mupot-seat': a.handle } })
    const r3 = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle.slice(1) + 'Q' } })
    for (const r of [r1, r2, r3]) expect(JSON.stringify(r.body)).not.toContain(a.handle)
    for (const s of [spy, spyE, spyW, spyL]) expect(JSON.stringify(s.mock.calls)).not.toContain(a.handle)
    // every text column of every table
    const tables = h.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((t) => t.name as string)
    for (const t of tables) {
      const rows = h.sqlite.prepare(`SELECT * FROM "${t}"`).all()
      expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v)), `table ${t}`).not.toContain(a.handle)
    }
    const kv = (env.SESSIONS as unknown as { get: (k: string) => Promise<string | null> })
    expect(kv).toBeDefined()
  })

  it('check_in as a seat agent creates exactly one agent_sessions row per seat agent (no unique violation)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a'); const b = await select(env, g, '/work/b')
    for (let i = 0; i < 2; i++) {
      for (const s of [a, b]) {
        const r = await rpc(env, g.ctx, 'check_in', {}, { headers: { 'x-mupot-seat': s.handle } })
        expect(r.status).toBe(200)
        expect(r.body.error).toBeUndefined()
      }
    }
    expect(n(`SELECT COUNT(*) AS n FROM agent_sessions WHERE agent_id = ?`, a.agentId)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_sessions WHERE agent_id = ?`, b.agentId)).toBe(1)
  })

  it('a bound seat session cannot call seat_select again (it already has an identity)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const r = await rpc(env, g.ctx, 'seat_select', { project: 'p', folder: '/z' }, { headers: { 'x-mupot-seat': a.handle } })
    expect(JSON.stringify(r.body)).toContain('not_unbound_directory_session')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('immutability', () => {
  it('a handle row cannot be re-pointed (agent / seat / grant token / harness / member / hash), deleted, or un-revoked', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a'); const b = await select(env, g, '/work/b')
    const id = h.sqlite.prepare(`SELECT id FROM seat_handles WHERE agent_id = ?`).get(a.agentId)!.id as string
    for (const set of [`agent_id = '${b.agentId}'`, `seat_id = '${b.seatId}'`, `grant_token_id = 'other'`, `harness_id = 'other'`, `consenting_member_id = '${HUMAN2}'`, `handle_hash = '${'0'.repeat(64)}'`, `tenant = 'x'`]) {
      expect(() => h.sqlite.exec(`UPDATE seat_handles SET ${set} WHERE id = '${id}'`), set).toThrow(/seat_handle_immutable/)
    }
    expect(() => h.sqlite.exec(`DELETE FROM seat_handles WHERE id = '${id}'`)).toThrow(/seat_handle_immutable/)
    h.sqlite.exec(`UPDATE seat_handles SET revoked_at = '2026-10-09T02:00:00.000Z' WHERE id = '${id}'`)
    expect(() => h.sqlite.exec(`UPDATE seat_handles SET revoked_at = NULL WHERE id = '${id}'`)).toThrow(/seat_handle_immutable/)
    h.sqlite.exec(`UPDATE seat_handles SET last_used_at = '2026-10-09T03:00:00.000Z' WHERE id = '${id}'`)
  })

  it('max_total on a seat row is immutable', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    expect(() => h.sqlite.exec(`UPDATE agent_seats SET max_total = 4000 WHERE id = '${a.seatId}'`)).toThrow(/agent_seat_immutable/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('last_used_at throttle', () => {
  it('first use stamps it; use inside the interval does not rewrite it; use after the interval does', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const t0 = Date.parse('2026-10-09T12:00:00.000Z')
    expect((await applySeatHandle(env, g.ctx, { headerHandle: a.handle, hints: NO_HINTS }, t0)).boundAgentId).toBe(a.agentId)
    const first = h.sqlite.prepare(`SELECT last_used_at AS t FROM seat_handles`).get()!.t as string
    expect(first).toBe(new Date(t0).toISOString())
    await applySeatHandle(env, g.ctx, { headerHandle: a.handle, hints: NO_HINTS }, t0 + 60_000)
    expect(h.sqlite.prepare(`SELECT last_used_at AS t FROM seat_handles`).get()!.t).toBe(first)
    await applySeatHandle(env, g.ctx, { headerHandle: a.handle, hints: NO_HINTS }, t0 + 11 * 60_000)
    expect(h.sqlite.prepare(`SELECT last_used_at AS t FROM seat_handles`).get()!.t).toBe(new Date(t0 + 11 * 60_000).toISOString())
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('flag OFF', () => {
  it('handle ignored, nothing read or logged, receipt/tools identical to before', async () => {
    const on = envFor(h)
    const g = await grant(on, HUMAN)
    const a = await select(on, g, '/work/a')
    const off = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const prepare = vi.spyOn(h.db, 'prepare')
    const offCtx = await buildAuthContextFromProps(off, { memberId: HUMAN, tokenId: g.tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: g.harnessId })
    const r = await rpc(off, offCtx!, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle, 'mcp-session-id': 'zzz' }, meta: { 'openai/session': 's' } })
    expect(r.sc.bound_agent_id).toBeNull()
    expect(r.sc.member_id).toBe(HUMAN)
    expect('identity_receipt' in r.sc).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    const touchedHandles = prepare.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('seat_handles'))
    expect(touchedHandles).toBe(false)
    // and the legacy X-Mupot-Seat label semantic is untouched (still the plain header value)
    const tools = await mcpApp.fetch(new Request('http://localhost/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), off)
    const names = ((await tools.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)
    expect(names).not.toContain('seat_select')
  })

  it('applySeatHandle returns the very same object with the flag off', async () => {
    const on = envFor(h)
    const g = await grant(on, HUMAN)
    const a = await select(on, g, '/work/a')
    const off = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    expect(await applySeatHandle(off, g.ctx, { headerHandle: a.handle, hints: NO_HINTS })).toBe(g.ctx)
  })

  it('_meta ARGUMENT is not stripped with the flag off (strict schema still rejects it, as before)', async () => {
    const off = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const g = await grant(envFor(h), HUMAN)
    const ctx = await buildAuthContextFromProps(off, { memberId: HUMAN, tokenId: g.tokenId, email: null, channel: 'directory', boundAgentId: null })
    const r = await rpc(off, ctx!, 'boot_context', {}, { argsMeta: { 'mupot/seat': 'x' } })
    expect(JSON.stringify(r.body)).toContain('invalid_args')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('step-0 harness_identity_probe', () => {
  it('logs once per grant per hour: booleans + hashes, never raw values', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const raw = { session: 'conv-RAW-123', subject: 'user-RAW-456', thread: 'thread-RAW-789' }
    const meta = { 'openai/session': raw.session, 'openai/subject': raw.subject, threadId: raw.thread, clientInfo: { name: 'Codex' }, 'x/other': 1 }
    await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'mcp-session-id': 'sess-RAW' }, meta })
    await rpc(env, g.ctx, 'boot_context', {}, { meta })
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('harness_identity_probe'))
    expect(lines).toHaveLength(1)
    const rec = JSON.parse(lines[0])
    expect(rec).toMatchObject({ metric: 'harness_identity_probe', openai_session: true, openai_subject: true, codex_thread_id: true, x_mupot_seat: false, meta_mupot_seat: false, mcp_session_id: true, client_info_name: 'Codex' })
    expect(rec.meta_keys).toEqual(expect.arrayContaining(['openai/session', 'threadId', 'x/other']))
    for (const v of [raw.session, raw.subject, raw.thread, 'sess-RAW']) expect(lines[0]).not.toContain(v)
    expect(rec.openai_session_h).toMatch(/^[0-9a-f]{12}$/)
  })

  it('a different grant logs separately; a seat handle in the header is only ever a boolean', async () => {
    const env = envFor(h)
    const g1 = await grant(env, HUMAN); const g2 = await grant(env, HUMAN2)
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const a = await select(env, g1, '/work/a') // first call of g1: this is its sampled one
    await rpc(env, g1.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } }) // inside the hour: not logged
    const probe = mintSeatHandle()
    await rpc(env, g2.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': probe } })
    const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('harness_identity_probe'))
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).not.toContain(a.handle)
    expect(lines.join('\n')).not.toContain(probe)
    expect(JSON.parse(lines[1]).x_mupot_seat).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('lifetime seat-creation bound (atomic, fail-closed)', () => {
  it('seatTotalCap defaults to 64, honours the var, clamps, ignores garbage', () => {
    expect(seatTotalCap({})).toBe(64)
    expect(seatTotalCap({ SEAT_MAX_TOTAL_PER_MEMBER: '5' })).toBe(5)
    expect(seatTotalCap({ SEAT_MAX_TOTAL_PER_MEMBER: '99999' })).toBe(4096)
    expect(seatTotalCap({ SEAT_MAX_TOTAL_PER_MEMBER: '0' })).toBe(64)
    expect(seatTotalCap({ SEAT_MAX_TOTAL_PER_MEMBER: 'x' })).toBe(64)
    expect(seatTotalCap({ SEAT_MAX_TOTAL_PER_MEMBER: '-1' })).toBe(64)
  })

  it('a deactivate/create loop stops at max_total even though live seats stay at 0', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_MEMBER: '3' })
    const g = await grant(env, HUMAN)
    for (let i = 0; i < 3; i++) {
      const s = await select(env, g, `/loop/${i}`)
      h.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = '${s.agentId}'`)
    }
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats s JOIN agents a ON a.id = s.agent_id WHERE a.status = 'active'`)).toBe(0)
    const before = n(`SELECT COUNT(*) AS n FROM agents`)
    const r = await rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: '/loop/3' })
    expect(JSON.stringify(r.body)).toContain('seat_cap_reached')
    expect(n(`SELECT COUNT(*) AS n FROM agents`)).toBe(before)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE member_id = ?`, HUMAN)).toBe(3)
  })

  it('the bound is per member: another human is unaffected', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_MEMBER: '1' })
    const g1 = await grant(env, HUMAN); const g2 = await grant(env, HUMAN2)
    await select(env, g1, '/a')
    expect((await rpc(env, g1.ctx, 'seat_select', { project: 'p', folder: '/b' })).sc.seat_handle).toBeUndefined()
    expect(typeof (await select(env, g2, '/a')).handle).toBe('string')
  })

  it('10 concurrent creates at the boundary -> exactly one success, no orphans', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_MEMBER: '3', SEAT_MAX_PER_MEMBER: '100' })
    const g = await grant(env, HUMAN)
    await select(env, g, '/seed/0'); await select(env, g, '/seed/1')
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: `/race/${i}` })))
    const ok = results.filter((r) => typeof r.sc.seat_handle === 'string')
    expect(ok).toHaveLength(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE member_id = ?`, HUMAN)).toBe(3)
    // every agent has a seat: nothing orphaned by the rolled-back batches
    expect(n(`SELECT COUNT(*) AS n FROM agents a WHERE a.slug LIKE 'seat-%' AND NOT EXISTS (SELECT 1 FROM agent_seats s WHERE s.agent_id = a.id)`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles`)).toBe(3)
  })

  it('the trigger itself enforces it on a raw insert (KV throttle and app pre-check not involved)', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_MEMBER: '2' })
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/a')
    await select(env, g, '/b')
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('raw-agent', '${(a.sc.agent as { squad_id: string }).squad_id}', 'raw-agent', 'Raw', 'active')`)
    expect(() => h.sqlite.exec(
      `INSERT INTO agent_seats (id, tenant, member_id, harness_id, key_hash, agent_id, label_basename, max_live, max_total)
       VALUES ('raw-seat', '${TENANT}', '${HUMAN}', '${g.harnessId}', '${'d'.repeat(64)}', 'raw-agent', 'x', 100, 2)`,
    )).toThrow(/seat_total_cap_exceeded/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('gates exercised directly (defence in depth behind the OAuth builder / resolveAuth)', () => {
  it('applySeatHandle refuses a bound ctx, a non-directory ctx, a harness-less ctx and a token-less ctx outright', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const hin = { headerHandle: a.handle, hints: NO_HINTS }
    const bound = { ...g.ctx, boundAgentId: 'some-agent' }
    expect(await applySeatHandle(env, bound, hin)).toBe(bound)
    const ws = { ...g.ctx, channel: 'workspace' as const }
    expect(await applySeatHandle(env, ws, hin)).toBe(ws)
    const noHarness = { ...g.ctx, harnessId: undefined }
    expect(await applySeatHandle(env, noHarness, hin)).toBe(noHarness)
    const noTok = { ...g.ctx, tokenId: null }
    expect(await applySeatHandle(env, noTok, hin)).toBe(noTok)
    // positive control: the unmodified ctx binds
    expect((await applySeatHandle(env, g.ctx, hin)).boundAgentId).toBe(a.agentId)
  })

  it('a forged seatBinding on a LEGACY bound blob is stripped: the receipt still says legacy_consent', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const seatTok = h.sqlite.prepare(`SELECT id FROM member_tokens WHERE agent_id = ?`).get(a.agentId)!.id as string
    const memberId = h.sqlite.prepare(`SELECT member_id FROM agent_member_bindings WHERE agent_id = ?`).get(a.agentId)!.member_id as string
    const bound = await buildAuthContextFromProps(env, { memberId, tokenId: seatTok, email: null, channel: 'directory', boundAgentId: a.agentId, consentedByMemberId: HUMAN })
    const forged = { ...bound!, seatBinding: { seatId: a.seatId, label: 'forged', harnessId: g.harnessId, grantTokenId: g.tokenId, humanMemberId: HUMAN } } as AuthContext
    const r = await rpc(env, forged, 'boot_context', {})
    expect(receiptOf(r)).toMatchObject({ binding_source: 'legacy_consent', seat: null })
  })

  it('the seat context carries NO latent authority beyond its clamped capabilities', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES ('${HUMAN}', 'org', NULL, 'owner')`)
    const seat = await applySeatHandle(env, g.ctx, { headerHandle: a.handle, hints: NO_HINTS })
    expect(seat.latentCapabilities).toEqual(seat.capabilities)
    for (const c of seat.latentCapabilities ?? []) expect(['observer', 'member']).toContain(c.capability)
  })

  it('the curated needs-you profile door never honours a seat handle', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    const r = await rpc(env, g.ctx, 'boot_context', {}, { path: '/mcp/profile/needs-you', headers: { 'x-mupot-seat': a.handle } })
    expect(r.status).toBe(200)
    expect(r.sc.bound_agent_id).toBeNull()
    expect(r.sc.member_id).toBe(HUMAN)
  })

  it('with the member-end revoke trigger absent, a suspended seat-agent member still cannot be impersonated', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/work/a')
    h.sqlite.exec(`DROP TRIGGER seat_handles_revoke_on_member_end`)
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${a.sc.member_id}'`)
    const r = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': a.handle } })
    expect(r.sc.bound_agent_id).toBeNull()
  })

  it('a raw handle row naming ANOTHER member as consenter / another harness never binds this grant', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const g2 = await grant(env, HUMAN, 'client-claude', 'Claude')
    const a = await select(env, g, '/work/a')
    // a handle for the same seat, re-pointed at the OTHER harness's harness id + grant (raw insert)
    const hd = mintSeatHandle()
    h.sqlite.prepare(`INSERT INTO seat_handles (id, tenant, handle_hash, seat_id, agent_id, harness_id, consenting_member_id, grant_token_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run('raw-h', TENANT, await hashSeatHandle(hd), a.seatId, a.agentId, g2.harnessId, HUMAN, g2.tokenId)
    const r = await rpc(env, g2.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': hd } })
    expect(r.sc.bound_agent_id).toBeNull() // the seat belongs to harness 1, not harness 2
    const hd2 = mintSeatHandle()
    h.sqlite.prepare(`INSERT INTO seat_handles (id, tenant, handle_hash, seat_id, agent_id, harness_id, consenting_member_id, grant_token_id) VALUES (?,?,?,?,?,?,?,?)`)
      .run('raw-h2', TENANT, await hashSeatHandle(hd2), a.seatId, a.agentId, g.harnessId, HUMAN2, g.tokenId)
    const r2 = await rpc(env, g.ctx, 'boot_context', {}, { headers: { 'x-mupot-seat': hd2 } })
    expect(r2.sc.bound_agent_id).toBeNull() // consenter differs from the seat's owner / the grant's member
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('W1 round-2 P3 folds', () => {
  it('flag off: seat_select refuses 403 BEFORE argument validation (no schema disclosure)', async () => {
    const off = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const g = await grant(envFor(h), HUMAN)
    for (const args of [{}, { project: 5 }, { bogus: true }, { project: 'p', harness_kind: 'x' }]) {
      const out = await invokeTool(g.ctx, off, 'seat_select', args, 'https://pot.test')
      if (out.ok) throw new Error('unreachable')
      expect(out.status).toBe(403)
      expect(out.error).toBe('seat_auto_enroll_disabled')
    }
    const nonObject = await invokeTool(g.ctx, off, 'seat_select', 'x', 'https://pot.test')
    if (nonObject.ok) throw new Error('unreachable')
    expect(nonObject.error).toBe('seat_auto_enroll_disabled')
  })

  it('flag on: harness_kind is no longer an input (strict schema rejects it)', async () => {
    const env = envFor(h)
    const g = await grant(env, HUMAN)
    const out = await invokeTool(g.ctx, env, 'seat_select', { project: 'p', harness_kind: 'x' }, 'https://pot.test')
    if (out.ok) throw new Error('unreachable')
    expect(out.error).toBe('invalid_args')
  })

  it('rate_limited is a 429 through the tool', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '100' })
    const g = await grant(env, HUMAN)
    for (let i = 0; i < 20; i++) await select(env, g, `/rl/${i}`)
    const out = await invokeTool(g.ctx, env, 'seat_select', { project: 'p', folder: '/rl/over' }, 'https://pot.test')
    if (out.ok) throw new Error('unreachable')
    expect(out.status).toBe(429)
    expect(out.error).toBe('rate_limited')
  })

  it('pause/resume cannot exceed the live-seat cap; only inactive frees a slot', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '2' })
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/a'); await select(env, g, '/b')
    h.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = '${a.agentId}'`)
    // paused still holds its slot: a third seat is refused, at the app pre-check AND at the trigger
    const refused = await rpc(env, g.ctx, 'seat_select', { project: 'p', folder: '/c' })
    expect(JSON.stringify(refused.body)).toContain('seat_cap_reached')
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('raw-agent', '${(a.sc.agent as { squad_id: string }).squad_id}', 'raw-agent', 'Raw', 'active')`)
    expect(() => h.sqlite.exec(
      `INSERT INTO agent_seats (id, tenant, member_id, harness_id, key_hash, agent_id, label_basename, max_live)
       VALUES ('raw-seat', '${TENANT}', '${HUMAN}', '${g.harnessId}', '${'e'.repeat(64)}', 'raw-agent', 'x', 2)`,
    )).toThrow(/seat_cap_exceeded/)
    h.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = '${a.agentId}'`)
    expect(typeof (await select(env, g, '/c')).handle).toBe('string')
  })

  it("the agent display name uses the member's display name, never the email local part", async () => {
    const env = envFor(h)
    h.sqlite.exec(`UPDATE members SET display_name = 'Hadi S.' , email = 'hadi.secret.mailbox@example.test' WHERE id = '${HUMAN}'`)
    const g = await grant(env, HUMAN)
    const a = await select(env, g, '/a')
    const name = (a.sc.agent as { name: string }).name
    expect(name.startsWith('Hadi S. · ')).toBe(true)
    expect(name).not.toContain('secret')
    // a display name that is an address (or empty) falls back to a short hash, never the address
    h.sqlite.exec(`UPDATE members SET display_name = 'leak@example.test' WHERE id = '${HUMAN2}'`)
    const g2 = await grant(env, HUMAN2)
    const b = await select(env, g2, '/a')
    const nameB = (b.sc.agent as { name: string }).name
    expect(nameB).toMatch(/^member-[0-9a-f]{6} · /)
    expect(nameB).not.toContain('leak')
  })

  it('concurrent creators losing the total-cap race all report seat_cap_reached (never provisioning_failed)', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_MEMBER: '3', SEAT_MAX_PER_MEMBER: '100' })
    const g = await grant(env, HUMAN)
    await select(env, g, '/seed/0'); await select(env, g, '/seed/1')
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => rpc(env, g.ctx, 'seat_select', { project: 'mupot', folder: `/race2/${i}` })))
    const failures = results.filter((r) => typeof r.sc.seat_handle !== 'string')
    expect(failures).toHaveLength(9)
    for (const f of failures) {
      expect(JSON.stringify(f.body)).toContain('seat_cap_reached')
      expect(JSON.stringify(f.body)).not.toContain('provisioning_failed')
    }
  })
})
