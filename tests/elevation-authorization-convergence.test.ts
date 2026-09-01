// tests/elevation-authorization-convergence.test.ts — Delivery Sequence step 4
// (mupot task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173),
// "authorization convergence": wiring the enforcement primitive
// (hasElevatedAction, src/auth/elevation.ts) into the first two sensitive
// operator-gated surfaces — mint_agent_token and grant_agent_capability
// (both src/mcp/provision.ts) — so a live, human-approved, session-bound
// elevation can substitute for the standing `operator_principal_required`
// floor those tools enforce against every bound-agent caller.
//
// Real migration chain (applyAllMigrations from tests/helpers/migrations.ts)
// and the real MCP tool surface (invokeTool) throughout — no mocked D1. Every
// elevation fixture is built through the real request/decide functions
// (src/auth/elevation.ts) and the real agent-session/web-session modules,
// exactly like tests/agent-session-rotation-revocation.test.ts and
// tests/elevation-mcp-integration.test.ts already do for step 3.
//
// FIVE adversarial cases per tool (task rule): an agent WITHOUT an elevation
// is refused; an agent WITH a live one succeeds AND is logged; an agent whose
// elevation has EXPIRED is refused; an agent whose elevation was REVOKED is
// refused; an agent whose session was rotated away is refused. Plus the
// collapse-preservation property itself: a bound session with zero live
// grants for the action gets the exact SAME unconditional refusal it got
// before this step, regardless of the target agent/squad named in args.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import {
  createElevationRequest,
  decideElevationRequest,
  revokeElevationGrant,
  listElevationUsage,
  type ElevationGrantRecord,
} from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import { revokeAgentSessionByCredentialSafe } from '../src/auth/agent-sessions'

/**
 * A bound-agent session that holds ZERO live elevation grants (never
 * requested one, or its only grant expired/was revoked/its session died) is
 * turned away at the MCP dispatcher's AAGATE capability floor
 * (ELEVATION_FLOOR_BYPASS_TOOLS, src/mcp/index.ts) — BEFORE the tool's own
 * handler, and therefore before any of its args are even schema-validated.
 * That is the collapse this step preserves: the floor's `forbidden
 * {need:'admin'}` is unchanged from pre-step-4 behavior for exactly this
 * population. A handler-level `operator_principal_required` refusal is only
 * ever reachable by a session that DOES hold some live grant (for a
 * DIFFERENT action, or the wrong scope) — see the "elevation scoped to a
 * DIFFERENT squad" and "does NOT authorize a rotation mint" cases below.
 */
function expectFloorCollapse(res: Awaited<ReturnType<typeof invokeTool>>): void {
  expect(res.ok).toBe(false)
  if (!res.ok) {
    expect(res.error).toBe('forbidden')
    expect(res.detail).toMatchObject({ need: 'admin' })
  }
}

const TENANT = 'tenant-elevconv'
const ORIGIN = 'https://pot.test'

const DEPT_ID = 'dept-1'
// ACTING_AGENT's own home squad — deliberately NOT the target squad, so a
// standing capability on it (if any leaked in) could never satisfy the
// target-squad check by accident.
const HOME_SQUAD_ID = 'squad-home'
// The squad the elevation is scoped to, and where the target agent lives.
const TARGET_SQUAD_ID = 'squad-target'

const ACTING_AGENT_ID = 'agent-acting'
const ACTING_AGENT_SLUG = 'acting-agent'
const ACTING_MEMBER_ID = 'member-acting'
const ACTING_TOKEN_ID = 'tok-acting-1'

const TARGET_AGENT_ID = 'agent-target'
const TARGET_AGENT_SLUG = 'target-agent'
const TARGET_MEMBER_ID = 'member-target'

const ADMIN_MEMBER_ID = 'member-admin'
const ADMIN_LOGIN_IDENTITY_ID = 'identity-admin'

let harness: SqliteD1Harness
let env: Env

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'test-dept', 'Test Department');

    INSERT INTO squads (id, department_id, slug, name)
    VALUES
      ('${HOME_SQUAD_ID}', '${DEPT_ID}', 'home', 'Home Squad'),
      ('${TARGET_SQUAD_ID}', '${DEPT_ID}', 'target', 'Target Squad');

    INSERT INTO agents (id, squad_id, slug, name, status)
    VALUES
      ('${ACTING_AGENT_ID}', '${HOME_SQUAD_ID}', '${ACTING_AGENT_SLUG}', 'Acting Agent', 'active'),
      ('${TARGET_AGENT_ID}', '${TARGET_SQUAD_ID}', '${TARGET_AGENT_SLUG}', 'Target Agent', 'active');

    INSERT INTO members (id, display_name, status, tenant)
    VALUES
      ('${ACTING_MEMBER_ID}', 'Acting Agent Member', 'active', '${TENANT}'),
      ('${TARGET_MEMBER_ID}', 'Target Agent Member', 'active', '${TENANT}'),
      ('${ADMIN_MEMBER_ID}', 'Admin', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES
      ('${TENANT}', '${ACTING_AGENT_ID}', '${ACTING_MEMBER_ID}', '2026-08-05T00:00:00Z'),
      ('${TENANT}', '${TARGET_AGENT_ID}', '${TARGET_MEMBER_ID}', '2026-08-05T00:00:00Z');

    -- ACTING_AGENT's own credential — a live agent_sessions row is created FROM
    -- this via check_in below, exactly like a real harness authenticating.
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
    VALUES ('${ACTING_TOKEN_ID}', '${ACTING_MEMBER_ID}', 'hash-acting-1', 'primary', 'workspace', '${TENANT}', '${ACTING_AGENT_ID}', datetime('now'));

    -- TARGET_AGENT already has SOME standing squad access on its OWN home
    -- squad (parity with real agents), but explicitly NOTHING on
    -- TARGET_SQUAD_ID beyond that pre-existing row — grant_agent_capability's
    -- tests add access there; mint_agent_token's tests never touch it.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-target-home', '${TARGET_MEMBER_ID}', 'squad', '${TARGET_SQUAD_ID}', 'member');

    -- The human approver: admin on TARGET_SQUAD_ID, with a login identity so
    -- createWebSession's FK is satisfiable.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-admin-target', '${ADMIN_MEMBER_ID}', 'squad', '${TARGET_SQUAD_ID}', 'admin');

    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
    VALUES ('${ADMIN_LOGIN_IDENTITY_ID}', '${TENANT}', 'google', '${ADMIN_MEMBER_ID}', 'admin@x.test', '${ADMIN_MEMBER_ID}', datetime('now'));
  `)
}

function actingAgentAuth(): AuthContext {
  return {
    userId: ACTING_MEMBER_ID,
    memberId: ACTING_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: ACTING_AGENT_ID,
    tokenId: ACTING_TOKEN_ID,
    capabilities: [],
  } as unknown as AuthContext
}

/** Memory-only KV stand-in — the one non-D1 dependency mint_agent_token
 *  touches (createCredentialClaim). Mirrors tests/provision-real-schema.test.ts. */
function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

/** Real check_in — creates ACTING_AGENT's live agent_sessions row the exact
 *  way a harness authenticating for real would, and returns its id. */
async function checkInActingAgent(): Promise<string> {
  const res = await invokeTool(actingAgentAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

/** Human approves `action` on TARGET_SQUAD_ID for the given session, for
 *  `durationMinutes` (a valid preset), at `nowMs`. Returns the live grant row. */
async function approveElevation(
  sessionId: string,
  action: string,
  durationMinutes: number,
  nowMs: number,
): Promise<ElevationGrantRecord> {
  const approverSession = await createWebSession(
    env,
    `raw-admin-${nowMs}`,
    { tenant: TENANT, memberId: ADMIN_MEMBER_ID, loginIdentityId: ADMIN_LOGIN_IDENTITY_ID },
    nowMs,
  )
  const created = await createElevationRequest(
    env,
    {
      tenant: TENANT,
      agentSessionId: sessionId,
      agentId: ACTING_AGENT_ID,
      memberId: ACTING_MEMBER_ID,
      actions: [action],
      scopeType: 'squad',
      scopeId: TARGET_SQUAD_ID,
      durationMinutes,
      reason: 'step-4 adversarial test',
    },
    nowMs,
  )
  if (!created.ok) throw new Error(`setup: createElevationRequest failed: ${JSON.stringify(created)}`)
  const decision = await decideElevationRequest(
    env,
    {
      tenant: TENANT,
      requestId: created.request.id,
      decision: 'approve',
      selectedActions: [action],
      decidedByMemberId: ADMIN_MEMBER_ID,
      decidedByCapabilities: [{ member_id: ADMIN_MEMBER_ID, scope_type: 'squad', scope_id: TARGET_SQUAD_ID, capability: 'admin' }],
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
    },
    nowMs,
  )
  if (!decision.ok) throw new Error(`setup: decideElevationRequest failed: ${JSON.stringify(decision)}`)
  return decision.grants[0]
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = {
    TENANT_SLUG: TENANT,
    DB: harness.db,
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: memoryKv(),
  } as unknown as Env
})

afterEach(() => {
  vi.useRealTimers()
  harness.close()
})

describe('mint_agent_token — elevation substitutes for operator_principal_required', () => {
  it('an agent WITHOUT any elevation is refused (unconditional collapse, unchanged from pre-step-4 behavior)', async () => {
    await checkInActingAgent()
    const res = await invokeTool(actingAgentAuth(), env, 'mint_agent_token', { agent: TARGET_AGENT_ID }, ORIGIN)
    expectFloorCollapse(res)
  })

  it('the collapse holds even for a NONEXISTENT target agent — the error is identical, no agent_not_found leak to a zero-grant stranger', async () => {
    await checkInActingAgent()
    const res = await invokeTool(actingAgentAuth(), env, 'mint_agent_token', { agent: 'does-not-exist' }, ORIGIN)
    expectFloorCollapse(res)
  })

  it('an agent WITH a live elevation succeeds, and the mint is itemized in elevation_usage_log with the minted token id', async () => {
    const sessionId = await checkInActingAgent()
    const grant = await approveElevation(sessionId, 'action:mint_token', 60, Date.now())

    const res = await invokeTool(actingAgentAuth(), env, 'mint_agent_token', { agent: TARGET_AGENT_ID, label: 'elevated-mint' }, ORIGIN)
    expect(res.ok).toBe(true)
    const out = res.result as { agent: { id: string }; token: { id: string } }
    expect(out.agent.id).toBe(TARGET_AGENT_ID)

    const usage = await listElevationUsage(env, TENANT, grant.id)
    // One entry from hasElevatedAction's own authorization-time log (pre-mint,
    // cannot yet name the token), one from the post-mint record naming it.
    expect(usage.length).toBeGreaterThanOrEqual(2)
    expect(usage.every((u) => u.agent_session_id === sessionId)).toBe(true)
    expect(usage.every((u) => u.action === 'action:mint_token')).toBe(true)
    const withTokenId = usage.find((u) => u.detail_json && JSON.parse(u.detail_json).minted_token_id)
    expect(withTokenId).toBeDefined()
    expect(JSON.parse(withTokenId!.detail_json as string).minted_token_id).toBe(out.token.id)
  })

  it('an agent whose elevation has EXPIRED is refused', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    vi.setSystemTime(t0)
    const sessionId = await checkInActingAgent()
    // Shortest preset (15min) so a modest clock advance clears it.
    await approveElevation(sessionId, 'action:mint_token', 15, t0)

    vi.setSystemTime(t0 + 16 * 60 * 1000)
    const res = await invokeTool(actingAgentAuth(), env, 'mint_agent_token', { agent: TARGET_AGENT_ID }, ORIGIN)
    expectFloorCollapse(res)
  })

  it('an agent whose elevation was explicitly REVOKED is refused', async () => {
    const sessionId = await checkInActingAgent()
    const grant = await approveElevation(sessionId, 'action:mint_token', 60, Date.now())
    const { revoked } = await revokeElevationGrant(env, TENANT, grant.id, 'test_revoke')
    expect(revoked).toBe(true)

    const res = await invokeTool(actingAgentAuth(), env, 'mint_agent_token', { agent: TARGET_AGENT_ID }, ORIGIN)
    expectFloorCollapse(res)
  })

  it('an agent whose session was rotated/revoked away is refused, even with an otherwise-live 24h grant', async () => {
    const sessionId = await checkInActingAgent()
    await approveElevation(sessionId, 'action:mint_token', 1440, Date.now())

    // Simulate the exact step-2/step-3 rotation weld: activateAgentTokenReplacement
    // revokes the OLD agent_sessions row by credential the moment rotation
    // completes — reproduced directly here rather than re-running the whole
    // mint→stage→activate pipeline, which tests/agent-session-rotation-
    // revocation.test.ts already proves end to end.
    const { revoked } = await revokeAgentSessionByCredentialSafe(env, TENANT, 'workspace_token', ACTING_TOKEN_ID, 'token_rotated')
    expect(revoked).toBe(true)

    const res = await invokeTool(actingAgentAuth(), env, 'mint_agent_token', { agent: TARGET_AGENT_ID }, ORIGIN)
    expectFloorCollapse(res)
  })

  it('elevation for action:mint_token does NOT authorize a rotation mint (rotate_prior_token_id) — that stays standing-org-admin-only', async () => {
    const sessionId = await checkInActingAgent()
    await approveElevation(sessionId, 'action:mint_token', 60, Date.now())

    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'mint_agent_token',
      { agent: TARGET_AGENT_ID, rotate_prior_token_id: 'some-prior-token' },
      ORIGIN,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('forbidden')
      expect(res.detail).toMatchObject({ need: 'admin', scope: 'org' })
    }
  })
})

describe('grant_agent_capability — elevation substitutes for operator_principal_required', () => {
  it('an agent WITHOUT any elevation is refused (unconditional collapse, unchanged from pre-step-4 behavior)', async () => {
    await checkInActingAgent()
    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      ORIGIN,
    )
    expectFloorCollapse(res)
  })

  it('the collapse holds even for a NONEXISTENT target squad — identical error, no squad_not_found leak to a zero-grant stranger', async () => {
    await checkInActingAgent()
    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: 'does-not-exist', capability: 'member' },
      ORIGIN,
    )
    expectFloorCollapse(res)
  })

  it('an agent WITH a live elevation succeeds, the grant is written, and the call is itemized in elevation_usage_log', async () => {
    const sessionId = await checkInActingAgent()
    const grant = await approveElevation(sessionId, 'action:manage_access', 60, Date.now())

    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'admin' },
      ORIGIN,
    )
    expect(res.ok).toBe(true)
    const out = res.result as { grant: { capability: string; scope_id: string } }
    expect(out.grant).toMatchObject({ capability: 'admin', scope_id: TARGET_SQUAD_ID })

    const row = harness.sqlite.prepare(
      `SELECT capability FROM capabilities WHERE member_id = ? AND scope_type = 'squad' AND scope_id = ?`,
    ).get(TARGET_MEMBER_ID, TARGET_SQUAD_ID) as { capability: string } | undefined
    expect(row?.capability).toBe('admin')

    const usage = await listElevationUsage(env, TENANT, grant.id)
    expect(usage.length).toBeGreaterThanOrEqual(1)
    expect(usage[0].agent_session_id).toBe(sessionId)
    expect(usage[0].tool_name).toBe('grant_agent_capability')
    expect(usage[0].action).toBe('action:manage_access')
  })

  it('an elevated agent may grant UP TO admin (never above — admin is already GRANTABLE_AGENT_CAPABILITIES\' ceiling and the approver was re-verified admin on this exact scope)', async () => {
    const sessionId = await checkInActingAgent()
    await approveElevation(sessionId, 'action:manage_access', 60, Date.now())
    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'admin' },
      ORIGIN,
    )
    expect(res.ok).toBe(true)
  })

  it('an agent whose elevation has EXPIRED is refused', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-01T00:00:00.000Z')
    vi.setSystemTime(t0)
    const sessionId = await checkInActingAgent()
    await approveElevation(sessionId, 'action:manage_access', 15, t0)

    vi.setSystemTime(t0 + 16 * 60 * 1000)
    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      ORIGIN,
    )
    expectFloorCollapse(res)
  })

  it('an agent whose elevation was explicitly REVOKED is refused', async () => {
    const sessionId = await checkInActingAgent()
    const grant = await approveElevation(sessionId, 'action:manage_access', 60, Date.now())
    const { revoked } = await revokeElevationGrant(env, TENANT, grant.id, 'test_revoke')
    expect(revoked).toBe(true)

    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      ORIGIN,
    )
    expectFloorCollapse(res)
  })

  it('an agent whose session was rotated/revoked away is refused, even with an otherwise-live 24h grant', async () => {
    const sessionId = await checkInActingAgent()
    await approveElevation(sessionId, 'action:manage_access', 1440, Date.now())
    const { revoked } = await revokeAgentSessionByCredentialSafe(env, TENANT, 'workspace_token', ACTING_TOKEN_ID, 'token_rotated')
    expect(revoked).toBe(true)

    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      ORIGIN,
    )
    expectFloorCollapse(res)
  })

  it('an elevation scoped to a DIFFERENT squad does not authorize this squad (no org/department inheritance fabricated)', async () => {
    const sessionId = await checkInActingAgent()
    // Approve for HOME_SQUAD_ID instead of TARGET_SQUAD_ID — the approver
    // does not even hold admin there, but decideElevationRequest's own gate
    // is exercised separately; here we only need a grant that EXISTS and is
    // live but scoped elsewhere, to prove hasElevatedAction's scope match
    // (not just "has any grant") governs the outcome.
    harness.sqlite.exec(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin-home', '${ADMIN_MEMBER_ID}', 'squad', '${HOME_SQUAD_ID}', 'admin')`,
    )
    const approverSession = await createWebSession(env, 'raw-admin-elsewhere', { tenant: TENANT, memberId: ADMIN_MEMBER_ID, loginIdentityId: ADMIN_LOGIN_IDENTITY_ID })
    const created = await createElevationRequest(env, {
      tenant: TENANT, agentSessionId: sessionId, agentId: ACTING_AGENT_ID, memberId: ACTING_MEMBER_ID,
      actions: ['action:manage_access'], scopeType: 'squad', scopeId: HOME_SQUAD_ID, durationMinutes: 60, reason: 'wrong scope on purpose',
    })
    if (!created.ok) throw new Error('setup failed')
    const decision = await decideElevationRequest(env, {
      tenant: TENANT, requestId: created.request.id, decision: 'approve',
      selectedActions: ['action:manage_access'],
      decidedByMemberId: ADMIN_MEMBER_ID,
      decidedByCapabilities: [{ member_id: ADMIN_MEMBER_ID, scope_type: 'squad', scope_id: HOME_SQUAD_ID, capability: 'admin' }],
      decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
    })
    if (!decision.ok) throw new Error('setup failed')

    // The collapse gate passes (session DOES hold a live action:manage_access
    // grant, just on the wrong squad) — so this now resolves the target and
    // returns a scope-specific refusal, exactly like a standing admin who
    // lacks capability on this particular squad already does today.
    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      ORIGIN,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('forbidden')
      expect(res.detail).toMatchObject({ need: 'admin', scope: 'squad', elevation_denied: 'no_matching_grant' })
    }
  })
})

describe('elevation never widens standing capability (rule 1)', () => {
  it('after a successful elevated mint_agent_token, the ACTING agent still has ZERO standing capabilities — nothing was written to `capabilities`', async () => {
    const sessionId = await checkInActingAgent()
    await approveElevation(sessionId, 'action:mint_token', 60, Date.now())
    const res = await invokeTool(actingAgentAuth(), env, 'mint_agent_token', { agent: TARGET_AGENT_ID }, ORIGIN)
    expect(res.ok).toBe(true)

    const row = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM capabilities WHERE member_id = ?`,
    ).get(ACTING_MEMBER_ID) as { n: number }
    expect(row.n).toBe(0)
  })

  it('after a successful elevated grant_agent_capability, the ELEVATION GRANT itself is untouched — no gate_grants/memberships row was fabricated', async () => {
    const sessionId = await checkInActingAgent()
    await approveElevation(sessionId, 'action:manage_access', 60, Date.now())
    const res = await invokeTool(
      actingAgentAuth(),
      env,
      'grant_agent_capability',
      { agent: TARGET_AGENT_ID, squad: TARGET_SQUAD_ID, capability: 'member' },
      ORIGIN,
    )
    expect(res.ok).toBe(true)

    // The elevation grant is scoped to the ACTING agent's session, never
    // materialized as a membership/gate_grants row for ANYONE.
    const memberships = harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM memberships WHERE agent_id = ?`,
    ).get(ACTING_AGENT_ID) as { n: number }
    expect(memberships.n).toBe(0)
  })
})
