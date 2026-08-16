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

/** Human-legible, per-row reason — never a generic placeholder ("blocked", ""). */
function blockerReason(gateOwner: string | null, resolution: GateOwnerResolution): string {
  if (resolution.resolvable) {
    return `Waiting on ${resolution.holder.displayName} (${gateOwner}) to approve or reject.`
  }
  switch (resolution.reason) {
    case 'absent':
      return 'Blocked — no gate owner is configured for this task; set gate_owner to route it for approval.'
    case 'no_grant':
      return `Blocked — nobody currently holds ${gateOwner}; grant it to a member or agent to unblock.`
    case 'multiple_grants':
      return `Blocked — ${gateOwner} is granted to more than one principal; narrow it to a single owner to unblock.`
    case 'inactive':
      return `Blocked — ${resolution.holder?.displayName ?? 'the current holder'} of ${gateOwner} is inactive; reassign the grant to unblock.`
    default:
      return `Blocked — ${gateOwner ?? 'this task'} has no resolvable owner.`
  }
}

/** Decorate raw ApprovalRow rows with server-computed owner/reason/can_verdict. */
async function decorateApprovals(env: Env, items: ApprovalRow[]): Promise<ApprovalItem[]> {
  const resolutions = await resolveGateOwners(env, items.map((item) => item.gate_owner))
  return items.map((item) => {
    const resolution: GateOwnerResolution = item.gate_owner
      ? resolutions.get(item.gate_owner) ?? { resolvable: false, capability: item.gate_owner, reason: 'no_grant', holder: null }
      : { resolvable: false, capability: null, reason: 'absent', holder: null }
    return {
      ...item,
      gate_owner_name: resolution.resolvable ? resolution.holder.displayName : null,
      blocker_reason: blockerReason(item.gate_owner, resolution),
      can_verdict: resolution.resolvable,
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
    return decorateApprovals(env, rs.results ?? [])
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
  return decorateApprovals(env, rs.results ?? [])
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
