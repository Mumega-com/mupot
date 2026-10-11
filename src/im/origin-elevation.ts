// mupot S13 — a human decides an agent's ELEVATION request without the dashboard, through
// the harness-attested human origin channel (the same trust model as task_verdict's
// human_origin, mupot#1424/#1425: see src/im/origin-verdict.ts for the full model and the
// fix-round history this module deliberately inherits rather than re-derives).
//
// One call, two authorities: the calling agent RELAYS; the decision is written AS the human
// who owns that agent, and only if every conjunct below holds. This module is the read-only
// dry run + the audit of refusals. THE WRITE and the authority predicate live in
// decideElevationRequest (src/auth/elevation.ts) — the same function the dashboard calls —
// reached through its `attestedOrigin` door, which is strictly narrower than the dashboard's.
//
// Conjuncts (all re-checked per call, none cached):
//   1. caller is agent-bound, and a human_origin is supplied (an agent without one is refused;
//      so is a non-agent caller: the dashboard is the human's own door); AND the calling TOKEN's
//      own row names a stamping harness (STAMPING_HARNESS_TOKEN_LABELS): the server cannot tell a
//      stamped origin from a model-typed one, so a credential that is not a stamping harness may
//      not supply one at all (origin_harness_not_stamping);
//   2. origin is well-formed, private-chat-shaped, fresh (parseHumanOrigin, shared);
//   3. the calling agent has an owner (agents.owner_member_id); the owner is active and ALREADY
//      bound to that exact chat (no first-bind here: binding is a lower-stakes act than an
//      elevation, and the stricter option costs one /account step);
//   4. the human's text is EXACTLY `approve|deny <request id or 8+ hex prefix>` (after NFKC, trim,
//      whitespace collapse, lowercase; one optional trailing period) and the word equals the
//      call's `decision`. An allow-shape, not a deny-list of hedges: "don't approve X", "approve X
//      only if CI passes", "nope, approve X" are all refused decision_text_not_exact;
//   5. the owner is not an agent's own member, is not the requester, and the calling agent is
//      not the requesting agent;
//   6. the owner holds ORG-scope admin by fresh capability rows (the legacy role plane is not
//      consulted: memberAuth forces role 'member' for origin-resolved humans, same as task_verdict);
//   7. per-member rate window (re-asserted as a NOT EXISTS in the commit batch's anchor: the JS
//      read here is only for a friendly 429); one decision per human message (reservation shared
//      with task_verdict);
//   8. inside decideElevationRequest: scope authority, narrowing-only, action allowlist
//      (ORIGIN_DECIDABLE_ACTIONS — no step-up action ever), and ONE atomic batch.
//
// The request's `reason` is agent-authored text and is never an input to any conjunct here.

import type { AuthContext, Env, Member } from '../types'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { decideElevationRequest, loadElevationRequestById, type DecideElevationResult } from '../auth/elevation'
import { ORIGIN_DECIDABLE_ACTIONS, ORIGIN_DECISION_RATE_WINDOW_MS } from '../auth/elevation-actions'
import { stampingBinds, stampingTokenExistsSql } from '../auth/stamping-harness'
import { nowSqlUtc } from '../auth/token-lifecycle'
import { canonicalJsonDigest, sha256Hex } from '../lib/canonical-json'
import { claimTimestamp } from '../lib/claim-timestamp'
import { assertWritten } from '../lib/receipt'
import { parseHumanOrigin, taskNamedInText } from './origin-verdict'

type OriginRefusalStatus = 403 | 404 | 409 | 429

export interface OriginElevationInput {
  requestId: string
  decision: 'approve' | 'deny'
  /** approve only: a NON-EMPTY subset of the requested actions. Undefined = all requested. */
  actions: string[] | undefined
  note: string
  humanOrigin: unknown
}

export type OriginElevationOutcome =
  | { ok: true; result: Extract<DecideElevationResult, { ok: true }>; memberId: string }
  | { ok: false; status: OriginRefusalStatus; error: string; detail?: string }

// The ONLY accepted message shape. Allow-list, not a hedge deny-list: any extra word ("only if",
// "actually", "nope,", "I cannot"), any punctuation inside, any other language reads as "not exact"
// and is refused; the human re-sends the plain two-word message. Typed on a phone: `approve 1a2b3c4d`.
const EXACT_DECISION_RE = /^(approve|deny) ([0-9a-f]{8,32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.?$/

export interface ExactDecision {
  decision: 'approve' | 'deny'
  /** The id token the human typed (prefix or full uuid), already normalised. */
  ref: string
}

/** NFKC + trim + whitespace-collapse + lowercase, then the exact shape; null otherwise. NFKC folds
 *  compatibility forms (fullwidth letters) to ASCII, so those read as the plain word. Visually
 *  similar letters from other scripts (Cyrillic а) do NOT fold and are refused. */
export function parseExactDecisionText(text: string): ExactDecision | null {
  const t = text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
  const m = EXACT_DECISION_RE.exec(t)
  if (!m) return null
  return { decision: m[1] === 'approve' ? 'approve' : 'deny', ref: m[2] }
}

/** Does the CALLING token's own row (server-written at mint, re-read live here) name a stamping
 *  harness? Never reads anything the caller passed in this call. */
export async function callerTokenIsStampingHarness(env: Env, auth: AuthContext): Promise<boolean> {
  if (!auth.tokenId || !auth.boundAgentId) return false
  const row = await env.DB.prepare(`SELECT ${stampingTokenExistsSql(true)} AS ok`)
    .bind(...stampingBinds(env.TENANT_SLUG, auth.boundAgentId, auth.tokenId, nowSqlUtc()))
    .first<{ ok: number }>()
  return row?.ok === 1
}

/** Audit a refusal. Floor refusals are decisions the ledger must remember too (an agent that
 *  keeps trying to self-approve is a signal). A failed audit write fails the call loudly. */
async function auditRefusal(
  env: Env,
  auth: AuthContext,
  memberId: string | null,
  requestId: string,
  reason: string,
  decision: string,
): Promise<void> {
  const id = crypto.randomUUID()
  const principalIsAgent = Boolean(auth.boundAgentId)
  const principalId = principalIsAgent ? (auth.boundAgentId as string) : (auth.memberId ?? auth.userId ?? 'unknown') // boundAgentId proven set by principalIsAgent
  const res = await env.DB.prepare(
    `INSERT INTO mutation_audit_entries (
       id, tenant, principal_kind, principal_id, member_id, agent_id, credential_id, origin, handler, operation,
       target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'mcp', 'elevation_decide', ?8, 'elevation_request', ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      id,
      auth.tenant,
      principalIsAgent ? 'agent' : 'member',
      principalId,
      memberId ?? (principalIsAgent ? null : (auth.memberId ?? null)),
      auth.boundAgentId ?? null,
      auth.tokenId ?? null,
      `refused:${reason}`.slice(0, 250),
      requestId.trim().slice(0, 120) || 'unknown',
      id,
      id,
      JSON.stringify({ decision, reason, via: 'agent_attested_origin' }),
      new Date().toISOString(),
    )
    .run()
  assertWritten(res, 'mutation_audit_entries.elevation_decide_refusal')
}

async function recentOriginDecisionExists(env: Env, memberId: string, nowMs: number): Promise<boolean> {
  const cutoff = new Date(nowMs - ORIGIN_DECISION_RATE_WINDOW_MS).toISOString()
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM elevation_origin_receipts WHERE member_id = ?1 AND created_at > ?2 LIMIT 1`,
  )
    .bind(memberId, cutoff)
    .first<{ x: number }>()
  return row !== null
}

export async function decideElevationViaOrigin(
  env: Env,
  auth: AuthContext,
  input: OriginElevationInput,
): Promise<OriginElevationOutcome> {
  let ownerId: string | null = null
  const refuse = async (status: OriginRefusalStatus, error: string, detail?: string): Promise<OriginElevationOutcome> => {
    await auditRefusal(env, auth, ownerId, input.requestId, error, input.decision)
    return { ok: false, status, error, ...(detail ? { detail } : {}) }
  }

  // (1) shape of the caller.
  if (!auth.boundAgentId) {
    return refuse(403, 'agent_bound_required', 'elevation_decide runs only through a human\'s own agent carrying a harness-stamped human_origin; decide on the dashboard otherwise')
  }
  const callerAgentId = auth.boundAgentId
  if (input.humanOrigin === undefined) {
    return refuse(403, 'human_origin_required', 'an agent cannot decide an elevation request on its own authority')
  }

  // (1b) the credential must be a stamping harness. Without this the server cannot tell a harness
  // stamp from an origin the model typed. Refuses BEFORE the origin is even parsed.
  if (!(await callerTokenIsStampingHarness(env, auth))) {
    return refuse(403, 'origin_harness_not_stamping', 'this credential is not a human-origin stamping harness (see docs/architecture/elevation-decide-over-human-origin.md); decide on the dashboard')
  }

  // (2) origin shape + freshness.
  const parsed = parseHumanOrigin(input.humanOrigin)
  if (!parsed.ok) return refuse(403, parsed.reason)
  const origin = parsed.value

  // (3) owner.
  const agentRow = await env.DB.prepare('SELECT owner_member_id FROM agents WHERE id = ?1').bind(callerAgentId).first<{ owner_member_id: string | null }>()
  if (!agentRow?.owner_member_id) return refuse(403, 'agent_not_owned')
  ownerId = agentRow.owner_member_id
  const owner = await env.DB.prepare(
    `SELECT id, email, display_name, telegram_chat_id, status, created_at FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
  ).bind(ownerId, env.TENANT_SLUG).first<Member>()
  if (!owner || owner.status !== 'active') return refuse(403, 'member_inactive')
  if (owner.telegram_chat_id === null) return refuse(403, 'member_chat_unbound', 'bind your Telegram on /account first; elevation decisions never first-bind')
  if (owner.telegram_chat_id !== origin.chat_id) return refuse(403, 'origin_member_mismatch')
  const agentOwned = await env.DB.prepare(`SELECT 1 AS x FROM agent_member_bindings WHERE tenant = ?1 AND member_id = ?2 LIMIT 1`)
    .bind(env.TENANT_SLUG, owner.id).first<{ x: number }>()
  if (agentOwned) return refuse(403, 'owner_is_an_agent_identity')

  // The request. Unknown and not-decidable read alike below (no existence oracle).
  const request = await loadElevationRequestById(env, env.TENANT_SLUG, input.requestId)
  if (!request) return refuse(404, 'not_found')

  // (4) the human's own words: EXACTLY `approve|deny <this request's id or 8+ hex prefix>`.
  const exact = parseExactDecisionText(origin.text)
  if (exact === null) return refuse(403, 'decision_text_not_exact', 'the message must be exactly "approve <request id>" or "deny <request id>" (the id, or its first 8+ hex characters), nothing else')
  if (!taskNamedInText(exact.ref, request.id)) return refuse(403, 'request_not_named', 'the message must contain this request\'s id (or its first 8+ hex characters)')
  if (exact.decision !== input.decision) return refuse(403, 'decision_word_mismatch')

  // (5) parties.
  if (request.agent_id === callerAgentId || request.member_id === owner.id) {
    return refuse(403, 'requester_cannot_decide')
  }

  // (6) fresh ORG-admin standing (capability rows only).
  const capabilities = await resolveCapabilities(env, owner.id)
  if (!hasCapability(capabilities, 'org', null, 'admin')) return refuse(403, 'not_org_admin')

  // (7) rate window.
  if (await recentOriginDecisionExists(env, owner.id, Date.now())) return refuse(429, 'origin_rate_limited')

  // (8) approve selection. Sensitive / non-allowlisted actions are refused HERE with a useful
  // message, and again inside decideElevationRequest (the real, non-bypassable check).
  let selected: string[] | undefined
  if (input.decision === 'approve') {
    const requested: string[] = JSON.parse(request.requested_actions_json)
    selected = input.actions && input.actions.length > 0 ? input.actions : requested
    const blocked = selected.filter((a) => !ORIGIN_DECIDABLE_ACTIONS.has(a))
    if (blocked.length > 0) {
      return refuse(403, 'origin_action_not_permitted', `dashboard-only: ${blocked.join(', ')}. Approve the rest by narrowing "actions", or use the dashboard.`)
    }
  }

  const textHash = await sha256Hex(origin.text)
  const updateId = `origin:telegram:${origin.chat_id}:${origin.message_id}`
  const digest = await canonicalJsonDigest({
    kind: 'elevation_decide',
    chat_id: origin.chat_id,
    user_id: origin.user_id,
    message_id: origin.message_id,
    request_id: request.id,
    decision: input.decision,
    text_hash: textHash,
  })

  const result = await decideElevationRequest(env, {
    tenant: env.TENANT_SLUG,
    requestId: request.id,
    decision: input.decision,
    selectedActions: selected,
    decidedByMemberId: owner.id,
    decidedByCapabilities: capabilities,
    decidedByIsOrgAdmin: false,
    decidedByWebSessionHash: null,
    recentReauthOk: false,
    note: input.note ? `[via chat] ${input.note}` : '[via chat]',
    attestedOrigin: {
      callerAgentId,
      callerTokenId: auth.tokenId ?? '',
      chatId: origin.chat_id,
      userId: origin.user_id,
      messageId: origin.message_id,
      messageAt: origin.message_at,
      textHash,
      reservation: { updateId, digest, reservedAt: claimTimestamp() },
    },
  })

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'origin_rate_limited' ? 429 : result.reason === 'forbidden' || result.reason === 'origin_action_not_permitted' ? 403 : 409
    return refuse(status, result.reason, 'detail' in result ? result.detail : undefined)
  }
  return { ok: true, result, memberId: owner.id }
}
