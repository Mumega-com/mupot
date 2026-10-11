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
//      so is a non-agent caller: the dashboard is the human's own door);
//   2. origin is well-formed, private-chat-shaped, fresh (parseHumanOrigin, shared);
//   3. the calling agent has an owner (agents.owner_member_id); the owner is active and ALREADY
//      bound to that exact chat (no first-bind here: binding is a lower-stakes act than an
//      elevation, and the stricter option costs one /account step);
//   4. the human's text names THIS request (full id or an 8+ hex prefix) AND carries exactly one
//      unnegated approve/deny word that matches the call's `decision` — "a claim in a message is
//      never authorization": the model cannot choose a decision the human did not utter;
//   5. the owner is not an agent's own member, is not the requester, and the calling agent is
//      not the requesting agent;
//   6. the owner holds ORG-scope admin by fresh capability rows (the legacy role plane is not
//      consulted: memberAuth forces role 'member' for origin-resolved humans, same as task_verdict);
//   7. per-member rate window; one decision per human message (reservation shared with task_verdict);
//   8. inside decideElevationRequest: scope authority, narrowing-only, action allowlist
//      (ORIGIN_DECIDABLE_ACTIONS — no step-up action ever), and ONE atomic batch.
//
// The request's `reason` is agent-authored text and is never an input to any conjunct here.

import type { AuthContext, Env, Member } from '../types'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { decideElevationRequest, loadElevationRequestById, type DecideElevationResult } from '../auth/elevation'
import { ORIGIN_DECIDABLE_ACTIONS } from '../auth/elevation-actions'
import { canonicalJsonDigest, sha256Hex } from '../lib/canonical-json'
import { claimTimestamp } from '../lib/claim-timestamp'
import { assertWritten } from '../lib/receipt'
import { parseHumanOrigin, taskNamedInText } from './origin-verdict'

const RATE_LIMIT_WINDOW_MS = 30 * 1000

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

// Exactly one decision word, unnegated. Deliberately blunt: anything that reads as hedged
// ("don't approve", "approve? no wait") is ambiguous and refused; the human re-sends plainly.
const APPROVE_RE = /\b(approve|approved)\b/
const DENY_RE = /\b(deny|denied|reject|rejected|decline|declined)\b/
const NEGATION_RE = /(\bnot\b|n't\b|\bnever\b|\bdont\b|\bno\b|\bwait\b|\bstop\b|\bcancel\b)/

export function decisionWordIn(text: string): 'approve' | 'deny' | 'ambiguous' | null {
  const t = text.toLowerCase()
  const a = APPROVE_RE.test(t)
  const d = DENY_RE.test(t)
  if (!a && !d) return null
  if (a && d) return 'ambiguous'
  if (NEGATION_RE.test(t)) return 'ambiguous'
  return a ? 'approve' : 'deny'
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
  const cutoff = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString()
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

  // (4) the human's own words: this request, and one plain decision word equal to the call's.
  if (!taskNamedInText(origin.text, request.id)) return refuse(403, 'request_not_named', 'the message must contain the request id (or its first 8+ hex characters)')
  const word = decisionWordIn(origin.text)
  if (word === null) return refuse(403, 'decision_word_missing', 'the message must say approve or deny')
  if (word === 'ambiguous') return refuse(403, 'decision_word_ambiguous', 'send one plain approve or deny, not both, and not negated')
  if (word !== input.decision) return refuse(403, 'decision_word_mismatch')

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
      chatId: origin.chat_id,
      userId: origin.user_id,
      messageId: origin.message_id,
      messageAt: origin.message_at,
      textHash,
      reservation: { updateId, digest, reservedAt: claimTimestamp() },
    },
  })

  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'forbidden' || result.reason === 'origin_action_not_permitted' ? 403 : 409
    return refuse(status, result.reason, 'detail' in result ? result.detail : undefined)
  }
  return { ok: true, result, memberId: owner.id }
}
