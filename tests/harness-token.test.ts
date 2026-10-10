// tests/harness-token.test.ts — mupot#1794 W4: a member-scoped TOKEN as a harness credential.
//
// Real sqlite D1 from the full committed migration chain. The mint goes through the real
// POST /members/:id/tokens route (membersApp, session cookie); the session goes through the two real
// bearer doors: resolveExternalToken -> buildAuthContextFromProps (prod POST /mcp) and
// mcpApp(Authorization) -> authenticateMember -> resolveSeatSession (direct mount).
//
// Not proven here: the cloudflare:workers entrypoint itself; real D1 concurrency (Promise.all over a
// serialized sqlite proves each write is ONE atomic statement/batch, not cross-isolate interleaving).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { membersApp } from '../src/members'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { buildAuthContextFromProps, resolveExternalToken } from '../src/mcp/oauth-authorize'
import { seatSelect, type SeatSelectAuth } from '../src/members/seat-select'
import { resolveMemberByToken, memberTokenHashIsLive, hashMemberToken } from '../src/auth/member-bearer'
import { prepareAgentCreate } from '../src/org/service'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'
const HUMAN2 = 'member-human-2'
const OWNER = 'member-owner'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

const SESSIONS: Record<string, string> = {
  'sess:admin-sid': JSON.stringify({ userId: 'u-admin', email: 'admin@x.test', role: 'admin', createdAt: '2026-01-01T00:00:00Z' }),
  'sess:member-sid': JSON.stringify({ userId: 'u-mem', email: 'mem@x.test', role: 'member', createdAt: '2026-01-01T00:00:00Z' }),
}

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  const kv = memoryKv()
  for (const [k, v] of Object.entries(SESSIONS)) void kv.put(k, v)
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: kv, OAUTH_KV: { get: async () => null, put: async () => undefined },
    SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '100', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

function seedMember(id: string, status = 'active'): void {
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${id}', '${id}@example.test', 'Human ${id}', '${status}', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
}

interface Minted { raw: string; tokenId: string; harnessId: string }

async function mint(env: Env, memberId: string, body: Record<string, unknown> = {}, cookie = 'admin-sid'): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await membersApp.request(`/members/${memberId}/tokens`, {
    method: 'POST',
    headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'ci-runner', harness_kind: 'ci', ...body }),
  }, env)
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

async function mintOk(env: Env, memberId: string, body: Record<string, unknown> = {}): Promise<Minted> {
  const r = await mint(env, memberId, body)
  if (r.status !== 201) throw new Error(`mint failed ${r.status} ${JSON.stringify(r.json)}`)
  const t = r.json.token as { raw: string; id: string }
  const hr = r.json.harness as { id: string }
  return { raw: t.raw, tokenId: t.id, harnessId: hr.id }
}

/** The prod door: POST /mcp with a mupot_ bearer -> resolveExternalToken -> props -> AuthContext. */
async function externalCtx(env: Env, raw: string): Promise<AuthContext | null> {
  const r = await resolveExternalToken(env, raw)
  if (!r) return null
  return buildAuthContextFromProps(env, r.props)
}

interface Rpc { status: number; body: Record<string, unknown>; sc: Record<string, unknown> }

async function rpcCtx(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Rpc> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
}

/** The direct-mount door: Authorization: Bearer <raw> -> authenticateMember. */
async function rpcBearer(env: Env, raw: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}): Promise<Rpc> {
  const res = await mcpApp.fetch(new Request('https://pot.test/', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${raw}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }), env)
  const text = await res.text()
  if (!text.startsWith('{')) throw new Error(`non-json ${res.status}: ${text.slice(0, 300)}`)
  const body = JSON.parse(text) as Record<string, unknown>
  return { status: res.status, body, sc: ((body.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {} }
}

async function select(env: Env, raw: string, folder: string, project = 'mupot'): Promise<{ handle: string; agentId: string; seatId: string; disposition: string }> {
  const r = await rpcBearer(env, raw, 'seat_select', { project, folder })
  const sc = r.sc
  if (typeof sc.seat_handle !== 'string') throw new Error(`no handle: ${JSON.stringify(r.body)}`)
  return { handle: sc.seat_handle, agentId: (sc.agent as { id: string }).id, seatId: (sc.seat as { id: string }).id, disposition: sc.disposition as string }
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  seedMember(HUMAN); seedMember(HUMAN2); seedMember(OWNER)
  h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-owner', '${OWNER}', 'org', NULL, 'owner')`)
  resetHarnessProbeSampling()
})
afterEach(() => h.close())

// ════════════════════════════════════════════════════════════════════════════
describe('mint door — the SAME authority checks as every member-token mint', () => {
  it('org admin mints a harness token: unbound directory token + token-kind harness, atomically, raw shown once', async () => {
    const env = envFor(h)
    const r = await mint(env, HUMAN, { harness_kind: 'codex', label: 'codex cloud env' })
    expect(r.status).toBe(201)
    const t = r.json.token as Record<string, unknown>
    expect(String(t.raw)).toMatch(/^mupot_[0-9a-f]{64}$/)
    const tok = h.sqlite.prepare(`SELECT * FROM member_tokens WHERE id = ?`).get(t.id)!
    expect(tok).toMatchObject({ member_id: HUMAN, channel: 'directory', agent_id: null, tenant: TENANT })
    expect(tok.expires_at).not.toBeNull() // standard 30-day default, never non-expiring
    expect(tok.token_hash).toBe(await hashMemberToken(String(t.raw)))
    expect(JSON.stringify(h.sqlite.prepare(`SELECT * FROM member_tokens`).all())).not.toContain(String(t.raw))
    const hr = h.sqlite.prepare(`SELECT * FROM harnesses`).get()!
    expect(hr).toMatchObject({ credential_kind: 'token', token_id: t.id, member_id: HUMAN, kind: 'codex', client_name: 'codex cloud env', oauth_client_id: `token:${t.id}` })
  })

  it('flag off: refused (404 seat_auto_enroll_disabled), zero rows', async () => {
    const env = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    const r = await mint(env, HUMAN)
    expect(r.status).toBe(404)
    expect(r.json.error).toBe('seat_auto_enroll_disabled')
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM harnesses`)).toBe(0)
  })

  it('org-admin floor: a plain member session cannot mint (403), zero rows', async () => {
    const r = await mint(envFor(h), HUMAN, {}, 'member-sid')
    expect(r.status).toBe(403)
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens`)).toBe(0)
  })

  it('target-rank ceiling: an admin cannot mint a harness token for an org OWNER (403), zero rows', async () => {
    const r = await mint(envFor(h), OWNER)
    expect(r.status).toBe(403)
    expect(r.json.reason).toBe('cannot_affect_higher_rank')
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM harnesses`)).toBe(0)
  })

  it.each([
    ['unknown kind', { harness_kind: 'mainframe' }, 'invalid_harness_kind'],
    ['channel supplied alongside', { channel: 'workspace' }, 'channel_not_allowed_with_harness_kind'],
    ['directory channel supplied', { channel: 'directory' }, 'channel_not_allowed_with_harness_kind'],
    ['missing label', { label: '  ' }, 'harness_label_required'],
    ['non_expiring', { non_expiring: true }, 'non_expiring_not_allowed'],
    ['zero expiry', { expires_in_days: 0 }, 'invalid_expiry'],
    ['string expiry', { expires_in_days: '30' }, 'invalid_expiry'],
    ['huge expiry', { expires_in_days: 9999 }, 'invalid_expiry'],
  ])('refuses %s', async (_name, body, error) => {
    const r = await mint(envFor(h), HUMAN, body as Record<string, unknown>)
    expect(r.status).toBe(400)
    expect(r.json.error).toBe(error)
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens`)).toBe(0)
  })

  it('a suspended member gets no harness token', async () => {
    seedMember('member-susp', 'suspended')
    const r = await mint(envFor(h), 'member-susp')
    expect(r.status).toBe(409)
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens`)).toBe(0)
  })

  it('the ordinary mint is untouched: workspace default still works, directory still refused', async () => {
    const env = envFor(h)
    const ok = await membersApp.request(`/members/${HUMAN}/tokens`, { method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x' }) }, env)
    expect(ok.status).toBe(201)
    const bad = await membersApp.request(`/members/${HUMAN}/tokens`, { method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'x', channel: 'directory' }) }, env)
    expect(bad.status).toBe(400)
  })

  it('token + harness are ONE batch: a refused harness insert leaves no orphan token', async () => {
    const env = envFor(h)
    h.sqlite.exec(`CREATE TRIGGER test_block_harness BEFORE INSERT ON harnesses BEGIN SELECT RAISE(ABORT, 'boom'); END`)
    const r = await mint(env, HUMAN)
    expect(r.status).toBe(500)
    expect(n(`SELECT COUNT(*) AS n FROM member_tokens`)).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('the credential is a ZERO-STANDING harness session', () => {
  it('prod door (resolveExternalToken): unbound directory, no capabilities, harness pointer set', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    const ctx = await externalCtx(env, m.raw)
    expect(ctx).toMatchObject({ memberId: HUMAN, channel: 'directory', boundAgentId: null, harnessId: m.harnessId, tokenId: m.tokenId })
    expect(ctx?.capabilities).toEqual([])
  })

  it('even a member who holds org admin gets ZERO capabilities from the token (B1 ceiling)', async () => {
    const env = envFor(h)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h1', '${HUMAN}', 'org', NULL, 'admin')`)
    const m = await mintOk(env, HUMAN)
    expect((await externalCtx(env, m.raw))?.capabilities).toEqual([])
    const r = await rpcBearer(env, m.raw, 'boot_context')
    expect(r.sc.capabilities).toEqual([])
    expect(r.sc.channel).toBe('directory')
  })

  it('flag OFF: the token is inert at BOTH doors (refused like a bad token), flag ON it works', async () => {
    const on = envFor(h)
    const m = await mintOk(on, HUMAN)
    const off = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    expect(await resolveExternalToken(off, m.raw)).toBeNull()
    expect((await rpcBearer(off, m.raw, 'boot_context')).status).toBe(401)
    expect(await resolveExternalToken(on, m.raw)).not.toBeNull()
    expect((await rpcBearer(on, m.raw, 'boot_context')).status).toBe(200)
  })

  it('REST bearer surfaces refuse it: it can never act as the human\'s full authority', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    expect(await resolveMemberByToken(env, m.raw)).toBeNull()
    expect(await memberTokenHashIsLive(env, await hashMemberToken(m.raw), HUMAN)).toBe(false)
  })

  it('a non-harness workspace token still resolves everywhere exactly as before (control)', async () => {
    const env = envFor(h)
    const res = await membersApp.request(`/members/${HUMAN}/tokens`, { method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'ws' }) }, env)
    const raw = ((await res.json()) as { token: { raw: string } }).token.raw
    expect(await resolveMemberByToken(env, raw)).toMatchObject({ memberId: HUMAN })
    const ctx = await externalCtx(env, raw)
    expect(ctx?.harnessId).toBeUndefined()
    expect(ctx?.channel).toBe('workspace')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('seat_select behind a token harness', () => {
  it('each thread behind the ONE shared token gets its own agent; same thread -> same agent', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    const a = await select(env, m.raw, '/work/a')
    const b = await select(env, m.raw, '/work/b')
    const a2 = await select(env, m.raw, '/work/a')
    expect(a.disposition).toBe('created')
    expect(a.agentId).not.toBe(b.agentId)
    expect(a2.agentId).toBe(a.agentId)
    expect(a2.disposition).toBe('existing')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ?`, m.harnessId)).toBe(2)
    for (const [s, label] of [[a, 'a'], [b, 'b']] as const) {
      const r = await rpcBearer(env, m.raw, 'boot_context', {}, { 'x-mupot-seat': s.handle })
      expect(r.sc.bound_agent_id).toBe(s.agentId)
      const receipt = r.sc.identity_receipt as Record<string, unknown>
      expect(receipt).toMatchObject({ binding_source: 'seat_handle', human: { member_id: HUMAN }, harness: { id: m.harnessId, kind: 'ci', credential_kind: 'token' }, seat: { label } })
    }
  })

  it('the prod door carries the same handle semantics (internal-header hop)', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    const ctx = (await externalCtx(env, m.raw))!
    const sel = await rpcCtx(env, ctx, 'seat_select', { project: 'p', folder: '/x' })
    const handle = sel.sc.seat_handle as string
    expect(typeof handle).toBe('string')
    const r = await rpcCtx(env, ctx, 'boot_context', {}, { 'x-mupot-seat': handle })
    expect(r.sc.bound_agent_id).toBe((sel.sc.agent as { id: string }).id)
  })

  it('two tokens of the SAME human are two harnesses: same folder, different agents', async () => {
    const env = envFor(h)
    const m1 = await mintOk(env, HUMAN, { label: 'ci-a' })
    const m2 = await mintOk(env, HUMAN, { label: 'ci-b' })
    const a = await select(env, m1.raw, '/work/a')
    const b = await select(env, m2.raw, '/work/a')
    expect(a.agentId).not.toBe(b.agentId)
  })

  it('a handle minted under token A is dead under token B of the same member and harness-kind', async () => {
    const env = envFor(h)
    const m1 = await mintOk(env, HUMAN, { label: 'ci-a' })
    const m2 = await mintOk(env, HUMAN, { label: 'ci-b' })
    const a = await select(env, m1.raw, '/work/a')
    const r = await rpcBearer(env, m2.raw, 'boot_context', {}, { 'x-mupot-seat': a.handle })
    expect(r.sc.bound_agent_id).toBeNull()
    expect((r.sc.identity_receipt as Record<string, unknown>).seat_handle_rejected).toBe(true)
  })

  it('refuses a token-harness pointer that is not the authenticating credential', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    const auth: SeatSelectAuth = { channel: 'directory', boundAgentId: null, memberId: HUMAN, harnessId: m.harnessId, tokenId: 'some-other-token' }
    expect(await seatSelect(env, auth, { project: 'p', folder: '/x' })).toMatchObject({ ok: false, error: 'harness_required' })
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats`)).toBe(0)
  })

  it('a handle only resolves while the token is live: expiry kills it', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    const a = await select(env, m.raw, '/work/a')
    h.sqlite.exec(`UPDATE member_tokens SET expires_at = '2020-01-01 00:00:00' WHERE id = '${m.tokenId}'`)
    expect((await rpcBearer(env, m.raw, 'boot_context', {}, { 'x-mupot-seat': a.handle })).status).toBe(401)
  })

  it('seat agents never count toward maxAgents (D5): only kind=work agents are counted', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    for (let i = 0; i < 6; i++) await select(env, m.raw, `/work/${i}`)
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE kind = 'work'`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE kind = 'home'`)).toBe(6)
    // free tier maxAgents is smaller than 6 seats, yet a WORK agent is still creatable afterwards.
    const squad = h.sqlite.prepare(`SELECT squad_id FROM agents LIMIT 1`).get()!.squad_id as string
    const work = await prepareAgentCreate(env, squad, { slug: 'real-work-agent', name: 'Real' }, { kind: 'work' })
    expect(work.ok).toBe(true)
  })

  it('seats clamp: min(human live rank, agent rank, member) — never above member', async () => {
    const env = envFor(h)
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h1', '${HUMAN}', 'org', NULL, 'admin')`)
    const m = await mintOk(env, HUMAN)
    const a = await select(env, m.raw, '/work/a')
    const r = await rpcBearer(env, m.raw, 'boot_context', {}, { 'x-mupot-seat': a.handle })
    const eff = (r.sc.identity_receipt as { effective_capabilities: { highest: string; count: number } }).effective_capabilities
    expect(eff.count).toBeGreaterThan(0)
    expect(['member', 'observer']).toContain(eff.highest)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('caps on a token harness', () => {
  it('live cap (SEAT_MAX_PER_MEMBER): the N+1th seat is refused, no orphan agent', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '2' })
    const m = await mintOk(env, HUMAN)
    await select(env, m.raw, '/a'); await select(env, m.raw, '/b')
    const agentsBefore = n(`SELECT COUNT(*) AS n FROM agents`)
    const r = await rpcBearer(env, m.raw, 'seat_select', { project: 'p', folder: '/c' })
    expect(JSON.stringify(r.body)).toContain('seat_cap_reached')
    expect(n(`SELECT COUNT(*) AS n FROM agents`)).toBe(agentsBefore)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats`)).toBe(2)
  })

  it('lifetime cap (SEAT_MAX_TOTAL_PER_MEMBER) counts every token harness of the member together', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_MEMBER: '3' })
    const m1 = await mintOk(env, HUMAN, { label: 'a' }); const m2 = await mintOk(env, HUMAN, { label: 'b' })
    await select(env, m1.raw, '/1'); await select(env, m1.raw, '/2'); await select(env, m2.raw, '/1')
    const r = await rpcBearer(env, m2.raw, 'seat_select', { project: 'p', folder: '/9' })
    expect(JSON.stringify(r.body)).toContain('seat_cap_reached')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats`)).toBe(3)
  })

  it('CONCURRENCY: 10 parallel seat_select on the SAME key -> exactly one seat and one agent', async () => {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    const out = await Promise.all(Array.from({ length: 10 }, () => rpcBearer(env, m.raw, 'seat_select', { project: 'p', folder: '/same' })))
    const ids = new Set(out.map((o) => (o.sc.agent as { id: string } | undefined)?.id).filter(Boolean))
    expect(ids.size).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE kind = 'home'`)).toBe(1)
  })

  it('CONCURRENCY: 12 parallel DISTINCT keys at live cap 5 -> exactly 5 seats, 5 agents (cap is atomic)', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '5' })
    const m = await mintOk(env, HUMAN)
    await Promise.all(Array.from({ length: 12 }, (_, i) => rpcBearer(env, m.raw, 'seat_select', { project: 'p', folder: `/k${i}` })))
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats`)).toBe(5)
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE kind = 'home'`)).toBe(5)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('revoking the token revokes its harness seats', () => {
  async function setup() {
    const env = envFor(h)
    const m = await mintOk(env, HUMAN)
    const a = await select(env, m.raw, '/work/a'); const b = await select(env, m.raw, '/work/b')
    return { env, m, a, b }
  }

  it('DELETE /members/:id/tokens/:tid retires every seat and revokes every handle', async () => {
    const { env, m } = await setup()
    const res = await membersApp.request(`https://pot.test/members/${HUMAN}/tokens/${m.tokenId}`, { method: 'DELETE', headers: { cookie: 'mupot_session=admin-sid', origin: 'https://pot.test' } }, env)
    expect(res.status).toBe(200)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE retired_at IS NULL`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE retired_at IS NOT NULL`)).toBe(2)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE revoked_at IS NULL`)).toBe(0)
    expect((await rpcBearer(env, m.raw, 'boot_context')).status).toBe(401)
  })

  it('a raw UPDATE of revoked_at (any revoker) fires the same trigger', async () => {
    const { m } = await setup()
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-10-10T00:00:00.000Z' WHERE id = '${m.tokenId}'`)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE retired_at IS NULL`)).toBe(0)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles WHERE revoked_at IS NULL`)).toBe(0)
  })

  it('a hard DELETE of the token row retires the seats too', async () => {
    const { m } = await setup()
    h.sqlite.exec(`PRAGMA foreign_keys = OFF`)
    h.sqlite.exec(`DELETE FROM member_tokens WHERE id = '${m.tokenId}'`)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE retired_at IS NULL`)).toBe(0)
  })

  it('revoking an UNRELATED token (another harness token, a workspace token) retires nothing', async () => {
    const { env, m } = await setup()
    const other = await mintOk(env, HUMAN, { label: 'other' })
    await select(env, other.raw, '/o')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-10-10T00:00:00.000Z' WHERE id = '${other.tokenId}'`)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ? AND retired_at IS NULL`, m.harnessId)).toBe(2)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ? AND retired_at IS NOT NULL`, other.harnessId)).toBe(1)
  })

  it('retired seats free the live cap but still count toward the lifetime bound; a retired key is not resurrected', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '2', SEAT_MAX_TOTAL_PER_MEMBER: '3' })
    const m = await mintOk(env, HUMAN)
    await select(env, m.raw, '/a'); await select(env, m.raw, '/b')
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-10-10T00:00:00.000Z' WHERE id = '${m.tokenId}'`)
    const m2 = await mintOk(env, HUMAN, { label: 'next' })
    await select(env, m2.raw, '/c') // live cap freed (2 retired) -> 3rd lifetime seat OK
    const r = await rpcBearer(env, m2.raw, 'seat_select', { project: 'p', folder: '/d' })
    expect(JSON.stringify(r.body)).toContain('seat_cap_reached') // lifetime 3/3
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('migration 0202 shape guards (the DB refuses what the code never writes)', () => {
  const insertToken = (id: string, channel: string, agentId: string | null, harnessKind: string | null = 'ci') =>
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id, harness_kind) VALUES ('${id}', '${HUMAN}', 'h-${id}', 'x', '${channel}', '2026-10-10', '${TENANT}', ${agentId ? `'${agentId}'` : 'NULL'}, ${harnessKind ? `'${harnessKind}'` : 'NULL'})`)
  const insertHarness = (id: string, clientId: string, kind: string, credential: string, tokenId: string | null, member = HUMAN) =>
    h.sqlite.exec(`INSERT INTO harnesses (id, tenant, member_id, oauth_client_id, client_name, kind, credential_kind, token_id) VALUES ('${id}', '${TENANT}', '${member}', '${clientId}', 'n', '${kind}', '${credential}', ${tokenId ? `'${tokenId}'` : 'NULL'})`)

  it('token harness must point at an UNBOUND DIRECTORY token of the SAME member', () => {
    expect(() => insertToken('t-ws', 'workspace', null)).toThrow(/harness_token_shape/) // a harness_kind token must be directory/unbound
    insertToken('t-ws', 'workspace', null, null)
    expect(() => insertHarness('h1', 'token:t-ws', 'ci', 'token', 't-ws')).toThrow(/harness_credential_shape/)
    insertToken('t-nokind', 'directory', null, null) // directory/unbound but NOT classed as a harness credential
    expect(() => insertHarness('h1b', 'token:t-nokind', 'ci', 'token', 't-nokind')).toThrow(/harness_credential_shape/)
    insertToken('t-dir', 'directory', null)
    expect(() => insertHarness('h2', 'token:t-dir', 'ci', 'token', 't-dir', HUMAN2)).toThrow(/harness_credential_shape/)
    expect(() => insertHarness('h3', 'token:t-dir', 'mainframe', 'token', 't-dir')).toThrow(/harness_credential_shape/)
    expect(() => insertHarness('h3b', 'token:t-dir', 'cursor', 'token', 't-dir')).toThrow(/harness_credential_shape/) // kind must equal the token's own harness_kind
    expect(() => insertHarness('h4', 'wrong-pointer', 'ci', 'token', 't-dir')).toThrow(/harness_credential_shape/)
    expect(() => insertHarness('h5', 'token:t-dir', 'ci', 'token', 'nope')).toThrow(/harness_credential_shape/)
    insertHarness('ok', 'token:t-dir', 'ci', 'token', 't-dir')
    expect(() => insertHarness('dup', 'other', 'ci', 'token', 't-dir')).toThrow() // one harness per token
  })

  it('an OAuth harness cannot squat the reserved token: namespace or carry a token_id', () => {
    insertToken('t-dir', 'directory', null)
    expect(() => insertHarness('o1', 'token:abc', 'cursor', 'oauth', null)).toThrow(/harness_credential_shape/)
    expect(() => insertHarness('o2', 'client-x', 'cursor', 'oauth', 't-dir')).toThrow(/harness_credential_shape/)
    insertHarness('o3', 'client-x', 'cursor', 'oauth', null)
  })

  it('credential identity is immutable; display labels are not', () => {
    insertToken('t-dir', 'directory', null)
    insertHarness('hh', 'token:t-dir', 'ci', 'token', 't-dir')
    expect(() => h.sqlite.exec(`UPDATE harnesses SET token_id = NULL WHERE id = 'hh'`)).toThrow(/harness_immutable/)
    expect(() => h.sqlite.exec(`UPDATE harnesses SET credential_kind = 'oauth' WHERE id = 'hh'`)).toThrow(/harness_immutable/)
    expect(() => h.sqlite.exec(`UPDATE harnesses SET member_id = '${HUMAN2}' WHERE id = 'hh'`)).toThrow(/harness_immutable/)
    h.sqlite.exec(`UPDATE harnesses SET client_name = 'renamed' WHERE id = 'hh'`)
  })

  it('every pre-0202 OAuth harness path is unchanged: the W1 upsert still yields credential_kind oauth', async () => {
    const env = envFor(h)
    const { upsertHarness } = await import('../src/members/harness')
    const row = await upsertHarness(env, HUMAN, 'client-cursor', 'Cursor')
    expect(row).toMatchObject({ credential_kind: 'oauth', token_id: null })
  })
})
