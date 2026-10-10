// tests/harness-token-confinement.test.ts — mupot#1794 W4 round 2.
//
// DEFECT CLASS under test: a harness token's zero standing used to be derived from a SECOND lookup and
// enforced per door, so any door that forgot, or any lookup that failed, handed out the human's
// authority. Now zero standing is a property of the CREDENTIAL (member_tokens.harness_kind), applied at
// every bearer door from the authenticating row, failing closed; and ONE chokepoint (invokeTool) admits
// only HARNESS_SESSION_ALLOWED_TOOLS for a harness session with no applied seat handle.
//
// Real sqlite D1 from the whole migration chain; real doors (membersApp mint, resolveExternalToken ->
// buildAuthContextFromProps -> internal header -> mcpApp, mcpApp bearer, /actions, legacy {tool,args},
// events, profile door). Not proven: the cloudflare:workers entrypoint; real D1 interleaving.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { membersApp } from '../src/members'
import { TOOLS, invokeTool, mcpApp, mcpActionsApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { buildAuthContextFromProps, resolveExternalToken } from '../src/mcp/oauth-authorize'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { HARNESS_SESSION_ALLOWED_TOOLS } from '../src/members/harness-credential'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const HUMAN = 'member-human-1'

function envFor(h: SqliteD1Harness, extra: Record<string, unknown> = {}): Env {
  const store = new Map<string, string>([['sess:admin-sid', JSON.stringify({ userId: 'u-admin', email: 'a@x.test', role: 'admin', createdAt: '2026-01-01T00:00:00Z' })]])
  return {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test',
    SESSIONS: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    SEAT_AUTO_ENROLL: '1', SEAT_MAX_PER_MEMBER: '100', ...extra,
  } as unknown as Env
}

let h: SqliteD1Harness
const n = (sql: string, ...p: unknown[]): number => Number(h.sqlite.prepare(sql).get(...p)!.n)

async function mintOk(env: Env, label = 'ci-runner', extra: Record<string, unknown> = {}): Promise<{ raw: string; tokenId: string; harnessId: string }> {
  const res = await membersApp.request(`/members/${HUMAN}/tokens`, {
    method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' },
    body: JSON.stringify({ label, harness_kind: 'ci', ...extra }),
  }, env)
  const j = (await res.json()) as { token: { raw: string; id: string }; harness: { id: string } }
  if (res.status !== 201) throw new Error(`mint ${res.status} ${JSON.stringify(j)}`)
  return { raw: j.token.raw, tokenId: j.token.id, harnessId: j.harness.id }
}

async function postJson(env: Env, path: string, raw: string | null, body: unknown, headers: Record<string, string> = {}, app: { fetch: (r: Request, e: Env) => Response | Promise<Response> } = mcpApp): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await app.fetch(new Request(`https://pot.test${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(raw ? { authorization: `Bearer ${raw}` } : {}), ...headers }, body: JSON.stringify(body),
  }), env)
  const text = await res.text()
  return { status: res.status, json: text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : { raw: text } }
}

const rpcCall = (env: Env, raw: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  postJson(env, '/', raw, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers)

const sc = (r: { json: Record<string, unknown> }): Record<string, unknown> =>
  ((r.json.result ?? {}) as { structuredContent?: Record<string, unknown> }).structuredContent ?? {}

/** isError result for a refused tool (HTTP 200 + result.isError), or a JSON-RPC error body. */
const refusalText = (r: { json: Record<string, unknown> }): string => JSON.stringify(r.json)

async function externalCtx(env: Env, raw: string): Promise<AuthContext | null> {
  const r = await resolveExternalToken(env, raw)
  return r ? buildAuthContextFromProps(env, r.props) : null
}

beforeEach(() => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('${HUMAN}', 'h@example.test', 'Human', 'active', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-h', '${HUMAN}', 'org', NULL, 'admin')`)
  resetHarnessProbeSampling()
})
afterEach(() => h.close())

// ════════════════════════════════════════════════════════════════════════════
describe('1. zero standing is decided by the token ROW and fails closed', () => {
  it('a directory/unbound bearer WITHOUT harness_kind is refused at both doors (never a human session)', async () => {
    const env = envFor(h)
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
                   VALUES ('t-plain', '${HUMAN}', '${await sha('mupot_plain')}', 'x', 'directory', '2026-10-10', '${TENANT}')`)
    expect(await resolveExternalToken(env, 'mupot_plain')).toBeNull()
    expect((await rpcCall(env, 'mupot_plain', 'boot_context')).status).toBe(401)
  })

  it('harness row ABSENT (token live) -> refused at both doors', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    h.sqlite.exec(`DROP TRIGGER harnesses_token_delete_guard`)
    h.sqlite.exec(`DELETE FROM harnesses WHERE id = '${m.harnessId}'`)
    expect(await resolveExternalToken(env, m.raw)).toBeNull()
    expect((await rpcCall(env, m.raw, 'boot_context')).status).toBe(401)
  })

  it('harness LOOKUP ERRORS -> refused (401 / null), never a fall-through to the human', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    h.sqlite.exec(`ALTER TABLE harnesses RENAME TO harnesses_broken`)
    expect(await resolveExternalToken(env, m.raw)).toBeNull()
    const r = await rpcCall(env, m.raw, 'boot_context')
    expect(r.status).toBe(401)
    expect(refusalText(r)).not.toContain(HUMAN)
  })

  it('flag off -> refused at both doors', async () => {
    const m = await mintOk(envFor(h))
    const off = envFor(h, { SEAT_AUTO_ENROLL: undefined })
    expect(await resolveExternalToken(off, m.raw)).toBeNull()
    expect((await rpcCall(off, m.raw, 'boot_context')).status).toBe(401)
  })

  it('zero standing does not depend on the harness lookup: buildAuthContextFromProps clamps from the row alone', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    // props WITHOUT a harness pointer (as if the lookup never happened) and a lying channel
    const ctx = await buildAuthContextFromProps(env, { memberId: HUMAN, tokenId: m.tokenId, email: null, channel: 'workspace', boundAgentId: null })
    expect(ctx).toMatchObject({ channel: 'directory', boundAgentId: null, harnessCredential: true })
    expect(ctx?.capabilities).toEqual([])
    expect(ctx?.latentCapabilities).toEqual([]) // NO latent grants: the human's org admin is not reachable by connect
  })

  it('all three doors yield capabilities [] and latent [] even though the member holds org admin', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    const viaProps = await externalCtx(env, m.raw)
    expect(viaProps?.capabilities).toEqual([]); expect(viaProps?.latentCapabilities).toEqual([])
    const viaBearer = sc(await rpcCall(env, m.raw, 'boot_context'))
    expect(viaBearer.capabilities).toEqual([])
    // the internal-header hop re-derives from the live row, whatever the blob claims
    const forged: AuthContext = { ...viaProps!, capabilities: [{ id: 'x', member_id: HUMAN, scope_type: 'org', scope_id: null, capability: 'owner', created_at: '' }] as never, latentCapabilities: [{ capability: 'owner' }] as never, channel: 'workspace', harnessCredential: false }
    const r = await postJson(env, '/', null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boot_context', arguments: {} } }, { [AUTH_CONTEXT_HEADER]: JSON.stringify(forged) })
    expect(sc(r).capabilities).toEqual([])
  })

  it('a blob can neither assert the marker on a normal session nor shed it from a harness session', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    const harnessCtx = (await externalCtx(env, m.raw))!
    const shed = await postJson(env, '/', null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { [AUTH_CONTEXT_HEADER]: JSON.stringify({ ...harnessCtx, harnessCredential: false }) })
    expect(refusalText(shed)).toContain('harness_session_seat_required')
    // a workspace token's session with a forged marker: the marker is dropped, the session is normal
    const ws = await membersApp.request(`/members/${HUMAN}/tokens`, { method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'ws' }) }, env)
    const wsRaw = ((await ws.json()) as { token: { raw: string } }).token.raw
    const wsCtx = (await externalCtx(env, wsRaw))!
    const asserted = await postJson(env, '/', null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { [AUTH_CONTEXT_HEADER]: JSON.stringify({ ...wsCtx, harnessCredential: true }) })
    expect(refusalText(asserted)).not.toContain('harness_session_seat_required')
  })

  it('RACE (gate P2): token expires between props build and the internal-header re-read -> fails closed, bootstrap_self never runs', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    const ctx = (await externalCtx(env, m.raw))!
    expect(ctx).not.toBeNull()
    h.sqlite.exec(`UPDATE member_tokens SET expires_at = '2020-01-01 00:00:00' WHERE id = '${m.tokenId}'`)
    const agentsBefore = n(`SELECT COUNT(*) AS n FROM agents`)
    const r = await postJson(env, '/', null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'bootstrap_self', arguments: { agent_name: 'race' } } },
      { [AUTH_CONTEXT_HEADER]: JSON.stringify({ ...ctx, harnessCredential: false }) })
    expect(r.status).toBe(401)
    expect(n(`SELECT COUNT(*) AS n FROM agents`)).toBe(agentsBefore)
    // same for a revoked token
    const m2 = await mintOk(env, 'ci-runner-2')
    const ctx2 = (await externalCtx(env, m2.raw))!
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = '${m2.tokenId}'`)
    const r2 = await postJson(env, '/', null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { [AUTH_CONTEXT_HEADER]: JSON.stringify(ctx2) })
    expect(r2.status).toBe(401)
  })

  it('PRESENCE (gate P2): a confined harness session writes no presence under the human (boot_context or seat_select)', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    const before = n(`SELECT COUNT(*) AS n FROM presence WHERE member_id = ?`, HUMAN)
    for (let i = 0; i < 5; i++) {
      await rpcCall(env, m.raw, 'boot_context', { seat: `River-admin-${i}` })
      await rpcCall(env, m.raw, 'seat_select', { project: 'p', folder: `/a${i}` })
    }
    await new Promise((r) => setTimeout(r, 50))
    expect(n(`SELECT COUNT(*) AS n FROM presence WHERE member_id = ?`, HUMAN)).toBe(before)
  })
})

async function sha(raw: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ════════════════════════════════════════════════════════════════════════════
describe('1b. harness delete guard (DB)', () => {
  it('cannot delete a token harness while its token is live; can after revoke', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    expect(() => h.sqlite.exec(`DELETE FROM harnesses WHERE id = '${m.harnessId}'`)).toThrow(/harness_token_live/)
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-10-10T00:00:00.000Z' WHERE id = '${m.tokenId}'`)
    h.sqlite.exec(`DELETE FROM harnesses WHERE id = '${m.harnessId}'`)
    expect(n(`SELECT COUNT(*) AS n FROM harnesses`)).toBe(0)
  })
  it('an EXPIRED token no longer holds its harness (guard follows the live predicate)', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    h.sqlite.exec(`UPDATE member_tokens SET expires_at = '2020-01-01 00:00:00' WHERE id = '${m.tokenId}'`)
    h.sqlite.exec(`DELETE FROM harnesses WHERE id = '${m.harnessId}'`)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('2. ONE allowlist chokepoint (invokeTool)', () => {
  it('the allowlist is exactly seat_select + boot_context, and both are real tools', () => {
    expect([...HARNESS_SESSION_ALLOWED_TOOLS].sort()).toEqual(['boot_context', 'seat_select'])
    const names = new Set(TOOLS.map((t) => t.name))
    for (const a of HARNESS_SESSION_ALLOWED_TOOLS) expect(names.has(a)).toBe(true)
  })

  it('SEAM: enumerates EVERY registered tool; from a harness session only the allowlist is reachable', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    const ctx = (await externalCtx(env, m.raw))!
    expect(ctx.harnessCredential).toBe(true)
    const reached: string[] = []
    const refused: string[] = []
    for (const t of TOOLS) {
      const out = await invokeTool(ctx, env, t.name, {})
      if (!out.ok && out.error === 'harness_session_seat_required') refused.push(t.name)
      else reached.push(t.name)
    }
    expect(reached.sort()).toEqual([...HARNESS_SESSION_ALLOWED_TOOLS].sort())
    expect(refused.length).toBe(TOOLS.length - HARNESS_SESSION_ALLOWED_TOOLS.size)
    for (const dangerous of ['connect', 'bootstrap_self', 'reveal_credential_claim', 'recall', 'remember', 'create_agent', 'mint_agent_token']) {
      expect(refused).toContain(dangerous)
    }
  })

  it('the refusal is the chokepoint: it fires before args validation and before the capability floor', async () => {
    const env = envFor(h)
    const ctx = (await externalCtx(env, (await mintOk(env)).raw))!
    const out = await invokeTool(ctx, env, 'recall', { not: 'valid' })
    expect(out).toMatchObject({ ok: false, status: 403, error: 'harness_session_seat_required' })
    expect(JSON.stringify(out)).toContain('seat_select')
  })

  it('every DOOR passes through it: /mcp tools/call, /actions/:tool, legacy {tool,args}, events, profile', async () => {
    const env = envFor(h, { EVENTS_ENABLED: 'true' })
    const m = await mintOk(env)
    // tools/call
    expect(refusalText(await rpcCall(env, m.raw, 'connect', { agent_name: 'x' }))).toContain('harness_session_seat_required')
    // /actions/:tool
    const act = await postJson(env, '/actions/recall', m.raw, { query: 'x' }, {}, mcpActionsApp)
    expect(act.status).toBe(403)
    expect(JSON.stringify(act.json)).toContain('harness_session_seat_required')
    // legacy {tool,args}
    const legacy = await postJson(env, '/', m.raw, { tool: 'bootstrap_self', args: { agent_name: 'x' } })
    expect(legacy.status).toBe(403)
    expect(JSON.stringify(legacy.json)).toContain('harness_session_seat_required')
    // events/*
    const ev = await postJson(env, '/', m.raw, { jsonrpc: '2.0', id: 1, method: 'events/list', params: {} })
    expect(ev.status).toBe(403)
    expect(JSON.stringify(ev.json)).toContain('harness_session_seat_required')
    // profile door: tools/list and tools/call
    const pl = await postJson(env, '/profile/needs-you', m.raw, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(pl.status).toBe(403)
    const pc = await postJson(env, '/profile/needs-you', m.raw, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'needs_you_list', arguments: {} } })
    expect(JSON.stringify(pc.json)).toContain('harness_session_seat_required')
  })

  it('what IS allowed: initialize, tools/list, boot_context, seat_select', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    expect((await postJson(env, '/', m.raw, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status).toBe(200)
    expect((await postJson(env, '/', m.raw, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200)
    expect(sc(await rpcCall(env, m.raw, 'boot_context')).member_id).toBe(HUMAN)
    expect(typeof sc(await rpcCall(env, m.raw, 'seat_select', { project: 'p', folder: '/a' })).seat_handle).toBe('string')
  })

  it('a REJECTED handle leaves the harness session confined; a VALID handle is the seat agent (not confined, member-capped)', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    const handle = sc(await rpcCall(env, m.raw, 'seat_select', { project: 'p', folder: '/a' })).seat_handle as string
    const bad = await rpcCall(env, m.raw, 'recall', { query: 'x' }, { 'x-mupot-seat': 'mseat_' + 'A'.repeat(43) })
    expect(refusalText(bad)).toContain('harness_session_seat_required')
    const good = await rpcCall(env, m.raw, 'recall', { query: 'x' }, { 'x-mupot-seat': handle })
    expect(refusalText(good)).not.toContain('harness_session_seat_required')
    const boot = sc(await rpcCall(env, m.raw, 'boot_context', {}, { 'x-mupot-seat': handle }))
    expect(boot.bound_agent_id).toBeTruthy()
  })

  it('a normal (non-harness) session is untouched by the chokepoint', async () => {
    const env = envFor(h)
    const ws = await membersApp.request(`/members/${HUMAN}/tokens`, { method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'ws' }) }, env)
    const raw = ((await ws.json()) as { token: { raw: string } }).token.raw
    const ctx = (await externalCtx(env, raw))!
    expect(ctx.harnessCredential).toBeUndefined()
    const out = await invokeTool(ctx, env, 'status', {})
    expect(out.ok || out.error !== 'harness_session_seat_required').toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('3. a harness token can never be welded to an agent', () => {
  it('connect from the harness session is refused at the chokepoint, and the row stays unbound', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    const r = await rpcCall(env, m.raw, 'connect', { agent_name: 'anything' })
    expect(refusalText(r)).toContain('harness_session_seat_required')
    expect(h.sqlite.prepare(`SELECT agent_id FROM member_tokens WHERE id = ?`).get(m.tokenId)!.agent_id).toBeNull()
  })

  it('DB trigger: agent_id can never be set on a harness token (belt and braces), nor class/channel/member changed', async () => {
    const env = envFor(h)
    const m = await mintOk(env)
    // an agent to point at
    h.sqlite.exec(`INSERT INTO departments (id, slug, name) VALUES ('d1', 'd1', 'D')`)
    h.sqlite.exec(`INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 's1', 'S')`)
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, status, kind) VALUES ('a1', 's1', 'a1', 'A', 'member', 'active', 'work')`)
    expect(() => h.sqlite.exec(`UPDATE member_tokens SET agent_id = 'a1' WHERE id = '${m.tokenId}'`)).toThrow(/harness_token_immutable/)
    expect(() => h.sqlite.exec(`UPDATE member_tokens SET harness_kind = NULL WHERE id = '${m.tokenId}'`)).toThrow(/harness_token_immutable/)
    expect(() => h.sqlite.exec(`UPDATE member_tokens SET channel = 'workspace' WHERE id = '${m.tokenId}'`)).toThrow(/harness_token_immutable/)
    // an ordinary token's agent_id weld is untouched by the trigger (control)
    h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('t-ord', '${HUMAN}', 'h-ord', 'x', 'workspace', '2026-10-10', '${TENANT}')`)
    h.sqlite.exec(`UPDATE member_tokens SET last_used_at = '2026-10-10' WHERE id = '${m.tokenId}'`) // bookkeeping still fine
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('4. expiry frees seats (cap rotation lockout)', () => {
  it('REPRO: cap=2, token A fills it, A expires, token B can seat_select (A\'s seats retired lazily)', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '2' })
    const a = await mintOk(env, 'ci-a')
    await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/1' })
    await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/2' })
    const b = await mintOk(env, 'ci-b')
    // control: A still live -> B is capped out
    expect(refusalText(await rpcCall(env, b.raw, 'seat_select', { project: 'p', folder: '/3' }))).toContain('seat_cap_reached')
    h.sqlite.exec(`UPDATE member_tokens SET expires_at = '2020-01-01 00:00:00' WHERE id = '${a.tokenId}'`)
    const ok = sc(await rpcCall(env, b.raw, 'seat_select', { project: 'p', folder: '/3' }))
    expect(ok.disposition).toBe('created')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ? AND retired_at IS NOT NULL`, a.harnessId)).toBe(2)
    expect(n(`SELECT COUNT(*) AS n FROM seat_handles h JOIN agent_seats s ON s.id = h.seat_id WHERE s.harness_id = ? AND h.revoked_at IS NULL`, a.harnessId)).toBe(0)
  })

  it('housekeeping is scoped: another member\'s expired harness is not touched, and a LIVE harness keeps its seats', async () => {
    const env = envFor(h, { SEAT_MAX_PER_MEMBER: '5' })
    h.sqlite.exec(`INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES ('member-2', 'm2@example.test', 'M2', 'active', '2026-10-09', '${TENANT}')`)
    const live = await mintOk(env, 'live')
    await rpcCall(env, live.raw, 'seat_select', { project: 'p', folder: '/live' })
    const res = await membersApp.request('/members/member-2/tokens', { method: 'POST', headers: { cookie: 'mupot_session=admin-sid', 'content-type': 'application/json' }, body: JSON.stringify({ label: 'm2', harness_kind: 'ci' }) }, env)
    const m2 = ((await res.json()) as { token: { raw: string; id: string } }).token
    await rpcCall(env, m2.raw, 'seat_select', { project: 'p', folder: '/m2' })
    h.sqlite.exec(`UPDATE member_tokens SET expires_at = '2020-01-01 00:00:00' WHERE id = '${m2.id}'`)
    await rpcCall(env, live.raw, 'seat_select', { project: 'p', folder: '/live2' }) // HUMAN's creation path runs the housekeeping
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE member_id = 'member-2' AND retired_at IS NULL`)).toBe(1)
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE member_id = '${HUMAN}' AND retired_at IS NULL`)).toBe(2)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('5. per-harness lifetime budget', () => {
  it('SEAT_MAX_TOTAL_PER_HARNESS bounds ONE shared token; the member\'s other harness is unaffected', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_HARNESS: '3', SEAT_MAX_PER_MEMBER: '50' })
    const a = await mintOk(env, 'ci-a'); const b = await mintOk(env, 'ci-b')
    for (let i = 0; i < 3; i++) await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: `/r${i}` })
    const refused = await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/r3' })
    expect(refusalText(refused)).toContain('harness_total_cap')
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ?`, a.harnessId)).toBe(3)
    expect(sc(await rpcCall(env, b.raw, 'seat_select', { project: 'p', folder: '/other' })).disposition).toBe('created')
  })

  it('retired seats still count (a CI loop cannot recycle the budget), and an existing seat key still resolves', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_HARNESS: '2', SEAT_MAX_PER_MEMBER: '50' })
    const a = await mintOk(env)
    await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/1' })
    await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/2' })
    expect(sc(await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/1' })).disposition).toBe('existing')
    expect(refusalText(await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/3' }))).toContain('harness_total_cap')
  })

  it('the trigger is the hard backstop at the boundary (raw insert)', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_HARNESS: '1' })
    const a = await mintOk(env)
    await rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: '/1' })
    const seat = h.sqlite.prepare(`SELECT * FROM agent_seats`).get()!
    h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, role, status, kind) VALUES ('ax', (SELECT squad_id FROM agents WHERE id = '${seat.agent_id}'), 'ax', 'AX', 'member', 'active', 'home')`)
    expect(() => h.sqlite.exec(`INSERT INTO agent_seats (id, tenant, member_id, harness_id, key_hash, agent_id, label_basename, max_live, max_total, max_harness_total)
      VALUES ('raw1', '${TENANT}', '${HUMAN}', '${a.harnessId}', '${'b'.repeat(64)}', 'ax', 'x', 100, 100, 1)`)).toThrow(/seat_harness_total_cap_exceeded/)
  })

  it('CONCURRENCY: 8 parallel distinct keys with a harness cap of 3 -> exactly 3 seats', async () => {
    const env = envFor(h, { SEAT_MAX_TOTAL_PER_HARNESS: '3', SEAT_MAX_PER_MEMBER: '50' })
    const a = await mintOk(env)
    await Promise.all(Array.from({ length: 8 }, (_, i) => rpcCall(env, a.raw, 'seat_select', { project: 'p', folder: `/k${i}` })))
    expect(n(`SELECT COUNT(*) AS n FROM agent_seats WHERE harness_id = ?`, a.harnessId)).toBe(3)
    expect(n(`SELECT COUNT(*) AS n FROM agents WHERE kind = 'home'`)).toBe(3)
  })
})
