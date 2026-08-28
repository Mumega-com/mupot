// tests/flight-004-approvals-2fa.test.ts — Verification of FLIGHT-004 / mumega-com#725.
//
// Invariants verified:
//   1. Action-Hash Determinism: Canonical serialization & SHA-256 hash calculation.
//   2. Challenge Creation: Server-generated single-use approval challenge bound to action payload hash and requester.
//   3. Challenge Authorization & Decisions: Only org-admins / authorized operators can approve or reject challenges with matching nonces.
//   4. Single-Use Replay Protection: Once consumed, challenges cannot be re-executed or replayed.
//   5. Action Mismatch Rejection: Altering the action type, target id, or payload arguments rejects execution (400 action_payload_mismatch).
//   6. Expiration Safety: Expired challenges cannot be approved or consumed.
//   7. MCP Tools: approval_challenge_create, approval_verify, and approval_consume integration.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  computeActionPayloadHash,
  createApprovalChallenge,
  decideApprovalChallenge,
  consumeApproval,
} from '../src/auth/approvals-2fa'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT-004: Native In-Pot 2FA & Action Approvals (#725)', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const ADMIN_MEMBER_ID = 'm-hadi'
  const OPERATOR_MEMBER_ID = 'm-operator'
  const SQUAD_ID = 'squad-core'

  const adminAuth: AuthContext = {
    userId: ADMIN_MEMBER_ID,
    memberId: ADMIN_MEMBER_ID,
    email: 'hadi@mumega.com',
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: ADMIN_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'owner' }],
  }

  const memberAuth: AuthContext = {
    userId: OPERATOR_MEMBER_ID,
    memberId: OPERATOR_MEMBER_ID,
    email: 'operator@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: OPERATOR_MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env

    // Seed test members and squad
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO members (id, email, display_name, status, tenant)
      VALUES ('${ADMIN_MEMBER_ID}', 'hadi@mumega.com', 'Hadi', 'active', '${TENANT}'),
             ('${OPERATOR_MEMBER_ID}', 'operator@mumega.com', 'Operator', 'active', '${TENANT}');

      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-core', 'core', 'Core');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-core', 'core', 'Core Squad');

      INSERT OR IGNORE INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-owner', '${ADMIN_MEMBER_ID}', 'org', NULL, 'owner'),
             ('cap-member-squad', '${OPERATOR_MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    `)
  })

  describe('1. Action-Payload Hash Computation', () => {
    it('generates deterministic SHA-256 action hash regardless of key ordering', async () => {
      const payload1 = { target: 'database', action: 'drop', reason: 'reinit' }
      const payload2 = { reason: 'reinit', target: 'database', action: 'drop' }

      const hash1 = await computeActionPayloadHash('system_action', payload1, 'target-1')
      const hash2 = await computeActionPayloadHash('system_action', payload2, 'target-1')

      expect(hash1).toHaveLength(64)
      expect(hash1).toBe(hash2)
    })

    it('produces different hash when target or payload changes', async () => {
      const hashA = await computeActionPayloadHash('deploy', { version: '1.0.0' }, 'pot-1')
      const hashB = await computeActionPayloadHash('deploy', { version: '1.0.1' }, 'pot-1')
      const hashC = await computeActionPayloadHash('deploy', { version: '1.0.0' }, 'pot-2')

      expect(hashA).not.toBe(hashB)
      expect(hashA).not.toBe(hashC)
    })
  })

  describe('2. Challenge Lifecycle & Execution Flow', () => {
    it('creates, approves, and consumes challenge token exactly once', async () => {
      const payload = { recipient: 'supplier', amount_cents: 50000 }
      const actionType = 'wire_transfer'
      const targetId = 'tx-1001'

      // 1. Create challenge
      const created = await createApprovalChallenge(env, {
        actionType,
        payload,
        targetId,
        requesterId: OPERATOR_MEMBER_ID,
      })

      expect(created.challengeId).toBeTruthy()
      expect(created.nonce).toBeTruthy()
      expect(created.actionPayloadHash).toHaveLength(64)

      // 2. Approve challenge as org admin
      const decided = await decideApprovalChallenge(env, adminAuth, {
        challengeId: created.challengeId,
        nonce: created.nonce,
        verdict: 'approved',
        verificationMethod: 'direct_operator_nonce',
        note: 'Approved by Hadi for Q3 settlement',
      })

      expect(decided.ok).toBe(true)
      if (!decided.ok) throw new Error('Unreachable')
      expect(decided.receipt.action_type).toBe(actionType)
      expect(decided.receipt.approved_by_member_id).toBe(ADMIN_MEMBER_ID)

      // 3. Consume approval before executing action
      const consumed = await consumeApproval(env, {
        challengeId: created.challengeId,
        nonce: created.nonce,
        actionType,
        payload,
        targetId,
      })

      expect(consumed.ok).toBe(true)
      if (!consumed.ok) throw new Error('Unreachable')
      expect(consumed.receipt.challenge_id).toBe(created.challengeId)

      // 4. Replay attempt fails closed with challenge_already_consumed
      const replay = await consumeApproval(env, {
        challengeId: created.challengeId,
        nonce: created.nonce,
        actionType,
        payload,
        targetId,
      })

      expect(replay.ok).toBe(false)
      if (replay.ok) throw new Error('Unreachable')
      expect(replay.error).toBe('challenge_already_consumed')
      expect(replay.status).toBe(409)
    })

    it('refuses approval if non-admin attempts to decide challenge', async () => {
      const created = await createApprovalChallenge(env, {
        actionType: 'rotate_key',
        payload: { key_id: 'prod-main' },
        requesterId: OPERATOR_MEMBER_ID,
      })

      const decided = await decideApprovalChallenge(env, memberAuth, {
        challengeId: created.challengeId,
        nonce: created.nonce,
        verdict: 'approved',
      })

      expect(decided.ok).toBe(false)
      if (decided.ok) throw new Error('Unreachable')
      expect(decided.error).toBe('unauthorized')
      expect(decided.status).toBe(403)
    })

    it('fails closed with action_payload_mismatch if payload was tampered', async () => {
      const originalPayload = { config: 'safe' }
      const tamperedPayload = { config: 'destructive' }

      const created = await createApprovalChallenge(env, {
        actionType: 'update_config',
        payload: originalPayload,
        requesterId: OPERATOR_MEMBER_ID,
      })

      // Admin approved safe config
      await decideApprovalChallenge(env, adminAuth, {
        challengeId: created.challengeId,
        nonce: created.nonce,
        verdict: 'approved',
      })

      // Attacker attempts to consume with tampered payload
      const outcome = await consumeApproval(env, {
        challengeId: created.challengeId,
        nonce: created.nonce,
        actionType: 'update_config',
        payload: tamperedPayload,
      })

      expect(outcome.ok).toBe(false)
      if (outcome.ok) throw new Error('Unreachable')
      expect(outcome.error).toBe('action_payload_mismatch')
      expect(outcome.status).toBe(400)
    })

    it('fails closed when challenge is expired', async () => {
      const created = await createApprovalChallenge(env, {
        actionType: 'transient_op',
        payload: { op: 'ping' },
        requesterId: OPERATOR_MEMBER_ID,
        expiresInSec: -10, // already expired
      })

      const decided = await decideApprovalChallenge(env, adminAuth, {
        challengeId: created.challengeId,
        nonce: created.nonce,
        verdict: 'approved',
      })

      expect(decided.ok).toBe(false)
      if (decided.ok) throw new Error('Unreachable')
      expect(decided.error).toBe('challenge_expired')
      expect(decided.status).toBe(409)
    })
  })

  describe('3. MCP Native Tools Integration', () => {
    it('executes approval_challenge_create, approval_verify, and approval_consume via MCP', async () => {
      // 1. Create Challenge via MCP
      const createRes = await invokeTool(memberAuth, env, 'approval_challenge_create', {
        action_type: 'secret_burn',
        payload: { burn_all: true },
        target_id: 'vault-1',
      })

      expect(createRes.ok).toBe(true)
      if (!createRes.ok) throw new Error('Unreachable')
      const { challengeId, nonce } = createRes.result as any

      // 2. Verify / Approve via MCP (Admin)
      const verifyRes = await invokeTool(adminAuth, env, 'approval_verify', {
        challenge_id: challengeId,
        nonce,
        verdict: 'approved',
        verification_method: 'direct_operator_nonce',
        note: 'Approved by Hadi via native MCP tool',
      })

      expect(verifyRes.ok).toBe(true)
      if (!verifyRes.ok) throw new Error('Unreachable')

      // 3. Consume Challenge via MCP
      const consumeRes = await invokeTool(memberAuth, env, 'approval_consume', {
        challenge_id: challengeId,
        nonce,
        action_type: 'secret_burn',
        payload: { burn_all: true },
        target_id: 'vault-1',
      })

      expect(consumeRes.ok).toBe(true)
      if (!consumeRes.ok) throw new Error('Unreachable')
      expect((consumeRes.result as any).receipt.action_type).toBe('secret_burn')
    })
  })
})
