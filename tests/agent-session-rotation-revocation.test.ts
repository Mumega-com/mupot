// tests/agent-session-rotation-revocation.test.ts — Delivery Sequence step 3
// (mupot task f5fe1222, mumega-com#1173), ★ Athena's hard gate condition
// from the step-2 review (mandatory, not a nice-to-have):
//
//   "Step 2 left a rotation gap: a rotated-away agent_sessions row survives
//   to its own ceiling. She ruled it inert at step 2 (rotation revokes the
//   old credential, so it cannot authenticate) but explicitly dangerous at
//   step 3, because a rotated-away session carrying an elevation would be
//   ambiguous against the ledger. Step 3 MUST revoke the old agent_sessions
//   row on token rotation, so session-bound elevation dies with the
//   credential."
//
// This exercises the REAL rotation pipeline in src/members/service.ts
// (prepareAgentTokenReplacement → stageAgentTokenReplacement →
// markAgentTokenReplacementClaimReady → markAgentTokenReplacementAuditSent →
// activateAgentTokenReplacement) end to end, against the real migration
// chain — the same sequence tests/dashboard-agent-token.test.ts's
// "replacement_retry_resumes_without_duplicate_live_token_or_audit" proves
// for member_tokens; this file proves the SAME sequence for agent_sessions.
import { describe, expect, it } from 'vitest'
import {
  activateAgentTokenReplacement,
  markAgentTokenReplacementAuditSent,
  markAgentTokenReplacementClaimReady,
  mintAgentBoundToken,
  prepareAgentTokenReplacement,
  stageAgentTokenReplacement,
} from '../src/members/service'
import { createAgentSession, evaluateAgentSession, loadAgentSessionById, loadLiveAgentSessionByCredential } from '../src/auth/agent-sessions'
import { createElevationRequest, decideElevationRequest, hasElevatedAction, loadLiveElevationGrantsForSession } from '../src/auth/elevation'
import { createWebSession } from '../src/auth/web-sessions'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

const TENANT = 'test'
const AGENT = { id: 'agent-abc', squad_id: 'squad-xyz', slug: 'growth-lead', name: 'Growth Lead' }

function createMigratedEnv() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-mint', 'mint', 'Mint');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('${AGENT.squad_id}', 'dept-mint', 'growth', 'Growth');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status)
      VALUES ('${AGENT.id}', '${AGENT.squad_id}', '${AGENT.slug}', '${AGENT.name}', 'member', 'test', 'active');
  `)
  return { env: { TENANT_SLUG: TENANT, DB: harness.db } as Env, sqlite: harness.sqlite, close: harness.close }
}

async function rotate(env: Env, priorTokenId: string, mintedByMemberId: string) {
  const prepared = await prepareAgentTokenReplacement(env, AGENT, 'replacement', { revokePriorTokenId: priorTokenId })
  const staged = await stageAgentTokenReplacement(env, AGENT, prepared, {
    claimId: 'claim-rotation-test',
    fingerprint: '0123456789abcdef',
    expiresAt: '2099-01-01T00:00:00.000Z',
    mintedByMemberId,
  })
  await markAgentTokenReplacementClaimReady(env, staged.id)
  await markAgentTokenReplacementAuditSent(env, staged.id)
  await activateAgentTokenReplacement(env, staged.id)
  return prepared.replacementTokenId
}

describe('token rotation revokes the OLD agent_sessions row (Athena\'s step-2 gate condition)', () => {
  it('a live agent_sessions row for the prior credential is revoked (reason: token_rotated) the moment rotation activates', async () => {
    const harness = createMigratedEnv()
    try {
      const prior = await mintAgentBoundToken(harness.env, AGENT, 'prior')
      const session = await createAgentSession(harness.env, {
        tenant: TENANT, agentId: AGENT.id, memberId: prior.memberId, authKind: 'workspace_token', credentialId: prior.tokenId,
      })
      expect(evaluateAgentSession(session).ok).toBe(true)

      await rotate(harness.env, prior.tokenId, prior.memberId)

      const after = await loadAgentSessionById(harness.env, TENANT, session.id)
      expect(after?.revoked_at).toBeTruthy()
      expect(after?.revoke_reason).toBe('token_rotated')
      expect(evaluateAgentSession(after!).ok).toBe(false)

      // Also unreachable through the credential-lookup path check_in itself uses.
      const live = await loadLiveAgentSessionByCredential(harness.env, TENANT, 'workspace_token', prior.tokenId)
      expect(live).toBeNull()
    } finally {
      harness.close()
    }
  })

  it('★ ADVERSARIAL (the exact scenario Athena flagged): an elevation granted to the PRIOR session becomes unreachable the instant rotation activates — before the grant\'s own expiry, before anyone revokes it explicitly', async () => {
    const harness = createMigratedEnv()
    try {
      const prior = await mintAgentBoundToken(harness.env, AGENT, 'prior')
      const priorSession = await createAgentSession(harness.env, {
        tenant: TENANT, agentId: AGENT.id, memberId: prior.memberId, authKind: 'workspace_token', credentialId: prior.tokenId,
      })

      // A human grants a long-lived (24h) elevation to the PRIOR session.
      await harness.sqlite.prepare(
        `INSERT INTO members (id, email, display_name, status, tenant) VALUES ('admin-1', 'admin@x.test', 'Admin', 'active', ?)`,
      ).run(TENANT)
      await harness.sqlite.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-1', 'admin-1', 'squad', ?, 'admin')`,
      ).run(AGENT.squad_id)
      await harness.sqlite.prepare(
        `INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
         VALUES ('id-admin-1', ?, 'google', 'admin-1', 'admin@x.test', 'admin-1', datetime('now'))`,
      ).run(TENANT)
      const approverSession = await createWebSession(harness.env, 'raw-admin', { tenant: TENANT, memberId: 'admin-1', loginIdentityId: 'id-admin-1' })

      const created = await createElevationRequest(harness.env, {
        tenant: TENANT, agentSessionId: priorSession.id, agentId: AGENT.id, memberId: prior.memberId,
        actions: ['action:dispatch'], scopeType: 'squad', scopeId: AGENT.squad_id, durationMinutes: 1440, reason: 'long task',
      })
      if (!created.ok) throw new Error('setup failed')
      const decision = await decideElevationRequest(harness.env, {
        tenant: TENANT, requestId: created.request.id, decision: 'approve',
        selectedActions: ['action:dispatch'],
        decidedByMemberId: 'admin-1',
        decidedByCapabilities: [{ member_id: 'admin-1', scope_type: 'squad', scope_id: AGENT.squad_id, capability: 'admin' }],
        decidedByWebSessionHash: approverSession.id_hash, recentReauthOk: true,
      })
      if (!decision.ok) throw new Error('approve failed')

      const priorAuth: AuthContext = {
        userId: prior.memberId, memberId: prior.memberId, email: null, role: 'member', tenant: TENANT,
        channel: 'workspace', boundAgentId: AGENT.id, tokenId: prior.tokenId,
      }
      // Confirmed live BEFORE rotation.
      const before = await hasElevatedAction(harness.env, priorAuth, 'action:dispatch', 'squad', AGENT.squad_id, { recordUsage: false })
      expect(before.granted).toBe(true)

      // Rotate the credential (a routine, legitimate key-rotation event — NOT a
      // revoke_agent_token/deactivate_agent call, and nobody touched the
      // elevation grant or the session directly).
      await rotate(harness.env, prior.tokenId, prior.memberId)

      // The 24h grant is nowhere near its own expiry, and nobody explicitly
      // revoked it — yet it must now be UNREACHABLE, because the exact
      // session it is bound to is dead. This is the ambiguity Athena's gate
      // exists to prevent: a rotated-away session must never be able to
      // authenticate an elevation, ever.
      const after = await hasElevatedAction(harness.env, priorAuth, 'action:dispatch', 'squad', AGENT.squad_id)
      expect(after.granted).toBe(false)
      if (!after.granted) {
        expect(['no_live_session', 'session_revoked']).toContain(after.reason)
      }

      // The grant ROW itself is untouched (still revoked_at IS NULL,
      // expires_at 24h out) — this is a LIVENESS re-derivation catching it,
      // exactly like approver-authority-loss and approver-session-ended do,
      // not a cross-write into elevation_grants triggered by rotation.
      const grants = await loadLiveElevationGrantsForSession(harness.env, TENANT, priorSession.id, Date.now())
      expect(grants).toHaveLength(1)
      expect(grants[0].revoked_at).toBeNull()
    } finally {
      harness.close()
    }
  })

  it('the REPLACEMENT credential has no session of its own yet (rotation does not fabricate one) — the next check_in mints it fresh', async () => {
    const harness = createMigratedEnv()
    try {
      const prior = await mintAgentBoundToken(harness.env, AGENT, 'prior')
      await createAgentSession(harness.env, {
        tenant: TENANT, agentId: AGENT.id, memberId: prior.memberId, authKind: 'workspace_token', credentialId: prior.tokenId,
      })
      const replacementTokenId = await rotate(harness.env, prior.tokenId, prior.memberId)
      const replacementSession = await loadLiveAgentSessionByCredential(harness.env, TENANT, 'workspace_token', replacementTokenId)
      expect(replacementSession).toBeNull()
    } finally {
      harness.close()
    }
  })
})
