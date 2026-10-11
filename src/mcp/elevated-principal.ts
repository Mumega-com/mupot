// mupot — shared "member, or an agent holding a live elevation grant" gate.
//
// Several lifecycle tools (routine_enable/pause/archive/update, project_update
// status changes, unarchive_row on projects/squads) were member-only: an
// agent-bound caller was refused outright. A live, human-approved elevation
// grant can now stand in for the member on those tools, through the SAME
// predicate mint_agent_token / grant_agent_capability / create_squad already
// use: hasElevatedAction (src/auth/elevation.ts), which re-derives session
// liveness, grant expiry/revocation, the approver's current authority and the
// approver's web-session liveness on every call.
//
// This module decides nothing about what a member may do — a non-agent caller
// passes through unchanged and the tool keeps its own standing checks. It only
// answers: for an agent-bound caller, does a live grant for `action` cover one
// of the target scopes? Nothing else is widened.

import type { AuthContext, Env } from '../types'
import {
  elevationHint,
  elevationRemedyMessage,
  hasElevatedAction,
  resolveScopeDepartmentId,
  type ElevationGrantRecord,
} from '../auth/elevation'
import { beginElevationReceipt, finishElevationReceipt } from '../auth/elevation-receipt'
import { fail, type ToolOutcome } from './index'

/** The only two actions this gate answers for. A union (not `string`) so the
 *  hasElevatedAction call sites below keep naming their action as a literal —
 *  tests/elevation-actions-enforced.test.ts scans for exactly that. */
export type LifecycleElevationAction = 'action:routine_policy' | 'action:project_status'

export type ElevationTarget = { type: 'org' } | { type: 'squad'; id: string }

export type ActingPrincipal =
  | { ok: true; via: 'member' }
  | { ok: true; via: 'elevation'; grant: ElevationGrantRecord }
  | { ok: false; outcome: ToolOutcome }

export interface ElevatedPrincipalOptions {
  toolName: string
  /** Error code returned on refusal — the tool's pre-existing code, so the
   *  refusal text does not change for a caller without a grant. */
  refusalCode: string
  detail?: unknown
  /** false: scan targets without writing an elevation_usage_log row; the tool
   *  then wraps its mutation in withElevationReceipt. Default true. */
  recordUsage?: boolean
}

async function checkAction(
  env: Env,
  auth: AuthContext,
  action: LifecycleElevationAction,
  target: ElevationTarget,
  opts: ElevatedPrincipalOptions,
): Promise<Awaited<ReturnType<typeof hasElevatedAction>>> {
  const scopeId = target.type === 'squad' ? target.id : null
  const squadDepartmentId = target.type === 'squad' ? await resolveScopeDepartmentId(env, 'squad', target.id) : null
  const callOpts = { toolName: opts.toolName, detail: opts.detail, squadDepartmentId, recordUsage: opts.recordUsage }
  // Literal action at each call site (see LifecycleElevationAction).
  if (action === 'action:routine_policy') {
    return hasElevatedAction(env, auth, 'action:routine_policy', target.type, scopeId, callOpts)
  }
  return hasElevatedAction(env, auth, 'action:project_status', target.type, scopeId, callOpts)
}

/**
 * memberOrElevatedAgent — a non-agent caller is the member and passes through
 * (the tool's own standing checks still run). An agent-bound caller must hold a
 * live grant for `action` covering ONE of `targets`; the first covering target
 * wins, and a target with no covering grant logs nothing.
 */
export async function memberOrElevatedAgent(
  auth: AuthContext,
  env: Env,
  action: LifecycleElevationAction,
  targets: ElevationTarget | readonly ElevationTarget[],
  opts: ElevatedPrincipalOptions,
): Promise<ActingPrincipal> {
  if (!auth.boundAgentId) return { ok: true, via: 'member' }
  const list: readonly ElevationTarget[] = Array.isArray(targets) ? targets : [targets as ElevationTarget] // as: Array.isArray does not narrow a readonly union
  let reason: Awaited<ReturnType<typeof hasElevatedAction>> | null = null
  for (const target of list) {
    const result = await checkAction(env, auth, action, target, opts)
    if (result.granted) return { ok: true, via: 'elevation', grant: result.grant }
    reason = result
  }
  const hint = elevationHint(opts.toolName)
  const denied = reason && !reason.granted ? reason.reason : 'no_matching_grant'
  return {
    ok: false,
    outcome: fail(403, opts.refusalCode, {
      elevation_denied: denied,
      remedy: elevationRemedyMessage(denied),
      ...(hint ? { hint } : {}),
    }),
  }
}

/**
 * withElevationReceipt — durable two-phase receipt around an elevated mutation
 * (PR #1831 F2). Call ONLY after authorization passed (a refused call writes
 * nothing). Order: INSERT a 'pending' elevation_usage_log row -> run `mutate`
 * -> resolve the row.
 *  - the pending INSERT fails: `mutate` is never called, the tool refuses.
 *  - `mutate` reports not-applied (or throws): the row becomes 'failed' with the
 *    error code (never left 'pending').
 *  - applied: when the mutation's own D1 batch carried the flip
 *    (inBatch: true, via appliedReceiptStatement) nothing more is written;
 *    otherwise the row is flipped to 'applied' right after the mutation.
 * A row that still ends up 'pending' is surfaced by elevation_status as
 * stuck_receipts after 10 minutes.
 */
export async function withElevationReceipt<R>(
  env: Env,
  auth: AuthContext,
  grant: ElevationGrantRecord,
  toolName: string,
  detail: unknown,
  mutate: (receiptId: string) => Promise<R>,
  classify: (result: R) => { applied: true } | { applied: false; code: string },
  opts: { inBatch?: boolean } = {},
): Promise<{ began: true; value: R } | { began: false; outcome: ToolOutcome }> {
  let receiptId: string
  try {
    receiptId = await beginElevationReceipt(env, auth.tenant, grant, toolName, detail)
  } catch {
    return { began: false, outcome: fail(500, 'elevation_receipt_failed', 'the elevation audit receipt could not be written; nothing was changed') }
  }
  let value: R
  try {
    value = await mutate(receiptId)
  } catch (err) {
    await finishElevationReceipt(env, receiptId, { status: 'failed', errorCode: 'exception' }).catch(() => undefined)
    throw err
  }
  const verdict = classify(value)
  if (!verdict.applied) {
    await finishElevationReceipt(env, receiptId, { status: 'failed', errorCode: verdict.code })
  } else if (!opts.inBatch) {
    await finishElevationReceipt(env, receiptId, { status: 'applied' })
  }
  return { began: true, value }
}
