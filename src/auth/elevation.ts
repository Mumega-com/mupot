// mupot — the elevation ledger (SENSITIVE). Delivery Sequence step 3 (mupot
// task f5fe1222-981c-4fb8-95c2-1eacd38f3cee, mumega-com#1173): "Fix the
// ability that I can make agents admin by a safe way and time limited."
//
// Design: docs/superpowers/specs/2026-09-01-human-approved-session-bound-agent-
// elevation-design.md, "Elevation Data Model" / "Approval Flow" /
// "Authorization Semantics". Deviations from that doc are recorded at the
// top of migrations/0142_elevation_ledger.sql (no rank grants — action-only;
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
// Date.now()) — the same house rule migrations 0140/0141's modules follow.

import type { AuthContext, CapabilityGrant, CapabilityScopeType, Env } from '../types'
import { hasCapability, resolveCapabilities } from './capability'
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
  isValidElevationDuration,
} from './elevation-actions'
import { assertBatchWritten } from '../lib/receipt'

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
  approved_by_web_session_hash: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  revoke_reason: string | null
}

const REQUEST_COLUMNS = `id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
  requested_scope_type, requested_scope_id, requested_duration_minutes, reason, status,
  created_at, decision_expires_at, decided_at, decided_by_member_id, decided_by_web_session_hash, decision_note`

const GRANT_COLUMNS = `id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id,
  effect, approved_by_member_id, approved_by_web_session_hash, created_at, expires_at, revoked_at, revoke_reason`

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
  | { ok: false; reason: 'invalid_elevation_request'; detail: string }

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
  }
  if (!['org', 'department', 'squad'].includes(input.scopeType)) {
    return { ok: false, reason: 'invalid_elevation_request', detail: 'invalid scope_type' }
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
  /** The approver's OWN live capability grants — caller resolves these
   *  fresh (resolveCapabilities) immediately before calling; never accept a
   *  cached/stale set here. */
  decidedByCapabilities: CapabilityGrant[]
  decidedByWebSessionHash: string
  /** Whether the approver's web session proved a fresh (<=5min) reauth
   *  round-trip — required when any selected action is in
   *  SENSITIVE_STEP_UP_ACTIONS (design Approval Flow step 5). */
  recentReauthOk: boolean
  note?: string
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

  if (input.decision === 'deny') {
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

  const squadDepartmentId = await resolveScopeDepartmentId(env, scopeType, scopeId)
  if (!hasCapability(input.decidedByCapabilities, scopeType, scopeId || null, 'admin', squadDepartmentId)) {
    return { ok: false, reason: 'forbidden', need: 'admin', scope: { type: scopeType, id: scopeId } }
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
      `SELECT id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at
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
  const grants = await loadLiveElevationGrantsForSession(env, tenant, liveSession.id, nowMs)
  const match = grants.find((g) => {
    if (g.action !== action) return false
    if (g.scope_type === 'org') return true
    if (g.scope_type === scopeType && g.scope_id === normalizedScopeId) return true
    if (
      scopeType === 'squad' &&
      g.scope_type === 'department' &&
      opts.squadDepartmentId &&
      g.scope_id === opts.squadDepartmentId
    ) {
      return true
    }
    return false
  })
  if (!match) return { granted: false, reason: 'no_matching_grant' }

  // Re-derive the APPROVER's authority live — never trust that they still
  // hold what they granted just because the grant row exists.
  const approverCapabilities = await resolveCapabilities(env, match.approved_by_member_id)
  const approverDeptId =
    match.scope_type === 'squad' ? await resolveScopeDepartmentId(env, match.scope_type, match.scope_id) : null
  if (!hasCapability(approverCapabilities, match.scope_type, match.scope_id || null, 'admin', approverDeptId)) {
    return { granted: false, reason: 'approver_authority_lost' }
  }

  const approverSession = await loadWebSessionByHash(env, tenant, match.approved_by_web_session_hash)
  if (!approverSession || !evaluateWebSession(approverSession, nowMs).ok) {
    return { granted: false, reason: 'approver_session_ended' }
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
}

export function elevationRemedyMessage(reason: ElevatedActionDenyReason): string {
  return ELEVATION_DENY_REMEDY[reason]
}

export type { CapabilityScopeType, AgentAuthKind }
export { ELEVATION_ACTIONS }
