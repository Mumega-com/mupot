// mupot — the elevation ledger (SENSITIVE). Delivery Sequence step 3 (mupot
// task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173): "Fix the
// ability that I can make agents admin by a safe way and time limited."
//
// Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
// elevation-design.md, "Elevation Data Model" / "Approval Flow" /
// "Authorization Semantics". Deviations from that doc are recorded at the
// top of migrations/0148_elevation_ledger.sql (no rank grants — action-only;
// scope_type matches the real CapabilityScopeType enum; effect + usage log
// added).
//
// THE CENTRAL SAFETY PROPERTY (step-3 constraint 2): nothing in this module
// ever writes an elevation into `capabilities`, `gate_grants`, `memberships`,
// `agent_member_bindings`, or `project_squad_access` — the five tables
// `deactivate_agent` clears and that ordinary standing authority lives in.
// An elevation lives ONLY in elevation_grants, and hasElevatedAction() below
// is a LIVE re-derivation on every call: it re-checks the acting agent's own
// agent_sessions row, the grant's own expiry/revocation, the approving
// human's CURRENT live capabilities, and the approving web session's CURRENT
// liveness. Nothing is cached, nothing is materialized into a standing
// table. Expiry and revocation on ANY of those four therefore genuinely
// remove authority on the very next call — there is no artifact anywhere
// that "expiry forgot to touch."
//
// EVERY function that reads "now" takes it as an explicit parameter (default
// Date.now()) — the same house rule migrations 0144/0147's modules follow.

import type { D1PreparedStatement } from '@cloudflare/workers-types'
import type { AuthContext, CapabilityGrant, CapabilityScopeType, Env } from '../types'
import { hasCapability, hasCapabilityOnDynamicScope, isOrgAdmin, loadSquadScope, planeCoversScope, resolveCapabilities } from './capability'
import {
  type AgentAuthKind,
  evaluateAgentSession,
  loadAgentSessionById,
  loadLiveAgentSessionByCredential,
  resolveAgentSessionContext,
} from './agent-sessions'
import { evaluateWebSession, loadWebSessionByHash } from './web-sessions'
import {
  ELEVATION_ACTIONS,
  type ElevationActionEffect,
  SENSITIVE_STEP_UP_ACTIONS,
  elevationActionEffect,
  isKnownElevationAction,
  ORIGIN_DECIDABLE_ACTIONS,
  isRequestableElevationAction,
  isValidElevationDuration,
} from './elevation-actions'
import { assertBatchWritten } from '../lib/receipt'
import { completeTelegramUpdate } from '../im/telegram-receipts'

export const REQUEST_DECISION_WINDOW_MS = 10 * 60 * 1000 // 10 minutes — design v1 "user code" window

function isMissingTableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /no such table:\s*(elevation_requests|elevation_grants|elevation_usage_log)\b/i.test(message)
}

// ── shapes ───────────────────────────────────────────────────────────────

export type ElevationRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'revoked'

export interface ElevationRequestRecord {
  id: string
  tenant: string
  agent_session_id: string
  agent_id: string
  member_id: string
  requested_actions_json: string
  requested_scope_type: CapabilityScopeType
  requested_scope_id: string
  requested_duration_minutes: number
  reason: string
  status: ElevationRequestStatus
  created_at: string
  decision_expires_at: string
  decided_at: string | null
  decided_by_member_id: string | null
  decided_by_web_session_hash: string | null
  decision_note: string | null
  /** S13 (0210): 'agent_attested_origin' when decided over the harness-attested human origin channel. */
  decided_via: 'agent_attested_origin' | null
  decided_origin_receipt_id: string | null
}

export interface ElevationGrantRecord {
  id: string
  tenant: string
  elevation_request_id: string
  agent_session_id: string
  action: string
  scope_type: CapabilityScopeType
  scope_id: string
  effect: ElevationActionEffect
  approved_by_member_id: string
  /** NULL exactly when approved_via = 'agent_attested_origin' (0210 CHECK). */
  approved_by_web_session_hash: string | null
  created_at: string
  expires_at: string
  revoked_at: string | null
  revoke_reason: string | null
  approved_via: 'web_session' | 'agent_attested_origin'
  /** Set exactly when approved_via = 'agent_attested_origin'. */
  origin_receipt_id: string | null
}

const REQUEST_COLUMNS = `id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
  requested_scope_type, requested_scope_id, requested_duration_minutes, reason, status,
  created_at, decision_expires_at, decided_at, decided_by_member_id, decided_by_web_session_hash, decision_note,
  decided_via, decided_origin_receipt_id`

const GRANT_COLUMNS = `id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id,
  effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, revoked_at, revoke_reason,
  approved_via, origin_receipt_id`

// ── create request (agent-initiated) ────────────────────────────────────────

export interface CreateElevationRequestInput {
  tenant: string
  agentSessionId: string
  agentId: string
  memberId: string
  actions: string[]
  scopeType: CapabilityScopeType
  scopeId: string
  durationMinutes: number
  reason: string
}

export type CreateElevationRequestResult =
  | { ok: true; request: ElevationRequestRecord }
  | { ok: false; reason: 'invalid_elevation_request' | 'invalid_scope'; detail: string }

/**
 * createElevationRequest — the agent-facing half. Every identity field
 * (tenant/agentSessionId/agentId/memberId) must be SERVER-DERIVED by the
 * caller (src/mcp's request_elevation tool, via resolveAgentSessionContext)
 * — this function does not re-derive identity, it only validates and
 * persists the ask. `actions` must be a non-empty set of KNOWN 'action:*'
 * keys (see elevation-actions.ts) — never 'admin', never free text.
 */
export async function createElevationRequest(
  env: Env,
  input: CreateElevationRequestInput,
  nowMs: number = Date.now(),
): Promise<CreateElevationRequestResult> {
  const uniqueActions = Array.from(new Set(input.actions))
  if (uniqueActions.length === 0) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'at least one action required' }
  }
  for (const action of uniqueActions) {
    if (!isKnownElevationAction(action)) {
      return { ok: false, reason: 'invalid_elevation_request', detail: `unknown action "${action}"` }
    }
    // Refuse at REQUEST time, not silently at use time. An action nothing
    // consults would otherwise be approved by a human, rendered as a live grant
    // with a countdown, and authorize nothing — a promise the system cannot
    // keep. Server-side because the tool's enum is only the client's copy.
    if (!isRequestableElevationAction(action)) {
      return {
        ok: false,
        reason: 'invalid_elevation_request',
        detail: `"${action}" is defined but not yet enforced by any tool — it cannot be requested`,
      }
    }
  }
  if (!['org', 'department', 'squad'].includes(input.scopeType)) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'invalid scope_type' }
  }
  // Adversarial round 1 on G-FP1b (P0-1, Athena): action:home_access must
  // name ONE exact home squad — an org- or department-scoped request for it
  // would (per hasElevatedAction's own "an org grant covers every scope"
  // matcher rule) approve access to EVERY home, including ones created
  // later, the moment any ordinary org admin approves it. Refused at REQUEST
  // time so this can never even reach an approver.
  if (uniqueActions.includes('action:home_access') && input.scopeType !== 'squad') {
    return {
      ok: false,
      reason: 'invalid_elevation_request',
      detail: 'action:home_access must name an exact squad scope, never org or department',
    }
  }
  // mupot#1674: an unknown scope id is refused at REQUEST time. Otherwise a
  // human approves a grant naming a slug / typo / wrong-tenant id that can never
  // match a real scope — a silent no-op approval. Ids only (slugs are refused
  // with a hint, not resolved: the grant row must carry the canonical id the
  // matcher compares against). org scope carries no id.
  if (input.scopeType === 'department' || input.scopeType === 'squad') {
    const table = input.scopeType === 'department' ? 'departments' : 'squads'
    const exists = input.scopeId
      ? await env.DB.prepare(`SELECT 1 AS ok FROM ${table} WHERE id = ?1 LIMIT 1`).bind(input.scopeId).first()
      : null
    if (!exists) {
      return {
        ok: false,
        reason: 'invalid_scope',
        detail: `${input.scopeType} scope_id must be the id of an existing ${input.scopeType} (a slug is not accepted here)`,
      }
    }
  }
  if (!isValidElevationDuration(input.durationMinutes)) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'invalid duration_minutes' }
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'reason required' }
  }

  const id = crypto.randomUUID()
  const nowIso = new Date(nowMs).toISOString()
  const decisionExpiresAt = new Date(nowMs + REQUEST_DECISION_WINDOW_MS).toISOString()
  const scopeId = input.scopeId ?? ''

  await env.DB.prepare(
    `INSERT INTO elevation_requests
       (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
        requested_scope_type, requested_scope_id, requested_duration_minutes, reason,
        status, created_at, decision_expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12)`,
  )
    .bind(
      id,
      input.tenant,
      input.agentSessionId,
      input.agentId,
      input.memberId,
      JSON.stringify(uniqueActions),
      input.scopeType,
      scopeId,
      input.durationMinutes,
      input.reason.trim(),
      nowIso,
      decisionExpiresAt,
    )
    .run()

  return {
    ok: true,
    request: {
      id,
      tenant: input.tenant,
      agent_session_id: input.agentSessionId,
      agent_id: input.agentId,
      member_id: input.memberId,
      requested_actions_json: JSON.stringify(uniqueActions),
      requested_scope_type: input.scopeType,
      requested_scope_id: scopeId,
      requested_duration_minutes: input.durationMinutes,
      reason: input.reason.trim(),
      status: 'pending',
      created_at: nowIso,
      decision_expires_at: decisionExpiresAt,
      decided_at: null,
      decided_by_member_id: null,
      decided_by_web_session_hash: null,
      decision_note: null,
      decided_via: null,
      decided_origin_receipt_id: null,
    },
  }
}

// ── load / list ──────────────────────────────────────────────────────────

export async function loadElevationRequestById(
  env: Env,
  tenant: string,
  id: string,
): Promise<ElevationRequestRecord | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT ${REQUEST_COLUMNS} FROM elevation_requests WHERE id = ?1 AND tenant = ?2 LIMIT 1`,
    )
      .bind(id, tenant)
      .first<ElevationRequestRecord>()
    return row ?? null
  } catch (err) {
    if (isMissingTableError(err)) return null
    throw err
  }
}

/** expireStaleElevationRequests — best-effort maintenance: flip any
 *  'pending' row past its decision_expires_at to 'expired'. Idempotent, safe
 *  to call on every read path (list/decide) — a pending-request ceiling
 *  reader must never see a decision window that has silently lapsed as if
 *  it were still open. */
export async function expireStaleElevationRequests(
  env: Env,
  tenant: string,
  nowMs: number = Date.now(),
): Promise<{ expiredCount: number }> {
  try {
    const nowIso = new Date(nowMs).toISOString()
    const result = await env.DB.prepare(
      `UPDATE elevation_requests SET status = 'expired'
        WHERE tenant = ?1 AND status = 'pending' AND decision_expires_at <= ?2`,
    )
      .bind(tenant, nowIso)
      .run()
    return { expiredCount: Number(result.meta?.changes ?? 0) }
  } catch (err) {
    if (isMissingTableError(err)) return { expiredCount: 0 }
    throw err
  }
}

/** listPendingElevationRequests — every currently-pending request for the
 *  tenant, newest first. Callers (the dashboard route) further filter to
 *  what the operator has scope authority over — this function does not
 *  authorize, it only lists (Security Invariant 12: UI visibility follows
 *  effective authorization, checked by the caller against each row's
 *  requested_scope_type/requested_scope_id). */
export async function listPendingElevationRequests(
  env: Env,
  tenant: string,
  nowMs: number = Date.now(),
): Promise<ElevationRequestRecord[]> {
  await expireStaleElevationRequests(env, tenant, nowMs)
  try {
    const rows = await env.DB.prepare(
      `SELECT ${REQUEST_COLUMNS} FROM elevation_requests
        WHERE tenant = ?1 AND status = 'pending'
        ORDER BY created_at ASC`,
    )
      .bind(tenant)
      .all<ElevationRequestRecord>()
    return rows.results ?? []
  } catch (err) {
    if (isMissingTableError(err)) return []
    throw err
  }
}

// ── decide (human-only, single-decision, atomic) ────────────────────────────

export interface DecideElevationInput {
  tenant: string
  requestId: string
  decision: 'approve' | 'deny'
  /** REQUIRED for 'approve': a non-empty subset of the request's own
   *  requested_actions_json. Never validated as a superset — the approval
   *  page may only REDUCE the request (design invariant 4). */
  selectedActions?: string[]
  /** MVP restriction (documented, not in the design doc): scope cannot be
   *  narrowed independently of the action set in this pass — a caller MUST
   *  echo back the request's own requested_scope_type/requested_scope_id
   *  exactly, or the decision is rejected as invalid_elevation_request. A
   *  future pass may add scope narrowing (org→department→squad) once a
   *  general scope-hierarchy resolver exists; not adding one here rather
   *  than reimplementing hasCapability's inheritance ad hoc keeps the two
   *  from silently drifting apart. */
  scopeType?: CapabilityScopeType
  scopeId?: string
  /** Must be <= request.requested_duration_minutes and one of the presets. */
  durationMinutes?: number
  decidedByMemberId: string
  /** TRUE when the approver holds org authority on the LEGACY ROLE plane
   *  (auth.role 'owner'/'admin'). That plane is invisible to
   *  resolveCapabilities, which is pure SQL over `capabilities` — so the org
   *  owner, who characteristically has ZERO capability rows, resolves to []
   *  and is refused by the grant check below. The caller passes isOrgAdmin(auth)
   *  here so both authority planes reach this decision. Do NOT collapse this
   *  into decidedByCapabilities by synthesizing a grant row: assigning
   *  capabilities to a role-only owner is what DOWNGRADES them (see the
   *  bridge in src/auth/index.ts). */
  decidedByIsOrgAdmin?: boolean
  /** The approver's OWN live capability grants — caller resolves these
   *  fresh (resolveCapabilities) immediately before calling; never accept a
   *  cached/stale set here. */
  decidedByCapabilities: CapabilityGrant[]
  /** The approver's dashboard web session. REQUIRED (non-empty) on the dashboard path;
   *  MUST be null on the attested-origin path (see `attestedOrigin`). */
  decidedByWebSessionHash: string | null
  /** S13: set ONLY by the harness-attested human origin door (src/im/origin-elevation.ts).
   *  This is a strictly NARROWER door through the same function, never a relaxation:
   *    - approve is limited to ORIGIN_DECIDABLE_ACTIONS (no step-up action, ever);
   *    - the approver must hold ORG-scope admin (checked in SQL inside the decision batch);
   *    - the calling agent may not be the requesting agent;
   *    - the decision, the origin receipt, every grant and the audit row land in ONE
   *      D1 batch anchored on the request flip (no flip => nothing else lands).
   *  Absent => the dashboard path, which requires a real web session hash. */
  attestedOrigin?: AttestedOriginDecision
  /** Whether the approver's web session proved a fresh (<=5min) reauth
   *  round-trip — required when any selected action is in
   *  SENSITIVE_STEP_UP_ACTIONS (design Approval Flow step 5). */
  recentReauthOk: boolean
  note?: string
}

/** Everything the origin door proved BEFORE calling (read-only dry run) plus the
 *  reservation it wants committed with the decision. */
export interface AttestedOriginDecision {
  /** The agent that relayed the human's message (auth.boundAgentId). */
  callerAgentId: string
  chatId: string
  userId: string
  messageId: string
  messageAt: string
  textHash: string
  /** telegram_webhook_receipts reservation, written in the SAME batch as the decision. */
  reservation: { updateId: string; digest: string; reservedAt: string }
}

export type DecideElevationResult =
  | { ok: true; request: ElevationRequestRecord; grants: ElevationGrantRecord[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'already_decided'; status: ElevationRequestStatus }
  | { ok: false; reason: 'request_expired' }
  | { ok: false; reason: 'agent_session_ended' }
  | { ok: false; reason: 'invalid_elevation_request'; detail: string }
  | { ok: false; reason: 'forbidden'; need: 'admin'; scope: { type: CapabilityScopeType; id: string } }
  | { ok: false; reason: 'reauth_required' }
  // S13 origin door only:
  | { ok: false; reason: 'origin_replayed' }
  | { ok: false; reason: 'origin_action_not_permitted'; detail: string }
  | { ok: false; reason: 'origin_guard_failed' }

/** resolveScopeDepartmentId — squads inherit a department grant (mirrors
 *  hasCapability's own department→squad inheritance); org/department scope
 *  need no lookup. Exported (step 4, authorization convergence) so a tool
 *  wiring hasElevatedAction against a squad-scoped action can supply the
 *  same squadDepartmentId this module uses internally, without a second,
 *  possibly-drifting copy of the squads.department_id lookup. */
export async function resolveScopeDepartmentId(
  env: Env,
  scopeType: CapabilityScopeType,
  scopeId: string,
): Promise<string | null> {
  if (scopeType !== 'squad' || !scopeId) return null
  const row = await env.DB.prepare(`SELECT department_id FROM squads WHERE id = ?1 LIMIT 1`)
    .bind(scopeId)
    .first<{ department_id: string }>()
  return row?.department_id ?? null
}

/** decidedByOrgAdminCoversScope — G-FP1b point 2 (Athena, pre-merge completion
 *  delta on #1472): `decidedByIsOrgAdmin === true` is a deliberate exception
 *  in decideElevationRequest's authority check — it lets an org admin decide
 *  a home-scoped `action:home_access` REQUEST, the sanctioned "human decides,
 *  time-boxed, receipted" door (see the comment above decidedByHasAuthority).
 *  But that exception must NOT become the same org-admin-reaches-into-home
 *  hole this whole PR closes everywhere else: an org admin holding NOTHING
 *  on a member's home squad must not be able to approve OR deny a request
 *  scoped to it. Gated the same way every other org-plane bypass in this
 *  codebase is — planeCoversScope('org', scope), never conditional, never
 *  bypassed for org/department-scoped requests (planeCoversScope only has an
 *  opinion about a SQUAD scope, so those pass through unaffected — action:
 *  home_access itself can only ever be requested at squad scope, per the
 *  request-time refusal above, but this authority check runs for every
 *  elevation action/scope shape, not only home_access). An unknown/missing
 *  squad row fails closed (no authority), matching this codebase's other
 *  loaders. */
async function decidedByOrgAdminCoversScope(
  env: Env,
  decidedByIsOrgAdmin: boolean | undefined,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
): Promise<boolean> {
  if (decidedByIsOrgAdmin !== true) return false
  if (scopeType !== 'squad' || !scopeId) return true
  const scope = await loadSquadScope(env, scopeId)
  if (!scope) return false
  return planeCoversScope('org', scope)
}

/** decidedByHasElevationAuthority — the ONE authority predicate for deciding an
 *  elevation request on a scope: org-admin plane (home squads excluded via
 *  decidedByOrgAdminCoversScope) OR an admin capability grant on the scope.
 *  Takes the already-resolved org-admin boolean so decideElevationRequest
 *  (whose input carries `decidedByIsOrgAdmin`, not an AuthContext) and
 *  canDecideElevation below share one body and cannot drift. */
async function decidedByHasElevationAuthority(
  env: Env,
  decidedByIsOrgAdmin: boolean | undefined,
  capabilities: CapabilityGrant[],
  scopeType: CapabilityScopeType,
  scopeId: string | null,
): Promise<boolean> {
  return (
    (await decidedByOrgAdminCoversScope(env, decidedByIsOrgAdmin, scopeType, scopeId)) ||
    (await hasCapabilityOnDynamicScope(env, capabilities, scopeType, scopeId, 'admin'))
  )
}

/** canDecideElevation (#1673) — may this caller decide (approve/deny) an
 *  elevation request on this scope? Every list/visibility surface (API
 *  pending + active lists, dashboard list + "Outside your authority" panel,
 *  dashboard decision page) and the decide transaction itself go through this
 *  predicate, so "listed" and "decidable" are the same fact (Security
 *  Invariant 12: UI visibility follows effective authorization). */
export async function canDecideElevation(
  env: Env,
  auth: AuthContext | null | undefined,
  capabilities: CapabilityGrant[] | undefined,
  scopeType: CapabilityScopeType,
  scopeId: string | null | undefined,
): Promise<boolean> {
  return decidedByHasElevationAuthority(env, isOrgAdmin(auth), capabilities ?? [], scopeType, scopeId || null)
}

/**
 * decideElevationRequest — THE single-decision transaction. Security
 * Invariant 6 ("Approval is single-decision and atomic. Concurrent
 * Allow/Deny or double-Allow yields one terminal decision and one grant
 * set."): the status flip is one guarded UPDATE (`WHERE status = 'pending'`)
 * — SQLite serializes it, so at most one concurrent caller ever observes
 * `changes === 1`; every other concurrent/later caller sees 0 and returns
 * 'already_decided' WITHOUT inserting any grant. The grant-row insert is
 * one `.batch()` call, which is all-or-nothing (assertBatchWritten) — a
 * mid-batch D1 failure leaves the request 'approved' with zero grants
 * rather than a PARTIAL grant set (a detectable data-integrity gap, never a
 * silent extra authority).
 */
export async function decideElevationRequest(
  env: Env,
  input: DecideElevationInput,
  nowMs: number = Date.now(),
): Promise<DecideElevationResult> {
  await expireStaleElevationRequests(env, input.tenant, nowMs)

  const request = await loadElevationRequestById(env, input.tenant, input.requestId)
  if (!request) return { ok: false, reason: 'not_found' }
  // A pending row whose decision window already lapsed reads as
  // 'request_expired' even if the sweep above (or an earlier reader) already
  // flipped its stored status to 'expired' — that is a maintenance detail,
  // not a DIFFERENT terminal decision from "someone else decided it", which
  // is what 'already_decided' means.
  if (request.status === 'expired' || (request.status === 'pending' && nowMs >= Date.parse(request.decision_expires_at))) {
    return { ok: false, reason: 'request_expired' }
  }
  if (request.status !== 'pending') return { ok: false, reason: 'already_decided', status: request.status }

  const agentSession = await loadAgentSessionById(env, input.tenant, request.agent_session_id)
  if (!agentSession || !evaluateAgentSession(agentSession, nowMs).ok) {
    await env.DB.prepare(
      `UPDATE elevation_requests SET status = 'denied', decided_at = ?1, decision_note = 'agent_session_ended'
        WHERE id = ?2 AND tenant = ?3 AND status = 'pending'`,
    )
      .bind(new Date(nowMs).toISOString(), request.id, input.tenant)
      .run()
    return { ok: false, reason: 'agent_session_ended' }
  }

  const nowIso = new Date(nowMs).toISOString()

  // ── which door: exactly one approver anchor, never both, never neither ──
  const origin = input.attestedOrigin
  if (origin && input.decidedByWebSessionHash) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'an attested-origin decision carries no web session' }
  }
  if (!origin && !input.decidedByWebSessionHash) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'a dashboard decision requires a web session' }
  }

  // ── authority, checked BEFORE either terminal decision ────────────────
  //
  // Approve and deny are two writes to the SAME authority ledger, and this
  // check used to sit below the deny branch — so deny was reachable by any
  // member with a login who learned a request id (the requesting agent knows
  // its own). They could terminally kill any pending request and the ledger
  // recorded them as the decider: an unauthorized write to an audit surface.
  //
  // Authority is evaluated against the REQUEST's own scope. Approve may narrow
  // the action set, never the scope (enforced below), so the request's scope is
  // the scope of both decisions.
  // hasCapabilityOnDynamicScope (not hasCapability directly): the request's
  // scope_type is not known statically here, and — per G-FP1b — a squad-scope
  // check must load a real SquadScope (kind included) rather than a bare id +
  // a separately-resolved department id, so an approver's org/department/role
  // authority correctly answers false for a home squad. The org-admin flag
  // (`decidedByIsOrgAdmin`) is NOT an exception for home squads: it is gated by
  // planeCoversScope('org', scope) (decidedByOrgAdminCoversScope), so an org
  // admin with no grant on a member's home can neither approve nor deny a
  // request scoped to it — INCLUDING `action:home_access`. The only durable
  // approver for a home-scoped request is the home's own exact squad-scope
  // admin grant (tests/home-access-elevation.test.ts).
  const decidedByHasAuthority = await decidedByHasElevationAuthority(
    env,
    input.decidedByIsOrgAdmin,
    input.decidedByCapabilities,
    request.requested_scope_type as CapabilityScopeType,
    request.requested_scope_id || null,
  )
  if (!decidedByHasAuthority) {
    return {
      ok: false,
      reason: 'forbidden',
      need: 'admin',
      scope: { type: request.requested_scope_type as CapabilityScopeType, id: request.requested_scope_id },
    }
  }

  // A request is never its own approval. The requesting principal and the
  // deciding principal are the same KIND of row here — an agent's identity is a
  // members row, so "a human approved this" would otherwise degrade to "the
  // principal that asked, approved" wherever those coincide.
  if (input.decidedByMemberId === request.member_id) {
    return { ok: false, reason: 'forbidden', need: 'admin', scope: { type: request.requested_scope_type as CapabilityScopeType, id: request.requested_scope_id } }
  }

  // The relaying agent is never the requesting agent: a request is not approved by
  // the very principal that asked, even with a human's words in its mouth.
  if (origin && request.agent_id === origin.callerAgentId) {
    return { ok: false, reason: 'forbidden', need: 'admin', scope: { type: request.requested_scope_type as CapabilityScopeType, id: request.requested_scope_id } }
  }

  if (input.decision === 'deny') {
    if (origin) {
      return commitOriginDecision(env, request, input, origin, 'denied', [], request.requested_duration_minutes, nowMs)
    }
    const result = await env.DB.prepare(
      `UPDATE elevation_requests
          SET status = 'denied', decided_at = ?1, decided_by_member_id = ?2,
              decided_by_web_session_hash = ?3, decision_note = ?4
        WHERE id = ?5 AND tenant = ?6 AND status = 'pending'`,
    )
      .bind(nowIso, input.decidedByMemberId, input.decidedByWebSessionHash, input.note ?? null, request.id, input.tenant)
      .run()
    if (Number(result.meta?.changes ?? 0) === 0) return { ok: false, reason: 'already_decided', status: 'denied' }
    const updated = await loadElevationRequestById(env, input.tenant, request.id)
    return { ok: true, request: updated ?? { ...request, status: 'denied' }, grants: [] }
  }

  // ── approve ──────────────────────────────────────────────────────────
  const requested: string[] = JSON.parse(request.requested_actions_json)
  const selected = Array.from(new Set(input.selectedActions ?? []))
  if (selected.length === 0) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'at least one selected action required' }
  }
  for (const action of selected) {
    if (!requested.includes(action)) {
      return { ok: false, reason: 'invalid_elevation_request', detail: `"${action}" was not requested` }
    }
  }

  const scopeType = input.scopeType ?? request.requested_scope_type
  const scopeId = input.scopeId ?? request.requested_scope_id
  if (scopeType !== request.requested_scope_type || scopeId !== request.requested_scope_id) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'scope cannot be widened or changed, only the action set narrowed' }
  }

  const durationMinutes = input.durationMinutes ?? request.requested_duration_minutes
  if (!isValidElevationDuration(durationMinutes) || durationMinutes > request.requested_duration_minutes) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'invalid or widened duration_minutes' }
  }

  // scopeType/scopeId are already proven identical to the request's own scope
  // above, so this re-check is over the same scope the hoisted gate cleared. It
  // stays as defence in depth and must honour the SAME two planes, or an owner
  // clears the first gate and is refused by the second.
  if (!(await decidedByHasElevationAuthority(env, input.decidedByIsOrgAdmin, input.decidedByCapabilities, scopeType, scopeId || null))) {
    return { ok: false, reason: 'forbidden', need: 'admin', scope: { type: scopeType, id: scopeId } }
  }

  if (origin) {
    // The origin door can never approve a step-up action (a chat message cannot prove a
    // fresh reauth) and only the explicit narrow set. recentReauthOk is IGNORED here: a
    // caller-supplied boolean must not be able to widen this door.
    const refused = selected.filter((a) => !ORIGIN_DECIDABLE_ACTIONS.has(a) || SENSITIVE_STEP_UP_ACTIONS.has(a))
    if (refused.length > 0) {
      return { ok: false, reason: 'origin_action_not_permitted', detail: `dashboard-only: ${refused.join(', ')}` }
    }
    return commitOriginDecision(env, request, input, origin, 'approved', selected, durationMinutes, nowMs)
  }

  const needsStepUp = selected.some((a) => SENSITIVE_STEP_UP_ACTIONS.has(a))
  if (needsStepUp && !input.recentReauthOk) {
    return { ok: false, reason: 'reauth_required' }
  }

  const flip = await env.DB.prepare(
    `UPDATE elevation_requests
        SET status = 'approved', decided_at = ?1, decided_by_member_id = ?2,
            decided_by_web_session_hash = ?3, decision_note = ?4
      WHERE id = ?5 AND tenant = ?6 AND status = 'pending'`,
  )
    .bind(nowIso, input.decidedByMemberId, input.decidedByWebSessionHash, input.note ?? null, request.id, input.tenant)
    .run()
  if (Number(flip.meta?.changes ?? 0) === 0) return { ok: false, reason: 'already_decided', status: 'approved' }

  const expiresAt = new Date(nowMs + durationMinutes * 60 * 1000).toISOString()
  const grants: ElevationGrantRecord[] = selected.map((action) => ({
    id: crypto.randomUUID(),
    tenant: input.tenant,
    elevation_request_id: request.id,
    agent_session_id: request.agent_session_id,
    action,
    scope_type: scopeType,
    scope_id: scopeId,
    effect: elevationActionEffect(action) as ElevationActionEffect,
    approved_by_member_id: input.decidedByMemberId,
    approved_by_web_session_hash: input.decidedByWebSessionHash,
    created_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
    revoke_reason: null,
    approved_via: 'web_session' as const,
    origin_receipt_id: null,
  }))

  const batchResults = await env.DB.batch(
    grants.map((g) =>
      env.DB.prepare(
        `INSERT INTO elevation_grants
           (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
            approved_by_member_id, approved_by_web_session_hash, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        g.id,
        g.tenant,
        g.elevation_request_id,
        g.agent_session_id,
        g.action,
        g.scope_type,
        g.scope_id,
        g.effect,
        g.approved_by_member_id,
        g.approved_by_web_session_hash,
        g.created_at,
        g.expires_at,
      ),
    ),
  )
  assertBatchWritten(batchResults, 'elevation_grants.insert', 1)

  const updatedRequest = await loadElevationRequestById(env, input.tenant, request.id)
  return { ok: true, request: updatedRequest ?? { ...request, status: 'approved' }, grants }
}

/**
 * S13 — the origin door's write. ONE D1 batch, anchored on the request flip:
 *
 *   [0] reservation   INSERT telegram_webhook_receipts (one decision per human message,
 *                     shared key space with task_verdict's origin reservation)
 *   [1] THE ANCHOR    UPDATE elevation_requests ... WHERE <every guard, in SQL, at write time>
 *   [2] receipt       INSERT elevation_origin_receipts   ... WHERE the flip landed
 *   [3..] grants      INSERT elevation_grants            ... WHERE the flip landed (approve)
 *   [n] audit         INSERT mutation_audit_entries      ... WHERE the flip landed
 *
 * D1 batches roll back on a THROW, never on a 0-row statement, so nothing after [1] carries
 * its own guard set: each depends solely on "my flip row exists" (its fresh receipt id), the
 * same single-anchor discipline as origin-verdict.ts. No flip => no receipt, no grant, no audit.
 */
async function commitOriginDecision(
  env: Env,
  request: ElevationRequestRecord,
  input: DecideElevationInput,
  origin: AttestedOriginDecision,
  status: 'approved' | 'denied',
  selected: string[],
  durationMinutes: number,
  nowMs: number,
): Promise<DecideElevationResult> {
  const nowIso = new Date(nowMs).toISOString()
  const receiptId = crypto.randomUUID()
  const expiresAt = new Date(nowMs + durationMinutes * 60 * 1000).toISOString()
  const decisionWord = status === 'approved' ? 'approve' : 'deny'
  const note = input.note ?? null
  const landed = `EXISTS (SELECT 1 FROM elevation_requests WHERE id = ? AND tenant = ? AND decided_origin_receipt_id = ? AND status = ?)`
  const landedParams = [request.id, input.tenant, receiptId, status]

  const grants: ElevationGrantRecord[] = selected.map((action) => ({
    id: crypto.randomUUID(),
    tenant: input.tenant,
    elevation_request_id: request.id,
    agent_session_id: request.agent_session_id,
    action,
    scope_type: request.requested_scope_type,
    scope_id: request.requested_scope_id,
    effect: elevationActionEffect(action) as ElevationActionEffect, // selected were validated against the registry above
    approved_by_member_id: input.decidedByMemberId,
    approved_by_web_session_hash: null,
    created_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
    revoke_reason: null,
    approved_via: 'agent_attested_origin',
    origin_receipt_id: receiptId,
  }))

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
       VALUES (?, ?, ?, ?, 'processing', ?)
       ON CONFLICT (tenant, update_id) DO NOTHING`,
    ).bind(input.tenant, origin.reservation.updateId, origin.userId, origin.reservation.digest, origin.reservation.reservedAt),
    env.DB.prepare(
      `UPDATE elevation_requests
          SET status = ?, decided_at = ?, decided_by_member_id = ?, decided_by_web_session_hash = NULL,
              decision_note = ?, decided_via = 'agent_attested_origin', decided_origin_receipt_id = ?
        WHERE id = ? AND tenant = ? AND status = 'pending' AND decision_expires_at > ?
          AND agent_id <> ?
          AND EXISTS (SELECT 1 FROM telegram_webhook_receipts
                       WHERE tenant = ? AND update_id = ? AND created_at = ? AND request_digest = ? AND state = 'processing')
          AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND owner_member_id = ?)
          AND EXISTS (SELECT 1 FROM members WHERE id = ? AND tenant = ? AND status = 'active' AND telegram_chat_id = ?)
          AND EXISTS (SELECT 1 FROM capabilities
                       WHERE member_id = ? AND scope_type = 'org' AND capability IN ('admin', 'owner'))
          AND EXISTS (SELECT 1 FROM agent_sessions WHERE id = elevation_requests.agent_session_id AND revoked_at IS NULL)`,
    ).bind(
      status, nowIso, input.decidedByMemberId, note, receiptId,
      request.id, input.tenant, nowIso,
      origin.callerAgentId,
      input.tenant, origin.reservation.updateId, origin.reservation.reservedAt, origin.reservation.digest,
      origin.callerAgentId, input.decidedByMemberId,
      input.decidedByMemberId, input.tenant, origin.chatId,
      input.decidedByMemberId,
    ),
    env.DB.prepare(
      `INSERT INTO elevation_origin_receipts
         (id, tenant, elevation_request_id, member_id, agent_id, channel, chat_id, message_id, message_at, text_hash, decision, created_at)
       SELECT ?, ?, ?, ?, ?, 'telegram', ?, ?, ?, ?, ?, ?
        WHERE ${landed}`,
    ).bind(
      receiptId, input.tenant, request.id, input.decidedByMemberId, origin.callerAgentId,
      origin.chatId, origin.messageId, origin.messageAt, origin.textHash, decisionWord, nowIso,
      ...landedParams,
    ),
    ...grants.map((g) =>
      env.DB.prepare(
        `INSERT INTO elevation_grants
           (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
            approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, approved_via, origin_receipt_id)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'agent_attested_origin', ?
          WHERE ${landed}`,
      ).bind(
        g.id, g.tenant, g.elevation_request_id, g.agent_session_id, g.action, g.scope_type, g.scope_id, g.effect,
        g.approved_by_member_id, g.created_at, g.expires_at, receiptId,
        ...landedParams,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, agent_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       SELECT ?, ?, 'member', ?, ?, ?, 'mcp', 'elevation_decide', ?, 'elevation_request', ?, ?, ?, ?, ?
        WHERE ${landed}`,
    ).bind(
      crypto.randomUUID(), input.tenant, input.decidedByMemberId, input.decidedByMemberId, origin.callerAgentId,
      decisionWord, request.id, `elevation-decide:${request.id}`, `elevation-decide:${request.id}`,
      JSON.stringify({
        decision: decisionWord,
        via: 'agent_attested_origin',
        origin_receipt_id: receiptId,
        chat_id: origin.chatId,
        message_id: origin.messageId,
        requester_agent_id: request.agent_id,
        requester_session_id: request.agent_session_id,
        grants: grants.map((g) => ({ id: g.id, action: g.action, scope_type: g.scope_type, scope_id: g.scope_id, expires_at: g.expires_at })),
      }),
      nowIso,
      ...landedParams,
    ),
  ]

  const results = await env.DB.batch(statements)
  const changes = (i: number): number => Number(results[i]?.meta?.changes ?? 0)
  const identity = {
    update_id: origin.reservation.updateId,
    telegram_user_id: origin.userId,
    request_digest: origin.reservation.digest,
  }

  if (changes(0) !== 1) {
    // The reservation key was already occupied: this human message already spent its one
    // decision. The anchor required OUR reservation, so nothing else could have landed.
    return { ok: false, reason: 'origin_replayed' }
  }
  if (changes(1) !== 1) {
    // Reservation is ours but the anchor did not land: the message is spent (reservation
    // completed) and the call is refused. Distinguish a lost race from a lapsed guard.
    await completeTelegramUpdate(env, identity, JSON.stringify({ applied: false, kind: 'elevation' }))
    const fresh = await loadElevationRequestById(env, input.tenant, request.id)
    if (fresh && fresh.status !== 'pending') return { ok: false, reason: 'already_decided', status: fresh.status }
    return { ok: false, reason: 'origin_guard_failed' }
  }
  // The anchor landed => every dependent statement had the SAME single-row guard. Verify
  // loudly: a mismatch here is a bug that must never be reported as success.
  const expected = 1 + 1 + grants.length + 1
  const landedCount = changes(2) + grants.reduce((n, _g, i) => n + changes(3 + i), 0) + changes(statements.length - 1)
  if (landedCount !== expected - 1) {
    throw new Error('elevation origin decision: anchor landed but a dependent write did not')
  }
  await completeTelegramUpdate(env, identity, JSON.stringify({ applied: true, kind: 'elevation', request_id: request.id }))
  const updated = await loadElevationRequestById(env, input.tenant, request.id)
  return { ok: true, request: updated ?? { ...request, status }, grants }
}

// ── grants: evaluate / list / revoke ────────────────────────────────────────

export type ElevationGrantLoadResult =
  | { ok: true; grant: ElevationGrantRecord }
  | { ok: false; reason: 'revoked' | 'expired' }

export function evaluateElevationGrant(
  grant: ElevationGrantRecord,
  nowMs: number = Date.now(),
): ElevationGrantLoadResult {
  if (grant.revoked_at !== null) return { ok: false, reason: 'revoked' }
  if (nowMs >= Date.parse(grant.expires_at)) return { ok: false, reason: 'expired' }
  return { ok: true, grant }
}

export async function loadLiveElevationGrantsForSession(
  env: Env,
  tenant: string,
  agentSessionId: string,
  nowMs: number = Date.now(),
): Promise<ElevationGrantRecord[]> {
  try {
    const nowIso = new Date(nowMs).toISOString()
    const rows = await env.DB.prepare(
      `SELECT ${GRANT_COLUMNS} FROM elevation_grants
        WHERE tenant = ?1 AND agent_session_id = ?2 AND revoked_at IS NULL AND expires_at > ?3
        ORDER BY created_at DESC`,
    )
      .bind(tenant, agentSessionId, nowIso)
      .all<ElevationGrantRecord>()
    return rows.results ?? []
  } catch (err) {
    if (isMissingTableError(err)) return []
    throw err
  }
}

export async function listActiveElevationGrants(
  env: Env,
  tenant: string,
  nowMs: number = Date.now(),
): Promise<ElevationGrantRecord[]> {
  try {
    const nowIso = new Date(nowMs).toISOString()
    const rows = await env.DB.prepare(
      `SELECT ${GRANT_COLUMNS} FROM elevation_grants
        WHERE tenant = ?1 AND revoked_at IS NULL AND expires_at > ?2
        ORDER BY created_at DESC`,
    )
      .bind(tenant, nowIso)
      .all<ElevationGrantRecord>()
    return rows.results ?? []
  } catch (err) {
    if (isMissingTableError(err)) return []
    throw err
  }
}

export async function loadElevationGrantById(
  env: Env,
  tenant: string,
  id: string,
): Promise<ElevationGrantRecord | null> {
  try {
    const row = await env.DB.prepare(`SELECT ${GRANT_COLUMNS} FROM elevation_grants WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
      .bind(id, tenant)
      .first<ElevationGrantRecord>()
    return row ?? null
  } catch (err) {
    if (isMissingTableError(err)) return null
    throw err
  }
}

/** revokeElevationGrant — human or agent self-revoke; ownership scoping
 *  (who may call this for which grant) is the CALLER's job — mirrors
 *  revokeAgentSessionById's split of concerns. Idempotent. */
export async function revokeElevationGrant(
  env: Env,
  tenant: string,
  id: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<{ revoked: boolean }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE elevation_grants SET revoked_at = ?1, revoke_reason = ?2 WHERE id = ?3 AND tenant = ?4 AND revoked_at IS NULL`,
  )
    .bind(nowIso, reason, id, tenant)
    .run()
  return { revoked: Number(result.meta?.changes ?? 0) > 0 }
}

// ── usage log ────────────────────────────────────────────────────────────

export interface ElevationUsageLogRow {
  id: string
  tenant: string
  elevation_grant_id: string
  agent_session_id: string
  action: string
  tool_name: string | null
  detail_json: string | null
  occurred_at: string
  /** Two-phase receipt outcome (migration 0208). */
  status: 'pending' | 'applied' | 'failed'
  error_code: string | null
  resolved_at: string | null
}

/** Human label for a usage row: an attempt is shown as an action that occurred
 *  ONLY when status is 'applied'. */
export function elevationUsageOutcomeLabel(row: Pick<ElevationUsageLogRow, 'status' | 'error_code'>): string {
  if (row.status === 'applied') return 'Applied'
  if (row.status === 'failed') return row.error_code ? `Failed (${row.error_code})` : 'Failed'
  return 'Pending (not yet confirmed)'
}

/** recordElevationUsage — exported (step 4) so a tool that must record a
 *  SECOND, post-effect usage entry (e.g. mint_agent_token recording the
 *  actual minted token id once it exists, which the pre-mint authorization
 *  log entry cannot yet contain) can reuse the exact same write path rather
 *  than a second hand-rolled INSERT. Rule (step-4 task): "if the log write
 *  fails, the action must fail" — this function does NOT swallow write
 *  failures (only a missing-table error, same narrow-cast as every other
 *  reader/writer in this module); a caller that awaits this after a
 *  sensitive effect has already committed must let a thrown error surface
 *  as a failed tool result rather than silently reporting success with an
 *  incomplete audit trail. */
export async function recordElevationUsage(
  env: Env,
  tenant: string,
  grantId: string,
  agentSessionId: string,
  action: string,
  toolName: string | null,
  detail: unknown,
  nowMs: number,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
      .bind(
        crypto.randomUUID(),
        tenant,
        grantId,
        agentSessionId,
        action,
        toolName,
        detail === undefined ? null : JSON.stringify(detail),
        new Date(nowMs).toISOString(),
      )
      .run()
  } catch (err) {
    if (isMissingTableError(err)) return
    throw err
  }
}

export async function listElevationUsage(env: Env, tenant: string, grantId: string): Promise<ElevationUsageLogRow[]> {
  try {
    const rows = await env.DB.prepare(
      `SELECT id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at,
              status, error_code, resolved_at
         FROM elevation_usage_log WHERE tenant = ?1 AND elevation_grant_id = ?2 ORDER BY occurred_at ASC`,
    )
      .bind(tenant, grantId)
      .all<ElevationUsageLogRow>()
    return rows.results ?? []
  } catch (err) {
    if (isMissingTableError(err)) return []
    throw err
  }
}

// ── enforcement: the additive capability check ──────────────────────────────

export type ElevatedActionDenyReason =
  | 'not_agent_session'
  | 'no_live_session'
  | 'session_revoked'
  | 'session_expired_idle'
  | 'session_expired_absolute'
  | 'no_matching_grant'
  | 'approver_authority_lost'
  | 'approver_session_ended'
  | 'approver_origin_invalid'

export type HasElevatedActionResult =
  | { granted: true; grant: ElevationGrantRecord }
  | { granted: false; reason: ElevatedActionDenyReason }

export interface HasElevatedActionOptions {
  nowMs?: number
  /** department id when scopeType === 'squad' — mirrors hasCapability's own
   *  squadDepartmentId parameter for department→squad inheritance. */
  squadDepartmentId?: string | null
  /** Log this check as a usage event when it grants. Default true. Set
   *  false for a pure visibility check (e.g. rendering "you could do X")
   *  that must not itself count as having DONE anything. */
  recordUsage?: boolean
  toolName?: string
  detail?: unknown
}

/** S13 — USE-time re-verification of an origin-decided grant. Every conjunct re-derived
 *  from live rows; none cached from decision time:
 *    receipt exists, is an APPROVE, names this request and this approver (tenant-scoped);
 *    the request still reads approved-via-this-receipt;
 *    approver still active, still bound to the chat that spoke, still ORG admin (fresh caps);
 *    the relaying agent is still owned by the approver. */
async function originGrantStillValid(
  env: Env,
  tenant: string,
  grant: ElevationGrantRecord,
  approverCapabilities: CapabilityGrant[],
): Promise<boolean> {
  if (!grant.origin_receipt_id) return false
  if (!hasCapability(approverCapabilities, 'org', null, 'admin')) return false
  const row = await env.DB.prepare(
    `SELECT 1 AS ok
       FROM elevation_origin_receipts r
       JOIN elevation_requests q ON q.id = r.elevation_request_id AND q.tenant = r.tenant
       JOIN members m ON m.id = r.member_id AND m.tenant = r.tenant
       JOIN agents a ON a.id = r.agent_id
      WHERE r.id = ?1 AND r.tenant = ?2 AND r.decision = 'approve'
        AND r.elevation_request_id = ?3 AND r.member_id = ?4
        AND q.status = 'approved' AND q.decided_via = 'agent_attested_origin'
        AND q.decided_origin_receipt_id = r.id AND q.decided_by_member_id = r.member_id
        AND m.status = 'active' AND m.telegram_chat_id = r.chat_id
        AND a.owner_member_id = r.member_id
      LIMIT 1`,
  )
    .bind(grant.origin_receipt_id, tenant, grant.elevation_request_id, grant.approved_by_member_id)
    .first<{ ok: number }>()
  return row !== null
}

/**
 * hasElevatedAction — THE enforcement primitive (step-3 constraint 4):
 * "a capability check that consults live elevations for the acting session,
 * additively, and never widens standing capability." This function answers
 * ONLY the elevation half — a caller composes it with the ordinary
 * hasCapability(auth.capabilities, ...) standing check:
 *
 *   const allowed =
 *     hasCapability(auth.capabilities ?? [], scopeType, scopeId, min, squadDepartmentId) ||
 *     (await hasElevatedAction(env, auth, action, scopeType, scopeId, opts)).granted
 *
 * It NEVER widens standing capability by itself — a caller that ignores its
 * `false` result and grants anyway is the caller's bug, not this function's
 * — and it applies ONLY to a bound-agent session (`auth.boundAgentId` set);
 * a pure human/operator principal gets `not_agent_session` unconditionally,
 * because elevation is defined as "what may THIS agent session temporarily
 * do", never a channel for a human to grant themselves anything.
 *
 * Every check re-derives liveness from scratch: the acting agent's OWN
 * exact agent_sessions row (dead session ⇒ denied, which is how a rotated-
 * away session — constraint 6 — loses any elevation it carried), the
 * grant's own expiry/revocation, the APPROVING human's CURRENT live
 * capabilities (design invariant "approver authority loss" ends the grant
 * without any separate revoke call), and the approving web session's
 * CURRENT liveness (design invariant "approving web-session logout...
 * immediately ends grants approved by that web session" — again with no
 * separate cross-write into elevation_grants needed, because this function
 * never trusts a cached "was live at grant time" fact).
 */
export async function hasElevatedAction(
  env: Env,
  auth: AuthContext,
  action: string,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
  opts: HasElevatedActionOptions = {},
): Promise<HasElevatedActionResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const tenant = auth.tenant

  const sessionCtx = resolveAgentSessionContext(auth)
  if (!sessionCtx.ok) return { granted: false, reason: 'not_agent_session' }

  const liveSession = await loadLiveAgentSessionByCredential(
    env,
    tenant,
    sessionCtx.context.authKind,
    sessionCtx.context.credentialId,
  )
  if (!liveSession) return { granted: false, reason: 'no_live_session' }
  const sessionEval = evaluateAgentSession(liveSession, nowMs)
  if (!sessionEval.ok) {
    const reason =
      sessionEval.reason === 'expired_idle'
        ? 'session_expired_idle'
        : sessionEval.reason === 'expired_absolute'
          ? 'session_expired_absolute'
          : 'session_revoked'
    return { granted: false, reason }
  }

  const normalizedScopeId = scopeId ?? ''
  // Adversarial round 1 on G-FP1b (P0-1, Athena): the matcher's org/department
  // limbs are inheritance, exactly like hasCapability's — so they must be
  // gated by planeCoversScope the same way. Without this, an org-scope
  // elevation grant for ANY action would satisfy a check against a home
  // squad (the request-time refusal above stops action:home_access
  // specifically from ever being REQUESTED at org/department scope, but a
  // grant already on disk, or a future action with the same shape, must not
  // rely on that alone — defence in depth, dynamic import to avoid the
  // capability.ts <-> elevation.ts module cycle).
  const { loadSquadScope: loadSquadScopeForMatch, planeCoversScope: planeCoversScopeForMatch } = await import('./capability')
  const targetSquadScope = scopeType === 'squad' && scopeId ? await loadSquadScopeForMatch(env, scopeId) : null
  const inheritancePlaneCovers = (plane: 'org' | 'department'): boolean =>
    targetSquadScope ? planeCoversScopeForMatch(plane, targetSquadScope) : true

  // Fail closed: a squad-scope check against a squad that does not exist must
  // never be 'covered' by an org/department grant (inheritancePlaneCovers has no
  // scope to compare, so it would answer true) — and must refuse identically to
  // a covered-by-nothing squad, so existence is not an oracle.
  if (scopeType === 'squad' && scopeId && !targetSquadScope) return { granted: false, reason: 'no_matching_grant' }

  const grants = await loadLiveElevationGrantsForSession(env, tenant, liveSession.id, nowMs)
  const match = grants.find((g) => {
    if (g.action !== action) return false
    if (g.scope_type === 'org') return inheritancePlaneCovers('org')
    if (g.scope_type === scopeType && g.scope_id === normalizedScopeId) return true
    if (
      scopeType === 'squad' &&
      g.scope_type === 'department' &&
      opts.squadDepartmentId &&
      g.scope_id === opts.squadDepartmentId
    ) {
      return inheritancePlaneCovers('department')
    }
    return false
  })
  if (!match) return { granted: false, reason: 'no_matching_grant' }

  // Re-derive the APPROVER's authority live — never trust that they still
  // hold what they granted just because the grant row exists. For a
  // 'action:home_access' grant on a home squad, this means ONLY the home's
  // OWNER (the sole holder of an exact squad-scope grant there — org/
  // department/role planes are capability-dead on a home, G-FP1b point 2)
  // can durably remain the approver: an org admin's authority re-check fails
  // closed with `approver_authority_lost` here, by design.
  const approverCapabilities = await resolveCapabilities(env, match.approved_by_member_id)
  if (!(await hasCapabilityOnDynamicScope(env, approverCapabilities, match.scope_type, match.scope_id || null, 'admin'))) {
    return { granted: false, reason: 'approver_authority_lost' }
  }

  if (match.approved_via === 'agent_attested_origin') {
    // The grant has no web session. Its anchor is the append-only origin receipt, and
    // "pre-authorization ages": the WHOLE decision is re-verified at USE, not trusted
    // because the row exists.
    if (!(await originGrantStillValid(env, tenant, match, approverCapabilities))) {
      return { granted: false, reason: 'approver_origin_invalid' }
    }
  } else {
    if (!match.approved_by_web_session_hash) return { granted: false, reason: 'approver_session_ended' }
    const approverSession = await loadWebSessionByHash(env, tenant, match.approved_by_web_session_hash)
    if (!approverSession || !evaluateWebSession(approverSession, nowMs).ok) {
      return { granted: false, reason: 'approver_session_ended' }
    }
  }

  if (opts.recordUsage !== false) {
    await recordElevationUsage(
      env,
      tenant,
      match.id,
      liveSession.id,
      action,
      opts.toolName ?? null,
      opts.detail,
      nowMs,
    )
  }

  return { granted: true, grant: match }
}

// ── bound-agent collapse gate (step 4, authorization convergence) ──────────
//
// Several operator-gated tools (mint_agent_token, grant_agent_capability, …)
// refuse EVERY bound-agent caller with one uniform 403 BEFORE resolving
// anything about the request's target (design Security Invariant: "wrong
// tenant: not found, never a cross-tenant existence oracle" — the same
// asymmetry protects a stranger from using a sensitive tool's error shape to
// probe whether an agent/squad exists). Once a live elevation grant can
// substitute for that operator floor, the collapse must still hold for a
// bound session that holds ZERO live grants for the action in question — it
// must get the exact same unconditional refusal, with nothing about the
// call's arguments resolved. A session that DOES hold some live grant for
// the action is no longer a stranger to it (a human already vetted this
// exact agent session for this exact action) and may proceed to a
// scope-specific hasElevatedAction check, exactly as a standing-capability
// admin who lacks capability on THIS particular squad already does today.
//
// This is therefore a CHEAP EXISTENCE PROBE, not an authorization decision:
// it does not re-check approver authority/session liveness (hasElevatedAction
// does that once a caller has a specific scope to check) and it NEVER logs
// usage — a probe that may return false must never appear in
// elevation_usage_log as though something happened.
/** Shared by both probes below: the caller's own live agent_sessions row, or
 *  null for anything that is not a live bound-agent session. */
async function loadLiveSessionForBoundAgent(
  env: Env,
  auth: AuthContext,
  nowMs: number,
): Promise<Awaited<ReturnType<typeof loadLiveAgentSessionByCredential>>> {
  if (!auth.boundAgentId) return null
  const sessionCtx = resolveAgentSessionContext(auth)
  if (!sessionCtx.ok) return null
  const liveSession = await loadLiveAgentSessionByCredential(
    env,
    auth.tenant,
    sessionCtx.context.authKind,
    sessionCtx.context.credentialId,
  )
  if (!liveSession) return null
  if (!evaluateAgentSession(liveSession, nowMs).ok) return null
  return liveSession
}

export async function boundAgentHasAnyLiveGrantForAction(
  env: Env,
  auth: AuthContext,
  action: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const liveSession = await loadLiveSessionForBoundAgent(env, auth, nowMs)
  if (!liveSession) return false
  const grants = await loadLiveElevationGrantsForSession(env, auth.tenant, liveSession.id, nowMs)
  return grants.some((g) => g.action === action)
}

/**
 * boundAgentHasAnyLiveElevationGrant — the ACTION-AGNOSTIC sibling, used
 * ONLY by the MCP dispatcher's AAGATE capability floor (src/mcp/index.ts
 * invokeTool) as a narrowly tool-named allowlist bypass (step 4). AAGATE
 * rejects a caller BEFORE a tool's handler ever runs when the caller holds
 * no standing capability at `spec.min` on ANY scope — which means a
 * bound-agent session with ZERO standing capability never reaches a
 * handler's own precise hasElevatedAction check at all, no matter what it
 * is elevated for. This probe answers only "does this live session hold
 * SOME live elevation grant, for any action" — exactly as scope/action
 * -agnostic as the floor's own holdsCapabilityFloor — so a caller who
 * legitimately holds elevation for the WRONG action still reaches the
 * handler and gets a precise, auditable refusal there (hasElevatedAction),
 * rather than being turned away by the floor with no chance to explain
 * itself. It grants nothing by itself and never logs usage.
 */
export async function boundAgentHasAnyLiveElevationGrant(
  env: Env,
  auth: AuthContext,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const liveSession = await loadLiveSessionForBoundAgent(env, auth, nowMs)
  if (!liveSession) return false
  const grants = await loadLiveElevationGrantsForSession(env, auth.tenant, liveSession.id, nowMs)
  return grants.length > 0
}

/** elevationRemedyMessage — a refusal must name the remedy (step-4 task rule
 *  "FAIL CLOSED, EXPLAIN OPENLY"). One canonical human-readable string per
 *  HasElevatedActionResult deny reason, reused by every wired tool so the
 *  wording cannot drift per call site. */
const ELEVATION_DENY_REMEDY: Record<ElevatedActionDenyReason, string> = {
  not_agent_session: 'elevation applies only to an authenticated bound agent session; a human/operator principal cannot use it to grant itself anything',
  no_live_session: 'this agent session is not currently live — check_in or re-authenticate, then request a fresh elevation',
  session_revoked: 'this agent session was revoked — any elevation bound to it ended the instant rotation/revocation completed',
  session_expired_idle: 'this agent session expired from inactivity — re-authenticate and request a fresh elevation',
  session_expired_absolute: 'this agent session reached its absolute lifetime — re-authenticate and request a fresh elevation',
  no_matching_grant: 'no live elevation grant covers this action and scope for this exact session — ask an org/department/squad admin to approve request_elevation for it',
  approver_authority_lost: 'the human who approved this grant no longer holds the required capability on this scope — ask a current admin to approve a fresh elevation',
  approver_session_ended: 'the human who approved this grant is no longer signed in — ask a current admin to approve a fresh elevation',
  approver_origin_invalid: 'the chat approval behind this grant no longer verifies (approver, chat binding, org-admin standing or agent ownership changed) — ask a current admin to approve a fresh elevation',
}

/** Tools that consult an elevation action, and the action key each consults.
 *  Text-only: used to name the door in a plain `need=<cap>` refusal. It grants
 *  nothing and is not consulted by any authorization decision. */
const ELEVATION_ACTION_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  project_create: 'action:workspace_project',
  grant_agent_capability: 'action:manage_access',
  mint_agent_token: 'action:mint_token',
  create_squad: 'action:project_lifecycle',
  routine_enable: 'action:routine_policy',
  routine_pause: 'action:routine_policy',
  routine_archive: 'action:routine_archive',
  routine_update: 'action:routine_policy',
  project_update: 'action:project_status',
  unarchive_row: 'action:project_status',
})

/** elevationHint — the refusal hint naming request_elevation + the action key
 *  for a tool that has an elevation door, or undefined for one that has none. */
export function elevationHint(toolName: string): string | undefined {
  const action = ELEVATION_ACTION_BY_TOOL[toolName]
  if (!action) return undefined
  return `an admin can approve a time-boxed elevation instead: call request_elevation with actions ["${action}"]`
}

export function elevationRemedyMessage(reason: ElevatedActionDenyReason): string {
  return ELEVATION_DENY_REMEDY[reason]
}

export type { CapabilityScopeType, AgentAuthKind }
export { ELEVATION_ACTIONS }
