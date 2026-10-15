// tests/inactive-agent-mint-and-auth-1961.test.ts — mupot#1961.
//
// A squad admin could mint a LIVE key (and weld) for a DEACTIVATED agent through both mint doors
// (POST /enroll/mint, MCP mint_agent_token), silently undoing deactivate_agent; and bearer auth
// checked the member's status but never the bound agent's. Fixed at two chokepoints:
//   1. src/members/service.ts: every statement of the mint batch carries EXISTS(agent active), so an
//      inactive agent lands zero rows (no member, binding, capability, token, gate grant, audit row).
//   2. src/auth/token-lifecycle.ts TOKEN_LIVE_PREDICATE: a token welded to an inactive agent is not live,
//      on every door that executes the predicate. Reactivating the agent revives the credential.
// Real schema (createSqliteD1 + applyAllMigrations); production functions only, no transcribed SQL.

import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { dashboardApp } from '../src/dashboard/index'
import { mcpApp } from '../src/mcp'
import { AgentInactiveError, mintAgentBoundToken, prepareAgentBoundTokenMint } from '../src/members/service'
import { resolveMemberByToken } from '../src/auth/member-bearer'
import { resolveExternalToken } from '../src/mcp/oauth-authorize'
import type { Env } from '../src/types'
import { mcpRequest, callToolOutcome } from './helpers/mcp-call'

const TENANT = 'pot-1961'
const ORIGIN = 'https://pot.test'
const ADMIN_TOKEN = 'mupot_admin_bearer_1961'
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

let harness: SqliteD1Harness | undefined
afterEach(() => { harness?.close(); harness = undefined })

function setup(): { env: Env; q: (sql: string) => Array<Record<string, unknown>> } {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'dept-a', 'sq-a', 'Squad A');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('m-admin', 'admin@pot.test', 'Admin', 'active', '${TENANT}'),
      ('m-op', 'op@pot.test', 'Operator', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c-admin', 'm-admin', 'squad', 'sq-a', 'admin'),
      ('c-op', 'm-op', 'squad', 'sq-a', 'admin');
    -- the MCP caller is a separate human with its own bearer; the dashboard caller (m-admin) uses a cookie session.
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant)
      VALUES ('t-op', 'm-op', '${sha(ADMIN_TOKEN)}', 'op', 'workspace', datetime('now'), NULL, '${TENANT}');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('ag-live', 'sq-a', 'live', 'Live', 'member', 'test', 'active'),
      ('ag-dead', 'sq-a', 'dead', 'Dead', 'member', 'test', 'inactive'),
      ('ag-paused', 'sq-a', 'paused', 'Paused', 'member', 'test', 'paused');
  `)
  const store = new Map<string, string>([['sess:s-admin', JSON.stringify({ userId: 'u-admin', email: 'admin@pot.test', role: 'member', createdAt: '2026-01-01T00:00:00Z' })]])
  const kv = new Map<string, string>()
  const env = {
    DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'T', PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) } },
    OAUTH_KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v) }, delete: async (k: string) => { kv.delete(k) } },
    VEC: { query: async () => ({ matches: [] }) }, BUS: { send: async () => {} }, BLOBS: {}, AI: {}, AGENT: {}, SQUAD: {},
  } as unknown as Env
  const sqlite = harness.sqlite
  return { env, q: (sql) => sqlite.prepare(sql).all() as Array<Record<string, unknown>> }
}

const enrollMint = (env: Env, agent: string) => dashboardApp.fetch(new Request(`${ORIGIN}/enroll/mint`, {
  method: 'POST',
  headers: { Cookie: 'mupot_session=s-admin', Origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ agent_id: agent, seat: 'laptop' }),
}), env)

const mcpCall = (env: Env, bearer: string, name: string, args: Record<string, unknown> = {}) => mcpApp.request(`${ORIGIN}/`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'tools/call', params: { name, arguments: args } }),
}, env)

const countFor = (q: ReturnType<typeof setup>['q'], agent: string) => ({
  tokens: q(`SELECT COUNT(*) n FROM member_tokens WHERE agent_id = '${agent}'`)[0].n as number,
  bindings: q(`SELECT COUNT(*) n FROM agent_member_bindings WHERE agent_id = '${agent}'`)[0].n as number,
  grants: q(`SELECT COUNT(*) n FROM gate_grants WHERE principal_id = '${agent}'`)[0].n as number,
  members: q(`SELECT COUNT(*) n FROM members WHERE display_name IN (SELECT name FROM agents WHERE id = '${agent}') AND id NOT IN ('m-admin', 'm-op')`)[0].n as number,
})

describe('#1961 mint refuses a non-active agent', () => {
  it('POSITIVE CONTROL: /enroll/mint for an ACTIVE agent mints and welds', async () => {
    const { env, q } = setup()
    const res = await enrollMint(env, 'ag-live')
    expect(res.status).toBe(200)
    expect(countFor(q, 'ag-live')).toEqual({ tokens: 1, bindings: 1, grants: 1, members: 1 })
  })

  it('POST /enroll/mint for an INACTIVE agent is refused 409 agent_inactive, with no token, no weld, no member, no grant', async () => {
    const { env, q } = setup()
    const res = await enrollMint(env, 'ag-dead')
    expect(res.status).toBe(409)
    expect(await res.text()).toContain('agent_inactive')
    expect(countFor(q, 'ag-dead')).toEqual({ tokens: 0, bindings: 0, grants: 0, members: 0 })
    expect(q(`SELECT COUNT(*) n FROM agent_token_issuance_audit`)[0].n).toBe(0)
  })

  it('POST /enroll/mint for a PAUSED agent is refused too (mint requires status=active)', async () => {
    const { env, q } = setup()
    expect((await enrollMint(env, 'ag-paused')).status).toBe(409)
    expect(countFor(q, 'ag-paused').tokens).toBe(0)
  })

  it('mint_agent_token (MCP) for an INACTIVE agent is refused agent_inactive and writes nothing', async () => {
    const { env, q } = setup()
    const out = await callToolOutcome(await mcpCall(env, ADMIN_TOKEN, 'mint_agent_token', { agent: 'ag-dead' }))
    expect(out.status).toBe(409)
    expect(out.error).toBe('agent_inactive')
    expect(countFor(q, 'ag-dead')).toEqual({ tokens: 0, bindings: 0, grants: 0, members: 0 })
  })

  it('POSITIVE CONTROL: mint_agent_token for an ACTIVE agent is not refused as inactive', async () => {
    const { env, q } = setup()
    const out = await callToolOutcome(await mcpCall(env, ADMIN_TOKEN, 'mint_agent_token', { agent: 'ag-live' }))
    expect(out.error).not.toBe('agent_inactive')
    expect(out.status, JSON.stringify(out)).toBe(200)
    expect(countFor(q, 'ag-live').tokens).toBe(1)
  })

  it('the in-batch guard is authoritative: a deactivate landing AFTER the preflight read still mints nothing', async () => {
    const { env, q } = setup()
    // Preflight reads status=active; the agent flips inactive before the batch runs (the race a
    // pre-read alone loses). Simulate by flipping on the first member_tokens-batch boundary.
    const realBatch = env.DB.batch.bind(env.DB)
    let flipped = false
    env.DB.batch = (async (stmts: Parameters<typeof realBatch>[0]) => {
      if (!flipped) { flipped = true; harness!.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'ag-live'`) }
      return realBatch(stmts)
    }) as typeof env.DB.batch
    const agent = { id: 'ag-live', squad_id: 'sq-a', slug: 'live', name: 'Live' }
    await expect(mintAgentBoundToken(env, agent, 'x', {
      issuedBy: { memberId: 'm-admin', principal: 'admin@pot.test', surface: 'enroll' },
    })).rejects.toBeInstanceOf(AgentInactiveError)
    expect(countFor(q, 'ag-live')).toEqual({ tokens: 0, bindings: 0, grants: 0, members: 0 })
    expect(q(`SELECT COUNT(*) n FROM agent_token_issuance_audit`)[0].n).toBe(0)
  })

  it('a LATER mint (binding already exists) for an agent deactivated afterwards is refused with no new token', async () => {
    const { env, q } = setup()
    const agent = { id: 'ag-live', squad_id: 'sq-a', slug: 'live', name: 'Live' }
    await mintAgentBoundToken(env, agent, 'first')
    harness!.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'ag-live'`)
    await expect(mintAgentBoundToken(env, agent, 'second')).rejects.toBeInstanceOf(AgentInactiveError)
    expect(countFor(q, 'ag-live').tokens).toBe(1)
  })
})

describe('#1961 a rotation batch is guarded too', () => {
  it('agent deactivated between prepare and batch: no replacement token lands AND the prior token is NOT revoked', async () => {
    const { env, q } = setup()
    const agent = { id: 'ag-live', squad_id: 'sq-a', slug: 'live', name: 'Live' }
    const first = await mintAgentBoundToken(env, agent, 'prior')
    const prepared = await prepareAgentBoundTokenMint(env, agent, 'next', { revokePriorTokenId: first.tokenId })
    harness!.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'ag-live'`)
    await env.DB.batch(prepared.statements)
    expect(q(`SELECT COUNT(*) n FROM member_tokens WHERE agent_id = 'ag-live'`)[0].n).toBe(1)
    expect(q(`SELECT revoked_at FROM member_tokens WHERE id = '${first.tokenId}'`)[0].revoked_at).toBeNull()
  })

  it('POSITIVE CONTROL: same sequence with the agent still active rotates (replacement lands, prior revoked)', async () => {
    const { env, q } = setup()
    const agent = { id: 'ag-live', squad_id: 'sq-a', slug: 'live', name: 'Live' }
    const first = await mintAgentBoundToken(env, agent, 'prior')
    const prepared = await prepareAgentBoundTokenMint(env, agent, 'next', { revokePriorTokenId: first.tokenId })
    await env.DB.batch(prepared.statements)
    expect(q(`SELECT COUNT(*) n FROM member_tokens WHERE agent_id = 'ag-live'`)[0].n).toBe(2)
    expect(q(`SELECT revoked_at FROM member_tokens WHERE id = '${first.tokenId}'`)[0].revoked_at).not.toBeNull()
  })
})

describe('#1961 bearer auth refuses a token whose bound agent is not active', () => {
  async function mintedAgentToken(env: Env): Promise<string> {
    const m = await mintAgentBoundToken(env, { id: 'ag-live', squad_id: 'sq-a', slug: 'live', name: 'Live' }, 'seat')
    return m.raw
  }

  it('an existing token works, is refused after the agent is deactivated, and works again on reactivation (every door)', async () => {
    const { env } = setup()
    const raw = await mintedAgentToken(env)
    const doors = async () => ({
      member_bearer: (await resolveMemberByToken(env, raw)) !== null,
      external: (await resolveExternalToken(env, raw)) !== null,
      mcp: (await mcpCall(env, raw, 'boot_context')).status === 200,
    })
    expect(await doors()).toEqual({ member_bearer: true, external: true, mcp: true })

    harness!.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'ag-live'`)
    expect(await doors()).toEqual({ member_bearer: false, external: false, mcp: false })

    harness!.sqlite.exec(`UPDATE agents SET status = 'active' WHERE id = 'ag-live'`)
    expect(await doors()).toEqual({ member_bearer: true, external: true, mcp: true })
  })

  it('a PAUSED agent keeps its credential (pause is the reversible wake toggle, not retirement)', async () => {
    const { env } = setup()
    const raw = await mintedAgentToken(env)
    harness!.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = 'ag-live'`)
    expect(await resolveMemberByToken(env, raw)).not.toBeNull()
  })

  it('an UNBOUND (human) token is unaffected by any agent status', async () => {
    const { env } = setup()
    harness!.sqlite.exec(`UPDATE agents SET status = 'inactive'`)
    expect(await resolveMemberByToken(env, ADMIN_TOKEN)).not.toBeNull()
  })

  it('a token whose agent row is missing fails closed', async () => {
    const { env } = setup()
    const raw = await mintedAgentToken(env)
    harness!.sqlite.exec(`PRAGMA foreign_keys = OFF; DELETE FROM agents WHERE id = 'ag-live'`)
    expect(await resolveMemberByToken(env, raw)).toBeNull()
  })
})
