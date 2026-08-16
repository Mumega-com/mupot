// /dashboard/approvals data layer — the gate queue (#6).
//
// Lists tasks sitting in status='review' that the CALLER may verdict:
//   - org owner/admin: every review task (same legacy bypass the verdict
//     endpoint uses — tasks/index.ts callerHoldsGateCapability)
//   - everyone else: only review tasks whose gate_owner capability has an
//     explicit gate_grants row for this principal (member or agent)
//
// Read-only. The verdict WRITE stays on POST /api/tasks/:id/verdict — this
// module never mutates; the page's buttons call the existing RBAC'd endpoint,
// so the queue UI cannot widen the gate's authority.

import type { Env, Task, AuthContext } from '../types'
import { CONTENT_GATE_OWNER } from '../agents/execute'
import { resolveGateOwners, type GateOwnerResolution } from '../gates/grants'

export interface ApprovalItem {
  id: string
  squad_id: string
  squad_name: string | null
  title: string
  body: string
  gate_owner: string | null
  assignee_agent_id: string | null
  agent_name: string | null
  result: string | null
  completed_at: string | null
  created_at: string
  // Flight-008 Slice 2 (mupot#1061, Safe Approvals Triage) — server-derived,
  // never placeholders. gate_owner_name/blocker_reason explain WHO must act
  // and WHY the row is waiting; can_verdict is the belt-and-suspenders twin of
  // the write-path RBAC (POST /api/tasks/:id/verdict) — the UI must never
  // offer Approve/Reject where the backend has no safe, named owner to honor.
  gate_owner_name: string | null
  blocker_reason: string
  can_verdict: boolean
}

// Raw column shape the two SELECTs below actually return — gate_owner_name/
// blocker_reason/can_verdict are computed afterward by decorateApprovals,
// never selected from D1 directly.
type ApprovalRow = Omit<ApprovalItem, 'gate_owner_name' | 'blocker_reason' | 'can_verdict'>

function holderNames(holders: readonly { displayName: string }[]): string {
  return holders.map((h) => h.displayName).join(', ')
}

/** Human-legible, per-row reason — never a generic placeholder ("blocked", ""). */
function blockerReason(gateOwner: string | null, resolution: GateOwnerResolution): string {
  if (resolution.resolvable) {
    return `Waiting on ${holderNames(resolution.holders)} (${gateOwner}) to approve or reject.`
  }
  switch (resolution.reason) {
    case 'absent':
      return 'Blocked — no gate owner is configured for this task; set gate_owner to route it for approval.'
    case 'no_grant':
      return `Blocked — nobody currently holds ${gateOwner}; grant it to a member or agent to unblock.`
    case 'inactive':
      return `Blocked — ${resolution.holders.length ? holderNames(resolution.holders) : 'the current holder'} of ${gateOwner} ${resolution.holders.length > 1 ? 'are' : 'is'} inactive; reassign the grant to unblock.`
    default:
      return `Blocked — ${gateOwner ?? 'this task'} has no resolvable owner.`
  }
}

/**
 * Decorate raw ApprovalRow rows with server-computed owner/reason/can_verdict.
 *
 * can_verdict mirrors the write-path's OWN authorization shape
 * (tasks/index.ts callerHoldsGateCapability), not just gate-owner
 * resolvability: an org owner/admin may verdict ANY review task via the
 * legacy bypass regardless of whether gate_owner resolves to a named holder
 * (see this file's header comment) — a row's blocker_reason still explains
 * the real gate-lane state (e.g. "nobody currently holds gate:routines") so
 * the admin isn't flying blind, but the control itself must not vanish for a
 * caller the backend would actually honor. Athena+River adversarial gate,
 * Flight-008 Slice 2 (mupot#1061): a prior version set can_verdict purely
 * from resolution.resolvable, which silently contradicted this module's own
 * documented owner/admin bypass and hung the Project-Routine E2E control
 * task's approve click (its gate, gate:routines, has zero grants in the
 * local/CI seed — the exact "wall with no door" case docs/gate-protocol.md
 * §10 records) — a real regression, not a fixture gap.
 *
 * For a non-admin caller, resolution.resolvable is still the correct and
 * sufficient signal: loadApprovals' non-admin branch already filters to rows
 * where EXISTS a gate_grants row for THIS principal, so if the capability's
 * only active holder(s) are empty here it means the row's one grant just
 * went inactive since the query ran (a genuine race, not a bug to bypass).
 */
async function decorateApprovals(env: Env, auth: AuthContext, items: ApprovalRow[]): Promise<ApprovalItem[]> {
  const resolutions = await resolveGateOwners(env, items.map((item) => item.gate_owner))
  const bypass = isOwnerAdmin(auth)
  return items.map((item) => {
    const resolution: GateOwnerResolution = item.gate_owner
      ? resolutions.get(item.gate_owner) ?? { resolvable: false, capability: item.gate_owner, reason: 'no_grant', holders: [] }
      : { resolvable: false, capability: null, reason: 'absent', holders: [] }
    return {
      ...item,
      gate_owner_name: resolution.resolvable ? holderNames(resolution.holders) : null,
      blocker_reason: blockerReason(item.gate_owner, resolution),
      can_verdict: bypass || resolution.resolvable,
    }
  })
}

// The gate queue only lists tasks that CAN be verdicted. A review task with a
// NULL gate_owner has no legal exit — the verdict endpoint 409s 'no_gate' and
// the state machine forbids review→open/in_progress — so surfacing it with an
// Approve button just hands the operator a 409. Filter it out at the source
// (both the owner/admin path and the gate-grant path inherit this).
const BASE_SELECT = `
  SELECT t.id, t.squad_id, s.name AS squad_name, t.title, t.body, t.gate_owner,
         t.assignee_agent_id, a.name AS agent_name, t.result, t.completed_at,
         t.created_at
    FROM tasks t
    LEFT JOIN squads s ON s.id = t.squad_id
    LEFT JOIN agents a ON a.id = t.assignee_agent_id
   WHERE t.status = 'review'
     AND t.gate_owner IS NOT NULL`

function isOwnerAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

// Tasks that cleared their gate (status='approved') and are content-publish work —
// awaiting the SEPARATE admin "Publish" action (flight-1 gap fix). Deliberately
// admin/owner-only visibility: this list feeds a button that fires a real external
// write (POST /admin/departments/:dept/execute/:gateId, which already enforces
// isAdmin server-side — src/dashboard/index.ts). Gating the query too means a
// non-admin never even sees the control, not just can't click it.
const PUBLISHABLE_SELECT = `
  SELECT t.id, t.squad_id, s.name AS squad_name, t.title, t.body, t.gate_owner,
         t.assignee_agent_id, a.name AS agent_name, t.result, t.completed_at,
         t.created_at
    FROM tasks t
    LEFT JOIN squads s ON s.id = t.squad_id
    LEFT JOIN agents a ON a.id = t.assignee_agent_id
   WHERE t.status = 'approved' AND t.gate_owner = ?1`

export async function loadApprovals(env: Env, auth: AuthContext): Promise<ApprovalItem[]> {
  if (isOwnerAdmin(auth)) {
    const rs = await env.DB.prepare(`${BASE_SELECT} ORDER BY t.created_at ASC`).all<ApprovalRow>()
    return decorateApprovals(env, auth, rs.results ?? [])
  }

  // Non-admin: visibility == verdict authority. Same principal resolution as
  // callerHoldsGateCapability (member tokens carry memberId; agent tokens carry
  // the agent id in userId).
  const principalId = auth.memberId ?? auth.userId
  const principalType: 'member' | 'agent' = auth.memberId ? 'member' : 'agent'
  if (!principalId) return []

  const rs = await env.DB.prepare(
    `${BASE_SELECT}
       AND EXISTS (
         SELECT 1 FROM gate_grants g
          WHERE g.capability     = t.gate_owner
            AND g.principal_type = ?1
            AND g.principal_id   = ?2
       )
     ORDER BY t.created_at ASC`,
  )
    .bind(principalType, principalId)
    .all<ApprovalRow>()
  return decorateApprovals(env, auth, rs.results ?? [])
}

// Approved content-publish tasks awaiting the admin's separate Publish click.
// Admin/owner only — see PUBLISHABLE_SELECT comment above. Non-admin callers get
// an empty list (not a 403): the page still renders, the section just stays empty,
// same shape as loadApprovals' non-admin path.
//
// These rows are past the verdict gate (status='approved') — Publish is a
// SEPARATE action (publishCardHtml/publishScript, its own admin-gated write
// path), so can_verdict is always false here and there is nothing left to
// "wait on" for a verdict; the fields are still populated (not omitted) so
// ApprovalItem stays one honest shape everywhere it is used.
export async function loadPublishable(env: Env, auth: AuthContext): Promise<ApprovalItem[]> {
  if (!isOwnerAdmin(auth)) return []
  const rs = await env.DB.prepare(`${PUBLISHABLE_SELECT} ORDER BY t.created_at ASC`)
    .bind(CONTENT_GATE_OWNER)
    .all<ApprovalRow>()
  return (rs.results ?? []).map((item) => ({
    ...item,
    gate_owner_name: null,
    blocker_reason: 'Approved — awaiting the separate Publish action.',
    can_verdict: false,
  }))
}

// Small pure helper for the result preview shown on queue cards.
export function resultPreview(task: Pick<Task, 'result'>, max = 600): string | null {
  if (!task.result) return null
  const text = task.result.trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}
