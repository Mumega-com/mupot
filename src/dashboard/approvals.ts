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
    const rs = await env.DB.prepare(`${BASE_SELECT} ORDER BY t.created_at ASC`).all<ApprovalItem>()
    return rs.results ?? []
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
    .all<ApprovalItem>()
  return rs.results ?? []
}

// Approved content-publish tasks awaiting the admin's separate Publish click.
// Admin/owner only — see PUBLISHABLE_SELECT comment above. Non-admin callers get
// an empty list (not a 403): the page still renders, the section just stays empty,
// same shape as loadApprovals' non-admin path.
export async function loadPublishable(env: Env, auth: AuthContext): Promise<ApprovalItem[]> {
  if (!isOwnerAdmin(auth)) return []
  const rs = await env.DB.prepare(`${PUBLISHABLE_SELECT} ORDER BY t.created_at ASC`)
    .bind(CONTENT_GATE_OWNER)
    .all<ApprovalItem>()
  return rs.results ?? []
}

// Small pure helper for the result preview shown on queue cards.
export function resultPreview(task: Pick<Task, 'result'>, max = 600): string | null {
  if (!task.result) return null
  const text = task.result.trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}
