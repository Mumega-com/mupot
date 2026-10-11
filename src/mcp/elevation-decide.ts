// mupot — elevation_decide + the human view of elevation_status (mupot task 31491b14, "MCP-first").
//
// A human org admin approves or denies an agent's elevation request from their OWN MCP session,
// not only from the dashboard. THERE IS ONE DECISION CHOKEPOINT: this tool calls
// decideElevationRequest (src/auth/elevation.ts) — the same function the dashboard route
// POST /auth/elevation/requests/:id/decide calls — and adds NO authorization predicate of its
// own that could drift from it. Everything below is either (a) a floor that is STRICTER than the
// dashboard's, or (b) the plumbing to feed that function the inputs a dashboard session supplies.
//
// STRICTER THAN THE DASHBOARD, deliberately (these are the decisions to review):
//   1. Human floor. An agent-bound token, a seat/harness session, a directory-consented
//      session, or any member that is an agent's own member is refused 403 human_accept_required.
//      Capability is read from the AMBIENT auth.capabilities only (never re-resolved fresh, which
//      would undo the directory ceiling), and must be ORG-scope admin (hasWorkspaceAdmin): a squad
//      admin can still decide on the dashboard, not here.
//   2. No step-up over MCP. A grant for a SENSITIVE_STEP_UP_ACTIONS action needs a fresh
//      reauth round-trip that an MCP token cannot perform, so approving one is refused
//      reauth_required (use the dashboard). `actions` may narrow the approval to the
//      non-sensitive subset. Deny never needs step-up, exactly as on the dashboard.
//   3. The grant is bound to one of the approver's own LIVE dashboard web sessions
//      (elevation_grants.approved_by_web_session_hash is NOT NULL + FK, and hasElevatedAction
//      ends the grant when that session ends). No live dashboard session => 409
//      web_session_required. The audit row records that the decision came through MCP.
//   4. A decision writes one mutation_audit_entries receipt, success or refusal.

import type { AuthContext, CapabilityScopeType, Env } from '../types'
import {
  canDecideElevation,
  decideElevationRequest,
  loadElevationRequestById,
  type ElevationRequestRecord,
} from '../auth/elevation'
import { hasWorkspaceAdmin } from '../auth/capability'
import { evaluateAgentSession, loadAgentSessionById } from '../auth/agent-sessions'
import { evaluateWebSession, listWebSessions } from '../auth/web-sessions'
import { ELEVATION_ACTIONS, SENSITIVE_STEP_UP_ACTIONS } from '../auth/elevation-actions'
import { assertWritten } from '../lib/receipt'
import { type ToolSpec, fail, done, type ToolOutcome } from './index'

const NOTE_MAX = 500

/** The human floor, shared by elevation_decide and the human view of elevation_status. */
export async function humanElevationDeciderFloor(
  auth: AuthContext,
  env: Env,
): Promise<{ ok: true; memberId: string } | { ok: false; outcome: ToolOutcome }> {
  const refuse = (): { ok: false; outcome: ToolOutcome } => ({ ok: false, outcome: fail(403, 'human_accept_required') })
  if (auth.boundAgentId) return refuse()
  if (!auth.memberId) return refuse()
  if (auth.seatBinding || auth.harnessCredential || auth.consentedByMemberId) return refuse()
  if (!hasWorkspaceAdmin(auth)) return { ok: false, outcome: fail(403, 'forbidden', { need: 'admin', scope: 'org' }) }
  // An agent's own member row is never a human decider, whatever token presents it.
  const bound = await env.DB.prepare(`SELECT 1 AS x FROM agent_member_bindings WHERE tenant = ?1 AND member_id = ?2 LIMIT 1`)
    .bind(auth.tenant, auth.memberId)
    .first<{ x: number }>()
  if (bound) return refuse()
  return { ok: true, memberId: auth.memberId }
}

interface ActionView { key: string; label: string; effect: string | null; effect_note: string | null; needs_dashboard_reauth: boolean }

async function scopeLabel(env: Env, scopeType: string, scopeId: string): Promise<string | null> {
  if (scopeType === 'org' || !scopeId) return null
  const table = scopeType === 'squad' ? 'squads' : scopeType === 'department' ? 'departments' : null
  if (!table) return null
  const row = await env.DB.prepare(`SELECT name FROM ${table} WHERE id = ?1 LIMIT 1`).bind(scopeId).first<{ name: string }>()
  return row?.name ?? null
}

async function describeRequest(env: Env, r: ElevationRequestRecord, nowMs: number): Promise<Record<string, unknown>> {
  const keys: string[] = JSON.parse(r.requested_actions_json)
  const actions: ActionView[] = keys.map((k) => ({
    key: k,
    label: ELEVATION_ACTIONS[k]?.label ?? k,
    effect: ELEVATION_ACTIONS[k]?.effect ?? null,
    effect_note: ELEVATION_ACTIONS[k]?.effectNote ?? null,
    needs_dashboard_reauth: SENSITIVE_STEP_UP_ACTIONS.has(k),
  }))
  const session = await loadAgentSessionById(env, r.tenant, r.agent_session_id)
  const sessionEval = session ? evaluateAgentSession(session, nowMs) : null
  const agent = await env.DB.prepare(`SELECT slug, name FROM agents WHERE id = ?1 LIMIT 1`).bind(r.agent_id).first<{ slug: string; name: string }>()
  return {
    id: r.id,
    status: r.status === 'pending' && nowMs >= Date.parse(r.decision_expires_at) ? 'expired' : r.status,
    actions,
    scope_type: r.requested_scope_type,
    scope_id: r.requested_scope_id,
    scope_name: await scopeLabel(env, r.requested_scope_type, r.requested_scope_id),
    duration_minutes: r.requested_duration_minutes,
    reason: r.reason,
    requester: {
      agent_id: r.agent_id,
      agent_slug: agent?.slug ?? null,
      agent_name: agent?.name ?? null,
      agent_session_id: r.agent_session_id,
      session_live: sessionEval ? sessionEval.ok : false,
      session_state: sessionEval ? (sessionEval.ok ? 'live' : sessionEval.reason) : 'not_found',
    },
    created_at: r.created_at,
    decision_expires_at: r.decision_expires_at,
    decided_at: r.decided_at,
    decided_by_member_id: r.decided_by_member_id,
    decision_note: r.decision_note,
    approvable_over_mcp: !actions.some((a) => a.needs_dashboard_reauth),
    approvable_subset_over_mcp: actions.filter((a) => !a.needs_dashboard_reauth).map((a) => a.key),
  }
}

/** The human half of elevation_status: what is pending, and exactly what approving it would grant.
 *  Read-only (no stale-sweep UPDATE): an expired pending row is reported as expired, not flipped. */
export async function humanElevationStatus(auth: AuthContext, env: Env, args: Record<string, unknown>): Promise<ToolOutcome> {
  const floor = await humanElevationDeciderFloor(auth, env)
  if (!floor.ok) return floor.outcome
  const nowMs = Date.now()
  const requestId = typeof args.request_id === 'string' && args.request_id.trim() ? args.request_id.trim() : null

  const visible = async (r: ElevationRequestRecord): Promise<boolean> =>
    canDecideElevation(env, auth, auth.capabilities, r.requested_scope_type as CapabilityScopeType, r.requested_scope_id)

  if (requestId) {
    const r = await loadElevationRequestById(env, auth.tenant, requestId)
    // Unknown and out-of-authority read identically: no existence oracle.
    if (!r || !(await visible(r))) return done({ view: 'human', request: null })
    return done({ view: 'human', request: await describeRequest(env, r, nowMs) })
  }

  const rows = await env.DB.prepare(
    `SELECT id FROM elevation_requests WHERE tenant = ?1 AND status = 'pending' AND decision_expires_at > ?2 ORDER BY created_at ASC LIMIT 100`,
  )
    .bind(auth.tenant, new Date(nowMs).toISOString())
    .all<{ id: string }>()
  const pending: Array<Record<string, unknown>> = []
  for (const { id } of rows.results ?? []) {
    const r = await loadElevationRequestById(env, auth.tenant, id)
    if (!r || !(await visible(r))) continue
    pending.push(await describeRequest(env, r, nowMs))
  }
  return done({ view: 'human', pending_requests: pending })
}

async function writeDecisionReceipt(
  env: Env,
  auth: AuthContext,
  memberId: string,
  request: ElevationRequestRecord | null,
  requestId: string,
  operation: string,
  evidence: Record<string, unknown>,
  idempotent: boolean,
): Promise<string> {
  const id = crypto.randomUUID()
  const res = await env.DB.prepare(
    `INSERT INTO mutation_audit_entries (
       id, tenant, principal_kind, principal_id, member_id, credential_id, origin, handler, operation,
       target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
     VALUES (?1, ?2, 'member', ?3, ?3, ?4, 'mcp', 'elevation_decide', ?5, 'elevation_request', ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT DO NOTHING`,
  )
    .bind(
      id, auth.tenant, memberId, auth.tokenId ?? null, operation, requestId,
      idempotent ? `elevation-decide:${requestId}` : id,
      idempotent ? `elevation-decide:${requestId}` : id,
      JSON.stringify({ ...evidence, requester_agent_id: request?.agent_id ?? null, requester_session_id: request?.agent_session_id ?? null }),
      new Date().toISOString(),
    )
    .run()
  // idempotent success receipts may legitimately conflict (a replay); refusal receipts never do.
  if (!idempotent) assertWritten(res, 'mutation_audit_entries.elevation_decide')
  return id
}

const toolElevationDecide: ToolSpec = {
  name: 'elevation_decide',
  scope: 'human org admin only: approve or deny a pending agent elevation request (same decision function as the dashboard; sensitive actions need the dashboard step-up)',
  min: 'admin',
  args: '{ request_id: string, decision: "approve"|"deny", actions?: string[] (approve only: narrow to a subset of the requested actions), note?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'deny'] },
      actions: { type: 'array', items: { type: 'string' } },
      note: { type: 'string' },
    },
    required: ['request_id', 'decision'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const floor = await humanElevationDeciderFloor(auth, env)
    if (!floor.ok) return floor.outcome
    const memberId = floor.memberId

    const requestId = typeof args.request_id === 'string' ? args.request_id.trim() : ''
    const decision = args.decision === 'approve' || args.decision === 'deny' ? args.decision : null
    if (!requestId || !decision) return fail(400, 'invalid_args', 'request_id and decision (approve|deny) required')
    const note = typeof args.note === 'string' ? args.note.trim().slice(0, NOTE_MAX) : ''
    const actions = Array.isArray(args.actions) ? args.actions.filter((a): a is string => typeof a === 'string') : undefined
    if (decision === 'deny' && actions && actions.length > 0) return fail(400, 'invalid_args', 'actions applies to approve only')

    const request = await loadElevationRequestById(env, auth.tenant, requestId)
    // Out-of-authority and unknown read identically (no existence oracle) — before anything is decided.
    if (!request || !(await canDecideElevation(env, auth, auth.capabilities, request.requested_scope_type as CapabilityScopeType, request.requested_scope_id))) {
      await writeDecisionReceipt(env, auth, memberId, null, requestId.slice(0, 120) || 'unknown', 'refused:not_found', { decision }, false)
      return fail(404, 'not_found')
    }

    // The decision binds to one of the approver's own live dashboard sessions (see header, point 3).
    const sessions = await listWebSessions(env, auth.tenant, memberId)
    const live = sessions.find((s) => evaluateWebSession(s).ok)
    if (!live) {
      await writeDecisionReceipt(env, auth, memberId, request, request.id, 'refused:web_session_required', { decision }, false)
      return fail(409, 'web_session_required', 'Sign in to the dashboard once: an approval is bound to a live dashboard session and ends when that session ends.')
    }

    const result = await decideElevationRequest(env, {
      tenant: auth.tenant,
      requestId: request.id,
      decision,
      selectedActions: decision === 'approve' ? (actions && actions.length > 0 ? actions : JSON.parse(request.requested_actions_json)) : undefined,
      decidedByMemberId: memberId,
      // Same two planes the dashboard passes — but from the AMBIENT capabilities only (see header, point 1).
      decidedByCapabilities: auth.capabilities ?? [],
      decidedByIsOrgAdmin: hasWorkspaceAdmin(auth),
      decidedByWebSessionHash: live.id_hash,
      recentReauthOk: false, // an MCP token cannot prove a fresh reauth: sensitive approvals go to the dashboard
      note: note ? `[via mcp] ${note}` : '[via mcp]',
    })

    if (!result.ok) {
      await writeDecisionReceipt(env, auth, memberId, request, request.id, `refused:${result.reason}`, { decision, reason: result.reason }, false)
      const status = result.reason === 'not_found' ? 404 : result.reason === 'forbidden' || result.reason === 'reauth_required' ? 403 : 409
      const detail = result.reason === 'reauth_required'
        ? 'This approval includes an action that needs a fresh dashboard reauth. Approve it on the dashboard, or pass `actions` to approve only the non-sensitive subset.'
        : 'detail' in result ? result.detail : undefined
      return fail(status, result.reason, detail)
    }

    const receiptId = await writeDecisionReceipt(
      env, auth, memberId, request, request.id, decision,
      { decision, grants: result.grants.map((g) => ({ id: g.id, action: g.action, scope_type: g.scope_type, scope_id: g.scope_id, expires_at: g.expires_at })), via_web_session_hash: live.id_hash },
      true,
    )
    return done({
      ok: true,
      request: { id: result.request.id, status: result.request.status },
      grants: result.grants.map((g) => ({
        id: g.id, action: g.action, label: ELEVATION_ACTIONS[g.action]?.label ?? g.action,
        scope_type: g.scope_type, scope_id: g.scope_id, effect: g.effect, expires_at: g.expires_at,
      })),
      audit_receipt_id: receiptId,
    })
  },
}

export const ELEVATION_DECIDE_TOOLS: ToolSpec[] = [toolElevationDecide]
