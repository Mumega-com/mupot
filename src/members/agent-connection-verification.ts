import {
  deleteAgentConnectionMessage,
  readAgentInbox,
  sendAgentMessage,
} from '../agents/messages'
import { mcpEndpoint, requiredCanonicalOrigin } from '../dashboard/connect'
import { rowsWritten } from '../lib/receipt'
import { buildOrient } from '../orient/service'
import type { Env } from '../types'
import type { AgentConnectionReceipt } from './agent-connection'
import { sha256Hex } from './service'

const MAX_VERIFICATION_ATTEMPTS = 5
const LOOPBACK_BODY = 'Mupot agent connection verification'

type PassCheck = { status: 'pass' }
type FailedCheck = { status: 'fail'; error: string }
type VerificationCheck = PassCheck | FailedCheck
type VerificationChecks = Record<string, VerificationCheck>

export interface AgentConnectionVerificationPrincipal {
  tenant: string
  tokenId: string
  memberId: string
  agentId: string
}

export type AgentConnectionVerificationOutcome =
  | {
      status: 'messaging_verified'
      receiptId: string
      messageId: string
      replay: boolean
      checks: Record<string, PassCheck>
    }
  | {
      status: 'verification_incomplete'
      error: string
      retryable: boolean
    }

export interface AgentConnectionVerificationDeps {
  buildOrient: typeof buildOrient
  sendAgentMessage: typeof sendAgentMessage
  readAgentInbox: typeof readAgentInbox
  deleteAgentConnectionMessage: typeof deleteAgentConnectionMessage
  requiredCanonicalOrigin: typeof requiredCanonicalOrigin
}

const DEFAULT_DEPS: AgentConnectionVerificationDeps = {
  buildOrient,
  sendAgentMessage,
  readAgentInbox,
  deleteAgentConnectionMessage,
  requiredCanonicalOrigin,
}

function incomplete(
  error: string,
  retryable: boolean,
): AgentConnectionVerificationOutcome {
  return { status: 'verification_incomplete', error, retryable }
}

function decodeDigest(hex: string | null): {
  bytes: Uint8Array
  valid: boolean
} {
  const bytes = new Uint8Array(32)
  const valid = typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex)
  const source = valid ? hex : '0'.repeat(64)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(source.slice(index * 2, index * 2 + 2), 16)
  }
  return { bytes, valid }
}

/**
 * Compare two SHA-256 hex digests without an early exit. Malformed values are
 * represented as zero-filled 32-byte arrays so the loop always performs the
 * same 32 XOR operations.
 */
function digestMatches(expectedHex: string | null, suppliedHex: string): boolean {
  const expected = decodeDigest(expectedHex)
  const supplied = decodeDigest(suppliedHex)
  let different = Number(!expected.valid) | Number(!supplied.valid)
  for (let index = 0; index < 32; index += 1) {
    different |= expected.bytes[index] ^ supplied.bytes[index]
  }
  return different === 0
}

function identityMatches(
  env: Env,
  receipt: AgentConnectionReceipt,
  principal: AgentConnectionVerificationPrincipal,
): boolean {
  return principal.tenant === env.TENANT_SLUG
    && receipt.tenant === env.TENANT_SLUG
    && receipt.token_id === principal.tokenId
    && receipt.member_id === principal.memberId
    && receipt.agent_id === principal.agentId
}

async function readReceipt(
  env: Env,
  receiptId: string,
): Promise<AgentConnectionReceipt | null> {
  return env.DB.prepare(
    `SELECT *
       FROM agent_connection_receipts
      WHERE tenant = ?
        AND id = ?
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, receiptId).first<AgentConnectionReceipt>()
}

function replayChecks(raw: string): Record<string, PassCheck> {
  try {
    const value = JSON.parse(raw) as Record<string, { status?: unknown }>
    const checks: Record<string, PassCheck> = {}
    for (const [name, check] of Object.entries(value)) {
      if (check?.status === 'pass') checks[name] = { status: 'pass' }
    }
    return checks
  } catch {
    return {}
  }
}

function replayOutcome(
  receipt: AgentConnectionReceipt,
): AgentConnectionVerificationOutcome {
  if (receipt.verification_status === 'pass' && receipt.verification_message_id) {
    return {
      status: 'messaging_verified',
      receiptId: receipt.id,
      messageId: receipt.verification_message_id,
      replay: true,
      checks: replayChecks(receipt.checks_json),
    }
  }
  if (receipt.verification_status === 'expired') {
    return incomplete('challenge_expired', false)
  }
  if (receipt.verification_status === 'fail') {
    return incomplete('challenge_exhausted', false)
  }
  return incomplete('verification_not_found', false)
}

async function expireChallenge(
  env: Env,
  receipt: AgentConnectionReceipt,
  nowIso: string,
): Promise<AgentConnectionVerificationOutcome> {
  const writes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_connection_receipts
          SET verification_status = 'expired',
              verification_challenge_hash = NULL,
              verification_error_code = 'challenge_expired',
              updated_at = ?
        WHERE tenant = ?
          AND id = ?
          AND verification_status = 'pending'`,
    ).bind(nowIso, env.TENANT_SLUG, receipt.id),
    env.DB.prepare(
      `UPDATE agent_connection_requests
          SET status = 'expired',
              error_code = 'challenge_expired',
              updated_at = ?,
              finalized_at = ?
        WHERE tenant = ?
          AND receipt_id = ?
          AND status IN ('credential_issued', 'client_connected')
          AND EXISTS (
            SELECT 1 FROM agent_connection_receipts r
             WHERE r.tenant = ?
               AND r.id = ?
               AND r.verification_status = 'expired'
          )`,
    ).bind(
      nowIso,
      nowIso,
      env.TENANT_SLUG,
      receipt.id,
      env.TENANT_SLUG,
      receipt.id,
    ),
  ])
  if (rowsWritten(writes[0]) < 1) {
    const current = await readReceipt(env, receipt.id)
    return current ? replayOutcome(current) : incomplete('verification_not_found', false)
  }
  if (rowsWritten(writes[1]) < 1) {
    const request = await env.DB.prepare(
      `SELECT status
         FROM agent_connection_requests
        WHERE tenant = ?
          AND receipt_id = ?
        LIMIT 1`,
    ).bind(env.TENANT_SLUG, receipt.id).first<{ status: string }>()
    if (request?.status !== 'expired') {
      return incomplete('verification_state_failed', true)
    }
  }
  return incomplete('challenge_expired', false)
}

async function recordChallengeMismatch(
  env: Env,
  receipt: AgentConnectionReceipt,
  nowIso: string,
): Promise<AgentConnectionVerificationOutcome> {
  const writes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_connection_receipts
          SET verification_attempts = verification_attempts + 1,
              verification_status =
                CASE WHEN verification_attempts + 1 >= ?
                     THEN 'fail' ELSE verification_status END,
              verification_challenge_hash =
                CASE WHEN verification_attempts + 1 >= ?
                     THEN NULL ELSE verification_challenge_hash END,
              verification_error_code = 'challenge_mismatch',
              updated_at = ?
        WHERE tenant = ?
          AND id = ?
          AND verification_status = 'pending'
          AND verification_attempts < ?`,
    ).bind(
      MAX_VERIFICATION_ATTEMPTS,
      MAX_VERIFICATION_ATTEMPTS,
      nowIso,
      env.TENANT_SLUG,
      receipt.id,
      MAX_VERIFICATION_ATTEMPTS,
    ),
    env.DB.prepare(
      `UPDATE agent_connection_requests
          SET status = 'failed',
              error_code = 'challenge_mismatch',
              updated_at = ?,
              finalized_at = ?
        WHERE tenant = ?
          AND receipt_id = ?
          AND status IN ('credential_issued', 'client_connected')
          AND EXISTS (
            SELECT 1 FROM agent_connection_receipts r
             WHERE r.tenant = ?
               AND r.id = ?
               AND r.verification_status = 'fail'
               AND r.verification_attempts >= ?
          )`,
    ).bind(
      nowIso,
      nowIso,
      env.TENANT_SLUG,
      receipt.id,
      env.TENANT_SLUG,
      receipt.id,
      MAX_VERIFICATION_ATTEMPTS,
    ),
  ])
  if (rowsWritten(writes[0]) < 1) {
    const current = await readReceipt(env, receipt.id)
    return current ? replayOutcome(current) : incomplete('verification_not_found', false)
  }
  const current = await readReceipt(env, receipt.id)
  if (!current) return incomplete('verification_not_found', false)
  if (current.verification_status !== 'fail') {
    return incomplete('challenge_mismatch', true)
  }
  if (rowsWritten(writes[1]) < 1) {
    const request = await env.DB.prepare(
      `SELECT status
         FROM agent_connection_requests
        WHERE tenant = ?
          AND receipt_id = ?
        LIMIT 1`,
    ).bind(env.TENANT_SLUG, receipt.id).first<{ status: string }>()
    if (request?.status !== 'failed') {
      return incomplete('verification_state_failed', true)
    }
  }
  return incomplete('challenge_exhausted', false)
}

async function recordTransientFailure(
  env: Env,
  receipt: AgentConnectionReceipt,
  nowIso: string,
  error: string,
  checks: VerificationChecks,
): Promise<AgentConnectionVerificationOutcome> {
  try {
    const writes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_connection_receipts
            SET client_connected_at = COALESCE(client_connected_at, ?),
                verification_error_code = ?,
                checks_json = ?,
                updated_at = ?
          WHERE tenant = ?
            AND id = ?
            AND verification_status = 'pending'`,
      ).bind(
        nowIso,
        error,
        JSON.stringify(checks),
        nowIso,
        env.TENANT_SLUG,
        receipt.id,
      ),
      env.DB.prepare(
        `UPDATE agent_connection_requests
            SET status = 'client_connected',
                error_code = ?,
                updated_at = ?
          WHERE tenant = ?
            AND receipt_id = ?
            AND status IN ('credential_issued', 'client_connected')
            AND EXISTS (
              SELECT 1 FROM agent_connection_receipts r
               WHERE r.tenant = ?
                 AND r.id = ?
                 AND r.verification_status = 'pending'
            )`,
      ).bind(
        error,
        nowIso,
        env.TENANT_SLUG,
        receipt.id,
        env.TENANT_SLUG,
        receipt.id,
      ),
    ])
    if (rowsWritten(writes[0]) < 1 || rowsWritten(writes[1]) < 1) {
      const current = await readReceipt(env, receipt.id)
      if (current && current.verification_status !== 'pending') return replayOutcome(current)
      return incomplete('verification_state_failed', true)
    }
    return incomplete(error, true)
  } catch {
    return incomplete('verification_state_failed', true)
  }
}

async function commitPass(
  env: Env,
  receipt: AgentConnectionReceipt,
  nowIso: string,
  requestId: string,
  messageId: string,
  checks: Record<string, PassCheck>,
): Promise<AgentConnectionVerificationOutcome> {
  try {
    const writes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_connection_receipts
            SET verification_status = 'pass',
                verification_challenge_hash = NULL,
                client_connected_at = COALESCE(client_connected_at, ?),
                verification_message_id = ?,
                verification_request_id = ?,
                messaging_verified_at = ?,
                verification_error_code = NULL,
                checks_json = ?,
                updated_at = ?
          WHERE tenant = ?
            AND id = ?
            AND token_id = ?
            AND member_id = ?
            AND agent_id = ?
            AND verification_status = 'pending'
            AND verification_challenge_hash = ?`,
      ).bind(
        nowIso,
        messageId,
        requestId,
        nowIso,
        JSON.stringify(checks),
        nowIso,
        env.TENANT_SLUG,
        receipt.id,
        receipt.token_id,
        receipt.member_id,
        receipt.agent_id,
        receipt.verification_challenge_hash,
      ),
      env.DB.prepare(
        `UPDATE agent_connection_requests
            SET status = 'messaging_verified',
                error_code = NULL,
                updated_at = ?,
                finalized_at = ?
          WHERE tenant = ?
            AND receipt_id = ?
            AND status IN ('credential_issued', 'client_connected')
            AND EXISTS (
              SELECT 1 FROM agent_connection_receipts r
               WHERE r.tenant = ?
                 AND r.id = ?
                 AND r.verification_status = 'pass'
                 AND r.verification_message_id = ?
                 AND r.verification_request_id = ?
            )`,
      ).bind(
        nowIso,
        nowIso,
        env.TENANT_SLUG,
        receipt.id,
        env.TENANT_SLUG,
        receipt.id,
        messageId,
        requestId,
      ),
    ])
    if (rowsWritten(writes[0]) < 1 || rowsWritten(writes[1]) < 1) {
      const current = await readReceipt(env, receipt.id)
      return current ? replayOutcome(current) : incomplete('verification_not_found', false)
    }
    return {
      status: 'messaging_verified',
      receiptId: receipt.id,
      messageId,
      replay: false,
      checks,
    }
  } catch {
    return incomplete('verification_state_failed', true)
  }
}

export async function verifyAgentConnection(
  env: Env,
  principal: AgentConnectionVerificationPrincipal,
  input: { receiptId: string; challenge: string },
  now = new Date(),
  dependencyOverrides: Partial<AgentConnectionVerificationDeps> = {},
): Promise<AgentConnectionVerificationOutcome> {
  const deps = { ...DEFAULT_DEPS, ...dependencyOverrides }
  if (
    typeof input.receiptId !== 'string'
    || input.receiptId.length < 1
    || typeof input.challenge !== 'string'
    || input.challenge.length < 1
  ) {
    return incomplete('invalid_verification_input', false)
  }

  const receipt = await readReceipt(env, input.receiptId)
  if (!receipt || !identityMatches(env, receipt, principal)) {
    return incomplete('verification_not_found', false)
  }
  if (receipt.verification_status !== 'pending') return replayOutcome(receipt)

  const nowIso = now.toISOString()
  if (
    !receipt.verification_expires_at
    || receipt.verification_expires_at <= nowIso
  ) {
    return expireChallenge(env, receipt, nowIso)
  }

  const suppliedHash = await sha256Hex(input.challenge)
  if (!digestMatches(receipt.verification_challenge_hash, suppliedHash)) {
    return recordChallengeMismatch(env, receipt, nowIso)
  }

  const checks: VerificationChecks = {
    challenge: { status: 'pass' },
  }
  const canonical = deps.requiredCanonicalOrigin(env)
  if (!canonical.ok) {
    checks.configuration = { status: 'fail', error: 'canonical_origin_unavailable' }
    return recordTransientFailure(
      env,
      receipt,
      nowIso,
      'canonical_origin_unavailable',
      checks,
    )
  }

  try {
    const oriented = await deps.buildOrient(
      env,
      receipt.agent_id,
      receipt.home_capability,
      mcpEndpoint(canonical.origin),
      true,
      now.getTime(),
    )
    if (!oriented.data || oriented.data.agent.id !== receipt.agent_id) {
      checks.orient = { status: 'fail', error: 'orient_failed' }
      return recordTransientFailure(env, receipt, nowIso, 'orient_failed', checks)
    }
    checks.orient = { status: 'pass' }
  } catch {
    checks.orient = { status: 'fail', error: 'orient_failed' }
    return recordTransientFailure(env, receipt, nowIso, 'orient_failed', checks)
  }

  const requestId = `agent-connection:${receipt.id}`
  let messageId: string
  try {
    const sent = await deps.sendAgentMessage(
      env,
      {
        fromAgent: receipt.agent_id,
        fromMember: receipt.member_id,
        toAgent: receipt.agent_id,
        body: LOOPBACK_BODY,
        kind: 'request',
        requestId,
      },
      {
        system: true,
        reason: 'agent connection verification self-loopback target is receipt-bound',
      },
    )
    if (!sent.ok) {
      checks.send = { status: 'fail', error: 'send_failed' }
      return recordTransientFailure(env, receipt, nowIso, 'send_failed', checks)
    }
    messageId = sent.id
    checks.send = { status: 'pass' }
  } catch {
    checks.send = { status: 'fail', error: 'send_failed' }
    return recordTransientFailure(env, receipt, nowIso, 'send_failed', checks)
  }

  try {
    const inbox = await deps.readAgentInbox(
      env,
      { agent: receipt.agent_id, peek: true, limit: 100 },
    )
    if (!inbox.ok) {
      checks.inbox_peek = { status: 'fail', error: 'inbox_failed' }
      return recordTransientFailure(env, receipt, nowIso, 'inbox_failed', checks)
    }
    const observed = inbox.messages.some((message) => (
      message.id === messageId
      && message.request_id === requestId
      && message.from_agent === receipt.agent_id
    ))
    if (!observed) {
      checks.inbox_peek = { status: 'fail', error: 'message_not_observed' }
      return recordTransientFailure(
        env,
        receipt,
        nowIso,
        'message_not_observed',
        checks,
      )
    }
    checks.inbox_peek = { status: 'pass' }
  } catch {
    checks.inbox_peek = { status: 'fail', error: 'inbox_failed' }
    return recordTransientFailure(env, receipt, nowIso, 'inbox_failed', checks)
  }

  try {
    const cleaned = await deps.deleteAgentConnectionMessage(env, {
      messageId,
      agentId: receipt.agent_id,
      requestId,
    })
    if (!cleaned.ok) {
      checks.cleanup = { status: 'fail', error: 'cleanup_failed' }
      return recordTransientFailure(env, receipt, nowIso, 'cleanup_failed', checks)
    }
    checks.cleanup = { status: 'pass' }
  } catch {
    checks.cleanup = { status: 'fail', error: 'cleanup_failed' }
    return recordTransientFailure(env, receipt, nowIso, 'cleanup_failed', checks)
  }

  return commitPass(
    env,
    receipt,
    nowIso,
    requestId,
    messageId,
    checks as Record<string, PassCheck>,
  )
}
