// tests/agent-directory-scope.test.ts — board a90ff195 (P0 2026-11-10).
//
// resolve_agent / get_agent_profile read the whole `agents` table for any caller holding
// observer on ANY scope — which a stranger's OAuth home squad satisfies. The directory now
// shows an agent only to an org admin, to the agent itself, or to a caller holding
// observer-or-above on THAT agent's squad (canOnSquad, the primitive squad_member_list and
// peers use). Real migrated schema; every call goes through the real MCP entry points.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { invokeTool, mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { resetHarnessProbeSampling } from '../src/mcp/harness-identity-probe'
import { resetAutoSeatRefusalCache } from '../src/members/seat-auto'
import { createHomeForMember } from '../src/org/service'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
function memoryKv() {
  const s = new Map<string, string>()
  return {
    async get(k: string, t?: string) { const v = s.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v },
    async put(k: string, v: string) { s.set(k, v) },
    async delete(k: string) { s.delete(k) },
    async list() { return { keys: [], list_complete: true } },
  }
}

let h: SqliteD1Harness
let env: Env
let tok = 0

function seed(): void {
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a','dept-a','Customer A'),('dept-b','dept-b','Customer B'),('dept-c','dept-c','Customer C');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('cust-a','dept-a','cust-a','Cust A','work'),('cust-b','dept-b','cust-b','Cust B','work'),('cust-c','dept-c','cust-c','Cust C','work');
    INSERT INTO members (id, email, display_name, status, created_at, tenant) VALUES
      ('mem-alice','alice@a.test','Alice','active','2026-10-01T00:00:00Z','${TENANT}'),
      ('mem-bob','bob@b.test','Bob','active','2026-10-01T00:00:00Z','${TENANT}'),
      ('mem-obs','obs@x.test','Obs','active','2026-10-01T00:00:00Z','${TENANT}'),
      ('mem-x','x@evil.test','Stranger','active','2026-11-10T00:00:00Z','${TENANT}'),
      ('mem-root','root@x.test','Root','active','2026-10-01T00:00:00Z','${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, status, purpose, owner_member_id) VALUES
      ('agent-a1','cust-a','a1','Alpha One','active','secret purpose A','mem-alice'),
      ('agent-a2','cust-a','a2','Alpha Two','active','p','mem-alice'),
      ('agent-b1','cust-b','b1','Bravo One','active','secret purpose B','mem-bob'),
      ('agent-c1','cust-c','c1','Charlie One','active','p','mem-bob');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c1','mem-alice','squad','cust-a','member'),
      ('c2','mem-bob','squad','cust-b','member'),
      ('c3','mem-obs','squad','cust-a','member'),
      ('c4','mem-obs','squad','cust-b','observer'),
      ('c5','mem-root','org',NULL,'admin');
  `)
}

async function authFor(memberId: string, opts: { boundAgentId?: string; withHarness?: boolean; channel?: 'workspace' | 'directory' } = {}): Promise<AuthContext> {
  const tokenId = `tok-${memberId}-${++tok}`
  // Seat sessions are directory-channel (zero ambient grants, seat standing); API-key style
  // callers (members, bound agents, admins) are workspace-channel with their live D1 grants.
  const channel = opts.channel ?? (opts.withHarness ? 'directory' : 'workspace')
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}','${memberId}','hash-${tokenId}','oauth:x','${channel}','2026-11-10T00:00:00Z','${TENANT}')`)
  let harnessId: string | undefined
  if (opts.withHarness) {
    const hr = await upsertHarness(env, memberId, 'client-x', 'ChatGPT', tokenId)
    harnessId = hr?.id
  }
  const ctx = await buildAuthContextFromProps(env, {
    memberId, tokenId, email: null, channel, boundAgentId: opts.boundAgentId ?? null,
    ...(harnessId ? { harnessId } : {}),
  })
  if (!ctx) throw new Error('auth context null')
  return ctx
}

interface Matches { ok: boolean; status?: number; error?: string; result?: { matches?: { id: string }[]; profile?: { id: string } } }
async function call(ctx: AuthContext, tool: string, args: Record<string, unknown>): Promise<Matches> {
  const out = await invokeTool(ctx, env, tool, args)
  return JSON.parse(JSON.stringify(out)) as Matches
}
async function resolveIds(ctx: AuthContext, query: string): Promise<string[]> {
  const out = await call(ctx, 'resolve_agent', { query })
  expect(out.ok).toBe(true)
  return (out.result?.matches ?? []).map((m) => m.id).sort()
}
// The OAuth chat-seat path: a real /mcp tools/call with an openai session, as the reviewer drove it.
async function rpc(ctx: AuthContext, name: string, args: Record<string, unknown>, session: string): Promise<string> {
  const params = { name, arguments: args, _meta: { 'openai/session': session } }
  const req = new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params }) })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  return res.text()
}

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = {
    DB: h.db, TENANT_SLUG: TENANT, PUBLIC_ORIGIN: 'https://pot.test', SESSIONS: memoryKv(),
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    BUS: { send: async () => undefined },
    SEAT_AUTO_ENROLL: '1', SEAT_ATTACH: '1', SEAT_ATTACH_DESIGNATED: '1', VIP_LANE: '1',
    SEAT_MAX_PER_MEMBER: '48', SEAT_MAX_TOTAL_PER_MEMBER: '256', SEAT_MAX_TOTAL_PER_HARNESS: '128',
  } as unknown as Env
  seed()
  resetHarnessProbeSampling()
  resetAutoSeatRefusalCache()
})
afterEach(() => h.close())

describe('agent directory scope', () => {
  it('a member-rank agent in A cannot resolve or profile anything in B (slug, id, name, broad query)', async () => {
    const a = await authFor('mem-alice', { boundAgentId: 'agent-a1' })
    expect(await resolveIds(a, 'b1')).toEqual([])
    expect(await resolveIds(a, 'agent-b1')).toEqual([])
    expect(await resolveIds(a, 'Bravo')).toEqual([])
    expect(await resolveIds(a, 'one')).toEqual(['agent-a1'])
    expect(await resolveIds(a, 'a')).toEqual(['agent-a1', 'agent-a2'])
    for (const id of ['agent-b1', 'agent-c1']) {
      const p = await call(a, 'get_agent_profile', { agent_id: id })
      expect(p.ok).toBe(false)
    }
    expect((await call(a, 'get_agent_profile', { agent_id: 'agent-a2' })).ok).toBe(true)
  })

  it('observer on B with member on A: sees A and B (observer may read a squad roster, as squad_member_list), not C', async () => {
    const o = await authFor('mem-obs', { boundAgentId: 'agent-a2' })
    expect(await resolveIds(o, 'one')).toEqual(['agent-a1', 'agent-b1'])
    expect((await call(o, 'get_agent_profile', { agent_id: 'agent-b1' })).ok).toBe(true)
    expect((await call(o, 'get_agent_profile', { agent_id: 'agent-c1' })).ok).toBe(false)
  })

  it('org admin sees every agent', async () => {
    const r = await authFor('mem-root')
    expect(await resolveIds(r, 'one')).toEqual(['agent-a1', 'agent-b1', 'agent-c1'])
    expect((await call(r, 'get_agent_profile', { agent_id: 'agent-b1' })).ok).toBe(true)
  })

  it('a bound agent always sees itself, even with no grant on its squad', async () => {
    h.sqlite.exec(`DELETE FROM capabilities WHERE id = 'c2'; INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c6','mem-bob','squad','cust-c','member')`)
    const b = await authFor('mem-bob', { boundAgentId: 'agent-b1' })
    expect(await resolveIds(b, 'one')).toEqual(['agent-b1', 'agent-c1'])
    expect((await call(b, 'get_agent_profile', { agent_id: 'agent-b1' })).ok).toBe(true)
    expect((await call(b, 'get_agent_profile', { agent_id: 'agent-a1' })).ok).toBe(false)
  })

  it('not visible and nonexistent answer identically', async () => {
    const a = await authFor('mem-alice', { boundAgentId: 'agent-a1' })
    const hidden = await call(a, 'get_agent_profile', { agent_id: 'agent-b1' })
    const missing = await call(a, 'get_agent_profile', { agent_id: 'agent-nope' })
    expect(hidden).toEqual(missing)
    expect(hidden.status).toBe(404)
    expect(hidden.error).toBe('agent_not_found')
    // resolve_agent: a hidden match is the same empty answer as no match at all
    expect(await call(a, 'resolve_agent', { query: 'bravo' })).toEqual(await call(a, 'resolve_agent', { query: 'zzzzqq' }))
  })

  it('the limit counts only visible agents (hidden rows sort first but cannot crowd the result)', async () => {
    h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c7','mem-bob','squad','cust-c','member'); DELETE FROM capabilities WHERE id = 'c2'`)
    const c = await authFor('mem-bob', { boundAgentId: 'agent-c1' })
    // Alpha One and Bravo One sort before Charlie One and are hidden from this caller.
    expect(await call(c, 'resolve_agent', { query: 'one', limit: 1 }).then((o) => (o.result?.matches ?? []).map((m) => m.id))).toEqual(['agent-c1'])
  })

  describe('stranger (fresh Google account: home squad only), the OAuth chat-seat shape', () => {
    function homeSquadId(): string {
      const row = h.sqlite.prepare(`SELECT id FROM squads WHERE kind = 'home'`).all()[0]
      return String(row?.id)
    }
    function seatIds(text: string): string[] {
      const rpcBody = JSON.parse(text) as { result?: { structuredContent?: { matches?: { id: string }[] } } }
      return (rpcBody.result?.structuredContent?.matches ?? []).map((m) => m.id)
    }

    it('chat seat: sees only its own home agent, nothing of A, B or C (held seat is the same path)', async () => {
      await createHomeForMember(env, 'mem-x')
      const ctx = await authFor('mem-x', { withHarness: true })
      const session = 'conv-1'
      // The seat agent is created on first call; the first visible match is its own home agent.
      const own = seatIds(await rpc(ctx, 'resolve_agent', { query: 'a' }, session))
      expect(own.length).toBe(1)
      const ownSquad = h.sqlite.prepare(`SELECT squad_id FROM agents WHERE id = ?`).all(own[0])[0]?.squad_id
      expect(ownSquad).toBe(homeSquadId())
      for (const q of ['a', 'o', 'one', 'e', 'cust', 'agent']) {
        const text = await rpc(ctx, 'resolve_agent', { query: q }, session)
        for (const id of seatIds(text)) expect(id).toBe(own[0])
        for (const leaked of ['agent-a1', 'agent-a2', 'agent-b1', 'agent-c1', 'secret purpose']) {
          expect(text.includes(leaked)).toBe(false)
        }
      }
      for (const id of ['agent-a1', 'agent-b1', 'agent-c1']) {
        const text = await rpc(ctx, 'get_agent_profile', { agent_id: id }, session)
        expect(text.includes('secret purpose')).toBe(false)
        expect(text.includes('Alpha') || text.includes('Bravo') || text.includes('Charlie')).toBe(false)
      }
      expect((await rpc(ctx, 'get_agent_profile', { agent_id: own[0] }, session)).includes(own[0])).toBe(true)
    })

    it('a bootstrap-style stranger key (home squad grant, bound to its home agent) sees only that agent', async () => {
      await createHomeForMember(env, 'mem-x')
      const home = homeSquadId()
      h.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-x-home','${home}','x-home','Helper','active')`)
      const ctx = await authFor('mem-x', { boundAgentId: 'agent-x-home' })
      expect(await resolveIds(ctx, 'e')).toEqual(['agent-x-home'])
      expect(await resolveIds(ctx, 'one')).toEqual([])
      expect((await call(ctx, 'get_agent_profile', { agent_id: 'agent-x-home' })).ok).toBe(true)
      for (const id of ['agent-a1', 'agent-b1', 'agent-c1']) {
        expect((await call(ctx, 'get_agent_profile', { agent_id: id })).ok).toBe(false)
      }
    })
  })
})
