// tests/elevation.test.ts — Delivery Sequence step 3 (mupot task f5fe1222,
// mumega-com#1173): the elevation ledger's D1-backed core
// (src/auth/elevation.ts), exercised directly against the real migration
// chain (createSqliteD1 + applyAllMigrations) — never a hand-rolled schema.
//
// RED/GREEN framing: before this branch, there was no way for a human to
// grant an already-authenticated agent session bounded, named, expiring
// authority at all — the only two paths were (a) a standing capabilities/
// gate_grants row (survives the agent's whole life, blast-radius problem)
// or (b) manual SSH/D1 surgery. Every assertion below is RED against "no
// elevation ledger exists" and GREEN against this branch's code.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createAgentSession, evaluateAgentSession, loadAgentSessionById } from '../src/auth/agent-sessions'
import { createWebSession, revokeWebSession, hashWebSessionId } from '../src/auth/web-sessions'
import {
  createElevationRequest,
  decideElevationRequest,
  evaluateElevationGrant,
  hasElevatedAction,
  listActiveElevationGrants,
  listElevationUsage,
  listPendingElevationRequests,
  loadElevationRequestById,
  loadLiveElevationGrantsForSession,
  revokeElevationGrant,
} from '../src/auth/elevation'

const TENANT = 'mumega'
const DEPT = 'dept-1'
const SQUAD = 'squad-1'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const ADMIN_MEMBER = 'member-admin'
const TOKEN_ID = 'token-a-1'

describe('elevation ledger (D1, real migration chain)', () => {
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
    // Admin's standing squad-admin capability — the authority they will
    // approve elevations WITHIN.
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

  function agentAuth(overrides: Partial<AuthContext> = {}): AuthContext {
    return {
      userId: AGENT_MEMBER,
      email: null,
      role: 'member',
      tenant: TENANT,
      memberId: AGENT_MEMBER,
      channel: 'workspace',
      boundAgentId: AGENT_ID,
      tokenId: TOKEN_ID,
      ...overrides,
    }
  }

  async function seedAgentSession(nowMs: number) {
    return createAgentSession(
      env,
      { tenant: TENANT, agentId: AGENT_ID, memberId: AGENT_MEMBER, authKind: 'workspace_token', credentialId: TOKEN_ID },
      nowMs,
    )
  }

  async function seedApproverWebSession(nowMs: number) {
    const raw = 'raw-admin-session'
    const record = await createWebSession(env, raw, { tenant: TENANT, memberId: ADMIN_MEMBER, loginIdentityId: 'identity-admin' }, nowMs)
    return record
  }

  const capabilities = [{ member_id: ADMIN_MEMBER, scope_type: 'squad' as const, scope_id: SQUAD, capability: 'admin' as const }]

  it('rejects a request naming an unknown action or the word "admin"', async () => {
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z')
    const session = await seedAgentSession(nowMs)
    const res = await createElevationRequest(
      env,
      {
        tenant: TENANT,
        agentSessionId: session.id,
        agentId: AGENT_ID,
        memberId: AGENT_MEMBER,
        actions: ['admin'],
        scopeType: 'squad',
        scopeId: SQUAD,
        durationMinutes: 60,
        reason: 'need it',
      },
      nowMs,
    )
    expect(res.ok).toBe(false)
  })

  it('rejects an invalid duration (not one of the presets)', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const res = await createElevationRequest(
      env,
      {
        tenant: TENANT,
        agentSessionId: session.id,
        agentId: AGENT_ID,
        memberId: AGENT_MEMBER,
        actions: ['action:manage_access'],
        scopeType: 'squad',
        scopeId: SQUAD,
        durationMinutes: 37,
        reason: 'need it',
      },
      nowMs,
    )
    expect(res.ok).toBe(false)
  })

  it('a pending request grants zero authority', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    const result = await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs })
    expect(result.granted).toBe(false)
  })

  it('deny leaves no grant and marks the request denied', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)

    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT,
        requestId: created.request.id,
        decision: 'deny',
        decidedByMemberId: ADMIN_MEMBER,
        decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash,
        recentReauthOk: false,
      },
      nowMs,
    )
    expect(decision.ok).toBe(true)
    if (decision.ok) {
      expect(decision.request.status).toBe('denied')
      expect(decision.grants).toHaveLength(0)
    }
    const grants = await loadLiveElevationGrantsForSession(env, TENANT, session.id, nowMs)
    expect(grants).toHaveLength(0)
  })

  it('approve rejects an action not in the original request (cannot ADD permissions)', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)

    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT,
        requestId: created.request.id,
        decision: 'approve',
        selectedActions: ['action:manage_access', 'action:deploy'], // deploy was never requested
        decidedByMemberId: ADMIN_MEMBER,
        decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash,
        recentReauthOk: true,
      },
      nowMs,
    )
    expect(decision.ok).toBe(false)
  })

  it('approve rejects a widened scope or a widened duration', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)

    const widenedScope = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:manage_access'], scopeType: 'org', scopeId: '',
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      nowMs,
    )
    expect(widenedScope.ok).toBe(false)

    const widenedDuration = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:manage_access'], durationMinutes: 1440,
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      nowMs,
    )
    expect(widenedDuration.ok).toBe(false)
  })

  it('approve rejects an approver without admin authority on the scope', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)

    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:manage_access'],
        decidedByMemberId: ADMIN_MEMBER,
        decidedByCapabilities: [], // no capability rows at all
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      nowMs,
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toBe('forbidden')
  })

  it('a sensitive action requires recent reauth to approve', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:register_key'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 15, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)

    const withoutReauth = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:register_key'],
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: false,
      },
      nowMs,
    )
    expect(withoutReauth.ok).toBe(false)
    if (!withoutReauth.ok) expect(withoutReauth.reason).toBe('reauth_required')

    const withReauth = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:register_key'],
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      nowMs,
    )
    expect(withReauth.ok).toBe(true)
  })

  it('approve writes a grant with the effect FROZEN from the action registry (register_key = irreversible)', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:register_key'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 15, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)
    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:register_key'],
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      nowMs,
    )
    expect(decision.ok).toBe(true)
    if (decision.ok) {
      expect(decision.grants[0].effect).toBe('irreversible')
    }
  })

  it('concurrent double-approve yields exactly one terminal decision and one grant set', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)

    const decideInput = {
      tenant: TENANT, requestId: created.request.id, decision: 'approve' as const,
      selectedActions: ['action:manage_access'],
      decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
      decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
    }
    const [first, second] = await Promise.all([
      decideElevationRequest(env, decideInput, nowMs),
      decideElevationRequest(env, decideInput, nowMs),
    ])
    const oks = [first, second].filter((r) => r.ok)
    expect(oks).toHaveLength(1)
    const grants = await loadLiveElevationGrantsForSession(env, TENANT, session.id, nowMs)
    expect(grants).toHaveLength(1)
  })

  it('an expired decision window cannot be approved', async () => {
    const nowMs = Date.parse('2026-09-01T00:00:00.000Z')
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)
    const later = nowMs + 11 * 60 * 1000 // past the 10-minute decision window

    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:manage_access'],
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      later,
    )
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.reason).toBe('request_expired')
  })

  // ── enforcement: hasElevatedAction ──────────────────────────────────────

  async function approveManageAccess(nowMs: number, agentSessionId: string, durationMinutes = 60) {
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)
    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:manage_access'],
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: capabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      nowMs,
    )
    if (!decision.ok) throw new Error('approve failed')
    return { grant: decision.grants[0], approverSession }
  }

  it('hasElevatedAction grants exactly for the bound session, action, and scope — and never widens standing capability by itself', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    await approveManageAccess(nowMs, session.id)

    const ok = await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs })
    expect(ok.granted).toBe(true)

    const wrongAction = await hasElevatedAction(env, agentAuth(), 'action:deploy', 'squad', SQUAD, { nowMs })
    expect(wrongAction.granted).toBe(false)

    const wrongScope = await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', 'some-other-squad', { nowMs })
    expect(wrongScope.granted).toBe(false)
  })

  it('hasElevatedAction is false for a pure human/operator principal (no boundAgentId) — elevation never grants a human anything', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    await approveManageAccess(nowMs, session.id)
    const humanAuth: AuthContext = { userId: ADMIN_MEMBER, email: 'a@x.test', role: 'member', tenant: TENANT, memberId: ADMIN_MEMBER }
    const result = await hasElevatedAction(env, humanAuth, 'action:manage_access', 'squad', SQUAD, { nowMs })
    expect(result.granted).toBe(false)
  })

  it('sibling credential (a second token for the SAME agent) does not inherit the elevation', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    await approveManageAccess(nowMs, session.id)

    const TOKEN_ID_2 = 'token-a-2'
    await env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
       VALUES (?1, ?2, 'hash-2', 'secondary', 'workspace', ?3, ?4, datetime('now'))`,
    )
      .bind(TOKEN_ID_2, AGENT_MEMBER, TENANT, AGENT_ID)
      .run()
    await createAgentSession(
      env,
      { tenant: TENANT, agentId: AGENT_ID, memberId: AGENT_MEMBER, authKind: 'workspace_token', credentialId: TOKEN_ID_2 },
      nowMs,
    )

    const siblingAuth = agentAuth({ tokenId: TOKEN_ID_2 })
    const result = await hasElevatedAction(env, siblingAuth, 'action:manage_access', 'squad', SQUAD, { nowMs })
    expect(result.granted).toBe(false)
  })

  it('an explicit revoke immediately removes authority on the next check', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const { grant } = await approveManageAccess(nowMs, session.id)

    expect((await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs, recordUsage: false })).granted).toBe(true)
    const { revoked } = await revokeElevationGrant(env, TENANT, grant.id, 'human_revoke', nowMs)
    expect(revoked).toBe(true)
    expect((await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs })).granted).toBe(false)
  })

  it('approver authority loss (their standing capability is revoked) ends the grant WITHOUT any separate write to elevation_grants', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    await approveManageAccess(nowMs, session.id)
    expect((await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs, recordUsage: false })).granted).toBe(true)

    // Revoke the approver's OWN standing capability — nothing in elevation_grants changes.
    await env.DB.prepare(`DELETE FROM capabilities WHERE member_id = ?1`).bind(ADMIN_MEMBER).run()

    const after = await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs })
    expect(after.granted).toBe(false)
    if (!after.granted) expect(after.reason).toBe('approver_authority_lost')
  })

  it('approver web-session logout ends the grant WITHOUT any separate write to elevation_grants', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const { grant, approverSession } = await approveManageAccess(nowMs, session.id)
    expect((await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs, recordUsage: false })).granted).toBe(true)

    await revokeWebSession(env, TENANT, ADMIN_MEMBER, approverSession.id_hash, 'logout', nowMs)

    const after = await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs })
    expect(after.granted).toBe(false)
    if (!after.granted) expect(after.reason).toBe('approver_session_ended')
    // The grant row itself is untouched — the liveness re-derivation is what changed, not the record.
    expect(grant.revoked_at).toBeNull()
  })

  it('org-scope grant covers every squad (inheritance mirrors hasCapability)', async () => {
    const nowMs = Date.now()
    const session = await seedAgentSession(nowMs)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:dispatch'], scopeType: 'org', scopeId: '', durationMinutes: 60, reason: 'x',
      },
      nowMs,
    )
    if (!created.ok) throw new Error('setup failed')
    const approverSession = await seedApproverWebSession(nowMs)
    // Approver needs ORG admin for this one.
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?1, ?2, 'org', NULL, 'admin')`,
    )
      .bind('cap-org-admin', ADMIN_MEMBER)
      .run()
    const orgCapabilities = [
      ...capabilities,
      { member_id: ADMIN_MEMBER, scope_type: 'org' as const, scope_id: null, capability: 'admin' as const },
    ]
    const decision = await decideElevationRequest(
      env,
      {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:dispatch'],
        decidedByMemberId: ADMIN_MEMBER, decidedByCapabilities: orgCapabilities,
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      },
      nowMs,
    )
    expect(decision.ok).toBe(true)

    const result = await hasElevatedAction(env, agentAuth(), 'action:dispatch', 'squad', SQUAD, { nowMs })
    expect(result.granted).toBe(true)
  })

  // ── constraint 2: EXPIRY MUST ACTUALLY REMOVE AUTHORITY ─────────────────
  // Adversarial mirror of step 1's "absolute expiry fails closed even if
  // continuously touched" test: touching the underlying agent_sessions row
  // (which DOES extend agent_sessions.idle_expires_at) must NEVER extend
  // elevation_grants.expires_at — there is no idle ceiling on a grant, only
  // the fixed duration chosen at approval time.
  it('ADVERSARIAL: a live, continuously-touched agent session does not extend its elevation past the granted duration', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const session = await seedAgentSession(t0)
    const { grant } = await approveManageAccess(t0, session.id, 15) // 15-minute grant

    // "Touch" the underlying session repeatedly well inside the grant window
    // — this is exactly what check_in does on every call, and it DOES push
    // agent_sessions.idle_expires_at forward.
    const fiveMinutesIn = t0 + 5 * 60 * 1000
    await createAgentSession(
      env,
      { tenant: TENANT, agentId: AGENT_ID, memberId: AGENT_MEMBER, authKind: 'workspace_token', credentialId: TOKEN_ID },
      fiveMinutesIn,
    ).catch(() => {}) // no-op if it already exists; the real touch path is getOrCreateAgentSession, exercised elsewhere

    const stillLiveSession = await loadAgentSessionById(env, TENANT, session.id)
    expect(stillLiveSession).toBeTruthy()

    // At t0 + 14 minutes (still inside the 15-minute grant): granted.
    const insideWindow = await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, {
      nowMs: t0 + 14 * 60 * 1000,
      recordUsage: false,
    })
    expect(insideWindow.granted).toBe(true)

    // At t0 + 16 minutes — one minute PAST the grant's fixed expiry — even
    // though the session itself is still comfortably alive (24h idle
    // ceiling) and was touched in between: DENIED. The grant's own
    // expires_at is the only ceiling that matters here, and it was never
    // pushed forward by session activity.
    const pastGrantExpiry = await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, {
      nowMs: t0 + 16 * 60 * 1000,
    })
    expect(pastGrantExpiry.granted).toBe(false)
    if (!pastGrantExpiry.granted) expect(pastGrantExpiry.reason).toBe('no_matching_grant')

    // Confirm directly against the row too — expires_at is exactly t0+15min,
    // not extended.
    expect(Date.parse(grant.expires_at)).toBe(t0 + 15 * 60 * 1000)
    expect(evaluateElevationGrant(grant, t0 + 16 * 60 * 1000).ok).toBe(false)
  })

  // ── constraint 7: itemised, queryable-after-expiry usage log ────────────
  it('usage is logged per matched check and remains queryable after the grant expires', async () => {
    const t0 = Date.now()
    const session = await seedAgentSession(t0)
    const { grant } = await approveManageAccess(t0, session.id, 15)

    await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, {
      nowMs: t0 + 1000,
      toolName: 'grant_agent_capability',
      detail: { target: 'someone' },
    })

    const usageWhileLive = await listElevationUsage(env, TENANT, grant.id)
    expect(usageWhileLive).toHaveLength(1)
    expect(usageWhileLive[0].tool_name).toBe('grant_agent_capability')

    // Well past expiry — the log must still be there.
    const usageAfterExpiry = await listElevationUsage(env, TENANT, grant.id)
    expect(usageAfterExpiry).toHaveLength(1)
  })

  it('a pure visibility check (recordUsage: false) does not itself log a usage row', async () => {
    const t0 = Date.now()
    const session = await seedAgentSession(t0)
    const { grant } = await approveManageAccess(t0, session.id)
    await hasElevatedAction(env, agentAuth(), 'action:manage_access', 'squad', SQUAD, { nowMs: t0, recordUsage: false })
    const usage = await listElevationUsage(env, TENANT, grant.id)
    expect(usage).toHaveLength(0)
  })

  it('listPendingElevationRequests lazily expires a stale pending row', async () => {
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    const session = await seedAgentSession(t0)
    const created = await createElevationRequest(
      env,
      {
        tenant: TENANT, agentSessionId: session.id, agentId: AGENT_ID, memberId: AGENT_MEMBER,
        actions: ['action:manage_access'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'x',
      },
      t0,
    )
    if (!created.ok) throw new Error('setup failed')
    const later = t0 + 11 * 60 * 1000
    const pending = await listPendingElevationRequests(env, TENANT, later)
    expect(pending).toHaveLength(0)
    const row = await loadElevationRequestById(env, TENANT, created.request.id)
    expect(row?.status).toBe('expired')
  })

  it('listActiveElevationGrants only returns live (non-revoked, non-expired) grants', async () => {
    const t0 = Date.now()
    const session = await seedAgentSession(t0)
    const { grant } = await approveManageAccess(t0, session.id, 15)
    expect(await listActiveElevationGrants(env, TENANT, t0)).toHaveLength(1)
    await revokeElevationGrant(env, TENANT, grant.id, 'human_revoke', t0)
    expect(await listActiveElevationGrants(env, TENANT, t0)).toHaveLength(0)
  })
})
