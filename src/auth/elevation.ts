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

import { attachDesignatedClause, ADMISSION_BOUND_TO_SEAT_SQL } from '../members/attach-designated'
import type { AuthContext, CapabilityGrant, CapabilityScopeType, Env } from '../types'
import { capabilityRank, hasCapabilityOnDynamicScope, humanVerifiedLegacyRoleRank, isOrgAdmin, loadSquadScope, planeCoversScope, resolveCapabilities } from './capability'
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
  OWNER_SUDO_MAX_MINUTES,
  isOwnerSudoAction,
  type ElevationActionEffect,
  SENSITIVE_STEP_UP_ACTIONS,
  elevationActionEffect,
  isKnownElevationAction,
  isRequestableElevationAction,
  isValidElevationDuration,
} from './elevation-actions'
import { installerRequestRefusal, installerWindowEnabled, isInstallerAction } from '../operators/installer-tiers'
import { attachedAuthority, isAttachedSudoAction } from './attached-ceiling'
import { canonicalizeSudoArgs, ownerSudoEnabled, type SudoActionKey } from './owner-sudo-args'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from './token-lifecycle'

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

/** AMR values that prove a passkey / hardware-key class login. ACCESS_REQUIRED_AMR must name ONLY these for action:install_high. */
const PASSKEY_CLASS_AMR: ReadonlySet<string> = new Set(['hwk', 'swk', 'webauthn'])

/** True when ACCESS_REQUIRED_AMR is non-empty and every value is passkey-class (config.ts reads the same list): one weaker value
 *  (e.g. pwd) would let any fresh Access login satisfy "passkey only". */
function accessAmrConfigured(env: Env): boolean {
  const vals = (env.ACCESS_REQUIRED_AMR ?? '').split(',').map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0)
  return vals.length > 0 && vals.every((v) => PASSKEY_CLASS_AMR.has(v))
}

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
  /** Owner sudo: the ONE call being authorised (mandatory for every action:sudo_*; see owner-sudo-args.ts). */
  sudoArgs?: unknown
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
  // Owner sudo: ONE act per request (the human approves exactly what the message names), org or squad scope (a department grant
  // would read as "every squad in it"), short, flag-gated, and argument-bound. Refused at REQUEST time so nothing un-approvable
  // reaches a human.
  let sudoCanonical: Awaited<ReturnType<typeof canonicalizeSudoArgs>> | null = null
  if (uniqueActions.some(isOwnerSudoAction)) {
    if (!ownerSudoEnabled(env)) {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'owner sudo is not enabled on this pot' }
    }
    if (uniqueActions.length !== 1) {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'an owner-sudo action must be requested alone' }
    }
    if (input.scopeType === 'department') {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'an owner-sudo action takes org or squad scope, not department' }
    }
    if (input.durationMinutes > OWNER_SUDO_MAX_MINUTES) {
      return { ok: false, reason: 'invalid_elevation_request', detail: `an owner-sudo action lasts at most ${OWNER_SUDO_MAX_MINUTES} minutes` }
    }
    if (uniqueActions[0] === 'action:sudo_grant_gate_capability' && input.scopeType !== 'org') {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'action:sudo_grant_gate_capability is org scope' }
    }
    // The exact call: mandatory, resolved, fenced, canonicalised. The same canonicaliser judges the call at use time.
    sudoCanonical = await canonicalizeSudoArgs(env, uniqueActions[0] as SudoActionKey, input.sudoArgs, { agentId: input.agentId, memberId: input.memberId })
    if (!sudoCanonical.ok) {
      return { ok: false, reason: 'invalid_elevation_request', detail: `${sudoCanonical.error}: ${sudoCanonical.detail}` }
    }
    // A squad-scope approval is for THAT squad: a grant on another squad could never be used, so it is not asked for.
    if (input.scopeType === 'squad' && sudoCanonical.value.squadId !== null && sudoCanonical.value.squadId !== input.scopeId) {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'scope_id must be the squad the call touches' }
    }
  }
  // Installer window (design S1): flag-gated, requested alone, tier-specific durations. Skipped entirely for any other action.
  if (uniqueActions.some(isInstallerAction)) {
    if (!installerWindowEnabled(env)) {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'the installer window is not enabled on this pot' }
    }
    const installRefusal = installerRequestRefusal(uniqueActions, input.durationMinutes)
    if (installRefusal) return { ok: false, reason: 'invalid_elevation_request', detail: installRefusal }
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
  // Installer window: a window on a HOME squad/department could authorise nothing (home targets are never grantable), so it is
  // refused before a human spends an approval on it.
  if (uniqueActions.some(isInstallerAction) && (input.scopeType === 'department' || input.scopeType === 'squad')) {
    const table = input.scopeType === 'department' ? 'departments' : 'squads'
    const kind = await env.DB.prepare(`SELECT kind FROM ${table} WHERE id = ?1 LIMIT 1`).bind(input.scopeId).first<{ kind: string }>()
    if (kind?.kind === 'home') {
      return { ok: false, reason: 'invalid_scope', detail: 'an installer window cannot be scoped to a home squad or home department' }
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

  // The exact sudo arguments and their digest are part of the SAME insert: a request row that names a sudo act exists only together with
  // the arguments the human is shown and the call is checked against. A second statement could fail and leave an approvable request
  // with no arguments bound to it (#2106).
  const sudoCols = sudoCanonical?.ok ? ', sudo_args_json, sudo_args_sha256' : ''
  const sudoVals = sudoCanonical?.ok ? ', ?13, ?14' : ''
  await env.DB.prepare(
    `INSERT INTO elevation_requests
       (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
        requested_scope_type, requested_scope_id, requested_duration_minutes, reason,
        status, created_at, decision_expires_at${sudoCols})
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?12${sudoVals})`,
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
      ...(sudoCanonical?.ok ? [sudoCanonical.value.json, sudoCanonical.value.sha256] : []),
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
  decidedByWebSessionHash: string
  /** TRUE = the decision row is written only while `decidedByWebSessionHash` is STILL a live session on a still-live login identity,
   *  checked inside the very UPDATE that records the decision (#2106). Without it, an identity revoked (and its sessions swept) between
   *  the caller's checks and this write would still land an approved/denied row. Leave unset only for callers whose hash is not a real
   *  web session (tests that exercise the ledger alone). */
  requireLiveApproverSession?: boolean
  /** Whether the approver's web session proved a fresh (within RECENT_REAUTH_WINDOW_MS) reauth
   *  round-trip — required when any selected action is in
   *  SENSITIVE_STEP_UP_ACTIONS (design Approval Flow step 5). */
  recentReauthOk: boolean
  /** TRUE only when the decision's proof is a passkey-class assertion (WebAuthn UV, or the access passkey login): the
   *  channel adapters set it from PASSKEY_CLASS_VIA. action:install_high is refused without it; a fresh IdP reauth or a
   *  Telegram device secret is not enough for it. Unset = not passkey-class. */
  decidedViaPasskey?: boolean
  /** TRUE when that passkey-class proof came through the Cloudflare Access page (its strength is the configured ACCESS_REQUIRED_AMR). */
  decidedViaAccess?: boolean
  /** Trusted channel flag, set by the shared decision core, never from a user-supplied note. */
  decidedViaApprovalBot?: boolean
  /** Trusted Mini App proof; device/user come from the verified channel, never the decision note. */
  decidedViaTelegramMiniapp?: boolean
  telegramMiniappDeviceId?: string
  telegramMiniappUserId?: string
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

// NOTE: the `live` CASE below mirrors findLiveAttachment (src/members/seat-attach.ts) minus the human's own grant token, which a
// decision surface does not hold; tests/attached-sudo.test.ts breaks each mirrored condition in turn and asserts the decision is refused (the table-driven 'liveness' test).
// ── "sudo for attached chats": the attachment a session belongs to ──────────────────────────────────────────────────
// An ATTACHED chat (W2 seat_attach) acts with its OWN credential, a member_tokens row created for exactly that one
// attachment (agent_seat_attachments.seat_token_id; its raw secret is discarded at attach time, nothing can present it
// except the server building the attached AuthContext). An agent session is keyed on that credential, so the session
// itself names its attachment, and through it the ONE human who attached. That is DERIVED on every read (never a stored
// claim on the request row, so there is nothing to forge and no migration): the decision rules below read it, never
// request text. A session whose credential is not an attachment token has no origin (null) and every rule is a no-op.
export interface SessionAttachmentOrigin {
  attachmentId: string
  /** The human who attached the chat: the ONLY member who may decide a request from it. */
  humanMemberId: string
  agentId: string
  /** The attachment is not detached AND its admission is still live. A dead one decides nothing and uses nothing. */
  live: boolean
}

export async function loadAttachmentOriginOfSession(env: Env, tenant: string, credentialId: string): Promise<SessionAttachmentOrigin | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT att.id AS attachment_id, att.human_member_id AS human_member_id, att.agent_id AS agent_id,
              CASE WHEN att.detached_at IS NULL AND adm.status = 'live' AND ${ADMISSION_BOUND_TO_SEAT_SQL}
                    AND EXISTS (SELECT 1 FROM agent_seats s WHERE s.id = att.seat_id AND s.tenant = att.tenant AND s.retired_at IS NULL
                                  AND s.member_id = att.human_member_id AND s.harness_id = att.harness_id)
                    AND EXISTS (SELECT 1 FROM agents a
                                  JOIN agent_member_bindings b ON b.tenant = att.tenant AND b.agent_id = a.id
                                  JOIN members am ON am.id = b.member_id AND am.tenant = att.tenant AND am.status = 'active'
                                 WHERE a.id = att.agent_id AND a.status = 'active' ${attachDesignatedClause(env, 'a', 'att.human_member_id')})
                    AND adm.agent_id = att.agent_id AND adm.human_member_id = att.human_member_id AND adm.harness_id = att.harness_id
                    AND EXISTS (SELECT 1 FROM harnesses hr WHERE hr.id = att.harness_id AND hr.tenant = att.tenant AND hr.member_id = att.human_member_id)
                    AND EXISTS (SELECT 1 FROM member_tokens t
                                 JOIN agent_member_bindings tb ON tb.tenant = att.tenant AND tb.agent_id = att.agent_id AND tb.member_id = t.member_id
                                 WHERE t.id = att.seat_token_id AND t.tenant = att.tenant AND t.agent_id = att.agent_id AND t.channel = 'directory'
                                  AND ${TOKEN_LIVE_PREDICATE('?3')})
                   THEN 1 ELSE 0 END AS live
         FROM agent_seat_attachments att
         LEFT JOIN agent_seat_admissions adm ON adm.id = att.admission_id AND adm.tenant = att.tenant
        WHERE att.tenant = ?1 AND att.seat_token_id = ?2
        LIMIT 1`,
    ).bind(tenant, credentialId, nowSqlUtc()).first<{ attachment_id: string; human_member_id: string; agent_id: string; live: number }>()
    return row ? { attachmentId: row.attachment_id, humanMemberId: row.human_member_id, agentId: row.agent_id, live: row.live === 1 } : null
  } catch (err) {
    // A pot that never applied the seat-attach migration has no attachments, so no session can have an origin.
    if (/no such table:\s*agent_seat_(attachments|admissions)\b/i.test(err instanceof Error ? err.message : String(err))) return null
    throw err
  }
}

/** May this member decide (approve OR deny) this request, as far as ATTACHMENT ORIGIN goes? A request from an attached
 *  chat is the attaching human's alone: another org admin may not approve it, and the list/review surfaces do not offer
 *  it to them (the same predicate backs both, Security Invariant 12). Requests with no attachment origin: always true. */
export async function attachedOriginAllowsDecider(env: Env, request: ElevationRequestRecord, deciderMemberId: string | null | undefined): Promise<boolean> {
  const session = await loadAgentSessionById(env, request.tenant, request.agent_session_id)
  if (!session) return true // no session row: the decide transaction refuses it as agent_session_ended
  const origin = await loadAttachmentOriginOfSession(env, request.tenant, session.credential_id)
  if (!origin) return true
  return origin.live && deciderMemberId != null && origin.humanMemberId === deciderMemberId
}

/** The member a decision surface would record as the decider: the web session's member, else the principal's own. */
export function deciderMemberIdOf(auth: Pick<AuthContext, 'webSessionMemberId' | 'memberId'> | null | undefined): string | null {
  return auth?.webSessionMemberId ?? auth?.memberId ?? null
}

/** Is this request from an ATTACHED chat? (Display + step-up copy only; the decision rules read the origin themselves.) */
export async function requestIsFromAttachedChat(env: Env, request: ElevationRequestRecord): Promise<boolean> {
  const session = await loadAgentSessionById(env, request.tenant, request.agent_session_id)
  return session ? (await loadAttachmentOriginOfSession(env, request.tenant, session.credential_id)) !== null : false
}

/** canDecideElevation PLUS the attachment-origin rule for one concrete request. The list/review surfaces call this. */
export async function canDecideElevationRequest(
  env: Env,
  auth: AuthContext | null | undefined,
  capabilities: CapabilityGrant[] | undefined,
  request: ElevationRequestRecord,
  deciderMemberId: string | null | undefined,
): Promise<boolean> {
  return (
    (await canDecideElevation(env, auth, capabilities, request.requested_scope_type, request.requested_scope_id)) &&
    (await attachedOriginAllowsDecider(env, request, deciderMemberId))
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

/** Every REFUSAL a decision can meet, in one READ-ONLY function. decideElevationRequest runs it first; a channel
 *  that burns a single-use token before deciding (secure moments, via decision-core.ts) runs the very same function
 *  BEFORE it consumes the token, so a refused decision can never spend the link. One predicate set, no second copy:
 *  expiry/status, agent-session liveness, authority, self-approval, and (approve) a non-empty subset of the requested
 *  actions, an unchanged scope, a valid and not-widened duration, and the step-up. `request` is the already-loaded row. */
export async function findElevationDecisionRefusal(
  env: Env,
  input: DecideElevationInput,
  request: ElevationRequestRecord,
  nowMs: number = Date.now(),
): Promise<Exclude<DecideElevationResult, { ok: true }> | null> {
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
    return { ok: false, reason: 'agent_session_ended' }
  }

  // ── "sudo for attached chats": a request from an ATTACHED chat is decided by the human who attached it, and no one else.
  // Derived from the session's own credential (see loadAttachmentOriginOfSession), so it holds for every channel that
  // reaches a decision (dashboard, Access page, secure moment, Telegram mini-app): they all end in this function.
  // A detached / admission-revoked / retired attachment is a dead session: nothing to approve, and nothing is granted.
  const attachmentOrigin = await loadAttachmentOriginOfSession(env, input.tenant, agentSession.credential_id)
  if (attachmentOrigin) {
    if (!attachmentOrigin.live) return { ok: false, reason: 'agent_session_ended' }
    // Same refusal shape as "not an admin": the other admin learns nothing about whose chat this is.
    if (input.decidedByMemberId !== attachmentOrigin.humanMemberId) {
      return { ok: false, reason: 'forbidden', need: 'admin', scope: { type: request.requested_scope_type as CapabilityScopeType, id: request.requested_scope_id } }
    }
    // The request itself may only name sudo-able actions (a row forged past request_elevation is refused here too).
    for (const a of JSON.parse(request.requested_actions_json) as string[]) {
      if (!isAttachedSudoAction(a)) return { ok: false, reason: 'invalid_elevation_request', detail: `"${a}" cannot be granted to an attached chat` }
    }
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

  if (input.decision === 'approve') {
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

    // An attached chat's request is ALWAYS a step-up decision (a fresh passkey / reauth), whatever the action's own
    // sensitivity: it is the human lending their own admin to a chat, the one thing a stale session must not do.
    // Installer window: not in SENSITIVE_STEP_UP_ACTIONS for the standard tier (Telegram's biometric may carry it) but it is never
    // approvable from a plain live dashboard session: a step-up (Mini App biometric / passkey / fresh reauth) is required for
    // both tiers, and the high tier needs a PASSKEY-class assertion specifically. Flag off: neither can be approved at all.
    const installing = selected.filter(isInstallerAction)
    if (installing.length > 0 && !installerWindowEnabled(env)) {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'the installer window is not enabled on this pot' }
    }
    const needsStepUp = attachmentOrigin !== null || installing.length > 0 || selected.some((a) => SENSITIVE_STEP_UP_ACTIONS.has(a))
    if (needsStepUp && !input.recentReauthOk) {
      return { ok: false, reason: 'reauth_required' }
    }
    // "Passkey only" must not silently degrade to any fresh Access login: without an AMR requirement configured it is unenforceable.
    // Only the Access path depends on that configuration; a verified WebAuthn assertion (secure moments) needs none.
    if (selected.includes('action:install_high') && input.decidedViaAccess === true && !accessAmrConfigured(env)) {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'action:install_high needs ACCESS_REQUIRED_AMR configured with passkey-class methods only (hwk, swk, webauthn) on this pot' }
    }
    if (selected.includes('action:install_high') && input.decidedViaPasskey !== true) {
      return { ok: false, reason: 'invalid_elevation_request', detail: 'action:install_high is approved with a passkey; open the approval link in your browser' }
    }
  }
  return null
}

/** The condition that makes a decision write atomic with the approver's identity: the web session is unrevoked AND its login identity is
 *  unrevoked, evaluated inside the same UPDATE. `tenantParam` and `hashParam` are the numbered binds the statement already carries. */
function liveApproverSessionSql(tenantParam: string, hashParam: string): string {
  return `AND EXISTS (SELECT 1 FROM web_sessions ws JOIN human_login_identities hli ON hli.id = ws.login_identity_id
                       WHERE ws.id_hash = ${hashParam} AND ws.tenant = ${tenantParam} AND ws.revoked_at IS NULL AND hli.revoked_at IS NULL)`
}

function telegramBindingGuard(input: DecideElevationInput, request: string, tenant: string, member: string, device: string, user: string): string {
  return input.decidedViaApprovalBot === true
      ? ` AND EXISTS (SELECT 1 FROM approval_bot_deliveries d JOIN members m ON m.id = d.member_id
            WHERE d.request_id = ${request} AND d.tenant = ${tenant} AND d.member_id = ${member}
              AND d.status = 'sent' AND m.telegram_chat_id = d.chat_id
              AND (m.tenant = ${tenant} OR m.tenant IS NULL) AND m.status = 'active')`
      : input.decidedViaTelegramMiniapp === true
        ? ` AND EXISTS (SELECT 1 FROM tg_miniapp_devices d
              JOIN members m ON m.id = d.member_id AND m.tenant = d.tenant
              JOIN human_login_identities i ON i.id = d.login_identity_id AND i.tenant = d.tenant AND i.member_id = d.member_id
             WHERE d.id = ${device} AND d.tenant = ${tenant} AND d.member_id = ${member}
               AND d.telegram_user_id = ${user} AND m.telegram_chat_id = d.telegram_user_id
               AND m.status = 'active' AND d.confirmed_at IS NOT NULL AND d.revoked_at IS NULL AND i.revoked_at IS NULL)`
        : ''
}

/** Re-read the failed predicates for a guarded no-op; a still-pending request is not closed. */
async function decisionLostReason(env: Env, input: DecideElevationInput, requestId: string, status: ElevationRequestStatus): Promise<DecideElevationResult> {
  const current = await loadElevationRequestById(env, input.tenant, requestId)
  if (current?.status !== 'pending') return { ok: false, reason: 'already_decided', status: current?.status ?? status }
  if (input.decidedViaApprovalBot === true || input.decidedViaTelegramMiniapp === true) {
    const bound = await env.DB.prepare(
      `SELECT 1 AS live WHERE 1 = 1 ${telegramBindingGuard(input, '?1', '?2', '?3', '?4', '?5')}`,
    ).bind(requestId, input.tenant, input.decidedByMemberId,
      ...(input.decidedViaTelegramMiniapp === true ? [input.telegramMiniappDeviceId ?? null, input.telegramMiniappUserId ?? null] : []),
    ).first()
    if (!bound) return { ok: false, reason: 'invalid_elevation_request', detail: 'binding_changed' }
  }
  if (input.requireLiveApproverSession === true) {
    const live = await env.DB.prepare(`SELECT 1 AS live WHERE 1 = 1 ${liveApproverSessionSql('?1', '?2')}`)
      .bind(input.tenant, input.decidedByWebSessionHash).first()
    if (!live) return { ok: false, reason: 'invalid_elevation_request', detail: 'approver_session_ended' }
  }
  return { ok: false, reason: 'invalid_elevation_request', detail: 'decision_not_recorded' }
}

/** Grant writes and the terminal decision share one D1 transaction. Grant writes
 * are gated on pending; the final update verifies the complete grant set inside
 * SQL, so even a silent no-op aborts rather than committing a partial approval.
 * Concurrent decisions serialize in D1: only the first pending request writes.
 */
export async function decideElevationRequest(
  env: Env,
  input: DecideElevationInput,
  nowMs: number = Date.now(),
): Promise<DecideElevationResult> {
  await expireStaleElevationRequests(env, input.tenant, nowMs)

  const request = await loadElevationRequestById(env, input.tenant, input.requestId)
  if (!request) return { ok: false, reason: 'not_found' }
  const refusal = await findElevationDecisionRefusal(env, input, request, nowMs)
  if (refusal) {
    if (refusal.reason === 'agent_session_ended') {
      await env.DB.prepare(
        `UPDATE elevation_requests SET status = 'denied', decided_at = ?1, decision_note = 'agent_session_ended'
          WHERE id = ?2 AND tenant = ?3 AND status = 'pending'`,
      )
        .bind(new Date(nowMs).toISOString(), request.id, input.tenant)
        .run()
    }
    return refusal
  }

  const nowIso = new Date(nowMs).toISOString()

  // Check inside each decision write, including the grant transaction. A callback
  // can pass its initial binding read just before a concurrent unbind commits.
  const miniappBindings = input.decidedViaTelegramMiniapp === true
    ? [input.telegramMiniappDeviceId ?? null, input.telegramMiniappUserId ?? null] : []
  const decidedVia = input.decidedViaApprovalBot === true ? "'approval_bot'"
    : input.decidedViaTelegramMiniapp === true ? "'telegram_miniapp'" : 'NULL'
  if (input.decision === 'deny') {
    const result = await env.DB.prepare(
      `UPDATE elevation_requests
          SET status = 'denied', decided_at = ?1, decided_by_member_id = ?2,
              decided_by_web_session_hash = ?3, decision_note = ?4,
              decided_via = ${decidedVia}
        WHERE id = ?5 AND tenant = ?6 AND status = 'pending'
          ${telegramBindingGuard(input, '?5', '?6', '?2', '?7', '?8')}
          ${input.requireLiveApproverSession === true ? liveApproverSessionSql('?6', '?3') : ''}`,
    )
      .bind(nowIso, input.decidedByMemberId, input.decidedByWebSessionHash, input.note ?? null, request.id, input.tenant, ...miniappBindings)
      .run()
    if (Number(result.meta?.changes ?? 0) === 0) return decisionLostReason(env, input, request.id, 'denied')
    return { ok: true, request: { ...request, status: 'denied', decided_at: nowIso,
      decided_by_member_id: input.decidedByMemberId, decided_by_web_session_hash: input.decidedByWebSessionHash,
      decision_note: input.note ?? null }, grants: [] }
  }

  // ── approve ── (every refusal was already cleared by findElevationDecisionRefusal above)
  const selected = Array.from(new Set(input.selectedActions ?? []))
  const scopeType = input.scopeType ?? request.requested_scope_type
  const scopeId = input.scopeId ?? request.requested_scope_id
  const durationMinutes = input.durationMinutes ?? request.requested_duration_minutes

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

  // The unique session/action/scope slot survives expiry and revocation. Reuse
  // ended slots for every action, preserving the grant id and its usage receipts.
  // Still-live slots remain conflicts; approval never overwrites active authority.
  const renewed = new Set<string>()
  for (const g of grants) {
    const prior = await env.DB.prepare(
      `SELECT id FROM elevation_grants
        WHERE tenant = ?1 AND agent_session_id = ?2 AND action = ?3 AND scope_type = ?4 AND scope_id = ?5
          AND (revoked_at IS NOT NULL OR expires_at <= ?6) LIMIT 1`,
    )
      .bind(input.tenant, g.agent_session_id, g.action, g.scope_type, g.scope_id, nowIso)
      .first<{ id: string }>()
    if (prior) {
      g.id = prior.id
      renewed.add(g.id)
    }
  }
  const grantStatements = grants.map((g) =>
    renewed.has(g.id)
      ? env.DB.prepare(
          `UPDATE elevation_grants
              SET elevation_request_id = ?2, approved_by_member_id = ?3, approved_by_web_session_hash = ?4,
                  created_at = ?5, expires_at = ?6, revoked_at = NULL, revoke_reason = NULL, effect = ?7
            WHERE id = ?1 AND tenant = ?8
              AND (revoked_at IS NOT NULL OR expires_at <= ?5)
              AND EXISTS (SELECT 1 FROM elevation_requests WHERE id = ?2 AND tenant = ?8 AND status = 'pending')
              ${telegramBindingGuard(input, '?2', '?8', '?3', '?9', '?10')}
              ${input.requireLiveApproverSession === true ? liveApproverSessionSql('?8', '?4') : ''}`,
        ).bind(g.id, g.elevation_request_id, g.approved_by_member_id, g.approved_by_web_session_hash,
          g.created_at, g.expires_at, g.effect, g.tenant, ...miniappBindings)
      : env.DB.prepare(
          `INSERT INTO elevation_grants
             (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
              approved_by_member_id, approved_by_web_session_hash, created_at, expires_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
            WHERE EXISTS (SELECT 1 FROM elevation_requests WHERE id = ?3 AND tenant = ?2 AND status = 'pending')
              ${telegramBindingGuard(input, '?3', '?2', '?9', '?13', '?14')}
              ${input.requireLiveApproverSession === true ? liveApproverSessionSql('?2', '?10') : ''}`,
        ).bind(g.id, g.tenant, g.elevation_request_id, g.agent_session_id, g.action, g.scope_type,
          g.scope_id, g.effect, g.approved_by_member_id, g.approved_by_web_session_hash, g.created_at, g.expires_at, ...miniappBindings),
  )
  const batchResults = await env.DB.batch([
    ...grantStatements,
    env.DB.prepare(
      `UPDATE elevation_requests
          SET status = CASE WHEN (
                SELECT COUNT(*) FROM elevation_grants
                 WHERE elevation_request_id = ?5 AND tenant = ?6
                   AND id IN (${grants.map((_, i) => `?${i + 8}`).join(', ')})
              ) = ?7 THEN 'approved' ELSE NULL END,
              decided_at = ?1, decided_by_member_id = ?2,
              decided_by_web_session_hash = ?3, decision_note = ?4,
              decided_via = ${decidedVia}
        WHERE id = ?5 AND tenant = ?6 AND status = 'pending'
          ${telegramBindingGuard(input, '?5', '?6', '?2', `?${grants.length + 8}`, `?${grants.length + 9}`)}
          ${input.requireLiveApproverSession === true ? liveApproverSessionSql('?6', '?3') : ''}`,
    ).bind(nowIso, input.decidedByMemberId, input.decidedByWebSessionHash, input.note ?? null,
      request.id, input.tenant, grants.length, ...grants.map((g) => g.id), ...miniappBindings),
  ])
  // NULL deliberately violates status's NOT NULL constraint when any grant was
  // skipped. This check must run inside the transaction, not after it commits.
  if (Number(batchResults[grants.length].meta?.changes ?? 0) === 0) {
    return decisionLostReason(env, input, request.id, 'approved')
  }

  // No fallible read after commit: a read failure must not report a committed approval as failed.
  return { ok: true, request: { ...request, status: 'approved', decided_at: nowIso,
    decided_by_member_id: input.decidedByMemberId, decided_by_web_session_hash: input.decidedByWebSessionHash,
    decision_note: input.note ?? null }, grants }
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
  /** The grant's `created_at` as the caller READ it. A renewed grant keeps its id but gets a new created_at (a new generation): with
   *  this set the revoke can only end the generation the caller saw, never a later approval that reused the row. */
  generation?: string,
): Promise<{ revoked: boolean }> {
  const nowIso = new Date(nowMs).toISOString()
  const result = await env.DB.prepare(
    `UPDATE elevation_grants SET revoked_at = ?1, revoke_reason = ?2 WHERE id = ?3 AND tenant = ?4 AND revoked_at IS NULL
        AND (?5 IS NULL OR created_at = ?5)`,
  )
    .bind(nowIso, reason, id, tenant, generation ?? null)
    .run()
  return { revoked: Number(result.meta?.changes ?? 0) > 0 }
}

/** #2100: use trusted channel provenance, never the user-editable decision note.
 * Older Telegram approvals may have only the audit receipt (the bot stamp used
 * to be best-effort, and Mini App decisions had no stamp). Both forms are scoped to the tenant, request and approver.
 * Prepared for the unbind batch: any failure rolls back the binding and receipt too. */
export function prepareTelegramApprovedElevationGrantRevocation(env: Env, memberId: string, nowIso: string) {
  return env.DB.prepare(
    `UPDATE elevation_grants SET revoked_at = ?3, revoke_reason = 'telegram_unbound'
      WHERE EXISTS (SELECT 1 FROM members WHERE id = ?2 AND (tenant = ?1 OR tenant IS NULL) AND telegram_chat_id IS NULL)
        AND id IN (SELECT g.id FROM elevation_grants g
      JOIN elevation_requests r ON r.id = g.elevation_request_id AND r.tenant = g.tenant
      WHERE g.tenant = ?1 AND g.approved_by_member_id = ?2
        AND r.decided_by_member_id = ?2
        AND (r.decided_via IN ('approval_bot', 'telegram_miniapp') OR (r.decided_via IS NULL AND EXISTS (
          SELECT 1 FROM mutation_audit_entries a
           WHERE a.tenant = g.tenant AND a.member_id = ?2 AND a.target_kind = 'elevation_request'
             AND a.target_id = r.id AND a.operation = 'elevation_approve'
             AND (a.handler = 'approval_bot' OR (a.handler = 'secure_moment'
               AND json_extract(CASE WHEN json_valid(a.evidence_json) THEN a.evidence_json ELSE '{}' END, '$.via') = 'telegram_miniapp'))
        )))
        AND g.revoked_at IS NULL AND g.expires_at > ?3)`,
  ).bind(env.TENANT_SLUG, memberId, nowIso)
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

/**
 * The ONE settle-after-success usage receipt for a grant-door write that authorized with `recordUsage: false`: call it only after
 * the write succeeded, so a malformed body or a slug conflict never leaves an 'applied' row (mupot#1906). Not try/caught beyond
 * recordElevationUsage's own missing-table rule: if the audit row cannot be written the call fails rather than report success untrailed.
 */
export async function recordGrantUsage(env: Env, grant: ElevationGrantRecord, action: string, toolName: string, detail: unknown): Promise<void> {
  await recordElevationUsage(env, env.TENANT_SLUG, grant.id, grant.agent_session_id, action, toolName, detail, Date.now())
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
  | 'attached_action_not_sudoable'
  | 'approver_not_attaching_human'
  | 'attachment_ended'

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
  /** Judge exactly this grant and no other (the installer window evaluates each live grant on its own, so an org grant
   *  cannot shadow a department grant on the same session). Unset = every existing caller, unchanged. */
  onlyGrantId?: string
  /** Also accept an approver whose admin authority lives on the legacy role plane (humanVerifiedLegacyRoleRank). Installer windows only. */
  approverRolePlane?: boolean
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

  // "sudo for attached chats": an ATTACHED caller (the server built this AuthContext from a live attachment on THIS request,
  // so detach / admission revoke / idle sweep / seat retire have already ended it) may use a grant only for an allow-listed
  // action, only one bound to ITS OWN attachment session (liveSession above is keyed on the attachment's own token), and
  // only one the attaching human approved. The same rules are enforced at request and decision time; this is the use-time copy.
  const attached = attachedAuthority(auth)
  if (attached && !isAttachedSudoAction(action)) return { granted: false, reason: 'attached_action_not_sudoable' }
  if (attached) {
    // Re-read the attachment at USE time through THE admission chokepoint (not only when this request's AuthContext was
    // built): a detach, an admission revoke, an idle sweep or a seat retire ends sudo immediately, whatever ctx a caller holds.
    const b = auth.seatBinding
    const { findLiveAttachment } = await import('../members/seat-attach') // dynamic: seat-attach pulls in the wider members graph
    const live = b ? await findLiveAttachment(env, { memberId: b.humanMemberId, tokenId: b.grantTokenId }, b.seatId) : null
    if (!live || live.attachment_id !== attached.attachmentId || live.seat_token_id !== sessionCtx.context.credentialId) {
      return { granted: false, reason: 'attachment_ended' }
    }
  }

  const grants = await loadLiveElevationGrantsForSession(env, tenant, liveSession.id, nowMs)
  const match = grants.find((g) => {
    if (g.action !== action) return false
    if (opts.onlyGrantId !== undefined && g.id !== opts.onlyGrantId) return false
    if (attached && g.approved_by_member_id !== attached.humanMemberId) return false
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
  if (!match) {
    const notTheAttachingHuman = attached !== null && grants.some((g) => g.action === action && g.approved_by_member_id !== attached.humanMemberId)
    return { granted: false, reason: notTheAttachingHuman ? 'approver_not_attaching_human' : 'no_matching_grant' }
  }

  // Re-derive the APPROVER's authority live — never trust that they still
  // hold what they granted just because the grant row exists. For a
  // 'action:home_access' grant on a home squad, this means ONLY the home's
  // OWNER (the sole holder of an exact squad-scope grant there — org/
  // department/role planes are capability-dead on a home, G-FP1b point 2)
  // can durably remain the approver: an org admin's authority re-check fails
  // closed with `approver_authority_lost` here, by design.
  const approverCapabilities = await resolveCapabilities(env, match.approved_by_member_id)
  if (!(await hasCapabilityOnDynamicScope(env, approverCapabilities, match.scope_type, match.scope_id || null, 'admin'))) {
    // Installer windows only: an approver on the LEGACY ROLE plane (owner/admin with no capability rows) was admitted at decision
    // time through decidedByIsOrgAdmin; re-derive the same authority here (role plane + rows, live) or the window dies on arrival.
    // Opt-in per caller so no other action's behaviour changes.
    // The VERIFIED login identity's role (humanVerifiedLegacyRoleRank), never members.email (an inviter types that: #1551 class), and
    // for a squad scope the same home-squad exclusion the decision applied (planeCoversScope('org', ...)).
    const rolePlaneOk = opts.approverRolePlane === true
      && (await humanVerifiedLegacyRoleRank(env, match.approved_by_member_id)) >= capabilityRank('admin')
      && (match.scope_type !== 'squad' || await (async () => {
        const sc = await loadSquadScope(env, match.scope_id)
        return sc !== null && planeCoversScope('org', sc)
      })())
    if (!rolePlaneOk) return { granted: false, reason: 'approver_authority_lost' }
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
export async function loadLiveSessionForBoundAgent(
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

/** Does this live grant count for THIS caller at all? Always for an ordinary bound agent. For an ATTACHED chat only an
 *  allow-listed action the attaching human approved counts (existence probes must not let a stray row open a door). */
function grantCountsForCaller(auth: AuthContext, g: ElevationGrantRecord): boolean {
  const attached = attachedAuthority(auth)
  return !attached || (isAttachedSudoAction(g.action) && g.approved_by_member_id === attached.humanMemberId)
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
  return grants.filter((g) => grantCountsForCaller(auth, g)).some((g) => g.action === action)
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
  return grants.some((g) => grantCountsForCaller(auth, g))
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
  attached_action_not_sudoable: 'an attached chat may only use the sudo-able actions; this one is not on that list',
  attachment_ended: 'this chat is no longer attached (detached, admission revoked, or the seat retired): any sudo it held ended with the attachment',
  approver_not_attaching_human: 'a grant for an attached chat counts only when the human who attached the chat approved it; ask them to approve a fresh request with their passkey',
}

/** Tools that consult an elevation action, and the action key each consults.
 *  Text-only: used to name the door in a plain `need=<cap>` refusal. It grants
 *  nothing and is not consulted by any authorization decision. */
const ELEVATION_ACTION_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  project_create: 'action:workspace_project',
  grant_agent_capability: 'action:manage_access',
  mint_agent_token: 'action:mint_token',
  create_squad: 'action:project_lifecycle',
  create_department: 'action:org_department_create',
  update_department: 'action:org_structure',
  update_squad: 'action:org_structure',
  routine_enable: 'action:routine_policy',
  routine_pause: 'action:routine_policy',
  routine_archive: 'action:routine_archive',
  routine_update: 'action:routine_policy',
  project_update: 'action:project_status',
  unarchive_row: 'action:project_status',
  // owner sudo: ONE call of the tool, run as the approving human (src/auth/owner-sudo.ts). update_squad keeps its org_structure hint.
  squad_member_add: 'action:sudo_squad_member_add',
  grant_gate_capability: 'action:sudo_grant_gate_capability',
  seat_event_grant: 'action:sudo_seat_event_grant',
})

/** elevationHint — the refusal hint naming request_elevation + the action key
 *  for a tool that has an elevation door, or undefined for one that has none. */
export function elevationHint(toolName: string): string | undefined {
  const action = ELEVATION_ACTION_BY_TOOL[toolName]
  if (!action) return undefined
  const base = `an admin can approve a time-boxed elevation instead: call request_elevation with actions ["${action}"]`
  const scope = ELEVATION_SCOPE_HINT_BY_TOOL[toolName]
  return scope ? `${base} and ${scope}` : base
}

/** The scope half of the copy-paste request, for the tools whose grant scope is not obvious (an agent has no tool that
 *  lists department ids, so the hint names what scope_id must be). Display only. */
const ELEVATION_SCOPE_HINT_BY_TOOL: Readonly<Record<string, string>> = Object.freeze({
  create_department: 'scope_type "org" (an ORG-scope grant is required; scope_id is empty)',
  update_department: 'scope_type "department" with scope_id = that department\'s id (or scope_type "org")',
  update_squad: 'scope_type "squad" with scope_id = that squad\'s id (or its department\'s id, or scope_type "org")',
  squad_member_add: 'scope_type "squad" with scope_id = that squad\'s id, duration_minutes 15 and sudo_args = the exact call (it covers ONE call, run as your human)',
  grant_gate_capability: 'scope_type "org", duration_minutes 15 and sudo_args = the exact call (it covers ONE call, run as your human)',
  seat_event_grant: 'scope_type "squad" with scope_id = the target agent\'s squad id, duration_minutes 15 and sudo_args = the exact call (it covers ONE call, run as your human)',
})

export function elevationRemedyMessage(reason: ElevatedActionDenyReason): string {
  return ELEVATION_DENY_REMEDY[reason]
}

export type { CapabilityScopeType, AgentAuthKind }
export { ELEVATION_ACTIONS }
