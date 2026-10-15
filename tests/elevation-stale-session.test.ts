// tests/elevation-stale-session.test.ts — Delivery Sequence step 3 (mupot
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
import { elevationViewInner } from '../src/access/decision-core'
import { renderPage } from '../src/access/page'
import { TG_LOCK_ROWS } from '../src/secure-moments/telegram-miniapp-client'

const TENANT = 'mumega'
const DEPT = 'dept-1'
const SQUAD = 'squad-1'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const ADMIN_MEMBER = 'member-admin'
const TOKEN_ID = 'token-a-1'

describe('elevation binds to a LIVE agent session, never an idle-expired row that is merely unrevoked', () => {
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

  async function expireSession(id: string): Promise<void> {
    // Idle ceiling passed (nobody called check_in for >24h) but revoked_at is still NULL: exactly the prod row 69da3f6d.
    await env.DB.prepare(`UPDATE agent_sessions SET idle_expires_at = ?1 WHERE id = ?2`).bind(new Date(Date.now() - 60_000).toISOString(), id).run()
  }

  const ASK = { actions: ['action:manage_access'], scope_type: 'squad', scope_id: SQUAD, duration_minutes: 60, reason: 'need it' }

  async function approve(requestId: string) {
    const approverSession = await createWebSession(env, 'raw-admin', { tenant: TENANT, memberId: ADMIN_MEMBER, loginIdentityId: 'identity-admin' })
    return decideElevationRequest(env, {
      tenant: TENANT, requestId, decision: 'approve', selectedActions: ['action:manage_access'],
      decidedByMemberId: ADMIN_MEMBER,
      decidedByCapabilities: [{ member_id: ADMIN_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'admin' }],
      decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
    })
  }

  it('request_elevation on a credential whose tracked session idle-expired binds to a fresh live session and the human can approve it', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const staleId = (checkin.result as { agent_session: { id: string } }).agent_session.id
    await expireSession(staleId)

    const res = await invokeTool(agentAuth(), env, 'request_elevation', ASK, 'https://pot.example')
    expect(res.ok).toBe(true)
    const requestId = (res.result as { request: { id: string } }).request.id
    const row = await loadElevationRequestById(env, TENANT, requestId)
    expect(row?.agent_session_id).not.toBe(staleId)

    const decision = await approve(requestId)
    expect(decision).toMatchObject({ ok: true })
  })

  it('elevation_status after an idle expiry reports the live session and sees the request it just filed', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const staleId = (checkin.result as { agent_session: { id: string } }).agent_session.id
    await expireSession(staleId)

    const req = await invokeTool(agentAuth(), env, 'request_elevation', ASK, 'https://pot.example')
    const requestId = (req.result as { request: { id: string } }).request.id
    const status = await invokeTool(agentAuth(), env, 'elevation_status', { request_id: requestId }, 'https://pot.example')
    expect(status.ok).toBe(true)
    const r = status.result as { session_id: string; request: { id: string; status: string } | null }
    expect(r.session_id).not.toBe(staleId)
    expect(r.request).toMatchObject({ id: requestId, status: 'pending' })
  })

  it('the rotation retires the dead row (no unrevoked-but-expired row is left to be mistaken for live)', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const staleId = (checkin.result as { agent_session: { id: string } }).agent_session.id
    await expireSession(staleId)
    await invokeTool(agentAuth(), env, 'request_elevation', ASK, 'https://pot.example')
    const dead = await env.DB.prepare(`SELECT revoked_at, revoke_reason FROM agent_sessions WHERE id = ?1`).bind(staleId).first<{ revoked_at: string | null; revoke_reason: string | null }>()
    expect(dead?.revoked_at).not.toBeNull()
    expect(dead?.revoke_reason).toBe('auto_expired_idle')
  })

  it('a grant never moves: a request filed on the old session and decided after rotation is refused, not re-pointed', async () => {
    const checkin = await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const oldId = (checkin.result as { agent_session: { id: string } }).agent_session.id
    const req = await invokeTool(agentAuth(), env, 'request_elevation', ASK, 'https://pot.example')
    const requestId = (req.result as { request: { id: string } }).request.id
    await expireSession(oldId)
    await invokeTool(agentAuth(), env, 'elevation_status', {}, 'https://pot.example') // rotates
    const decision = await approve(requestId)
    expect(decision).toMatchObject({ ok: false, reason: 'agent_session_ended' })
  })

  it('a credential that never checked in is still refused (no implicit session creation)', async () => {
    const res = await invokeTool(agentAuth(), env, 'request_elevation', ASK, 'https://pot.example')
    expect(res.ok).toBe(false)
  })

  it('a revoked session is NOT resurrected by request_elevation (explicit end_agent_session stays ended)', async () => {
    await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    await invokeTool(agentAuth(), env, 'end_agent_session', {}, 'https://pot.example')
    const res = await invokeTool(agentAuth(), env, 'request_elevation', ASK, 'https://pot.example')
    expect(res.ok).toBe(false)
  })

  // Symptom 2 (mobile gray boxes). The plain secure page (secure.<host>/m/<id>/<token>, any mobile browser) is the same
  // server HTML the Telegram Mini App injects; ONLY the Mini App script disables rows (TG_LOCK_ROWS, policy
  // passkeyOnly). So gray + unselectable on a phone = the Telegram WebView path, never the plain page.
  it('the plain approval page renders every action box enabled and ticked; only the Telegram script can disable one', async () => {
    await invokeTool(agentAuth(), env, 'check_in', {}, 'https://pot.example')
    const res = await invokeTool(agentAuth(), env, 'request_elevation', { ...ASK, actions: ['action:manage_access', 'action:project_status'] }, 'https://pot.example')
    const requestId = (res.result as { request: { id: string } }).request.id
    const row = await loadElevationRequestById(env, TENANT, requestId)
    if (!row) throw new Error('request row missing')
    const inner = await elevationViewInner(env, row)
    const inputs = inner.match(/<input[^>]*name="actions"[^>]*>/g) ?? []
    expect(inputs).toHaveLength(2)
    for (const i of inputs) {
      expect(i).toContain(' checked')
      expect(i).not.toContain('disabled')
    }
    const page = renderPage('t', inner)
    // gray styling exists only behind :disabled; nothing in the plain page script touches the inputs
    expect(page).toContain('label.choice:has(>input:disabled)')
    expect(TG_LOCK_ROWS).toContain('disabled=true')
  })
})
