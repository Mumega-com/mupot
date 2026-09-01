// tests/agent-sessions-mcp-integration.test.ts — Delivery Sequence step 2
// (mupot task f5fe1222, mumega-com#1173), exercised through the REAL MCP
// tool surface (src/mcp TOOLS + invokeTool), not a standalone wrapper around
// the D1 functions — see tests/agent-sessions.test.ts for those unit-level
// cases. Real migration chain (createSqliteD1 + applyAllMigrations), real
// member_tokens/agents/squads rows, real tool gating.
//
// RED/GREEN: before this branch, check_in never created any session-tracking
// row at all (there was nothing for list_agent_sessions to list, nothing for
// end_agent_session/revoke_agent_session to revoke, and deactivate_agent /
// revoke_agent_token left a "session" — if one had existed — reading as live
// forever). GREEN is this file passing on this branch's code.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool, TOOLS } from '../src/mcp'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { evaluateAgentSession, loadAgentSessionById } from '../src/auth/agent-sessions'

const TENANT = 'mumega'
const DEPT = 'dept-1'
const SQUAD = 'squad-1'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const ADMIN_MEMBER = 'member-admin'
const TOKEN_ID = 'token-a-1'
const TOKEN_ID_2 = 'token-a-2'

function fakeSessionsKv() {
  const store = new Map<string, string>()
  return {
    async get(key: string) {
      return store.get(key) ?? null
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
    async delete(key: string) {
      store.delete(key)
    },
  }
}

describe('agent_sessions — integration through the real MCP tool surface', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db, SESSIONS: fakeSessionsKv() } as unknown as Env

    await env.DB.prepare(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`).bind(DEPT).run()
    await env.DB.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad', 'Squad')`)
      .bind(SQUAD, DEPT)
      .run()
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, 'agent-a', 'Agent A', 'member', 'test', 'active')`,
    )
      .bind(AGENT_ID, SQUAD)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, 'Agent A Member', 'active', datetime('now'))`,
    )
      .bind(AGENT_MEMBER, TENANT)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, 'Admin', 'active', datetime('now'))`,
    )
      .bind(ADMIN_MEMBER, TENANT)
      .run()
    // member_tokens_agent_binding_insert (migration 0071) requires a matching
    // agent_member_bindings row before ANY agent-bound member_tokens INSERT.
    await env.DB.prepare(
      `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`,
    )
      .bind(TENANT, AGENT_ID, AGENT_MEMBER)
      .run()
    // The agent's live bearer credential — the SAME row auth.tokenId names.
    await env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
       VALUES (?1, ?2, 'hash-1', 'primary', 'workspace', ?3, ?4, datetime('now'))`,
    )
      .bind(TOKEN_ID, AGENT_MEMBER, TENANT, AGENT_ID)
      .run()
    await env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
       VALUES (?1, ?2, 'hash-2', 'secondary', 'workspace', ?3, ?4, datetime('now'))`,
    )
      .bind(TOKEN_ID_2, AGENT_MEMBER, TENANT, AGENT_ID)
      .run()
  })

  afterEach(() => harness.close())

  function agentAuth(tokenId = TOKEN_ID): AuthContext {
    return {
      userId: AGENT_MEMBER,
      memberId: AGENT_MEMBER,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: AGENT_ID,
      capabilities: [],
      tokenId,
    }
  }

  function adminAuth(grants: CapabilityGrant[] = [
    { member_id: ADMIN_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' },
  ]): AuthContext {
    return {
      userId: ADMIN_MEMBER,
      memberId: ADMIN_MEMBER,
      email: 'admin@example.com',
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: null,
      capabilities: grants,
    }
  }

  it('the new tools are advertised on the MCP surface', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain('end_agent_session')
    expect(names).toContain('list_agent_sessions')
    expect(names).toContain('revoke_agent_session')
  })

  it('check_in creates a first-class agent_sessions row on first use and echoes it back', async () => {
    const res = await invokeTool(agentAuth(), env, 'check_in', { seat: 'laptop' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    const result = res.result as { agent_session?: { id: string; idle_expires_at: string; absolute_expires_at: string } }
    expect(result.agent_session?.id).toBeTruthy()

    const row = await loadAgentSessionById(env, TENANT, result.agent_session!.id)
    expect(row).toMatchObject({ agent_id: AGENT_ID, member_id: AGENT_MEMBER, auth_kind: 'workspace_token', credential_id: TOKEN_ID, seat: 'laptop' })
    expect(evaluateAgentSession(row!).ok).toBe(true)
  })

  it('check_in for a DIFFERENT token on the same agent creates a DISTINCT session', async () => {
    const first = await invokeTool(agentAuth(TOKEN_ID), env, 'check_in', {}, 'https://pot.example')
    const second = await invokeTool(agentAuth(TOKEN_ID_2), env, 'check_in', {}, 'https://pot.example')
    const firstId = (first.result as { agent_session: { id: string } }).agent_session.id
    const secondId = (second.result as { agent_session: { id: string } }).agent_session.id
    expect(firstId).not.toBe(secondId)
  })

  it('a pure human/operator principal (no boundAgentId) gets check_in behavior unchanged — no agent_session in the response', async () => {
    // check_in requires a member-token principal but not necessarily an agent-bound one.
    const humanAuth: AuthContext = { ...adminAuth(), memberId: ADMIN_MEMBER, tokenId: 'admin-token' }
    const res = await invokeTool(humanAuth, env, 'check_in', {}, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect((res.result as Record<string, unknown>).agent_session).toBeUndefined()
  })

  it('end_agent_session: the agent can revoke its OWN exact current session with no id argument', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const sessionId = (checkin.result as { agent_session: { id: string } }).agent_session.id

    const res = await invokeTool(agentAuth(), env, 'end_agent_session', {}, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ revoked: true, session_id: sessionId })

    const row = await loadAgentSessionById(env, TENANT, sessionId)
    expect(evaluateAgentSession(row!).ok).toBe(false)
  })

  it('end_agent_session: fails closed with not_agent_session for a pure human/operator principal', async () => {
    const res = await invokeTool(adminAuth(), env, 'end_agent_session', {}, 'https://pot.example')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('not_agent_session')
  })

  it('after self-ending its session, the SAME still-valid credential gets a FRESH session on next check_in (no new bearer minted)', async () => {
    const first = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const firstId = (first.result as { agent_session: { id: string } }).agent_session.id
    await invokeTool(agentAuth(), env, 'end_agent_session', {}, 'https://pot.example')

    const second = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const secondId = (second.result as { agent_session: { id: string } }).agent_session.id
    expect(secondId).not.toBe(firstId)
    // Same credential (TOKEN_ID) throughout — this proves no new bearer was minted;
    // only the session-tracking row changed.
    const row = await loadAgentSessionById(env, TENANT, secondId)
    expect(row?.credential_id).toBe(TOKEN_ID)
  })

  it('list_agent_sessions: an operator with admin-on-squad can list an agent\'s sessions; a bound-agent caller is refused', async () => {
    await invokeTool(agentAuth(), env, 'check_in', { seat: 'laptop' }, 'https://pot.example')

    const asOperator = await invokeTool(adminAuth(), env, 'list_agent_sessions', { agent: AGENT_ID }, 'https://pot.example')
    expect(asOperator.ok).toBe(true)
    const result = asOperator.result as { live_count: number; sessions: Array<{ seat: string | null; live: boolean }> }
    expect(result.live_count).toBe(1)
    expect(result.sessions[0]).toMatchObject({ seat: 'laptop', live: true })

    // The AAGATE capability-floor pre-check (src/mcp/index.ts invokeTool) runs
    // BEFORE the tool body, so a caller must ALSO hold the 'admin' floor to even
    // reach list_agent_sessions' own operator_principal_required check — same
    // shape as list_agent_tokens' precedent test. This isolates that specific
    // gate rather than conflating it with the floor check.
    const boundAgentWithAdmin: AuthContext = {
      ...agentAuth(),
      capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const asAgent = await invokeTool(boundAgentWithAdmin, env, 'list_agent_sessions', { agent: AGENT_ID }, 'https://pot.example')
    expect(asAgent.ok).toBe(false)
    if (!asAgent.ok) expect(asAgent.error).toBe('operator_principal_required')
  })

  it('list_agent_sessions: an operator WITHOUT admin on the target squad is refused (403 forbidden)', async () => {
    await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const weakAdmin = adminAuth([{ member_id: ADMIN_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }])
    const res = await invokeTool(weakAdmin, env, 'list_agent_sessions', { agent: AGENT_ID }, 'https://pot.example')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('forbidden')
  })

  it('revoke_agent_session: an operator with admin-on-squad can revoke a named session; ownership is enforced', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const sessionId = (checkin.result as { agent_session: { id: string } }).agent_session.id

    const res = await invokeTool(adminAuth(), env, 'revoke_agent_session', { agent: AGENT_ID, session_id: sessionId }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect(res.result).toMatchObject({ revoked: true })

    const row = await loadAgentSessionById(env, TENANT, sessionId)
    expect(evaluateAgentSession(row!).ok).toBe(false)

    // Idempotent second call.
    const again = await invokeTool(adminAuth(), env, 'revoke_agent_session', { agent: AGENT_ID, session_id: sessionId }, 'https://pot.example')
    expect(again.result).toMatchObject({ revoked: false, already_revoked: true })
  })

  it('revoke_agent_token also retires the agent_sessions row keyed to that SAME credential (fact 3)', async () => {
    const checkin = await invokeTool(agentAuth(TOKEN_ID), env, 'check_in', {}, 'https://pot.example')
    const sessionId = (checkin.result as { agent_session: { id: string } }).agent_session.id

    const res = await invokeTool(adminAuth(), env, 'revoke_agent_token', { agent: AGENT_ID, token_id: TOKEN_ID }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect((res.result as { revoked: boolean }).revoked).toBe(true)

    const row = await loadAgentSessionById(env, TENANT, sessionId)
    expect(row?.revoked_at).not.toBeNull()
    expect(row?.revoke_reason).toBe('token_revoked')
    expect(evaluateAgentSession(row!).ok).toBe(false)
  })

  it('revoke_agent_token for token A does NOT touch token B\'s live session (never a blanket agent-wide revoke)', async () => {
    const checkinA = await invokeTool(agentAuth(TOKEN_ID), env, 'check_in', {}, 'https://pot.example')
    const checkinB = await invokeTool(agentAuth(TOKEN_ID_2), env, 'check_in', {}, 'https://pot.example')
    const sessionAId = (checkinA.result as { agent_session: { id: string } }).agent_session.id
    const sessionBId = (checkinB.result as { agent_session: { id: string } }).agent_session.id

    await invokeTool(adminAuth(), env, 'revoke_agent_token', { agent: AGENT_ID, token_id: TOKEN_ID }, 'https://pot.example')

    const rowA = await loadAgentSessionById(env, TENANT, sessionAId)
    const rowB = await loadAgentSessionById(env, TENANT, sessionBId)
    expect(evaluateAgentSession(rowA!).ok).toBe(false)
    expect(evaluateAgentSession(rowB!).ok).toBe(true)
  })

  it('deactivate_agent revokes EVERY live agent_sessions row for that agent and reports the count (fact 3)', async () => {
    const checkinA = await invokeTool(agentAuth(TOKEN_ID), env, 'check_in', {}, 'https://pot.example')
    const checkinB = await invokeTool(agentAuth(TOKEN_ID_2), env, 'check_in', {}, 'https://pot.example')
    const sessionAId = (checkinA.result as { agent_session: { id: string } }).agent_session.id
    const sessionBId = (checkinB.result as { agent_session: { id: string } }).agent_session.id

    const res = await invokeTool(adminAuth([{ member_id: ADMIN_MEMBER, scope_type: 'org', scope_id: null, capability: 'admin' }]), env, 'deactivate_agent', { agent: AGENT_ID }, 'https://pot.example')
    expect(res.ok).toBe(true)
    expect((res.result as { agent_sessions_revoked: number }).agent_sessions_revoked).toBe(2)

    expect(evaluateAgentSession((await loadAgentSessionById(env, TENANT, sessionAId))!).ok).toBe(false)
    expect(evaluateAgentSession((await loadAgentSessionById(env, TENANT, sessionBId))!).ok).toBe(false)
  })
})
