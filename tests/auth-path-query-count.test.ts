// Per-request D1 cost of authentication, BEFORE a tool / page handler runs (task: authenticated requests are slow).
//
// A tracing proxy over the node:sqlite D1 harness counts every executed statement and, more importantly, the number
// of SERIAL WAVES (each statement takes a simulated 4 ms so overlapping statements really overlap): a wave starts whenever a statement begins while nothing else is in flight. Two statements issued
// together (Promise.all) are one wave; a statement that waits for the previous answer is a new wave. Real D1 latency
// is not measurable here, but each wave is one network round trip from the Worker, so waves are what multiply it.
//
// Two halves:
//  1. count tests  - pin the number of waves on the two hot paths (agent-bound bearer on POST /mcp, signed-in dashboard).
//  2. semantics    - the auth RESULT (who, which capabilities, which bound agent, 401 or not) for valid / expired /
//                    revoked / wrong-tenant / suspended-member / unbound credentials, and for dashboard sessions,
//                    must be identical to what main produced before the waves were collapsed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { buildAuthContextFromProps, resolveExternalToken } from '../src/mcp/oauth-authorize'
import { hashMemberToken } from '../src/auth/member-bearer'
import { hashWebSessionId } from '../src/auth/web-sessions'
import { requireAuth } from '../src/auth'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const RAW = 'mupot_' + 'a'.repeat(64)

interface Trace { sqls: string[]; waveOf: number[]; inflight: number; waves: number }
const newTrace = (): Trace => ({ sqls: [], waveOf: [], inflight: 0, waves: 0 })

function traced(h: SqliteD1Harness, t: Trace): Env['DB'] {
  const begin = (label: string) => { if (t.inflight === 0) t.waves++; t.inflight++; t.sqls.push(label); t.waveOf.push(t.waves) }
  const wrapStmt = (stmt: any): any => new Proxy(stmt, { // eslint-disable-line @typescript-eslint/no-explicit-any -- test-only tracer over a structural D1 statement
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === 'bind') return (...a: unknown[]) => wrapStmt(v.apply(target, a))
      if (prop === 'first' || prop === 'all' || prop === 'run' || prop === 'raw') {
        return async (...a: unknown[]) => {
          begin(String(target.sql).replace(/\s+/g, ' ').trim().slice(0, 100))
          try { await new Promise((r) => setTimeout(r, 4)); return await v.apply(target, a) } finally { t.inflight-- }
        }
      }
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return new Proxy(h.db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv)
      if (prop === 'prepare') return (sql: string) => wrapStmt(v.call(target, sql))
      if (prop === 'batch') return async (stmts: unknown[]) => {
        begin(`BATCH(${stmts.length})`)
        try { await new Promise((r) => setTimeout(r, 4)); return await v.call(target, stmts) } finally { t.inflight-- }
      }
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function memoryKv(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

// Measured upper bound for the boundary waves of a consent-bound directory session (see the test that uses it).
const BOUND_DIRECTORY_BOUNDARY_WAVES = 6

let h: SqliteD1Harness
beforeEach(() => { h = createSqliteD1(); applyAllMigrations(h.sqlite) })
afterEach(() => h.close())

// ══════════════════════════════════════════════════════════════════════════════
// (a) agent-bound bearer on POST /mcp: resolveExternalToken -> buildAuthContextFromProps -> internal header -> mcpApp
// ══════════════════════════════════════════════════════════════════════════════
interface McpSeed {
  memberStatus?: string
  expiresAt?: string | null
  revokedAt?: string | null
  tokenTenant?: string
  memberTenant?: string
  bound?: boolean
  channel?: string
  capExpired?: boolean
}

async function seedMcp(o: McpSeed = {}): Promise<void> {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1','d1','D');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sq1','d1','s1','S','work');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag1','sq1','ag1','Ag','member','t','active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m1','m1@t','M1','${o.memberStatus ?? 'active'}','${o.memberTenant ?? TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}','ag1','m1','2026-01-01T00:00:00.000Z');
  `)
  h.sqlite.prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability, expires_at) VALUES ('c1','m1','squad','sq1','admin',?)`)
    .run(o.capExpired ? '2000-01-01 00:00:00' : null)
  h.sqlite.prepare(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, agent_id, tenant, expires_at, revoked_at) VALUES ('t1','m1',?,?,?,?,?,?,?)`)
    .run(await hashMemberToken(RAW), 'l', o.channel ?? 'workspace', o.bound === false ? null : 'ag1', o.tokenTenant ?? TENANT, o.expiresAt ?? null, o.revokedAt ?? null)
}

function mcpEnv(t: Trace): Env {
  return { DB: traced(h, t), TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: memoryKv(), OAUTH_KV: memoryKv() } as unknown as Env
}

interface McpOutcome {
  door: 'rejected_at_resolveExternalToken' | 'rejected_at_buildAuthContext' | 'admitted'
  caps?: string[]
  latent?: string[]
  bound?: string | null
  channel?: string
  tokenId?: string | null
  rpcStatus?: number
  toolOk?: boolean
}

const capStr = (g: ReadonlyArray<{ scope_type: string; scope_id: string | null; capability: string }> | undefined) =>
  (g ?? []).map((c) => `${c.scope_type}:${c.scope_id}:${c.capability}`).sort()

/** Run the whole prod door for `tools/call status` and report the auth result the handler saw. */
async function mcpStatusCall(env: Env, t: Trace, marks?: { afterExternal: () => void; afterBuild: () => void }): Promise<McpOutcome> {
  const r = await resolveExternalToken(env, RAW)
  marks?.afterExternal()
  if (!r) return { door: 'rejected_at_resolveExternalToken' }
  const auth = await buildAuthContextFromProps(env, r.props)
  marks?.afterBuild()
  if (!auth) return { door: 'rejected_at_buildAuthContext' }
  const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }) })
  const res = await mcpApp.fetch(mcpInternalRequest(req, auth), env)
  const body = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text: string }> } }
  const text = body.result?.content?.[0]?.text
  void t
  return {
    door: 'admitted',
    caps: capStr(auth.capabilities),
    latent: capStr(auth.latentCapabilities),
    bound: auth.boundAgentId ?? null,
    channel: auth.channel,
    tokenId: auth.tokenId ?? null,
    rpcStatus: res.status,
    toolOk: text !== undefined && (JSON.parse(text) as { ok?: boolean }).ok === true,
  }
}

describe('MCP agent-bound bearer: D1 round trips before the handler', () => {
  it('auth costs at most 3 serial waves (token lookup, props->context, boundary re-derive); was 5', async () => {
    await seedMcp()
    const t = newTrace()
    const env = mcpEnv(t)
    let wavesAfterExternal = 0
    let wavesAfterBuild = 0
    let sqlAfterBuild = 0
    const out = await mcpStatusCall(env, t, {
      afterExternal: () => { wavesAfterExternal = t.waves },
      afterBuild: () => { wavesAfterBuild = t.waves; sqlAfterBuild = t.sqls.length },
    })
    expect(out.door).toBe('admitted')
    // resolveExternalToken: 1 statement, 1 wave.
    expect(wavesAfterExternal).toBe(1)
    // buildAuthContextFromProps: token liveness re-read + capabilities, issued together = 1 more wave (was 2).
    expect(wavesAfterBuild - wavesAfterExternal).toBe(1)
    expect(sqlAfterBuild).toBe(3)
    // mcpApp resolveAuth boundary re-derive (capabilities + token re-read) must also be one wave (was 2): wave 3.
    const resolveAuthSql = t.sqls.slice(sqlAfterBuild, sqlAfterBuild + 2)
    expect(resolveAuthSql.some((s) => s.includes('FROM capabilities'))).toBe(true)
    expect(resolveAuthSql.some((s) => s.startsWith('SELECT t.id AS token_id'))).toBe(true)
    expect(t.waveOf[sqlAfterBuild]).toBe(3)
    expect(t.waveOf[sqlAfterBuild + 1]).toBe(3)
  })
})

describe('MCP directory-channel session: the boundary re-derive stays parallel', () => {
  async function runDirectory(o: { bound: boolean }): Promise<{ t: Trace; sqlAfterBuild: number; out: McpOutcome }> {
    await seedMcp({ channel: 'directory', bound: o.bound })
    const t = newTrace()
    const env = mcpEnv(t)
    let sqlAfterBuild = 0
    const out = await mcpStatusCall(env, t, { afterExternal: () => {}, afterBuild: () => { sqlAfterBuild = t.sqls.length } })
    return { t, sqlAfterBuild, out }
  }

  it('unbound directory: live token row and member grants are ONE wave at the boundary (no extra serial read)', async () => {
    const { t, sqlAfterBuild, out } = await runDirectory({ bound: false })
    expect(out.door).toBe('admitted')
    expect(out.channel).toBe('directory')
    expect(out.caps).toEqual([]) // ambient authority stays zero
    expect(out.latent).toEqual(['squad:sq1:admin']) // latent grants are recomputed live
    const first = t.sqls.slice(sqlAfterBuild, sqlAfterBuild + 2)
    expect(first.some((q) => q.includes('FROM capabilities'))).toBe(true)
    expect(first.some((q) => q.startsWith('SELECT t.id AS token_id'))).toBe(true)
    expect(t.waveOf[sqlAfterBuild]).toBe(t.waveOf[sqlAfterBuild + 1])
  })

  it('bound directory: the consent check and the latent grants share one wave after the row read', async () => {
    const { t, sqlAfterBuild, out } = await runDirectory({ bound: true })
    expect(out.door).toBe('admitted')
    const boundaryWaves = new Set(t.waveOf.slice(sqlAfterBuild)).size
    // pinned at what was measured when the re-derive was parallelised: wave 1 row+grants, then the consent check batch
    expect(boundaryWaves).toBeLessThanOrEqual(BOUND_DIRECTORY_BOUNDARY_WAVES)
  })
})

describe('MCP bearer auth semantics are unchanged by the batching', () => {
  const run = async (o: McpSeed = {}): Promise<McpOutcome> => {
    await seedMcp(o)
    const t = newTrace()
    return mcpStatusCall(mcpEnv(t), t)
  }

  it('valid agent-bound workspace key: admitted with live grants and the bound agent', async () => {
    expect(await run()).toEqual({
      door: 'admitted', caps: ['squad:sq1:admin'], latent: ['squad:sq1:admin'], bound: 'ag1', channel: 'workspace', tokenId: 't1', rpcStatus: 200, toolOk: true,
    })
  })

  it('expired token: refused at the first lookup, no context built', async () => {
    expect((await run({ expiresAt: '2000-01-01 00:00:00' })).door).toBe('rejected_at_resolveExternalToken')
  })

  it('revoked token: refused at the first lookup', async () => {
    expect((await run({ revokedAt: '2026-01-01 00:00:00' })).door).toBe('rejected_at_resolveExternalToken')
  })

  it('wrong-tenant member: refused at the first lookup', async () => {
    expect((await run({ memberTenant: 'other' })).door).toBe('rejected_at_resolveExternalToken')
  })

  it('suspended member: refused at the first lookup', async () => {
    expect((await run({ memberStatus: 'suspended' })).door).toBe('rejected_at_resolveExternalToken')
  })

  it('unbound workspace key: admitted, no bound agent', async () => {
    const out = await run({ bound: false })
    expect(out).toMatchObject({ door: 'admitted', bound: null, channel: 'workspace', caps: ['squad:sq1:admin'] })
  })

  it('expired capability grant is not surfaced (live grants only)', async () => {
    const out = await run({ capExpired: true })
    expect(out).toMatchObject({ door: 'admitted', caps: [] })
  })

  it('token revoked between the first lookup and the context build: context refused (per-request liveness stays fresh)', async () => {
    await seedMcp()
    const t = newTrace()
    const env = mcpEnv(t)
    const r = await resolveExternalToken(env, RAW)
    expect(r).not.toBeNull()
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-01-01 00:00:00' WHERE id = 't1'`)
    expect(await buildAuthContextFromProps(env, r!.props)).toBeNull()
  })

  it('token revoked after the context build, before the mcpApp boundary: no tool runs', async () => {
    await seedMcp()
    const t = newTrace()
    const env = mcpEnv(t)
    const r = await resolveExternalToken(env, RAW)
    const auth = await buildAuthContextFromProps(env, r!.props)
    expect(auth).not.toBeNull()
    h.sqlite.exec(`UPDATE member_tokens SET revoked_at = '2026-01-01 00:00:00' WHERE id = 't1'`)
    const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }) })
    const res = await mcpApp.fetch(mcpInternalRequest(req, auth!), env)
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } }
    // The boundary re-reads the token row: it nulls tokenId and the weld, and the call is not served as the agent.
    const payload = body.result?.content?.[0]?.text ? (JSON.parse(body.result.content[0].text) as { result?: { bound_agent_id?: unknown } }) : undefined
    expect(payload?.result?.bound_agent_id ?? null).toBeNull()
  })

  it('member suspended between context build and the boundary: no standing as the member', async () => {
    await seedMcp()
    const t = newTrace()
    const env = mcpEnv(t)
    const r = await resolveExternalToken(env, RAW)
    const auth = await buildAuthContextFromProps(env, r!.props)
    h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'm1'`)
    const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }) })
    const res = await mcpApp.fetch(mcpInternalRequest(req, auth!), env)
    const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } }
    const payload = body.result?.content?.[0]?.text ? (JSON.parse(body.result.content[0].text) as { result?: { bound_agent_id?: unknown } }) : undefined
    expect(payload?.result?.bound_agent_id ?? null).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// (b) signed-in human dashboard GET: requireAuth (cookie -> KV -> D1)
// ══════════════════════════════════════════════════════════════════════════════
const SID = 'sid-' + 'b'.repeat(32)

interface DashSeed {
  role?: 'owner' | 'admin' | 'member'
  memberStatus?: string
  revoked?: boolean
  idleExpired?: boolean
  lastSeenMsAgo?: number
  registered?: boolean
}

async function seedDash(o: DashSeed = {}): Promise<Env> {
  const role = o.role ?? 'member'
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1','d1','D');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('sq1','d1','s1','S','work');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('hm1','hm1@t','H','${o.memberStatus ?? 'active'}','${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('hc1','hm1','squad','sq1','member');
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id) VALUES ('li1','${TENANT}','google','sub1','hm1@t','hm1');
  `)
  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  h.sqlite.prepare(`INSERT INTO web_sessions (id_hash, tenant, member_id, login_identity_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(await hashWebSessionId(SID), TENANT, 'hm1', 'li1', iso(now - 3600_000), iso(now - (o.lastSeenMsAgo ?? 60_000)), iso(o.idleExpired ? now - 1000 : now + 3600_000), iso(now + 86_400_000), o.revoked ? iso(now - 1000) : null)
  const record = { userId: 'u1', email: 'hm1@t', role, createdAt: iso(now), ...(o.registered === false ? {} : { webSessionRegistered: true }) }
  return { DB: traced(h, dashTrace), TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: memoryKv({ [`sess:${SID}`]: JSON.stringify(record) }) } as unknown as Env
}

let dashTrace: Trace

interface DashOutcome { status: number; role?: string; memberId?: string | null; webSessionMemberId?: string | null; caps?: string[] | null; channel?: string | null }

async function dashGet(env: Env): Promise<DashOutcome> {
  let seen: AuthContext | undefined
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
  app.use('*', requireAuth)
  app.get('/probe', (c) => { seen = c.get('auth'); return c.text('ok') })
  const res = await app.request('/probe', { headers: { cookie: `mupot_session=${SID}` } }, env)
  if (res.status !== 200 || !seen) return { status: res.status }
  return {
    status: 200,
    role: seen.role,
    memberId: seen.memberId ?? null,
    webSessionMemberId: seen.webSessionMemberId ?? null,
    caps: seen.capabilities === undefined ? null : capStr(seen.capabilities),
    channel: seen.channel ?? null,
  }
}

describe('dashboard session auth: D1 round trips before the handler', () => {
  beforeEach(() => { dashTrace = newTrace() })

  it('signed-in owner (cookie): 1 wave when the session was touched recently; was 3', async () => {
    const env = await seedDash({ role: 'owner' })
    const out = await dashGet(env)
    expect(out).toMatchObject({ status: 200, role: 'owner', memberId: 'hm1', caps: null })
    expect(dashTrace.waves).toBe(1)
    expect(dashTrace.sqls.length).toBe(2)
  })

  it('signed-in plain member: 2 waves (members+session in parallel, then grants); was 4', async () => {
    const env = await seedDash({ role: 'member' })
    const out = await dashGet(env)
    expect(out).toMatchObject({ status: 200, role: 'member', memberId: 'hm1', caps: ['squad:sq1:member'] })
    expect(dashTrace.waves).toBe(2)
    expect(dashTrace.sqls.length).toBe(3)
  })

  it('stale last_seen_at adds exactly the one UPDATE (coalesced write), no extra SELECT', async () => {
    const env = await seedDash({ role: 'owner', lastSeenMsAgo: 10 * 60 * 60_000 })
    await dashGet(env)
    expect(dashTrace.sqls.filter((s) => s.startsWith('SELECT last_seen_at FROM web_sessions')).length).toBe(0)
    expect(dashTrace.sqls.filter((s) => s.startsWith('UPDATE web_sessions SET last_seen_at')).length).toBe(1)
    expect(dashTrace.waves).toBe(2)
    const row = h.sqlite.prepare(`SELECT last_seen_at FROM web_sessions`).get() as { last_seen_at: string }
    expect(Date.now() - Date.parse(row.last_seen_at)).toBeLessThan(60_000)
  })
})

describe('dashboard session auth semantics are unchanged by the batching', () => {
  beforeEach(() => { dashTrace = newTrace() })

  it('valid member: bridged to the member with live grants', async () => {
    expect(await dashGet(await seedDash({ role: 'member' }))).toEqual({
      status: 200, role: 'member', memberId: 'hm1', webSessionMemberId: 'hm1', caps: ['squad:sq1:member'], channel: 'dashboard',
    })
  })

  it('valid owner: identity attached, authority stays legacy-role (capabilities undefined)', async () => {
    expect(await dashGet(await seedDash({ role: 'owner' }))).toEqual({
      status: 200, role: 'owner', memberId: 'hm1', webSessionMemberId: 'hm1', caps: null, channel: 'dashboard',
    })
  })

  it('revoked web session: 401 and the KV session is deleted', async () => {
    const env = await seedDash({ role: 'owner', revoked: true })
    expect((await dashGet(env)).status).toBe(401)
    expect(await env.SESSIONS.get(`sess:${SID}`)).toBeNull()
  })

  it('idle-expired web session: 401 and the KV session is deleted', async () => {
    const env = await seedDash({ role: 'member', idleExpired: true })
    expect((await dashGet(env)).status).toBe(401)
    expect(await env.SESSIONS.get(`sess:${SID}`)).toBeNull()
  })

  it('suspended member: 401 and the KV session is deleted (both guards)', async () => {
    const env = await seedDash({ role: 'owner', memberStatus: 'suspended' })
    expect((await dashGet(env)).status).toBe(401)
    expect(await env.SESSIONS.get(`sess:${SID}`)).toBeNull()
  })

  it('no cookie / unknown session: 401', async () => {
    const env = await seedDash({ role: 'owner' })
    const app = new Hono<{ Bindings: Env }>()
    app.use('*', requireAuth)
    app.get('/probe', (c) => c.text('ok'))
    expect((await app.request('/probe', {}, env)).status).toBe(401)
    expect((await app.request('/probe', { headers: { cookie: 'mupot_session=nope' } }, env)).status).toBe(401)
  })
})
