// tests/elevation-mcp-integration.test.ts — Delivery Sequence step 3 (mupot
// task f5fe1222, mumega-com#1173), exercised through the REAL MCP tool
// surface (src/mcp TOOLS + invokeTool) — see tests/elevation.test.ts for the
// D1-backed unit-level cases this file does not repeat. Real migration
// chain (createSqliteD1 + applyAllMigrations), real member_tokens/agents/
// squads rows, real tool gating.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invokeTool, TOOLS } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { decideElevationRequest, loadElevationRequestById } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'

const TENANT = 'mumega'
const DEPT = 'dept-1'
const SQUAD = 'squad-1'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const ADMIN_MEMBER = 'member-admin'
const TOKEN_ID = 'token-a-1'

describe('elevation ledger — integration through the real MCP tool surface', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env

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
      `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, 'admin@x.test', 'Admin', 'active', datetime('now'))`,
    )
      .bind(ADMIN_MEMBER, TENANT)
      .run()
    await env.DB.prepare(
      `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`,
    )
      .bind(TENANT, AGENT_ID, AGENT_MEMBER)
      .run()
    await env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
       VALUES (?1, ?2, 'hash-1', 'primary', 'workspace', ?3, ?4, datetime('now'))`,
    )
      .bind(TOKEN_ID, AGENT_MEMBER, TENANT, AGENT_ID)
      .run()
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?1, ?2, 'squad', ?3, 'admin')`,
    )
      .bind('cap-admin-1', ADMIN_MEMBER, SQUAD)
      .run()
    await env.DB.prepare(
      `INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
       VALUES (?1, ?2, 'google', ?3, 'admin@x.test', ?4, datetime('now'))`,
    )
      .bind('identity-admin', TENANT, ADMIN_MEMBER, ADMIN_MEMBER)
      .run()
  })

  afterEach(() => harness.close())

  function agentAuth(): AuthContext {
    return {
      userId: AGENT_MEMBER, memberId: AGENT_MEMBER, email: null, role: 'member', tenant: TENANT,
      channel: 'workspace', boundAgentId: AGENT_ID, capabilities: [], tokenId: TOKEN_ID,
    }
  }

  function adminAuth(): AuthContext {
    return {
      userId: ADMIN_MEMBER, memberId: ADMIN_MEMBER, email: 'admin@x.test', role: 'member', tenant: TENANT,
      channel: 'workspace', boundAgentId: null,
      capabilities: [{ member_id: ADMIN_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }],
    }
  }

  it('the new tools are advertised on the MCP surface', () => {
    const names = TOOLS.map((t) => t.name)
    expect(names).toContain('request_elevation')
    expect(names).toContain('elevation_status')
  })

  it('request_elevation requires a live agent session (check_in first)', async () => {
    const res = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      { actions: ['action:manage_access'], scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'need it' },
      'https://pot.example',
    )
    expect(res.ok).toBe(false)
  })

  it('request_elevation, once checked in, creates a pending request bound to the exact live session', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const sessionId = (checkin.result as { agent_session: { id: string } }).agent_session.id

    const res = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      { actions: ['action:manage_access'], scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'need it' },
      'https://pot.example',
    )
    expect(res.ok).toBe(true)
    const result = res.result as { request: { id: string; status: string } }
    expect(result.request.status).toBe('pending')

    const row = await loadElevationRequestById(env, TENANT, result.request.id)
    expect(row?.agent_session_id).toBe(sessionId)
  })

  it('a pure human/operator principal cannot call request_elevation for itself (fails closed, no argument names another target either)', async () => {
    const res = await invokeTool(
      adminAuth(),
      env,
      'request_elevation',
      { actions: ['action:manage_access'], scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'x' },
      'https://pot.example',
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toBe('not_agent_session')
  })

  it('request_elevation rejects the literal word "admin" as an action (schema-level: not in the enum)', async () => {
    await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const res = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      { actions: ['admin'], scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'x' },
      'https://pot.example',
    )
    expect(res.ok).toBe(false)
  })

  it('elevation_status reflects a request through pending → approved, and shows the active elevation on the SAME session only', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const sessionId = (checkin.result as { agent_session: { id: string } }).agent_session.id

    const req = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      { actions: ['action:manage_access'], scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'x' },
      'https://pot.example',
    )
    const requestId = (req.result as { request: { id: string } }).request.id

    const pendingStatus = await invokeTool(agentAuth(), env, 'elevation_status', { request_id: requestId }, 'https://pot.example')
    expect((pendingStatus.result as { request: { status: string } }).request.status).toBe('pending')
    expect((pendingStatus.result as { active_elevations: unknown[] }).active_elevations).toHaveLength(0)

    // Human decides — through the SAME core function the dashboard route calls
    // (tests/elevation-approval-routes.test.ts exercises the HTTP surface).
    const approverSession = await createWebSession(env, 'raw-admin', { tenant: TENANT, memberId: ADMIN_MEMBER, loginIdentityId: 'identity-admin' })
    const decision = await decideElevationRequest(env, {
      tenant: TENANT,
      requestId,
      decision: 'approve',
      selectedActions: ['action:manage_access'],
      decidedByMemberId: ADMIN_MEMBER,
      decidedByCapabilities: [{ member_id: ADMIN_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }],
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
    })
    expect(decision.ok).toBe(true)

    const afterStatus = await invokeTool(agentAuth(), env, 'elevation_status', { request_id: requestId }, 'https://pot.example')
    const result = afterStatus.result as {
      session_id: string
      request: { status: string }
      active_elevations: Array<{ action: string; live: boolean }>
    }
    expect(result.session_id).toBe(sessionId)
    expect(result.request.status).toBe('approved')
    expect(result.active_elevations).toHaveLength(1)
    expect(result.active_elevations[0]).toMatchObject({ action: 'action:manage_access', live: true })
  })

  it('elevation_status for a request_id belonging to a DIFFERENT session reads as absent — never a cross-session existence oracle', async () => {
    await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const req = await invokeTool(
      agentAuth(),
      env,
      'request_elevation',
      { actions: ['action:manage_access'], scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'x' },
      'https://pot.example',
    )
    const requestId = (req.result as { request: { id: string } }).request.id

    // A second token/session for the SAME agent.
    const TOKEN_ID_2 = 'token-a-2'
    await env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
       VALUES (?1, ?2, 'hash-2', 'secondary', 'workspace', ?3, ?4, datetime('now'))`,
    )
      .bind(TOKEN_ID_2, AGENT_MEMBER, TENANT, AGENT_ID)
      .run()
    const siblingAuth: AuthContext = { ...agentAuth(), tokenId: TOKEN_ID_2 }
    await invokeTool(siblingAuth, env, 'check_in', {}, 'https://pot.example')

    const status = await invokeTool(siblingAuth, env, 'elevation_status', { request_id: requestId }, 'https://pot.example')
    expect((status.result as { request: unknown }).request).toBeNull()
  })
})
