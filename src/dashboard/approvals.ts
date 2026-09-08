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
//
// mupot#1081 (can_verdict rebuild): every row here also carries can_verdict /
// can_approve / can_reject, computed by evaluateVerdictGates — the SAME
// predicate the write route (POST /:id/verdict) and its MCP twin
// (task_verdict) call. A prior version of this field
// (`can_verdict = isOwnerAdmin(auth) || resolution.resolvable`) was TRUE ON
// EVERY REACHABLE PATH: this module's own visibility filter (the EXISTS
// clause below) already guarantees a non-admin caller's own grant exists, so
// a predicate built only from "does a grant exist" could never see a caller
// it should refuse. Modeling the REAL write-path gates (squad scope, gate
// ownership incl. the self-completion special case, the gate:loops surface
// cap, and self-verdict) is what makes the FALSE branch reachable — e.g. an
// org owner who is also the task's assignee (self-verdict), or a caller who
// holds gate:loops but not outreach:send-gated (surface cap) — see
// tests/tasks-verdict-gates.test.ts and tests/dashboard-approvals-can-verdict.test.ts.

import type { Env, Task, AuthContext } from '../types'
import { CONTENT_GATE_OWNER } from '../agents/execute'
import { canActOnSquad, evaluateVerdictGates, createVerdictGateCache } from '../tasks/index'
import { resolveGatePrincipal } from '../gates/principal'

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
  // mupot#1081 — see module header. can_verdict = can_approve || can_reject;
  // kept as its own field because the card/queue UI decides whether to render
  // ANY action affordance at all (vs. the specific Approve/Reject buttons)
  // from this one flag.
  //
  // DELIBERATELY UNMODELED (named explicitly so this stays a documented gap,
  // not a silent one — #1081's own point is that an unguarded invariant is a
  // trap): can_approve/can_reject do NOT check the two gates that live INSIDE
  // writeVerdict (src/tasks/service.ts) rather than in the RBAC section any
  // caller evaluates up front —
  //   1. squadCanWriteProjectEvidence / TaskEvidenceFenceError (403): the
  //      task's owning squad may have lost write/admin on its project since
  //      the row was queried.
  //   2. the K5 conditional `UPDATE tasks ... WHERE status='review'` /
  //      VerdictRaceError (409): another verdict may have already landed
  //      concurrently.
  // Consequence: a row this module marks can_approve/can_reject:true can
  // still 403 or 409 at write time on either of these two paths — the queue
  // is not a hard guarantee against those two specific failures, only
  // against the five RBAC gates evaluateVerdictGates + canActOnSquad model.
  // #1081 named both as "Also unmodeled" and did not ask for them to be
  // hoisted; matches that scope.
  can_verdict: boolean
  can_approve: boolean
  can_reject: boolean
}

// A raw queue/publishable row as SELECTed from D1, before the verdict-gate
// fields are computed (decorateApprovals) or deliberately omitted
// (PublishableItem — see below). Never constructed with can_verdict/
// can_approve/can_reject already on it.
type ApprovalRow = Omit<ApprovalItem, 'can_verdict' | 'can_approve' | 'can_reject'>

// Approved content-publish tasks (loadPublishable) are past the verdict gate
// entirely — Publish is a separate admin action, unrelated to can_verdict.
// mupot#1081 flagged the PRIOR shape (ApprovalItem.can_verdict hardcoded
// false on these rows) as a "trap": mutation M8 (false -> true) SURVIVED the
// whole suite because publishCardHtml never read the field — an unguarded,
// unread invariant carries no safety property at all, it just LOOKS like one.
// The fix is to not carry the field here rather than to carry it unread:
// PublishableItem has no can_verdict/can_approve/can_reject at all, so
// publishCardHtml's parameter type makes "read a verdict flag on a
// publishable row" a compile error, not a silent no-op.
export type PublishableItem = ApprovalRow

function isOwnerAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

// The gate queue only lists tasks that CAN be verdicted. A review task with a
// NULL gate_owner has no legal exit — the verdict endpoint 409s 'no_gate' and
// the state machine forbids review→open/in_progress — so surfacing it with an
// Approve button just hands the operator a 409. Filter it out at the source
// (both the owner/admin path and the gate-grant path inherit this).
//
// mupot#1319 gate BLOCK-1 (round 1): BOUNDED at APPROVALS_QUEUE_LIMIT display
// rows. Before this fix there was no LIMIT at all, and decorateApprovals
// fans out up to 4 D1 calls per row (measured 4.00/row on a gate:loops-heavy
// fixture) through an unbounded Promise.all — an operator with ~250 pending
// rows was issuing ~1000 D1 calls rendering ONE page load.
//
// mupot#1319 round 2, Codex FINDING 3 (CORRECTED — round 1 applied the LIMIT
// in SQL, oldest-first, BEFORE eligibility ever ran): that was starvation,
// and silently wrong, which is worse than the fan-out it replaced. A
// non-admin caller with APPROVALS_QUEUE_LIMIT+ OLD review rows they can no
// longer action (lost squad access; a stale gate grant the EXISTS clause
// below cannot see is inactive) had those unactionable rows consume the
// ENTIRE returned window — newer rows they COULD actually verdict never
// appeared in the queue at all, and nothing told the operator this was
// happening.
//
// Fix: fetch a larger CANDIDATE window (APPROVALS_FETCH_CEILING, itself a
// hard bound so this cannot degrade back to unbounded), decorate ALL of it,
// then select ACTIONABLE rows first regardless of their position in that
// candidate window — see selectQueueWindow below. Decorating up to 5x more
// candidate rows is now cheap: BLOCK-1's cache fix (deptCache / gateCache)
// makes decoration cost O(distinct squad/gate), not O(rows), so widening the
// candidate window barely changes D1 call count — it only does more
// (already-cheap) JS-side filtering.
//
// Residual, DOCUMENTED limit, not a full fix: if more than
// APPROVALS_FETCH_CEILING consecutive OLDEST rows are ALL unactionable, an
// actionable row beyond the ceiling still will not appear. Closing that
// completely would require re-implementing evaluateVerdictGates' full RBAC
// (squad-scope + department inheritance, gate ownership including the
// self-completion special case, the gate:loops surface cap, self-verdict) as
// SQL — duplicating, in a second language, the exact predicate this whole
// flight exists to keep singular. The ceiling is deliberately generous (5x
// the display limit) specifically because decoration is now cheap; widening
// it further narrows the residual window at near-zero added D1 cost.
export const APPROVALS_QUEUE_LIMIT = 200
export const APPROVALS_FETCH_CEILING = APPROVALS_QUEUE_LIMIT * 5

const BASE_SELECT = `
  SELECT t.id, t.squad_id, s.name AS squad_name, t.title, t.body, t.gate_owner,
         t.assignee_agent_id, a.name AS agent_name, t.result, t.completed_at,
         t.created_at
    FROM tasks t
    LEFT JOIN squads s ON s.id = t.squad_id
    LEFT JOIN agents a ON a.id = t.assignee_agent_id
   WHERE t.status = 'review'
     AND t.gate_owner IS NOT NULL`

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

// Compute can_approve/can_reject per row via the SAME predicate the write
// route calls (evaluateVerdictGates), PLUS the squad-scope check the write
// route also runs separately (canActOnSquad) — #1081's read-side finding was
// that squad scope was entirely unmodeled on this side (gate grants are
// org-global; canActOnSquad is squad-scoped, so a caller can hold a gate
// grant for a squad they are no longer a member of). Every row here already
// has a non-null gate_owner (BASE_SELECT's WHERE clause), so the narrowing
// is safe without a runtime guard.
// mupot#1319 gate BLOCK-1: deptCache and gateCache are created ONCE per
// loadApprovals() call and threaded through every row (and, for gateCache,
// both verdicts of every row) — see canActOnSquad's and evaluateVerdictGates'
// own doc comments for exactly what each memoizes and why it is safe (both
// are scoped to this one function call, discarded after, never shared across
// requests or callers).
async function decorateApprovals(env: Env, auth: AuthContext, rows: ApprovalRow[]): Promise<ApprovalItem[]> {
  const deptCache = new Map<string, Promise<string | null>>()
  const gateCache = createVerdictGateCache()
  return Promise.all(
    rows.map(async (row) => {
      const gateOwner = row.gate_owner
      if (!gateOwner || !(await canActOnSquad(env, auth, row.squad_id, 'member', deptCache))) {
        return { ...row, can_verdict: false, can_approve: false, can_reject: false }
      }
      const task = { squad_id: row.squad_id, gate_owner: gateOwner, assignee_agent_id: row.assignee_agent_id }
      const [approveResult, rejectResult] = await Promise.all([
        evaluateVerdictGates(env, auth, task, 'approved', gateCache),
        evaluateVerdictGates(env, auth, task, 'rejected', gateCache),
      ])
      const can_approve = approveResult.allowed
      const can_reject = rejectResult.allowed
      return { ...row, can_verdict: can_approve || can_reject, can_approve, can_reject }
    }),
  )
}

// mupot#1319 round 2, Codex FINDING 3 + FINDING 4/2: the caller-facing result
// of loadApprovals. `items` is what renders (actionable rows ALWAYS placed
// ahead of informational ones — see selectQueueWindow), `actionableCount` is
// the number this module's OWN documented contract promises ("needs your
// decision — the only tasks a verdict endpoint will actually accept"), and
// `actionableCountIsLowerBound` is the honesty signal every KPI surface must
// render instead of a bare, possibly-wrong exact number.
export interface ApprovalsQueue {
  items: ApprovalItem[]
  /** Count of can_verdict:true rows actually present in `items` — NOT
   *  items.length, which also counts informational (unactionable) rows. */
  actionableCount: number
  /** True when actionableCount is a LOWER BOUND, not the exact total:
   *  either actionable rows alone filled the APPROVALS_QUEUE_LIMIT display
   *  window (more may exist beyond it), or the underlying candidate fetch
   *  hit APPROVALS_FETCH_CEILING before exhausting the table (more
   *  actionable rows, of any age, may exist beyond the fetched window
   *  entirely — see APPROVALS_FETCH_CEILING's doc comment). A surface that
   *  cannot express "at least N" must say so rather than print this count
   *  as if it were exact. */
  actionableCountIsLowerBound: boolean
}

// Select the displayed window from a fully-decorated CANDIDATE set (already
// bounded at APPROVALS_FETCH_CEILING by the SQL LIMIT below). Actionable rows
// are placed first, in their original (oldest-first) relative order, so an
// actionable row is NEVER crowded out of the display window by an
// unactionable one merely because the unactionable one is older — that
// crowding-out was Codex FINDING 3. Informational rows fill any remaining
// space, oldest first, for context only (no action renders on them).
export function selectQueueWindow(decorated: ApprovalItem[]): ApprovalsQueue {
  const actionable = decorated.filter((t) => t.can_verdict)
  const informational = decorated.filter((t) => !t.can_verdict)
  const items = [...actionable, ...informational].slice(0, APPROVALS_QUEUE_LIMIT)
  const actionableCountIsLowerBound =
    actionable.length > APPROVALS_QUEUE_LIMIT || decorated.length >= APPROVALS_FETCH_CEILING
  return {
    items,
    actionableCount: Math.min(actionable.length, APPROVALS_QUEUE_LIMIT),
    actionableCountIsLowerBound,
  }
}

export async function loadApprovals(env: Env, auth: AuthContext): Promise<ApprovalsQueue> {
  if (isOwnerAdmin(auth)) {
    const rs = await env.DB.prepare(`${BASE_SELECT} ORDER BY t.created_at ASC LIMIT ?1`)
      .bind(APPROVALS_FETCH_CEILING)
      .all<ApprovalRow>()
    const decorated = await decorateApprovals(env, auth, rs.results ?? [])
    return selectQueueWindow(decorated)
  }

  const principal = resolveGatePrincipal(auth)
  if (!principal) return { items: [], actionableCount: 0, actionableCountIsLowerBound: false }

  const rs = await env.DB.prepare(
    `${BASE_SELECT}
       AND EXISTS (
         SELECT 1 FROM gate_grants g
          WHERE g.capability     = t.gate_owner
            AND g.principal_type = ?1
            AND g.principal_id   = ?2
       )
     ORDER BY t.created_at ASC LIMIT ?3`,
  )
    .bind(principal.type, principal.id, APPROVALS_FETCH_CEILING)
    .all<ApprovalRow>()
  const decorated = await decorateApprovals(env, auth, rs.results ?? [])
  return selectQueueWindow(decorated)
}

// Approved content-publish tasks awaiting the admin's separate Publish click.
// Admin/owner only — see PUBLISHABLE_SELECT comment above. Non-admin callers get
// an empty list (not a 403): the page still renders, the section just stays empty,
// same shape as loadApprovals' non-admin path. No verdict-gate fields — see
// PublishableItem's doc comment above (mupot#1081).
export async function loadPublishable(env: Env, auth: AuthContext): Promise<PublishableItem[]> {
  if (!isOwnerAdmin(auth)) return []
  const rs = await env.DB.prepare(`${PUBLISHABLE_SELECT} ORDER BY t.created_at ASC`)
    .bind(CONTENT_GATE_OWNER)
    .all<PublishableItem>()
  return rs.results ?? []
}

// Small pure helper for the result preview shown on queue cards.
export function resultPreview(task: Pick<Task, 'result'>, max = 600): string | null {
  if (!task.result) return null
  const text = task.result.trim()
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}
