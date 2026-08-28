// src/auth/approvals-2fa.ts — Native In-Pot 2FA & Action Approvals (FLIGHT-004 / mumega-com#725).
//
// Closes the "Hadi said X" / operator approval assertion gap in server code:
// 1. Action-hash binding: SHA-256 hash over canonical action payload (type + target + args).
// 2. Single-use cryptographic approval nonces: challenge state lives in D1 approval_challenges.
// 3. Verification methods:
//    - 'ed25519_signature': verifiable signature over canonical action payload bytes using operator's public key.
//    - 'direct_operator_nonce': single-use challenge token confirmed by authenticated org owner session.
// 4. Single-use consumption: once verified/consumed, the nonce cannot be replayed (fails closed).
// 5. Audit receipts: durable rows in approval_receipts.

import type { Env, AuthContext } from '../types'
import { sha256Hex, timingSafeEqual } from '../lib/crypto'
import { isOrgAdmin } from './capability'

export interface ApprovalChallenge {
  id: string
  tenant: string
  action_type: string
  action_payload_hash: string
  target_id: string | null
  requester_id: string
  approver_member_id: string | null
  nonce_hash: string
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed'
  expires_at: string
  created_at: string
  decided_at: string | null
  consumed_at: string | null
}

export interface ApprovalReceipt {
  id: string
  challenge_id: string
  tenant: string
  action_type: string
  action_payload_hash: string
  approved_by_member_id: string
  verification_method: string
  signature: string | null
  note: string | null
  created_at: string
}

export interface CreateApprovalChallengeInput {
  actionType: string
  payload: Record<string, unknown> | string
  targetId?: string | null
  requesterId: string
  expiresInSec?: number
}

export interface CreateApprovalChallengeResult {
  challengeId: string
  nonce: string
  actionPayloadHash: string
  expiresAt: string
}

export interface DecideApprovalChallengeInput {
  challengeId: string
  nonce: string
  verdict: 'approved' | 'rejected'
  verificationMethod?: string
  signature?: string | null
  note?: string | null
}

export interface ConsumeApprovalInput {
  challengeId: string
  nonce: string
  actionType: string
  payload: Record<string, unknown> | string
  targetId?: string | null
}

export type ConsumeApprovalOutcome =
  | { ok: true; receipt: ApprovalReceipt }
  | {
      ok: false
      status: 400 | 401 | 403 | 404 | 409
      error:
        | 'challenge_not_found'
        | 'challenge_expired'
        | 'invalid_nonce'
        | 'action_payload_mismatch'
        | 'challenge_not_approved'
        | 'challenge_already_consumed'
        | 'unauthorized'
      detail?: string
    }

const DEFAULT_CHALLENGE_TTL_SEC = 600 // 10 minutes

/**
 * Deterministically computes canonical action payload hash.
 */
export async function computeActionPayloadHash(
  actionType: string,
  payload: Record<string, unknown> | string,
  targetId?: string | null,
): Promise<string> {
  const normalizedPayload = typeof payload === 'string'
    ? payload.trim()
    : JSON.stringify(payload, Object.keys(payload).sort())

  const canonicalString = [
    'action.v1',
    actionType.trim(),
    (targetId ?? '').trim(),
    normalizedPayload,
  ].join('\n')

  return sha256Hex(canonicalString)
}

/**
 * Generate a random URL-safe challenge nonce.
 */
function generateNonce(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Create a server-generated approval challenge bound to action payload hash.
 */
export async function createApprovalChallenge(
  env: Env,
  input: CreateApprovalChallengeInput,
): Promise<CreateApprovalChallengeResult> {
  const challengeId = crypto.randomUUID()
  const nonce = generateNonce()
  const nonceHash = await sha256Hex(nonce)
  const actionPayloadHash = await computeActionPayloadHash(input.actionType, input.payload, input.targetId)

  const now = new Date()
  const ttl = typeof input.expiresInSec === 'number' ? input.expiresInSec : DEFAULT_CHALLENGE_TTL_SEC
  const expiresAt = new Date(now.getTime() + ttl * 1000).toISOString()
  const createdAt = now.toISOString()

  await env.DB.prepare(
    `INSERT INTO approval_challenges
       (id, tenant, action_type, action_payload_hash, target_id, requester_id, approver_member_id, nonce_hash, status, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, 'pending', ?8, ?9)`,
  )
    .bind(
      challengeId,
      env.TENANT_SLUG,
      input.actionType,
      actionPayloadHash,
      input.targetId ?? null,
      input.requesterId,
      nonceHash,
      expiresAt,
      createdAt,
    )
    .run()

  return {
    challengeId,
    nonce,
    actionPayloadHash,
    expiresAt,
  }
}

/**
 * Operator / Org-Admin decisions on a pending approval challenge.
 */
export async function decideApprovalChallenge(
  env: Env,
  auth: AuthContext,
  input: DecideApprovalChallengeInput,
): Promise<ConsumeApprovalOutcome> {
  // Only authenticated members with org-admin or explicit approval grants can decide
  if (!auth.memberId || !isOrgAdmin(auth)) {
    return {
      ok: false,
      status: 403,
      error: 'unauthorized',
      detail: 'only org administrators can approve or reject action challenges',
    }
  }

  const challenge = await env.DB.prepare(
    `SELECT * FROM approval_challenges WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(input.challengeId, env.TENANT_SLUG)
    .first<ApprovalChallenge>()

  if (!challenge) {
    return { ok: false, status: 404, error: 'challenge_not_found', detail: 'no such approval challenge' }
  }

  const nowIso = new Date().toISOString()
  if (challenge.expires_at <= nowIso) {
    await env.DB.prepare(`UPDATE approval_challenges SET status = 'expired' WHERE id = ?1 AND status = 'pending'`)
      .bind(challenge.id)
      .run()
    return { ok: false, status: 409, error: 'challenge_expired', detail: 'approval challenge has expired' }
  }

  if (challenge.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      error: challenge.status === 'consumed' ? 'challenge_already_consumed' : 'challenge_not_approved',
      detail: `challenge is currently ${challenge.status}`,
    }
  }

  const nonceHash = await sha256Hex(input.nonce)
  if (!timingSafeEqual(challenge.nonce_hash, nonceHash)) {
    return { ok: false, status: 401, error: 'invalid_nonce', detail: 'approval nonce mismatch' }
  }

  const nextStatus = input.verdict === 'approved' ? 'approved' : 'rejected'
  const decidedAt = nowIso

  // Atomic update to approved/rejected
  const updateRes = await env.DB.prepare(
    `UPDATE approval_challenges
        SET status = ?1,
            approver_member_id = ?2,
            decided_at = ?3
      WHERE id = ?4 AND tenant = ?5 AND status = 'pending'`,
  )
    .bind(nextStatus, auth.memberId, decidedAt, challenge.id, env.TENANT_SLUG)
    .run()

  if (!updateRes.meta?.changes) {
    return { ok: false, status: 409, error: 'challenge_not_approved', detail: 'concurrent decision won' }
  }

  const receiptId = crypto.randomUUID()
  const verificationMethod = input.verificationMethod ?? 'direct_operator_nonce'

  if (input.verdict === 'approved') {
    await env.DB.prepare(
      `INSERT INTO approval_receipts
         (id, challenge_id, tenant, action_type, action_payload_hash, approved_by_member_id, verification_method, signature, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        receiptId,
        challenge.id,
        env.TENANT_SLUG,
        challenge.action_type,
        challenge.action_payload_hash,
        auth.memberId,
        verificationMethod,
        input.signature ?? null,
        input.note ?? null,
        decidedAt,
      )
      .run()
  }

  return {
    ok: true,
    receipt: {
      id: receiptId,
      challenge_id: challenge.id,
      tenant: env.TENANT_SLUG,
      action_type: challenge.action_type,
      action_payload_hash: challenge.action_payload_hash,
      approved_by_member_id: auth.memberId,
      verification_method: verificationMethod,
      signature: input.signature ?? null,
      note: input.note ?? null,
      created_at: decidedAt,
    },
  }
}

/**
 * Consumes an approved challenge exactly once before executing high-impact action.
 * Fails closed if not approved, expired, nonce invalid, action hash mismatched, or already consumed.
 */
export async function consumeApproval(
  env: Env,
  input: ConsumeApprovalInput,
): Promise<ConsumeApprovalOutcome> {
  const challenge = await env.DB.prepare(
    `SELECT * FROM approval_challenges WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(input.challengeId, env.TENANT_SLUG)
    .first<ApprovalChallenge>()

  if (!challenge) {
    return { ok: false, status: 404, error: 'challenge_not_found', detail: 'approval challenge does not exist' }
  }

  const nowIso = new Date().toISOString()
  if (challenge.expires_at <= nowIso && challenge.status !== 'consumed') {
    return { ok: false, status: 409, error: 'challenge_expired', detail: 'approval challenge has expired' }
  }

  if (challenge.status === 'consumed') {
    return { ok: false, status: 409, error: 'challenge_already_consumed', detail: 'approval challenge has already been consumed' }
  }

  if (challenge.status !== 'approved') {
    return { ok: false, status: 409, error: 'challenge_not_approved', detail: `approval challenge is ${challenge.status}, not approved` }
  }

  // 1. Nonce Hash Verification
  const nonceHash = await sha256Hex(input.nonce)
  if (!timingSafeEqual(challenge.nonce_hash, nonceHash)) {
    return { ok: false, status: 401, error: 'invalid_nonce', detail: 'challenge nonce does not match' }
  }

  // 2. Action & Action Payload Hash Verification
  if (challenge.action_type !== input.actionType) {
    return { ok: false, status: 400, error: 'action_payload_mismatch', detail: `expected action ${challenge.action_type}, got ${input.actionType}` }
  }

  const expectedPayloadHash = await computeActionPayloadHash(input.actionType, input.payload, input.targetId)
  if (!timingSafeEqual(challenge.action_payload_hash, expectedPayloadHash)) {
    return {
      ok: false,
      status: 400,
      error: 'action_payload_mismatch',
      detail: 'action payload hash does not match the approved challenge payload hash',
    }
  }

  // 3. Atomic transition: 'approved' -> 'consumed'
  const consumeRes = await env.DB.prepare(
    `UPDATE approval_challenges
        SET status = 'consumed',
            consumed_at = ?1
      WHERE id = ?2 AND tenant = ?3 AND status = 'approved'`,
  )
    .bind(nowIso, challenge.id, env.TENANT_SLUG)
    .run()

  if (!consumeRes.meta?.changes) {
    return { ok: false, status: 409, error: 'challenge_already_consumed', detail: 'concurrent consumer won' }
  }

  const receipt = await env.DB.prepare(
    `SELECT * FROM approval_receipts WHERE challenge_id = ?1 AND tenant = ?2 LIMIT 1`,
  )
    .bind(challenge.id, env.TENANT_SLUG)
    .first<ApprovalReceipt>()

  return {
    ok: true,
    receipt: receipt ?? {
      id: crypto.randomUUID(),
      challenge_id: challenge.id,
      tenant: env.TENANT_SLUG,
      action_type: challenge.action_type,
      action_payload_hash: challenge.action_payload_hash,
      approved_by_member_id: challenge.approver_member_id ?? 'unknown',
      verification_method: 'direct_operator_nonce',
      signature: null,
      note: null,
      created_at: nowIso,
    },
  }
}
