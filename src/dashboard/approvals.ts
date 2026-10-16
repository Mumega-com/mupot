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

import type { Env, Task, AuthContext, OrgKind } from '../types'
import { CONTENT_GATE_OWNER } from '../agents/execute'
import { canActOnSquad, evaluateVerdictGates, createVerdictGateCache, primeVerdictIndependence } from '../tasks/index'
import { hasDedicatedGatePredicate } from '../tasks/service'
import { resolveGatePrincipal } from '../gates/principal'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { resolveVisibleTaskScope, visibleTaskClause } from '../tasks/visibility'
import { GATE_ASK_LIVE_PREDICATE } from '../gates/approval-expiry-rule'

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
  /** Last touch — drives the "Older" display partition. Optional: only the live queue selects it. */
  updated_at?: string
  /** True when the VIEWER holds a gate_grants row for this task's gate (resolved
   *  through gate_grants + resolveGatePrincipal, never a name match). */
  own_gate?: boolean
  /** REVIEW_ENTERED_AT_SQL — when the task entered review (drives age, Older, sort). */
  review_entered_at?: string
  /** tasks.priority: P0..P3, null = untriaged. */
  priority?: 'P0' | 'P1' | 'P2' | 'P3' | null
  project_id?: string | null
  project_name?: string | null
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

// Staleness is a DISPLAY partition, never a filter: an item untouched for
// APPROVAL_OLDER_DAYS moves into a collapsed "Older" section that KEEPS its
// approve/reject buttons. Nothing is hidden or made read-only by age.
// 7d: strictly BELOW the 14d expiry window (APPROVAL_EXPIRY.gate_verdict_days), so "Older" is a live
// warning state, not a section that can never populate (an ask older than 14d is expired and swept).
export const APPROVAL_OLDER_DAYS = 7
export const APPROVAL_HISTORY_PAGE_SIZE = 20
export const APPROVAL_LIVE_LIST_CAP = 20

// When did this task ENTER review? tasks.review_entered_at (migrations/0232), stamped by trigger on
// every transition into review: the ONE review-entry fragment, shared with the expiry predicate
// (src/gates/approval-expiry-rule.ts reads the same column). The fallbacks only cover a row that
// predates the column and was never backfilled.
export const REVIEW_ENTERED_AT_SQL = `COALESCE(t.review_entered_at, t.updated_at, t.created_at)`

export function isOlderItem(t: Pick<ApprovalItem, 'review_entered_at' | 'updated_at' | 'created_at'>, nowMs = Date.now()): boolean {
  const touched = Date.parse(t.review_entered_at ?? t.updated_at ?? t.created_at)
  // Unparseable timestamp => treated as older (collapsed, still actionable).
  return !Number.isFinite(touched) || nowMs - touched > APPROVAL_OLDER_DAYS * 86_400_000
}

const BASE_SELECT = `
  SELECT t.id, t.squad_id, s.name AS squad_name, t.title, t.body, t.gate_owner,
         t.assignee_agent_id, a.name AS agent_name, t.result, t.completed_at,
         t.created_at, t.updated_at, ${REVIEW_ENTERED_AT_SQL} AS review_entered_at,
         t.priority, t.project_id, pr.name AS project_name
    FROM tasks t
    LEFT JOIN squads s ON s.id = t.squad_id
    LEFT JOIN agents a ON a.id = t.assignee_agent_id
    LEFT JOIN projects pr ON pr.id = t.project_id
   WHERE t.status = 'review'
     AND t.gate_owner IS NOT NULL
     AND ${TASK_NOT_ARCHIVED_SQL('t')}
     AND ${GATE_ASK_LIVE_PREDICATE('t', "datetime('now')")}`

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
   WHERE t.status = 'approved' AND t.gate_owner = ?1
     AND ${TASK_NOT_ARCHIVED_SQL('t')}`

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
  const deptCache = new Map<string, Promise<{ department_id: string; kind: OrgKind } | null>>()
  const gateCache = createVerdictGateCache()
  // One independence read for the whole window (policy rule 3), not one per row.
  await primeVerdictIndependence(env, auth, gateCache, rows.filter((r) => r.gate_owner).map((r) => r.id))
  return Promise.all(
    rows.map(async (row) => {
      const gateOwner = row.gate_owner
      if (!gateOwner || !(await canActOnSquad(env, auth, row.squad_id, 'member', deptCache))) {
        return { ...row, can_verdict: false, can_approve: false, can_reject: false }
      }
      // mupot#1592 NEW-2: a gate namespace with its OWN dedicated verdict tool
      // (today: gate:office → office.review_approval) can never be decided
      // through the generic verdict route this dashboard's Approve/Reject
      // buttons POST to (src/tasks/service.ts's writeVerdict now refuses it
      // outright) — mirror that here so the dashboard never renders a button
      // that always 409s. Structurally absent, not disabled, matching this
      // module's own can_verdict/can_approve/can_reject contract.
      if (hasDedicatedGatePredicate(gateOwner)) {
        return { ...row, can_verdict: false, can_approve: false, can_reject: false }
      }
      const task = { id: row.id, squad_id: row.squad_id, gate_owner: gateOwner, assignee_agent_id: row.assignee_agent_id }
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
  /** can_verdict rows in `items` whose gate the VIEWER holds a grant for — the sidebar/page badge.
   *  The ONE "waiting on you" number: read it through waitingOnYou(), never re-derive it. */
  ownCount: number
  /** True when ownCount is a LOWER BOUND (own rows filled the display window, or the candidate
   *  fetch hit APPROVALS_FETCH_CEILING). Independent of the org-wide actionableCountIsLowerBound:
   *  the "+" on the badge follows the OWN count, not the all-gate total. */
  ownCountIsLowerBound: boolean
}

/** THE "waiting on you" number every member-facing surface (badge JSON, /approvals header,
 *  Home KPI, Health) must use. The all-gate total (actionableCount) is an org-wide figure and
 *  must be labelled "across all reviewers" wherever it is shown. */
export function waitingOnYou(q: Pick<ApprovalsQueue, 'ownCount' | 'ownCountIsLowerBound'>): { count: number; isLowerBound: boolean } {
  return { count: q.ownCount, isLowerBound: q.ownCountIsLowerBound }
}

// Select the displayed window from a fully-decorated CANDIDATE set (already
// bounded at APPROVALS_FETCH_CEILING by the SQL LIMIT below). Actionable rows
// are placed first, in their original (oldest-first) relative order, so an
// actionable row is NEVER crowded out of the display window by an
// unactionable one merely because the unactionable one is older — that
// crowding-out was Codex FINDING 3. Informational rows fill any remaining
// space, oldest first, for context only (no action renders on them).
export function selectQueueWindow(decorated: ApprovalItem[]): ApprovalsQueue {
  const isOwn = (t: ApprovalItem): boolean => t.can_verdict && t.own_gate === true
  const own = decorated.filter(isOwn)
  const otherActionable = decorated.filter((t) => t.can_verdict && !isOwn(t))
  const informational = decorated.filter((t) => !t.can_verdict)
  // Own-gate rows lead the window so the own count (the badge) is never crowded out by
  // another reviewer's actionable rows; each group keeps its oldest-first order.
  const items = [...own, ...otherActionable, ...informational].slice(0, APPROVALS_QUEUE_LIMIT)
  const truncated = decorated.length >= APPROVALS_FETCH_CEILING
  return {
    items,
    actionableCount: Math.min(own.length + otherActionable.length, APPROVALS_QUEUE_LIMIT),
    actionableCountIsLowerBound: own.length + otherActionable.length > APPROVALS_QUEUE_LIMIT || truncated,
    ownCount: Math.min(own.length, APPROVALS_QUEUE_LIMIT),
    ownCountIsLowerBound: own.length > APPROVALS_QUEUE_LIMIT || truncated,
  }
}

export async function loadApprovals(env: Env, auth: AuthContext): Promise<ApprovalsQueue> {
  if (isOwnerAdmin(auth)) {
    // own_gate: does the VIEWER hold a gate_grants row for this task's gate.
    const ownPrincipal = resolveGatePrincipal(auth)
    const rs = ownPrincipal
      ? await env.DB.prepare(
        `SELECT q.*, EXISTS (SELECT 1 FROM gate_grants g WHERE g.capability = q.gate_owner
                               AND g.principal_type = ?2 AND g.principal_id = ?3) AS own_gate
           FROM (${BASE_SELECT} ORDER BY t.created_at ASC LIMIT ?1) q`,
      ).bind(APPROVALS_FETCH_CEILING, ownPrincipal.type, ownPrincipal.id).all<Omit<ApprovalRow, 'own_gate'> & { own_gate: number }>()
      : await env.DB.prepare(`${BASE_SELECT} ORDER BY t.created_at ASC LIMIT ?1`)
        .bind(APPROVALS_FETCH_CEILING)
        .all<Omit<ApprovalRow, 'own_gate'> & { own_gate: number }>()
    const decorated = await decorateApprovals(env, auth, (rs.results ?? []).map((r) => ({ ...r, own_gate: Boolean(r.own_gate) })))
    return selectQueueWindow(decorated)
  }

  const principal = resolveGatePrincipal(auth)
  if (!principal) return { items: [], actionableCount: 0, actionableCountIsLowerBound: false, ownCount: 0, ownCountIsLowerBound: false }

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
  // Non-admin: the EXISTS above already means every row is a gate the viewer holds.
  const decorated = await decorateApprovals(env, auth, (rs.results ?? []).map((r) => ({ ...r, own_gate: true })))
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


// ── history (?view=history) ──────────────────────────────────────────────────
// Expired-but-still-pending items and decided items, newest first, read-only.
// Same RBAC scoping as the live queue (owner/admin: all; others: gate_grants).

export interface ApprovalHistoryRow {
  id: string
  title: string
  gate_owner: string | null
  squad_name: string | null
  agent_name: string | null
  at: string
  verdict: 'approved' | 'rejected' | null
}

export interface ApprovalHistoryPage {
  rows: ApprovalHistoryRow[]
  page: number
  hasMore: boolean
}

export interface ApprovalsSummary {
  decidedThisWeek: number
}

function scopeFor(auth: AuthContext): { sql: string; binds: unknown[]; next: number } | null {
  if (isOwnerAdmin(auth)) return { sql: '', binds: [], next: 1 }
  const principal = resolveGatePrincipal(auth)
  if (!principal) return null
  return {
    sql: `AND EXISTS (SELECT 1 FROM gate_grants g WHERE g.capability = t.gate_owner AND g.principal_type = ?1 AND g.principal_id = ?2)`,
    binds: [principal.type, principal.id],
    next: 3,
  }
}

/** Decided items, newest first, read-only. Same RBAC scoping as the live queue. */
export async function loadApprovalsHistory(env: Env, auth: AuthContext, page = 1): Promise<ApprovalHistoryPage> {
  const safePage = Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1
  const scope = scopeFor(auth)
  if (!scope) return { rows: [], page: safePage, hasMore: false }
  const rs = await env.DB.prepare(
    `SELECT t.id, t.title, t.gate_owner, s.name AS squad_name, a.name AS agent_name,
            v.decided_at AS at, v.verdict AS verdict
       FROM task_verdicts v
       JOIN tasks t ON t.id = v.task_id
       LEFT JOIN squads s ON s.id = t.squad_id
       LEFT JOIN agents a ON a.id = t.assignee_agent_id
      WHERE t.gate_owner IS NOT NULL AND t.status <> 'review'
        AND v.decided_at = (SELECT MAX(v2.decided_at) FROM task_verdicts v2 WHERE v2.task_id = v.task_id)
        AND ${TASK_NOT_ARCHIVED_SQL('t')} ${scope.sql}
      ORDER BY v.decided_at DESC, t.id LIMIT ?${scope.next} OFFSET ?${scope.next + 1}`,
  )
    .bind(...scope.binds, APPROVAL_HISTORY_PAGE_SIZE + 1, (safePage - 1) * APPROVAL_HISTORY_PAGE_SIZE)
    .all<ApprovalHistoryRow>()
  const all = rs.results ?? []
  return { rows: all.slice(0, APPROVAL_HISTORY_PAGE_SIZE), page: safePage, hasMore: all.length > APPROVAL_HISTORY_PAGE_SIZE }
}

/** The one quiet line under the list: decided this week. */
export async function loadApprovalsSummary(env: Env, auth: AuthContext): Promise<ApprovalsSummary> {
  const scope = scopeFor(auth)
  if (!scope) return { decidedThisWeek: 0 }
  const decided = await env.DB.prepare(
    `SELECT COUNT(DISTINCT v.task_id) AS n
       FROM task_verdicts v JOIN tasks t ON t.id = v.task_id
      WHERE t.gate_owner IS NOT NULL AND t.status <> 'review'
        AND COALESCE(julianday(v.decided_at) > julianday('now') - 7, 0) = 1
        AND ${TASK_NOT_ARCHIVED_SQL('t')} ${scope.sql}`,
  ).bind(...scope.binds).first<{ n: number }>()
  return { decidedThisWeek: Number(decided?.n ?? 0) }
}


// ── "You asked" (?tab=sent): asks the VIEWER originated, read-only ───────────
// A READ filter, deliberately NOT the verdict-independence rule (that rule is built to REFUSE
// a verdict; reused as a read filter it matched bindings, agent_keys and past submitters/
// runners and leaked titles across squads). The ask is the viewer's when:
//   - the task is assigned to the viewer as a human (assignee_member_id), or
//   - it is assigned to an agent whose agents.owner_member_id IS the viewer (shown "assigned to your agent <agent>", since someone else may have created the task).
// AND the viewer can read the task's squad (resolveVisibleTaskScope/visibleTaskClause, the
// task-list read fence, which also hides archived tasks). Exactly one fragment, named here so
// it is one mutation target. ?1 = viewer member id.
export const ASK_ORIGINATED_BY_VIEWER_SQL =
  `(t.assignee_member_id = ?1 OR t.assignee_agent_id IN (SELECT oa.id FROM agents oa WHERE oa.owner_member_id = ?1))`

export type AskState = 'waiting' | 'approved' | 'rejected'

export interface AskItem {
  id: string
  title: string
  body: string
  gate_owner: string | null
  priority: 'P0' | 'P1' | 'P2' | 'P3' | null
  project_id: string | null
  project_name: string | null
  assignee_agent_id: string | null
  agent_name: string | null
  review_entered_at: string
  created_at: string
  updated_at: string
  state: AskState
  /** Set when the ask is the viewer's via an agent they own (not directly theirs). */
  via_agent: string | null
}

export const ASKS_LIMIT = 200

export async function loadAsks(env: Env, auth: AuthContext): Promise<AskItem[]> {
  // Only a real member id can originate; an agent/anonymous principal has no "my asks".
  if (!auth.memberId) return []
  const visible = visibleTaskClause(await resolveVisibleTaskScope(env, auth), 2, 't')
  const rs = await env.DB.prepare(
    `SELECT t.id, t.title, t.body, t.gate_owner, t.priority, t.project_id, pr.name AS project_name,
            t.assignee_agent_id, a.name AS agent_name, t.status, t.created_at, t.updated_at,
            ${REVIEW_ENTERED_AT_SQL} AS review_entered_at, t.assignee_member_id
       FROM tasks t
       LEFT JOIN agents a ON a.id = t.assignee_agent_id
       LEFT JOIN projects pr ON pr.id = t.project_id
      WHERE t.status IN ('review', 'approved', 'rejected') AND t.gate_owner IS NOT NULL
        AND ${visible.sql}
        AND ${ASK_ORIGINATED_BY_VIEWER_SQL}
      ORDER BY CASE t.status WHEN 'review' THEN 0 ELSE 1 END, t.updated_at DESC, t.id
      LIMIT ?${String(2 + visible.binds.length)}`,
  ).bind(auth.memberId, ...visible.binds, ASKS_LIMIT).all<Omit<AskItem, 'state' | 'via_agent'> & { status: string; assignee_member_id: string | null }>()
  return (rs.results ?? []).map((r) => ({
    id: r.id, title: r.title, body: r.body, gate_owner: r.gate_owner, priority: r.priority,
    project_id: r.project_id, project_name: r.project_name, assignee_agent_id: r.assignee_agent_id,
    agent_name: r.agent_name, review_entered_at: r.review_entered_at, created_at: r.created_at, updated_at: r.updated_at,
    state: r.status === 'review' ? 'waiting' : r.status === 'approved' ? 'approved' : 'rejected',
    // tasks.task_single_assignee makes assignee_agent_id and assignee_member_id mutually
    // exclusive, and the only agent leg that includes a row is "assignee agent owned by the
    // viewer": a non-null assignee agent IS the agent that matched; a direct ask has none.
    via_agent: r.assignee_agent_id === null ? null : (r.agent_name ?? r.assignee_agent_id),
  }))
}
