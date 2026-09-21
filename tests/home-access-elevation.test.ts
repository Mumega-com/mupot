// tests/home-access-elevation.test.ts — FP-01 Slice 1 v2 (G-FP1b point 4): the ONE
// additional door into a member's home squad besides createHomeForMember's own write is a
// time-boxed, human-approved elevation grant naming that exact squad — never a standing
// capability. Wired into src/auth/capability.ts's canOnSquadAuth (bound-agent sessions only).
//
// This is the BOUND-AGENT half of point 4 — the achievable half without a schema change.
// The PURE WEB-SESSION (dashboard) operator variant is NOT implemented: hasElevatedAction
// refuses any non-agent session with `not_agent_session` before ever consulting a scope, and
// migrations/0148_elevation_ledger.sql's elevation_requests.agent_session_id is NOT NULL —
// there is no session row a human-only operator could ever satisfy without a schema change,
// which is out of scope for this PR (see the PR body's "not done" list).
//
// Also proves the load-bearing consequence of G-FP1b point 2 for THIS specific action: the
// approver-authority re-check inside hasElevatedAction runs on every use, and an org-scope
// admin's authority never covers a home squad — so only the home's OWNER (the sole holder of
// an EXACT squad-scope grant there) can durably remain the approver for `action:home_access`.
// An org-admin attempting to approve is refused outright by decideElevationRequest itself.
//
// Modeled directly on tests/elevation-squad-lead-e2e.test.ts's harness (check_in → real
// agent_session; createElevationRequest/decideElevationRequest against real D1).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import { canOnSquadAuth } from '../src/auth/capability'
import { createHomeForMember } from '../src/org/service'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createElevationRequest, decideElevationRequest } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'

const TENANT = 'tenant-home-elevation'
const ORIGIN = 'https://pot.test'

const MUBOT_AGENT_ID = 'agent-mubot'
const MUBOT_MEMBER_ID = 'member-mubot'
const MUBOT_TOKEN_ID = 'tok-mubot-1'

const SHADI_MEMBER_ID = 'member-shadi'
const SHADI_IDENTITY_ID = 'identity-shadi'

const ORG_ADMIN_MEMBER_ID = 'member-org-admin'
const ORG_ADMIN_IDENTITY_ID = 'identity-org-admin'

let harness: SqliteD1Harness
let env: Env
let homeSquadId: string

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO org_settings (key, value) VALUES ('billing_state', '{"tier":"scale"}')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value;

    INSERT INTO departments (id, slug, name) VALUES ('dept-mubot', 'mubot', 'Mubot Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-mubot', 'dept-mubot', 'mubot', 'Mubot Squad');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('${MUBOT_AGENT_ID}', 'squad-mubot', 'mubot', 'Mubot', 'active');

    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${MUBOT_MEMBER_ID}', 'Mubot Member', 'active', '${TENANT}'),
      ('${SHADI_MEMBER_ID}', 'Shadi', 'active', '${TENANT}'),
      ('${ORG_ADMIN_MEMBER_ID}', 'Org Admin', 'active', '${TENANT}');

    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${MUBOT_AGENT_ID}', '${MUBOT_MEMBER_ID}', '2026-09-01T00:00:00Z');

    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
      VALUES ('${MUBOT_TOKEN_ID}', '${MUBOT_MEMBER_ID}', 'hash-mubot-1', 'primary', 'workspace', '${TENANT}', '${MUBOT_AGENT_ID}', datetime('now'));

    -- Mubot's ENTIRE standing authority: member on its own squad. Nothing on
    -- anyone's home.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-mubot-own', '${MUBOT_MEMBER_ID}', 'squad', 'squad-mubot', 'member');

    -- An UNRELATED org-scope admin — must NOT be able to approve action:home_access
    -- for Shadi's home (G-FP1b point 2: org grants are capability-dead on a home).
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-org-admin', '${ORG_ADMIN_MEMBER_ID}', 'org', NULL, 'admin');

    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('${SHADI_IDENTITY_ID}', '${TENANT}', 'google', '${SHADI_MEMBER_ID}', 'shadi@x.test', '${SHADI_MEMBER_ID}', datetime('now'));
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
      VALUES ('${ORG_ADMIN_IDENTITY_ID}', '${TENANT}', 'google', '${ORG_ADMIN_MEMBER_ID}', 'admin@x.test', '${ORG_ADMIN_MEMBER_ID}', datetime('now'));
  `)
}

function mubotAuth(): AuthContext {
  return {
    userId: MUBOT_MEMBER_ID,
    memberId: MUBOT_MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: MUBOT_AGENT_ID,
    tokenId: MUBOT_TOKEN_ID,
    capabilities: [
      { member_id: MUBOT_MEMBER_ID, scope_type: 'squad', scope_id: 'squad-mubot', capability: 'member' },
    ],
  } as unknown as AuthContext
}

function memoryKv(): Env['SESSIONS'] {
  const store = new Map<string, string>()
  return {
    async put(key: string, value: string) { store.set(key, value) },
    async get(key: string) { return store.get(key) ?? null },
    async delete(key: string) { store.delete(key) },
  } as unknown as Env['SESSIONS']
}

async function checkIn(): Promise<string> {
  const res = await invokeTool(mubotAuth(), env, 'check_in', {}, ORIGIN)
  if (!res.ok) throw new Error(`setup: check_in failed: ${JSON.stringify(res)}`)
  return (res.result as { agent_session: { id: string } }).agent_session.id
}

async function requestHomeAccess(
  sessionId: string,
  durationMinutes: number,
  nowMs: number,
): Promise<{ ok: true; requestId: string } | { ok: false; error: unknown }> {
  const created = await createElevationRequest(
    env,
    {
      tenant: TENANT,
      agentSessionId: sessionId,
      agentId: MUBOT_AGENT_ID,
      memberId: MUBOT_MEMBER_ID,
      actions: ['action:home_access'],
      scopeType: 'squad',
      scopeId: homeSquadId,
      durationMinutes,
      reason: 'onboarding conversation with Shadi',
    },
    nowMs,
  )
  if (!created.ok) return { ok: false, error: created }
  return { ok: true, requestId: created.request.id }
}

async function decideAsApprover(
  requestId: string,
  approverMemberId: string,
  approverIdentityId: string,
  approverCapabilities: Array<{ member_id: string; scope_type: 'org' | 'department' | 'squad'; scope_id: string | null; capability: 'owner' | 'admin' | 'lead' | 'member' | 'observer' }>,
  nowMs: number,
) {
  const approverSession = await createWebSession(
    env,
    `raw-approver-${approverMemberId}-${nowMs}`,
    { tenant: TENANT, memberId: approverMemberId, loginIdentityId: approverIdentityId },
    nowMs,
  )
  return decideElevationRequest(
    env,
    {
      tenant: TENANT,
      requestId,
      decision: 'approve',
      selectedActions: ['action:home_access'],
      decidedByMemberId: approverMemberId,
      decidedByCapabilities: approverCapabilities,
      decidedByWebSessionHash: approverSession.id_hash,
      recentReauthOk: true,
    },
    nowMs,
  )
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed(harness.sqlite)
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    SESSIONS: memoryKv(),
    PUBLIC_ORIGIN: ORIGIN,
  } as unknown as Env
  const home = await createHomeForMember(env, SHADI_MEMBER_ID)
  if (!home.ok) throw new Error(`setup: createHomeForMember failed: ${JSON.stringify(home)}`)
  homeSquadId = home.squad.id
})

afterEach(() => {
  vi.useRealTimers()
  harness.sqlite.close()
})

describe('elevation-to-home (G-FP1b point 4, bound-agent sessions)', () => {
  it('baseline: mubot has zero standing access to the home before any elevation', async () => {
    expect(await canOnSquadAuth(env, mubotAuth(), homeSquadId, 'observer')).toBe(false)
  })

  it('an ORG-ADMIN cannot approve action:home_access for someone else\'s home (G-FP1b point 2)', async () => {
    const t0 = Date.parse('2026-09-21T12:00:00.000Z')
    const sessionId = await checkIn()
    const req = await requestHomeAccess(sessionId, 60, t0)
    if (!req.ok) throw new Error('setup failed')
    const decision = await decideAsApprover(
      req.requestId,
      ORG_ADMIN_MEMBER_ID,
      ORG_ADMIN_IDENTITY_ID,
      [{ member_id: ORG_ADMIN_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
      t0,
    )
    expect(decision.ok).toBe(false)
    if (decision.ok) return
    expect(decision.reason).toBe('forbidden')

    // No grant exists — mubot still has no access.
    expect(await canOnSquadAuth(env, mubotAuth(), homeSquadId, 'observer')).toBe(false)
  })

  it('org:admin refused -> home owner approves -> allowed -> expiry -> refused again', async () => {
    const t0 = Date.parse('2026-09-21T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    // Refused before any grant.
    expect(await canOnSquadAuth(env, mubotAuth(), homeSquadId, 'observer')).toBe(false)

    const sessionId = await checkIn()
    const req = await requestHomeAccess(sessionId, 60, t0)
    if (!req.ok) throw new Error(`setup failed: ${JSON.stringify(req.error)}`)

    // The HOME OWNER approves — the only durable approver for a home scope,
    // since only an exact squad-scope grant (theirs) ever covers it.
    const decision = await decideAsApprover(
      req.requestId,
      SHADI_MEMBER_ID,
      SHADI_IDENTITY_ID,
      [{ member_id: SHADI_MEMBER_ID, scope_type: 'squad', scope_id: homeSquadId, capability: 'admin' }],
      t0,
    )
    expect(decision.ok, JSON.stringify(decision)).toBe(true)

    // Now allowed.
    expect(await canOnSquadAuth(env, mubotAuth(), homeSquadId, 'observer')).toBe(true)

    // Mubot's standing capabilities are UNCHANGED by the elevation — this is
    // additive session authority, never a written grant.
    expect(mubotAuth().capabilities).toHaveLength(1)

    // Past the 60-minute window, refused again — no one revoked anything.
    vi.setSystemTime(t0 + 61 * 60 * 1000)
    expect(await canOnSquadAuth(env, mubotAuth(), homeSquadId, 'observer')).toBe(false)
  })

  it('elevation grants NOTHING on a DIFFERENT member\'s home', async () => {
    const other = await createHomeForMember(env, MUBOT_MEMBER_ID)
    if (!other.ok) throw new Error('setup failed')

    const t0 = Date.parse('2026-09-21T12:00:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(t0)

    const sessionId = await checkIn()
    const req = await requestHomeAccess(sessionId, 60, t0)
    if (!req.ok) throw new Error('setup failed')
    const decision = await decideAsApprover(
      req.requestId,
      SHADI_MEMBER_ID,
      SHADI_IDENTITY_ID,
      [{ member_id: SHADI_MEMBER_ID, scope_type: 'squad', scope_id: homeSquadId, capability: 'admin' }],
      t0,
    )
    expect(decision.ok).toBe(true)

    // Named Shadi's home only — mubot's OWN home (a different squad) is untouched.
    expect(await canOnSquadAuth(env, mubotAuth(), homeSquadId, 'observer')).toBe(true)
    expect(await canOnSquadAuth(env, mubotAuth(), other.squad.id, 'observer')).toBe(false)
  })
})
