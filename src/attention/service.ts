import type { AuthContext, Env, OrgKind } from '../types'
import { brandSquadScope, hasCapability, planeCoversScope } from '../auth/capability'
import { CONTENT_GATE_OWNER } from '../agents/execute'
import { projectVisibilityClause } from '../projects/access'
import { BREAKER_EXEMPT_STATUSES, CYCLE_INSTANCE_PREFIX, RECOMMIT_OR_KILL_STEP } from '../projects/circuit-breaker'
import {
  DEFAULT_STALL_THRESHOLD_DAYS,
  idleDurationDays,
  isPastStallThreshold,
  lastActivityFromSignals,
  loadProjectIdleSignals,
  resolveStallThresholdDays,
} from '../projects/stall-detector'
import type { RoutinePrincipal } from '../routines/access'
import { routineTablesReady } from '../routines/schema-ready'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { createVerdictGateCache, evaluateVerdictGates, type VerdictGateCache } from '../tasks/index'
import { canReadSquadTasks } from '../tasks/visibility'
import { humanGateHolderExistsSql } from '../tasks/runtime-receipts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SOURCE_SCAN_CAP = 100
const CURSOR_TTL_SECONDS = 600
/** Warning window for the recommit-due source's BOUNDARY trigger — matches
 *  the "72h heads-up" requirement (mupot#lifecycle-warning). A row also
 *  appears once already overdue (boundary in the past), which this same
 *  "<= threshold" test covers. This is one of TWO independent triggers — see
 *  the IDLE trigger below, which fires regardless of boundary distance
 *  because shouldEvaluateBreaker's stalled=1 early-raise does too. */
const RECOMMIT_DUE_WINDOW_MS = 72 * 60 * 60 * 1000
/** Inside this window (or already overdue) a recommit-due row is 'urgent' rather than 'high'. */
const RECOMMIT_URGENT_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * IDLE trigger lead time (round 2, mupot PR #1533 — adversarial P0-1).
 * shouldEvaluateBreaker (circuit-breaker.ts) early-raises the breaker the
 * MOMENT projects.stalled flips to 1, in the SAME cron tick as the stall
 * detector sets it (runProjectLoopTick runs stall-detect then breaker,
 * back to back) — there is no gap between "just became stalled" and
 * "circuit breaker evaluates it" to warn inside. A boundary-only warning
 * (RECOMMIT_DUE_WINDOW_MS above) misses this entirely whenever the real
 * cycle_boundary_at is far in the future (the probe that found this: an
 * idle active project with boundary +30d went from 0 needs_you items to
 * stall_flagged:1 + killed:1 + archived in ONE tick).
 *
 * The fix warns BEFORE the flag flips: once a project's live idle duration
 * (computed with the stall detector's OWN functions below, never a second
 * copy) is within this many days of its stall threshold, it is due — even
 * though projects.stalled is still 0 and cycle_boundary_at may be weeks out.
 */
const STALL_WARNING_LEAD_DAYS = 2

/**
 * Needs You urgency + staleness rule (mupot#1688). ONE rule for every task-
 * backed source (approvals, blocked work, publishable output), computed in SQL
 * so the keyset cursor orders by exactly what is displayed:
 *
 *   base    task.priority  P0 -> urgent(0), P1 -> high(1), P2 / unset -> normal(2), P3 -> low(3)
 *   bump    one level up (never past urgent) for each of:
 *             - waiting >= NEEDS_YOU_AGE_BUMP_DAYS[0] days (3)   -> +1
 *             - waiting >= NEEDS_YOU_AGE_BUMP_DAYS[1] days (7)   -> +2 (replaces the +1)
 *             - the project target_date is within NEEDS_YOU_DUE_BUMP_DAYS (2) of now or past -> +1
 *           total bump is capped at 2 levels, so a low-priority old item reads 'high' at most.
 *   stale   waiting >= NEEDS_YOU_STALE_DAYS (14): the age bump no longer applies (it is no
 *           longer 'getting worse', it is old) and the item sorts AFTER every non-stale item
 *           (sort rank + NEEDS_YOU_STALE_RANK_OFFSET) and reports stale:true — the UI groups
 *           it as 'older'. Nothing is auto-dismissed or hidden.
 *
 * Routine waits keep their own wait-reason rank (0 for approval/review/budget, 1 for
 * agent/answer) and only gain the stale grouping. Recommit-due keeps its deadline-driven rank.
 */
export const NEEDS_YOU_STALE_DAYS = 14
export const NEEDS_YOU_AGE_BUMP_DAYS = [3, 7] as const
export const NEEDS_YOU_DUE_BUMP_DAYS = 2
const NEEDS_YOU_STALE_RANK_OFFSET = 10

export type NeedsYouKind =
  | 'approval'
  | 'routine_agent'
  | 'routine_answer'
  | 'routine_review'
  | 'routine_approval'
  | 'routine_budget'
  | 'blocked_task'
  | 'publishable_output'
  | 'project_recommit_due'

export type NeedsYouAction =
  | 'view'
  | 'approve'
  | 'reject'
  | 'assign_agent'
  | 'answer'
  | 'change_budget'
  | 'cancel'
  | 'publish'
  | 'recommit'

export interface NeedsYouItem {
  kind: NeedsYouKind
  source_type: 'task' | 'routine_run' | 'project'
  source_id: string
  project_id: string
  project_name: string
  title: string
  reason: string
  urgency: 'urgent' | 'high' | 'normal' | 'low'
  responsible: string | null
  requested_by: string | null
  created_at: string
  deadline_at: string | null
  safe_url: string
  allowed_actions: NeedsYouAction[]
  /** Waiting >= NEEDS_YOU_STALE_DAYS: render under 'older', never mixed into the live list. */
  stale: boolean
}

export interface NeedsYouOptions {
  project_id?: string
  limit?: number
  after?: string
  /**
   * 'inbox' (default): only items the viewer can ACT on, human gates only.
   * 'stuck': workspace admins only — approvals waiting on a gate that NO
   * independent human holds (agent-only lanes, gate:agent-self-completion).
   * They never appear in the owner inbox.
   */
  view?: 'inbox' | 'stuck'
  /** The caller's real AuthContext. Every caller has one; when omitted (principal-only
   *  callers, tests) it is rebuilt from the principal. Never client-supplied. */
  auth?: AuthContext
}

export interface NeedsYouPage {
  items: NeedsYouItem[]
  next_cursor: string | null
  truncated: boolean
  truncated_sources: string[]
}

interface SourceRow {
  kind: NeedsYouKind
  source_type: NeedsYouItem['source_type']
  // project source rows carry NULL for every squad/gate field below — a
  // 'project' row is visibility-scoped by projectVisibilityClause directly
  // (see recommitDue query), never by squad membership.
  source_id: string
  project_id: string
  project_name: string
  title: string
  reason: string
  urgency_rank: number
  responsible: string | null
  requested_by: string | null
  created_at: string
  deadline_at: string | null
  squad_id: string | null
  squad_department_id: string | null
  squad_kind: OrgKind | null
  project_access_level: 'read' | 'write' | 'admin' | null
  assignee_agent_id: string | null
  gate_owner: string | null
  sort_deadline: string
  sort_timestamp: string
}

interface NeedsYouCursor {
  tenant: string
  actor_type: RoutinePrincipal['actor_type']
  actor_id: string
  project_id: string | null
  urgency_rank: number
  deadline: string
  timestamp: string
  type: NeedsYouItem['source_type']
  id: string
}

interface SourceResult {
  name: string
  rows: SourceRow[]
  truncated: boolean
}

const DEADLINE_SENTINEL = '9999-12-31T23:59:59.999Z'

function safePath(segment: string): string {
  return encodeURIComponent(segment)
}

function isStaleRank(rank: number): boolean {
  return rank >= NEEDS_YOU_STALE_RANK_OFFSET
}

function urgency(sortRank: number): NeedsYouItem['urgency'] {
  const rank = sortRank % NEEDS_YOU_STALE_RANK_OFFSET
  if (rank === 0) return 'urgent'
  if (rank === 1) return 'high'
  if (rank === 2) return 'normal'
  return 'low'
}

function principalCanActOnSquad(row: SourceRow, principal: RoutinePrincipal): boolean {
  if (row.squad_id === null || row.squad_department_id === null || row.squad_kind === null) return false
  const scope = brandSquadScope({ id: row.squad_id, department_id: row.squad_department_id, kind: row.squad_kind })
  // G-FP1b point 2/3: legacy_owner_admin never covers a home squad — a needs-
  // you row about another member's home task/routine must not surface to an
  // unrelated owner/admin login with zero grant rows there.
  return (principal.legacy_owner_admin === true && planeCoversScope('role', scope))
    || hasCapability(principal.grants, 'squad', scope, 'member')
}

function principalCanAnswerRoutine(row: SourceRow, principal: RoutinePrincipal): boolean {
  // Adversarial round 1 (Athena, P2): `workspace_admin` used to bypass
  // UNCONDITIONALLY, ahead of any home-squad exclusion — an org-wide admin
  // could answer a routine question about another member's home regardless
  // of project access level. The bypass must be scope-aware the same way
  // every other admin bypass in this file already is: never reach a home
  // squad via the legacy-role plane or an org-scope grant, exact-match
  // grants excepted (a home's own owner is unaffected either way, since
  // they separately pass the plain squad-access check below).
  if (principal.workspace_admin) {
    if (row.squad_id === null || row.squad_department_id === null || row.squad_kind === null) return false
    const scope = brandSquadScope({ id: row.squad_id, department_id: row.squad_department_id, kind: row.squad_kind })
    const legacyPlaneCovers = principal.legacy_owner_admin === true && planeCoversScope('role', scope)
    const orgGrantCovers = hasCapability(principal.grants, 'org', null, 'member') && planeCoversScope('org', scope)
    if (legacyPlaneCovers || orgGrantCovers) return true
  }
  return (row.project_access_level === 'write' || row.project_access_level === 'admin')
    && principalCanActOnSquad(row, principal)
}

interface TaskDecision {
  approve: boolean
  reject: boolean
}

function actionsFor(row: SourceRow, principal: RoutinePrincipal, decision?: TaskDecision): NeedsYouAction[] {
  if (row.source_type === 'task') {
    if (row.kind === 'approval') {
      // The RBAC half (gate ownership, gate:loops surface cap, self-verdict,
      // owner-affiliation) is evaluateVerdictGates' answer, resolved by the caller
      // (resolveTaskDecisions) — the SAME predicate task_verdict / POST /verdict run,
      // never re-derived here. Only the squad-scope half is local.
      if (!decision || !principalCanActOnSquad(row, principal)) return ['view']
      const actions: NeedsYouAction[] = ['view']
      if (decision.approve) actions.push('approve')
      if (decision.reject) actions.push('reject')
      return actions
    }
    if (row.kind === 'publishable_output') {
      return principal.actor_type === 'member' && principal.workspace_admin ? ['view', 'publish'] : ['view']
    }
    return ['view']
  }

  if (row.source_type === 'project') {
    // Recommit is gated the SAME way the write route gates it — POST
    // /projects/:id/recommit and the project_recommit MCP tool both require
    // access.workspaceAdmin (src/projects/index.ts, src/mcp/projects.ts).
    // Self-recommit (an assignee recommitting their own project) is refused
    // SERVER-SIDE by proposeProjectRecommit's isSelfRecommit check — that
    // refusal is legible at write time (its own 'self_recommit' error), not
    // silently pre-filtered here: doing so would need this visibility-only
    // source to also resolve the project's task assignees, duplicating a
    // second copy of that lookup for a case the write path already refuses
    // cleanly.
    return principal.actor_type === 'member' && principal.workspace_admin
      ? ['view', 'recommit']
      : ['view']
  }

  const actions: NeedsYouAction[] = ['view']
  const human = principal.actor_type === 'member'
  if (row.kind === 'routine_answer' && human && principalCanAnswerRoutine(row, principal)) {
    actions.push('answer')
  }
  if (!human || !principal.workspace_admin || !principalCanActOnSquad(row, principal)) return actions

  switch (row.kind) {
    case 'routine_agent': actions.push('assign_agent', 'cancel'); break
    case 'routine_budget': actions.push('change_budget', 'cancel'); break
    case 'routine_answer':
    case 'routine_review':
    case 'routine_approval': actions.push('cancel'); break
  }
  return actions
}

/**
 * Is this row the viewer's to act on? Any verb beyond 'view' qualifies. The one
 * exception is blocked work: the list has no resolve verb for it (unblocking happens
 * on the task itself), so being the human squad member who can act on its squad IS
 * the actionability — its gate lane was already required to be human-held in SQL.
 */
function isActionable(row: SourceRow, principal: RoutinePrincipal, actions: NeedsYouAction[]): boolean {
  if (actions.some(action => action !== 'view')) return true
  return row.kind === 'blocked_task' && principal.actor_type === 'member' && principalCanActOnSquad(row, principal)
}

function itemFrom(row: SourceRow, principal: RoutinePrincipal, decision?: TaskDecision): NeedsYouItem {
  return {
    kind: row.kind,
    source_type: row.source_type,
    source_id: row.source_id,
    project_id: row.project_id,
    project_name: row.project_name,
    title: row.title,
    reason: row.reason,
    urgency: urgency(row.urgency_rank),
    responsible: row.responsible,
    requested_by: row.requested_by,
    created_at: row.created_at,
    deadline_at: row.deadline_at,
    safe_url: row.source_type === 'task'
      ? `/projects/${safePath(row.project_id)}#work`
      : row.source_type === 'project'
        ? `/projects/${safePath(row.project_id)}`
        : `/projects/${safePath(row.project_id)}/routines?run_id=${safePath(row.source_id)}`,
    allowed_actions: actionsFor(row, principal, decision),
    stale: isStaleRank(row.urgency_rank),
  }
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LIMIT
}

function cursorPredicate(cursor: NeedsYouCursor | null): { sql: string; binds: unknown[] } {
  if (!cursor) return { sql: '', binds: [] }
  return {
    sql: `WHERE (
      urgency_rank > ?
      OR (urgency_rank = ? AND (
        sort_deadline > ?
        OR (sort_deadline = ? AND (
          sort_timestamp < ?
          OR (sort_timestamp = ? AND (
            source_type > ?
            OR (source_type = ? AND source_id > ?)
          ))
        ))
      ))
    )`,
    binds: [
      cursor.urgency_rank, cursor.urgency_rank,
      cursor.deadline, cursor.deadline,
      cursor.timestamp, cursor.timestamp,
      cursor.type, cursor.type, cursor.id,
    ],
  }
}

function orderedSourceQuery(inner: string, cursor: NeedsYouCursor | null): { sql: string; binds: unknown[] } {
  const after = cursorPredicate(cursor)
  return {
    sql: `SELECT * FROM (${inner}) attention ${after.sql}
      ORDER BY urgency_rank ASC, sort_deadline ASC, sort_timestamp DESC, source_type ASC, source_id ASC
      LIMIT ?`,
    binds: [...after.binds, SOURCE_SCAN_CAP + 1],
  }
}

async function querySource(
  env: Env,
  name: string,
  inner: string,
  binds: unknown[],
  cursor: NeedsYouCursor | null,
): Promise<SourceResult> {
  const query = orderedSourceQuery(inner, cursor)
  const result = await env.DB.prepare(query.sql).bind(...binds, ...query.binds).all<SourceRow>()
  const rows = result.results ?? []
  return { name, rows: rows.slice(0, SOURCE_SCAN_CAP), truncated: rows.length > SOURCE_SCAN_CAP }
}

const ISO_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Age in days of a created_at column, against the (validated, server-minted) now. */
function ageDaysSql(createdExpr: string, nowIso: string): string {
  return `(julianday('${nowIso}') - julianday(${createdExpr}))`
}

/**
 * Sort rank for a task-backed row — the rule documented at NEEDS_YOU_STALE_DAYS.
 * `projectAlias` carries target_date (the due signal). Stale rows get the offset.
 */
function taskRankSql(taskAlias: string, projectAlias: string, nowIso: string): string {
  const age = ageDaysSql(`${taskAlias}.created_at`, nowIso)
  const [soon, week] = NEEDS_YOU_AGE_BUMP_DAYS
  const base = `CASE ${taskAlias}.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P3' THEN 3 ELSE 2 END`
  const ageBump = `CASE WHEN ${age} >= ${NEEDS_YOU_STALE_DAYS} THEN 0 WHEN ${age} >= ${week} THEN 2 WHEN ${age} >= ${soon} THEN 1 ELSE 0 END`
  const dueBump = `CASE WHEN ${projectAlias}.target_date IS NOT NULL
    AND julianday(${projectAlias}.target_date) - julianday('${nowIso}') <= ${NEEDS_YOU_DUE_BUMP_DAYS} THEN 1 ELSE 0 END`
  return `(CASE WHEN ${age} >= ${NEEDS_YOU_STALE_DAYS} THEN ${NEEDS_YOU_STALE_RANK_OFFSET} ELSE 0 END
    + MAX(0, (${base}) - MIN(2, (${ageBump}) + (${dueBump}))))`
}

async function sourceRows(
  env: Env,
  principal: RoutinePrincipal,
  options: NeedsYouOptions,
  cursor: NeedsYouCursor | null,
  nowIso: string,
): Promise<SourceResult[]> {
  const visibility = projectVisibilityClause(principal.project_read)
  const projectClause = options.project_id ? ' AND p.id = ?' : ''
  const projectBinds = options.project_id ? [options.project_id] : []
  if (!ISO_NOW.test(nowIso)) throw new Error('invalid_needs_you_now')
  const stuckView = options.view === 'stuck'
  // Archived projects drop out of every source (a task/routine under an archived project is
  // not live work). Task-level archive is TASK_NOT_ARCHIVED_SQL (canonical, hygiene/filters).
  const projectLive = `p.status != 'archived'`
  // A gate wait belongs to the human inbox when an independent HUMAN holds the lane
  // (humanGateHolderExistsSql, the predicate that admits a human review gate) OR the lane has
  // no agent holder at all (org owner/admin decide it by role, e.g. gate:routines). A lane held
  // by an AGENT with no independent human holder, and gate:agent-self-completion (no human
  // lane by design), are agent-gate waits: a stuck-agent signal for an admin, not the owner's inbox.
  const humanHolder = `(t.gate_owner <> 'gate:agent-self-completion' AND (${humanGateHolderExistsSql({
    gateOwnerExpr: 't.gate_owner',
    assigneeIdExpr: 't.assignee_agent_id',
    squadIdExpr: 't.squad_id',
    tenantParam: sqlQuote(env.TENANT_SLUG),
  })} OR NOT EXISTS (
    SELECT 1 FROM gate_grants agent_lane
     WHERE agent_lane.capability = t.gate_owner AND agent_lane.principal_type = 'agent'
  )))`
  const holderClause = stuckView ? `AND NOT ${humanHolder}` : `AND ${humanHolder}`
  const projectScope = [...projectBinds, ...visibility.binds]

  const approvals = querySource(env, 'approvals', `
    SELECT
      'approval' AS kind, 'task' AS source_type, t.id AS source_id,
      p.id AS project_id, p.name AS project_name, t.title,
      'Approval required by ' || t.gate_owner AS reason,
      ${taskRankSql('t', 'p', nowIso)} AS urgency_rank, t.gate_owner AS responsible, t.assignee_agent_id AS requested_by,
      t.created_at, p.target_date AS deadline_at,
      t.squad_id, s.department_id AS squad_department_id, s.kind AS squad_kind, NULL AS project_access_level,
      t.assignee_agent_id, t.gate_owner,
      COALESCE(p.target_date, '${DEADLINE_SENTINEL}') AS sort_deadline,
      t.created_at AS sort_timestamp
    FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN squads s ON s.id = t.squad_id
    WHERE t.status = 'review' AND t.gate_owner IS NOT NULL${projectClause}
      AND ${projectLive} ${holderClause}
      AND ${TASK_NOT_ARCHIVED_SQL('t')}
      AND ${visibility.sql}
  `, projectScope, cursor)

  // The admin 'stuck' view is approvals only — never start the other sources for it.
  if (stuckView) return [await approvals]

  // Rolling deploy: Worker may ship before D1 applies 0073. Skip Routine waits until tables exist.
  const routinesReady = await routineTablesReady(env)
  const routineWaits = routinesReady
    ? querySource(env, 'routine_waits', `
    SELECT
      CASE rr.waiting_reason
        WHEN 'agent' THEN 'routine_agent'
        WHEN 'answer' THEN 'routine_answer'
        WHEN 'review' THEN 'routine_review'
        WHEN 'approval' THEN 'routine_approval'
        ELSE 'routine_budget'
      END AS kind,
      'routine_run' AS source_type, rr.id AS source_id,
      p.id AS project_id, p.name AS project_name, r.name AS title,
      'Routine is waiting for ' || rr.waiting_reason AS reason,
      (CASE WHEN rr.waiting_reason IN ('approval', 'review', 'budget') THEN 0 ELSE 1 END
        + CASE WHEN ${ageDaysSql('rr.created_at', nowIso)} >= ${NEEDS_YOU_STALE_DAYS} THEN ${NEEDS_YOU_STALE_RANK_OFFSET} ELSE 0 END) AS urgency_rank,
      r.responsible_squad_id AS responsible, r.created_by AS requested_by,
      rr.created_at, rr.scheduled_for AS deadline_at,
      r.responsible_squad_id AS squad_id, s.department_id AS squad_department_id, s.kind AS squad_kind,
      psa.access_level AS project_access_level,
      NULL AS assignee_agent_id, NULL AS gate_owner,
      COALESCE(rr.scheduled_for, '${DEADLINE_SENTINEL}') AS sort_deadline,
      rr.created_at AS sort_timestamp
    FROM routine_runs rr
    JOIN routines r ON r.id = rr.routine_id AND r.tenant = rr.tenant
    JOIN projects p ON p.id = rr.project_id
    JOIN squads s ON s.id = r.responsible_squad_id
    JOIN project_squad_access psa
      ON psa.project_id = rr.project_id AND psa.squad_id = r.responsible_squad_id
    WHERE rr.tenant = ? AND rr.status = 'waiting' AND rr.waiting_reason IS NOT NULL
      AND NOT (rr.waiting_reason = 'review' AND rr.task_id IS NOT NULL)${projectClause}
      AND ${projectLive}
      AND ${visibility.sql}
  `, [env.TENANT_SLUG, ...projectScope], cursor)
    : Promise.resolve({ name: 'routine_waits', rows: [], truncated: false })

  const blockedTasks = querySource(env, 'blocked_tasks', `
    SELECT
      'blocked_task' AS kind, 'task' AS source_type, t.id AS source_id,
      p.id AS project_id, p.name AS project_name, t.title,
      'Blocked work requires ' || t.gate_owner AS reason,
      ${taskRankSql('t', 'p', nowIso)} AS urgency_rank, t.gate_owner AS responsible, NULL AS requested_by,
      t.created_at, p.target_date AS deadline_at,
      t.squad_id, s.department_id AS squad_department_id, s.kind AS squad_kind, NULL AS project_access_level,
      NULL AS assignee_agent_id, t.gate_owner,
      COALESCE(p.target_date, '${DEADLINE_SENTINEL}') AS sort_deadline,
      t.created_at AS sort_timestamp
    FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN squads s ON s.id = t.squad_id
    WHERE t.status = 'blocked' AND t.assignee_agent_id IS NULL AND t.gate_owner IS NOT NULL${projectClause}
      AND ${projectLive}
      AND (t.gate_owner NOT LIKE 'gate:%' OR ${humanHolder})
      AND ${TASK_NOT_ARCHIVED_SQL('t')}
      AND ${visibility.sql}
  `, projectScope, cursor)

  const publishableOutputs = querySource(env, 'publishable_outputs', `
    SELECT
      'publishable_output' AS kind, 'task' AS source_type, t.id AS source_id,
      p.id AS project_id, p.name AS project_name, t.title,
      'Approved output awaits publication' AS reason,
      ${taskRankSql('t', 'p', nowIso)} AS urgency_rank, 'workspace_admin' AS responsible, t.assignee_agent_id AS requested_by,
      t.created_at, p.target_date AS deadline_at,
      t.squad_id, s.department_id AS squad_department_id, s.kind AS squad_kind, NULL AS project_access_level,
      t.assignee_agent_id, t.gate_owner,
      COALESCE(p.target_date, '${DEADLINE_SENTINEL}') AS sort_deadline,
      t.created_at AS sort_timestamp
    FROM tasks t JOIN projects p ON p.id = t.project_id
    JOIN squads s ON s.id = t.squad_id
    WHERE t.status = 'approved' AND t.gate_owner = ? AND t.result IS NOT NULL${projectClause}
      AND ${projectLive}
      AND ${TASK_NOT_ARCHIVED_SQL('t')}
      AND ${visibility.sql}
  `, [CONTENT_GATE_OWNER, ...projectScope], cursor)

  const recommitDue = recommitDueSource(env, projectClause, projectScope, visibility, cursor, nowIso)

  return Promise.all([approvals, routineWaits, blockedTasks, publishableOutputs, recommitDue])
}

interface RecommitCandidateRow {
  project_id: string
  project_name: string
  cycle_boundary_at: string
  created_at: string
  stall_threshold_days: number | null
}

/**
 * Recommit-due warning (mupot lifecycle-warning): the circuit breaker
 * (src/projects/circuit-breaker.ts) archives any non-exempt project at
 * cycle_boundary_at unless a receipted recommit exists for that EXACT
 * boundary — silently, with no prior notice. This source surfaces that fate
 * ahead of time so someone with recommit authority sees it before the
 * breaker fires. It has TWO independent triggers, because the breaker itself
 * does (shouldEvaluateBreaker, circuit-breaker.ts):
 *
 *   1. BOUNDARY: cycle_boundary_at is within RECOMMIT_DUE_WINDOW_MS (72h) or
 *      already past.
 *   2. IDLE (round 2, mupot PR #1533 — adversarial P0-1): shouldEvaluateBreaker
 *      early-raises the breaker the INSTANT projects.stalled flips to 1,
 *      regardless of how far cycle_boundary_at is — and stall-detect + the
 *      breaker run in the SAME cron tick (src/projects/loop.ts), so there is
 *      no persisted "just stalled, not yet killed" window to warn inside. A
 *      boundary-only check misses this: an idle active project with a
 *      30-day-out boundary went from zero needs_you items to
 *      stall_flagged:1 + killed:1 + archived in ONE real tick. The fix
 *      computes LIVE idleness with the stall detector's OWN functions
 *      (resolveStallThresholdDays / loadProjectIdleSignals /
 *      lastActivityFromSignals / idleDurationDays / isPastStallThreshold,
 *      all imported from src/projects/stall-detector.ts — never a second
 *      copy) and fires once idle is within STALL_WARNING_LEAD_DAYS of the
 *      threshold, days before the CACHED stalled column would even flip.
 *
 * Status eligibility reuses BREAKER_EXEMPT_STATUSES from circuit-breaker.ts
 * directly (NOT IN over the same array shouldEvaluateBreaker AND
 * listProjectsDueAtBoundary check) — one list, three readers, cannot
 * diverge. See tests/attention-recommit-due.test.ts's "predicate parity"
 * case (round 2 widened it to all three call sites).
 *
 * "No receipted recommit for THIS boundary" reuses hasReceiptedRecommit's
 * OWN storage shape: a workflow_receipts row at instance_id =
 * `${CYCLE_INSTANCE_PREFIX}${project_id}:${cycle_boundary_at}` (the exact
 * format cycleInstanceId() builds — CYCLE_INSTANCE_PREFIX is imported, not
 * re-typed) with step_name = RECOMMIT_OR_KILL_STEP and a JSON detail whose
 * decision is 'recommit' — pinned exactly on the string 'recommit', not
 * "any receipt exists": a KILL receipt for this boundary (e.g. one whose
 * follow-on archive UPDATE failed, leaving the project still active) must
 * NOT silence the warning. This is expressed as SQL (json_extract) rather
 * than an N+1 hasReceiptedRecommit call per candidate row, but it reads the
 * SAME columns hasReceiptedRecommit reads, under the SAME key — a
 * recommitted-project test that seeds its receipt via the REAL
 * proposeProjectRecommit() (not a hand-inserted row) is what proves the two
 * never drift (see the "recommitted project is absent" test).
 *
 * IMPORTANT — this is NOT a pure single-SQL source like the others above:
 * the idle trigger needs a live per-project computation (loadProjectIdleSignals
 * issues real D1 reads) that cannot be expressed as one SELECT, so this
 * fetches a bounded CANDIDATE window by SQL (status + boundary-not-null +
 * no-receipt + visibility, capped at SOURCE_SCAN_CAP+1, ordered by
 * cycle_boundary_at as a proximity proxy — see the residual-limit note
 * below), then decides inclusion/urgency/reason in JS. Candidates are
 * fetched newest-boundary-first as a best-effort ordering so a genuinely
 * boundary-urgent row is unlikely to be the one that falls outside the cap;
 * this is a DOCUMENTED residual limit (same shape as approvals.ts's
 * APPROVALS_FETCH_CEILING gap), not a full fix — an idle-triggered warning
 * on a project whose boundary sorts outside the fetched window could still
 * be missed on a tenant with more than SOURCE_SCAN_CAP due-or-idle projects
 * at once.
 */
async function recommitDueSource(
  env: Env,
  projectClause: string,
  projectScope: unknown[],
  visibility: { sql: string; binds: string[] },
  cursor: NeedsYouCursor | null,
  nowIso: string,
): Promise<SourceResult> {
  const exemptPlaceholders = BREAKER_EXEMPT_STATUSES.map(() => '?').join(', ')
  const candidateResult = await env.DB.prepare(`
    SELECT p.id AS project_id, p.name AS project_name, p.cycle_boundary_at,
           p.created_at, p.stall_threshold_days
      FROM projects p
     WHERE p.status NOT IN (${exemptPlaceholders})
       AND p.cycle_boundary_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM workflow_receipts wr
          WHERE wr.instance_id = '${CYCLE_INSTANCE_PREFIX}' || p.id || ':' || p.cycle_boundary_at
            AND wr.step_name = ?
            AND json_extract(wr.detail, '$.decision') = 'recommit'
       )${projectClause}
       AND ${visibility.sql}
     ORDER BY p.cycle_boundary_at ASC, p.id ASC
     LIMIT ?
  `).bind(...BREAKER_EXEMPT_STATUSES, RECOMMIT_OR_KILL_STEP, ...projectScope, SOURCE_SCAN_CAP + 1)
    .all<RecommitCandidateRow>()

  const candidateRows = candidateResult.results ?? []
  const truncated = candidateRows.length > SOURCE_SCAN_CAP
  const candidates = candidateRows.slice(0, SOURCE_SCAN_CAP)

  const nowMs = Date.parse(nowIso)
  const dueByMs = nowMs + RECOMMIT_DUE_WINDOW_MS
  const urgentByMs = nowMs + RECOMMIT_URGENT_WINDOW_MS

  const annotated = await Promise.all(candidates.map(async (candidate): Promise<SourceRow | null> => {
    const boundaryMs = Date.parse(candidate.cycle_boundary_at)
    const boundaryDue = Number.isFinite(boundaryMs) && boundaryMs <= dueByMs
    const boundaryUrgent = Number.isFinite(boundaryMs) && boundaryMs <= urgentByMs

    // Live idleness — the stall detector's OWN functions, never re-derived.
    const thresholdDays = resolveStallThresholdDays(candidate.stall_threshold_days, DEFAULT_STALL_THRESHOLD_DAYS)
    const signals = await loadProjectIdleSignals(env, candidate.project_id)
    const lastActivity = lastActivityFromSignals(signals)
    const idleDays = idleDurationDays(lastActivity, candidate.created_at, nowIso)
    const idleUrgent = isPastStallThreshold(idleDays, thresholdDays)
    const idleApproaching = idleUrgent || idleDays >= thresholdDays - STALL_WARNING_LEAD_DAYS

    if (!boundaryDue && !idleApproaching) return null

    const reasonParts: string[] = []
    if (boundaryDue) reasonParts.push(`cycle boundary at ${candidate.cycle_boundary_at}`)
    if (idleApproaching) {
      reasonParts.push(idleUrgent
        ? `idle ${idleDays.toFixed(1)}d has passed the ${thresholdDays}d stall threshold — the same cron tick that flags it stalled can archive it`
        : `idle ${idleDays.toFixed(1)}d is within ${STALL_WARNING_LEAD_DAYS}d of the ${thresholdDays}d stall threshold — once stalled, the breaker can archive on that same tick`)
    }
    const reason = `${reasonParts.join('; ')} — recommitting protects only through this boundary (${candidate.cycle_boundary_at}); archived automatically without one`

    return {
      kind: 'project_recommit_due',
      source_type: 'project',
      source_id: candidate.project_id,
      project_id: candidate.project_id,
      project_name: candidate.project_name,
      title: candidate.project_name,
      reason,
      urgency_rank: (boundaryUrgent || idleUrgent) ? 0 : 1,
      responsible: 'workspace_admin',
      requested_by: null,
      created_at: candidate.created_at,
      deadline_at: candidate.cycle_boundary_at,
      squad_id: null, squad_department_id: null, squad_kind: null, project_access_level: null,
      assignee_agent_id: null, gate_owner: null,
      sort_deadline: candidate.cycle_boundary_at,
      sort_timestamp: candidate.created_at,
    }
  }))

  const included = annotated.filter((row): row is SourceRow => row !== null)
  const rows = cursor === null ? included : included.filter(row => passesCursor(row, cursor))
  return { name: 'recommit_due', rows, truncated }
}

/**
 * JS mirror of cursorPredicate's SQL tuple ordering, for the ONE source
 * (recommit-due) whose final urgency_rank cannot be known until a live
 * per-row idleness computation runs — it cannot be expressed as a single
 * ORDER-BY-able SQL SELECT the way orderedSourceQuery/cursorPredicate is.
 * Both implementations walk the SAME five-column tuple (urgency_rank ASC,
 * sort_deadline ASC, sort_timestamp DESC, source_type ASC, source_id ASC).
 */
function passesCursor(row: SourceRow, cursor: NeedsYouCursor): boolean {
  if (row.urgency_rank !== cursor.urgency_rank) return row.urgency_rank > cursor.urgency_rank
  if (row.sort_deadline !== cursor.deadline) return row.sort_deadline > cursor.deadline
  if (row.sort_timestamp !== cursor.timestamp) return row.sort_timestamp < cursor.timestamp
  if (row.source_type !== cursor.type) return row.source_type > cursor.type
  return row.source_id > cursor.id
}

function validateCursor(cursor: unknown): cursor is NeedsYouCursor {
  if (!cursor || typeof cursor !== 'object') return false
  const value = cursor as Record<string, unknown>
  return typeof value.tenant === 'string'
    && (value.actor_type === 'member' || value.actor_type === 'agent')
    && typeof value.actor_id === 'string'
    && (value.project_id === null || typeof value.project_id === 'string')
    && Number.isSafeInteger(value.urgency_rank)
    && typeof value.deadline === 'string'
    && typeof value.timestamp === 'string'
    && (value.type === 'task' || value.type === 'routine_run' || value.type === 'project')
    && typeof value.id === 'string'
}

async function digestToken(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function resolveCursor(
  env: Env,
  principal: RoutinePrincipal,
  options: NeedsYouOptions,
): Promise<NeedsYouCursor | null> {
  if (!options.after) return null
  if (!/^[0-9a-f-]{36}$/i.test(options.after)) throw new Error('invalid_needs_you_cursor')
  const digest = await digestToken(options.after)
  const cursor = await env.SESSIONS.get<NeedsYouCursor>(`needs-you-cursor:${digest}`, 'json')
  if (!validateCursor(cursor)
    || cursor.tenant !== env.TENANT_SLUG
    || cursor.actor_type !== principal.actor_type
    || cursor.actor_id !== principal.actor_id
    || cursor.project_id !== (options.project_id ?? null)) {
    throw new Error('invalid_needs_you_cursor')
  }
  return cursor
}

function cursorFor(
  env: Env,
  principal: RoutinePrincipal,
  projectId: string | undefined,
  row: SourceRow,
): NeedsYouCursor {
  return {
    tenant: env.TENANT_SLUG,
    actor_type: principal.actor_type,
    actor_id: principal.actor_id,
    project_id: projectId ?? null,
    urgency_rank: row.urgency_rank,
    deadline: row.sort_deadline,
    timestamp: row.sort_timestamp,
    type: row.source_type,
    id: row.source_id,
  }
}

async function issueCursor(env: Env, cursor: NeedsYouCursor): Promise<string> {
  const token = crypto.randomUUID()
  const digest = await digestToken(token)
  await env.SESSIONS.put(`needs-you-cursor:${digest}`, JSON.stringify(cursor), { expirationTtl: CURSOR_TTL_SECONDS })
  return token
}

function compareRows(left: SourceRow, right: SourceRow): number {
  return left.urgency_rank - right.urgency_rank
    || left.sort_deadline.localeCompare(right.sort_deadline)
    || right.sort_timestamp.localeCompare(left.sort_timestamp)
    || left.source_type.localeCompare(right.source_type)
    || left.source_id.localeCompare(right.source_id)
}

/** Hard bound on source pages scanned for ONE response (each page <= SOURCE_SCAN_CAP rows/source). */
const MAX_SCAN_PAGES = 5

// Principal-only callers (tests, internal) carry no AuthContext: rebuild the one
// routinePrincipal() was derived from. A legacy owner/admin with no loaded grants keeps
// `capabilities` undefined (the role plane), exactly as the real session does.
function authForPrincipal(principal: RoutinePrincipal): AuthContext {
  const legacy = principal.legacy_owner_admin === true
  return {
    userId: principal.actor_id,
    email: null,
    role: principal.org_owner === true ? 'owner' : legacy ? 'admin' : 'member',
    tenant: principal.tenant,
    ...(principal.actor_type === 'member' ? { memberId: principal.actor_id } : {}),
    boundAgentId: principal.actor_type === 'agent' ? principal.actor_id : null,
    ...(legacy && principal.grants.length === 0 ? {} : { capabilities: principal.grants }),
  }
}

/**
 * The viewer-specific half of "can this person act on it", resolved with the SAME
 * predicates the write paths run — never a second copy:
 *   - visibility: canReadSquadTasks (src/tasks/visibility.ts, the task-visibility
 *     chokepoint) — a task row of a squad the viewer cannot read never appears;
 *   - approvals: evaluateVerdictGates for 'approved' and 'rejected' (gate ownership incl.
 *     liveness, gate:loops surface cap, self-verdict, owner-affiliation #1663, the
 *     gate:agent-self-completion assignee rule), one cache per request.
 * Returns the rows the viewer may see plus the per-approval decision.
 */
async function resolveTaskDecisions(
  env: Env,
  auth: AuthContext,
  rows: SourceRow[],
  cache: VerdictGateCache,
  decisions: Map<string, TaskDecision>,
  visible: Map<string, Promise<boolean>>,
  informationOnly: boolean,
): Promise<SourceRow[]> {
  const kept = await Promise.all(rows.map(async (row) => {
    if (row.source_type !== 'task') return true
    if (row.squad_id === null) return false
    let canRead = visible.get(row.squad_id)
    if (!canRead) {
      canRead = canReadSquadTasks(env, auth, row.squad_id)
      visible.set(row.squad_id, canRead)
    }
    if (!(await canRead)) return false
    // The admin 'stuck' view is information only: no verb is offered, so no verdict predicate runs.
    if (informationOnly || row.kind !== 'approval' || row.gate_owner === null) return true
    const task = { squad_id: row.squad_id, gate_owner: row.gate_owner, assignee_agent_id: row.assignee_agent_id }
    const [approve, reject] = await Promise.all([
      evaluateVerdictGates(env, auth, task, 'approved', cache),
      evaluateVerdictGates(env, auth, task, 'rejected', cache),
    ])
    decisions.set(row.source_id, { approve: approve.allowed, reject: reject.allowed })
    return true
  }))
  return rows.filter((_, index) => kept[index])
}

/**
 * Bounded projection over authoritative Task and RoutineRun records (mupot#1688: the
 * viewer's INBOX, not a wall). ONE function feeds the MCP needs_you_list tool, REST
 * /needs-you, the dashboard /needs-you page and Telegram /needs.
 *
 * An item is listed only when the viewer can ACT on it (allowed_actions beyond 'view'),
 * can read its squad's tasks, its project and task are not archived, and — for gate
 * waits — an independent HUMAN holds the gate. Agent-gate waits are the admin
 * `view: 'stuck'` list. Urgency/staleness: see NEEDS_YOU_STALE_DAYS.
 * Cursor state is held server-side; no Need You row is persisted or resolved here.
 */
export async function listNeedsYou(
  env: Env,
  principal: RoutinePrincipal,
  options: NeedsYouOptions = {},
  // Test-only seam (never a client-supplied option — NeedsYouOptions has no
  // `now` field, so no caller can spoof "now" through the public request
  // shape). Mirrors the nowIso param every project-loop function takes.
  nowIso: string = new Date().toISOString(),
): Promise<NeedsYouPage> {
  const empty: NeedsYouPage = { items: [], next_cursor: null, truncated: false, truncated_sources: [] }
  if (principal.tenant !== env.TENANT_SLUG) return empty
  if (options.view === 'stuck' && !principal.workspace_admin) return empty
  const limit = options.limit ?? DEFAULT_LIMIT
  if (!validLimit(limit)) throw new Error('invalid_needs_you_pagination')
  const cursor = await resolveCursor(env, principal, options)
  const auth = options.auth ?? authForPrincipal(principal)
  const stuckView = options.view === 'stuck'
  const decisions = new Map<string, TaskDecision>()
  const gateCache = createVerdictGateCache()
  const visible = new Map<string, Promise<boolean>>()
  const kept: SourceRow[] = []
  // The viewer filter runs AFTER the capped SQL fetch, so a page of rows the viewer cannot
  // act on must never hide the ones they can: keep scanning source pages (bounded) until
  // enough kept rows exist or the sources are exhausted, and hand back a cursor from the last
  // SCANNED row when the bound is hit.
  let scanCursor = cursor
  let frontierCursor: NeedsYouCursor | null = null
  let exhausted = false
  let unscannable: string[] = []
  let pendingSources: string[] = []
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const sources = await sourceRows(env, principal, options, scanCursor, nowIso);
    const all = sources.flatMap(source => source.rows).sort(compareRows)
    // recommit_due is JS-ranked (not keyset-pageable), so it cannot bound the frontier.
    const pageable = sources.filter(source => source.truncated && source.name !== 'recommit_due')
    pendingSources = pageable.map(source => source.name)
    unscannable = sources.filter(source => source.truncated && source.name === 'recommit_due').map(source => source.name)
    const frontierRow = pageable
      .map(source => source.rows.at(-1))
      .filter((row): row is SourceRow => row !== undefined)
      .sort(compareRows)[0] ?? null
    const consider = frontierRow ? all.filter(row => compareRows(row, frontierRow) <= 0) : all
    const visibleRows = await resolveTaskDecisions(env, auth, consider, gateCache, decisions, visible, stuckView)
    kept.push(...visibleRows.filter(row => stuckView
      || isActionable(row, principal, actionsFor(row, principal, decisions.get(row.source_id)))))
    if (!frontierRow) { exhausted = true; frontierCursor = null; break }
    frontierCursor = cursorFor(env, principal, options.project_id, frontierRow)
    scanCursor = frontierCursor
    if (kept.length > limit) break
  }
  const items = kept.slice(0, limit)
  const last = items.at(-1)
  const moreKept = kept.length > limit
  // Scan bound hit with rows still unscanned: not exhausted and not already paging on kept rows.
  const scanIncomplete = !exhausted && !moreKept
  let nextCursor: string | null = null
  if (moreKept && last) nextCursor = await issueCursor(env, cursorFor(env, principal, options.project_id, last))
  else if (scanIncomplete && frontierCursor) nextCursor = await issueCursor(env, frontierCursor)
  return {
    items: items.map(row => itemFrom(row, principal, decisions.get(row.source_id))),
    next_cursor: nextCursor,
    truncated: scanIncomplete || unscannable.length > 0,
    truncated_sources: [...(scanIncomplete ? pendingSources : []), ...unscannable],
  }
}
