// tests/bound-agent-live-authz.test.ts — mupot#983: agent-bound MCP tools re-check the weld live.
//
// Every fixture caller is a plain member-rank agent session: NOT an org owner and with no workspace-admin
// standing, so the admin bypass cannot mask the check under test.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { boundAgentRefusal, mcpApp, mcpActionsApp } from '../src/mcp/index'
import { hashMemberToken } from '../src/auth/member-bearer'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { seedLiveToken } from './helpers/live-token'
import { boundAgentIsLive, BOUND_AGENT_NOT_AUTHORIZED } from '../src/auth/bound-agent-live'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const OWNER = 'member-owner'
const CONSENTER = 'member-consenter'
const AGENT_MEMBER = 'member-agent-a'

let harness: SqliteD1Harness

function envFor(h: SqliteD1Harness): Env {
  return { DB: h.db, TENANT_SLUG: TENANT, BUS: { send: async () => {} } } as unknown as Env
}

function agentAuth(extra: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: AGENT_MEMBER,
    email: null,
    role: 'member',
    tenant: TENANT,
    memberId: AGENT_MEMBER,
    channel: 'workspace',
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    boundAgentId: 'agent-a',
    tokenId: 'tok-1',
    ...extra,
  } as AuthContext
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-eng', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-eng', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-b', 'squad-a', 'agent-b', 'Agent B', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${OWNER}', 'Owner', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${CONSENTER}', 'Consenter', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${AGENT_MEMBER}', 'Agent A', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-a', '${AGENT_MEMBER}', '2026-08-01T00:00:00.000Z');
    UPDATE agents SET owner_member_id = '${OWNER}' WHERE id = 'agent-a';
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', '${AGENT_MEMBER}', 'squad', 'squad-a', 'member');
  `)
})

afterEach(() => harness.close())

// Every tool that authorizes on auth.boundAgentId alone, with a call that reaches its body when the weld is live.
const TOOL_CALLS: Array<[string, Record<string, unknown>]> = [
  ['inbox', {}],
  ['inbox_consumer_status', {}],
  ['send', { to: 'agent-b', body: 'hello' }],
  ['presence_list', { self: true }],
]

const denied = (status: number, error: string) => ({ ok: false, status, error })

describe('#983 live capability check at the tool boundary', () => {
  it.each(TOOL_CALLS)('active agent: %s is not refused by the live check', async (tool) => {
    expect(await boundAgentRefusal(envFor(harness), agentAuth(), tool)).toBeNull()
  })

  it.each(TOOL_CALLS)('deactivated agent (token not swept): %s -> 403', async (tool) => {
    harness.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'agent-a'`)
    expect(await boundAgentRefusal(envFor(harness), agentAuth(), tool)).toMatchObject(denied(403, BOUND_AGENT_NOT_AUTHORIZED))
  })

  it('paused agent keeps the existing pause semantics (admitted, same set as TOKEN_LIVE_PREDICATE)', async () => {
    harness.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = 'agent-a'`)
    expect(await boundAgentRefusal(envFor(harness), agentAuth(), 'inbox')).toBeNull()
  })

  it.each(TOOL_CALLS)('agent row gone: %s -> 403', async (tool) => {
    harness.sqlite.exec(`DELETE FROM agent_member_bindings WHERE agent_id = 'agent-a'; DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'; DELETE FROM agents WHERE id = 'agent-a'`)
    expect(await boundAgentRefusal(envFor(harness), agentAuth(), tool)).toMatchObject(denied(403, BOUND_AGENT_NOT_AUTHORIZED))
  })

  it.each(TOOL_CALLS)('owning member removed: %s -> 403', async (tool) => {
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    expect(await boundAgentRefusal(envFor(harness), agentAuth(), tool)).toMatchObject(denied(403, BOUND_AGENT_NOT_AUTHORIZED))
  })

  it.each(TOOL_CALLS)('consenting member removed: %s -> 403', async (tool) => {
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${CONSENTER}'`)
    const auth = agentAuth({ channel: 'directory', consentedByMemberId: CONSENTER })
    expect(await boundAgentRefusal(envFor(harness), auth, tool)).toMatchObject(denied(403, BOUND_AGENT_NOT_AUTHORIZED))
  })

  it('active consenting member: unchanged behaviour', async () => {
    const auth = agentAuth({ channel: 'directory', consentedByMemberId: CONSENTER })
    expect(await boundAgentRefusal(envFor(harness), auth, 'inbox')).toBeNull()
  })

  it('the refusal does not distinguish which leg failed', async () => {
    const env = envFor(harness)
    harness.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'agent-a'`)
    const agentGone = await boundAgentRefusal(env, agentAuth(), 'inbox')
    harness.sqlite.exec(`UPDATE agents SET status = 'active' WHERE id = 'agent-a'; UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    const ownerGone = await boundAgentRefusal(env, agentAuth(), 'inbox')
    expect(agentGone).toEqual(ownerGone)
    expect(agentGone).toMatchObject(denied(403, BOUND_AGENT_NOT_AUTHORIZED))
  })

  it('an unbound session never pays the extra read', async () => {
    expect(await boundAgentIsLive(envFor(harness), { boundAgentId: null })).toBe(true)
  })

  it('fails closed when the read throws', async () => {
    const env = { DB: { prepare: () => { throw new Error('d1 down') } }, TENANT_SLUG: TENANT } as unknown as Env
    expect(await boundAgentIsLive(env, { boundAgentId: 'agent-a' })).toBe(false)
  })

  it('costs exactly one D1 statement per call', async () => {
    let prepared = 0
    const real = harness.db
    const counting = { prepare: (sql: string) => { if (sql.includes('FROM agents a')) prepared++; return real.prepare(sql) } }
    await boundAgentIsLive({ DB: counting as unknown as Env['DB'], TENANT_SLUG: TENANT }, { boundAgentId: 'agent-a', consentedByMemberId: CONSENTER })
    expect(prepared).toBe(1)
  })
})

// ── the real doors: token row -> internal header / bearer -> app -> tool body ───────────────────────
describe('#983 through the real transport doors (non-admin agent token)', () => {
  const BEARER = 'raw-agent-bearer-983'
  const header = async (): Promise<Record<string, string>> => {
    const tokenId = seedLiveToken(harness.sqlite, { memberId: AGENT_MEMBER, tenant: TENANT, tokenId: 'tok-door', channel: 'workspace', boundAgentId: 'agent-a' })
    harness.sqlite.prepare(`UPDATE member_tokens SET token_hash = ? WHERE id = ?`).run(await hashMemberToken(BEARER), tokenId)
    return { 'content-type': 'application/json', authorization: `Bearer ${BEARER}`, [AUTH_CONTEXT_HEADER]: JSON.stringify(agentAuth({ tokenId })) }
  }
  const legacy = async (tool: string, args: Record<string, unknown>) => mcpApp.request('https://pot.test/', {
    method: 'POST', headers: await header(), body: JSON.stringify({ tool, args }),
  }, envFor(harness))
  const rpc = async (tool: string, args: Record<string, unknown>) => mcpApp.request('https://pot.test/', {
    method: 'POST', headers: await header(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  }, envFor(harness))
  const actions = async (tool: string, args: Record<string, unknown>) => mcpActionsApp.request(`https://pot.test/actions/${tool}`, {
    method: 'POST', headers: await header(), body: JSON.stringify(args),
  }, envFor(harness))

  it.each(TOOL_CALLS)('active agent: %s reaches its body on every door', async (tool, args) => {
    expect((await legacy(tool, args)).status).toBeLessThan(400)
    expect((await actions(tool, args)).status).toBeLessThan(400)
    expect(JSON.stringify(await (await rpc(tool, args)).json())).not.toContain(BOUND_AGENT_NOT_AUTHORIZED)
  })

  it.each(TOOL_CALLS)('owning member removed: %s -> 403 agent_not_authorized on every door', async (tool, args) => {
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    for (const door of [legacy, actions]) {
      const res = await door(tool, args)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe(BOUND_AGENT_NOT_AUTHORIZED)
    }
    expect(JSON.stringify(await (await rpc(tool, args)).json())).toContain(BOUND_AGENT_NOT_AUTHORIZED)
  })

  it('deactivated agent: still refused at the door (token layer 401, unchanged), never served', async () => {
    harness.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'agent-a'`)
    expect((await legacy('inbox', {})).status).toBeGreaterThanOrEqual(400)
    expect((await actions('inbox', {})).status).toBeGreaterThanOrEqual(400)
  })

  it('an unbound member session is untouched even when an agent is gone', async () => {
    const tokenId = seedLiveToken(harness.sqlite, { memberId: CONSENTER, tenant: TENANT, tokenId: 'tok-human', channel: 'workspace' })
    harness.sqlite.exec(`UPDATE agents SET status = 'inactive' WHERE id = 'agent-a'`)
    const res = await mcpApp.request('https://pot.test/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify(agentAuth({ tokenId, userId: CONSENTER, memberId: CONSENTER, boundAgentId: null })) },
      body: JSON.stringify({ tool: 'peers', args: {} }),
    }, envFor(harness))
    expect(res.status).not.toBe(403)
  })
})
