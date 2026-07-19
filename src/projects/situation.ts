import { canonicalFlightMetaSql } from '../flight/meta-sql'
import type { Env, Project } from '../types'
import {
  listProjectActivity,
  sanitizeProjectDetail,
  type ProjectActivitySource,
  type ProjectProjectionRow,
} from './projections'

export const PROJECT_SITUATION_COUNT_CAP = 100
const PROJECT_SITUATION_DETAIL_CAP = 20

export type ProjectHealth = 'archived' | 'paused' | 'completed' | 'blocked' | 'review' | 'active' | 'ready'
export type ProjectSituationWorkStatus = 'blocked' | 'review' | 'in_progress' | 'open'

export interface ProjectSituationTask {
  id: string
  squad_id: string
  title: string
  status: ProjectSituationWorkStatus
  assignee_agent_id: string | null
  updated_at: string
}

export interface ProjectSituationBlocker extends ProjectSituationTask {
  status: 'blocked'
  blocker_summary: string | null
}

export interface ProjectSituationReview extends ProjectSituationTask {
  status: 'review'
  gate_owner: string | null
}

export interface ProjectSituationFlight {
  id: string
  agent: string
  goal: string
  status: 'preflight' | 'running' | 'waiting' | 'sleeping'
  created_at: number
}

export interface ProjectSituationRoutine {
  id: string
  name: string
  next_run_at: string
  timezone: string
  responsible_squad_id: string
  preferred_agent_id: string | null
}

export interface ProjectSituationRoutineRun {
  id: string
  routine_id: string
  routine_name: string
  status: string
  waiting_reason: string | null
  responsible_squad_id: string
  assigned_agent_id: string | null
  scheduled_for: string | null
  updated_at: string
}

export interface ProjectSituationTerminalRoutineRun extends ProjectSituationRoutineRun {
  result_summary: string | null
  cost_micro_usd: number
  finished_at: string | null
}

export interface ProjectSituationRoutines {
  enabled_count: number
  paused_count: number
  enabled_count_truncated: boolean
  paused_count_truncated: boolean
  active_run_truncated: boolean
  latest_terminal_run_truncated: boolean
  next: ProjectSituationRoutine | null
  active_run: ProjectSituationRoutineRun | null
  latest_terminal_run: ProjectSituationTerminalRoutineRun | null
  truncated: boolean
}

export interface ProjectSituationNeedsYouItem {
  kind: 'approval' | 'routine_agent' | 'routine_answer' | 'routine_review' | 'routine_approval' | 'routine_budget' | 'blocked_task' | 'publishable_output'
  source_type: 'task' | 'routine_run'
  source_id: string
  title: string
  reason: string
  urgency: 'urgent' | 'high' | 'normal' | 'low'
  responsible: string | null
  created_at: string
  deadline_at: string | null
}

export interface ProjectSituationNeedsYou {
  count: number
  highest_priority: ProjectSituationNeedsYouItem | null
  truncated: boolean
}

export interface ProjectSituationTaskCounts {
  blocked: number
  review: number
  in_progress: number
  open: number
}

export interface ProjectSituationTaskTruncation {
  blocked: boolean
  review: boolean
  in_progress: boolean
  open: boolean
  overall: boolean
}

export type ProjectSituationNextAction =
  | { type: 'address_needs_you'; label: string; item: ProjectSituationNeedsYouItem }
  | { type: 'resolve_routine_wait'; label: string; run: ProjectSituationRoutineRun }
  | { type: 'review_task'; label: string; task: ProjectSituationReview }
  | { type: 'unblock_task'; label: string; task: ProjectSituationBlocker }
  | { type: 'continue_task'; label: string; task: ProjectSituationTask }
  | { type: 'start_task'; label: string; task: ProjectSituationTask }
  | { type: 'monitor_flight'; label: string; flight: ProjectSituationFlight }
  | { type: 'run_routine'; label: string; routine: ProjectSituationRoutine }
  | { type: 'create_task'; label: string; project: Pick<Project, 'id' | 'status'> }
  | { type: 'verify_completion'; label: string; project: Pick<Project, 'id' | 'status'> }
  | { type: 'resume_project'; label: string; project: Pick<Project, 'id' | 'status'> }
  | { type: 'reopen_project'; label: string; project: Pick<Project, 'id' | 'status'> }

export interface ProjectSituation {
  health: ProjectHealth
  summary: string
  blockers: ProjectSituationBlocker[]
  pending_reviews: ProjectSituationReview[]
  task_counts: ProjectSituationTaskCounts
  task_counts_truncated: ProjectSituationTaskTruncation
  active_work_count: number
  active_work_count_truncated: boolean
  active_flight_count: number
  active_flight_count_truncated: boolean
  blocker_details_truncated: boolean
  pending_review_details_truncated: boolean
  snapshot_truncated: boolean
  routines: ProjectSituationRoutines
  needs_you: ProjectSituationNeedsYou
  latest_activity: ProjectProjectionRow<ProjectActivitySource> | null
  next_action: ProjectSituationNextAction | null
}

export interface ProjectSituationOptions {
  excludeTaskIds?: string[]
  excludeFlightIds?: string[]
  excludeMessageIds?: string[]
}

type SituationTaskRow = {
  id: string
  squad_id: string
  title: string
  status: ProjectSituationWorkStatus
  assignee_agent_id: string | null
  result: string | null
  gate_owner: string | null
  updated_at: string
  status_order: number
}

type SituationFlightRow = ProjectSituationFlight

type SituationRoutineRow = {
  id: string
  name: string
  status: 'enabled' | 'paused'
  next_run_at: string | null
  timezone: string
  responsible_squad_id: string
  preferred_agent_id: string | null
}

type SituationRoutineRunRow = {
  id: string
  routine_id: string
  routine_name: string
  status: string
  waiting_reason: string | null
  responsible_squad_id: string
  assigned_agent_id: string | null
  scheduled_for: string | null
  result_summary?: string | null
  cost_micro_usd?: number
  finished_at?: string | null
  updated_at: string
}

type SituationNeedsYouRow = ProjectSituationNeedsYouItem & { urgency_rank: number }

function jsonIds(ids: string[] | null): string {
  return JSON.stringify([...new Set(ids ?? [])])
}

function readableFlag(ids: string[] | null): number {
  return ids === null ? 1 : 0
}

function epochMs(expression: string): string {
  return `CAST(ROUND((julianday(${expression}) - 2440587.5) * 86400000) AS INTEGER)`
}

function safeTask(row: SituationTaskRow): ProjectSituationTask {
  return {
    id: row.id,
    squad_id: row.squad_id,
    title: sanitizeProjectDetail(row.title),
    status: row.status,
    assignee_agent_id: row.assignee_agent_id,
    updated_at: row.updated_at,
  }
}

function safeBlocker(row: SituationTaskRow): ProjectSituationBlocker {
  const detail = sanitizeProjectDetail(row.result)
  return { ...safeTask(row), status: 'blocked', blocker_summary: detail || null }
}

function safeReview(row: SituationTaskRow): ProjectSituationReview {
  return { ...safeTask(row), status: 'review', gate_owner: row.gate_owner }
}

function safeFlight(row: SituationFlightRow): ProjectSituationFlight {
  return {
    id: row.id,
    agent: row.agent,
    goal: sanitizeProjectDetail(row.goal),
    status: row.status,
    created_at: Number(row.created_at),
  }
}

function safeRoutine(row: SituationRoutineRow): ProjectSituationRoutine {
  return {
    id: row.id,
    name: sanitizeProjectDetail(row.name),
    next_run_at: row.next_run_at as string,
    timezone: sanitizeProjectDetail(row.timezone),
    responsible_squad_id: row.responsible_squad_id,
    preferred_agent_id: row.preferred_agent_id,
  }
}

function safeRoutineRun(row: SituationRoutineRunRow): ProjectSituationRoutineRun {
  return {
    id: row.id,
    routine_id: row.routine_id,
    routine_name: sanitizeProjectDetail(row.routine_name),
    status: row.status,
    waiting_reason: row.waiting_reason,
    responsible_squad_id: row.responsible_squad_id,
    assigned_agent_id: row.assigned_agent_id,
    scheduled_for: row.scheduled_for,
    updated_at: row.updated_at,
  }
}

function safeTerminalRoutineRun(row: SituationRoutineRunRow): ProjectSituationTerminalRoutineRun {
  return {
    ...safeRoutineRun(row),
    result_summary: row.result_summary ? sanitizeProjectDetail(row.result_summary) : null,
    cost_micro_usd: Number(row.cost_micro_usd ?? 0),
    finished_at: row.finished_at ?? null,
  }
}

function safeNeedsYou(row: SituationNeedsYouRow): ProjectSituationNeedsYouItem {
  return {
    kind: row.kind,
    source_type: row.source_type,
    source_id: row.source_id,
    title: sanitizeProjectDetail(row.title),
    reason: sanitizeProjectDetail(row.reason),
    urgency: row.urgency,
    responsible: row.responsible ? sanitizeProjectDetail(row.responsible) : null,
    created_at: row.created_at,
    deadline_at: row.deadline_at,
  }
}

function cappedCount(rows: SituationTaskRow[]): number {
  return Math.min(rows.length, PROJECT_SITUATION_COUNT_CAP)
}

function displayCount(value: number, truncated: boolean): string {
  return `${value}${truncated ? '+' : ''}`
}

function healthFor(project: Project, counts: ProjectSituationTaskCounts, activeFlightCount: number): ProjectHealth {
  if (project.status === 'archived') return 'archived'
  if (project.status === 'paused') return 'paused'
  if (project.status === 'completed') return 'completed'
  if (counts.blocked > 0) return 'blocked'
  if (counts.review > 0) return 'review'
  if (counts.in_progress > 0 || counts.open > 0 || activeFlightCount > 0) return 'active'
  return 'ready'
}

function summaryFor(
  health: ProjectHealth,
  counts: ProjectSituationTaskCounts,
  truncation: ProjectSituationTaskTruncation,
  activeWorkCount: number,
  activeFlightCount: number,
  activeFlightCountTruncated: boolean,
): string {
  if (health === 'archived') return 'Project is archived.'
  if (health === 'paused') return 'Project is paused.'
  if (health === 'completed') return 'Project is completed.'
  if (health === 'blocked') {
    return `${displayCount(counts.blocked, truncation.blocked)} blocked task(s) need attention.`
  }
  if (health === 'review') {
    return `${displayCount(counts.review, truncation.review)} task(s) are awaiting review.`
  }
  if (health === 'active') {
    return `${displayCount(activeWorkCount, truncation.overall)} active task(s) and ${displayCount(activeFlightCount, activeFlightCountTruncated)} active flight(s).`
  }
  return 'Project is ready for its next step.'
}

function projectTarget(project: Project): Pick<Project, 'id' | 'status'> {
  return { id: project.id, status: project.status }
}

function nextAction(
  project: Project,
  needsYou: ProjectSituationNeedsYouItem | null,
  routineRun: ProjectSituationRoutineRun | null,
  reviews: ProjectSituationReview[],
  blockers: ProjectSituationBlocker[],
  inProgress: ProjectSituationTask | null,
  open: ProjectSituationTask | null,
  flight: ProjectSituationFlight | null,
  routine: ProjectSituationRoutine | null,
): ProjectSituationNextAction | null {
  if (needsYou?.urgency === 'urgent') {
    return { type: 'address_needs_you', label: `Address ${needsYou.title}`, item: needsYou }
  }
  if (routineRun?.status === 'waiting') {
    return { type: 'resolve_routine_wait', label: `Resolve Routine wait for "${routineRun.routine_name}"`, run: routineRun }
  }
  const review = reviews[0]
  if (review) return { type: 'review_task', label: `Review "${review.title}"`, task: review }
  const blocker = blockers[0]
  if (blocker) return { type: 'unblock_task', label: `Unblock "${blocker.title}"`, task: blocker }
  if (inProgress) return { type: 'continue_task', label: `Continue "${inProgress.title}"`, task: inProgress }
  if (open) return { type: 'start_task', label: `Start "${open.title}"`, task: open }
  if (flight) return { type: 'monitor_flight', label: `Monitor "${flight.goal}"`, flight }
  if (routine) return { type: 'run_routine', label: `Run "${routine.name}"`, routine }
  if (project.status === 'active') {
    return { type: 'create_task', label: 'Create the next project task', project: projectTarget(project) }
  }
  if (project.status === 'completed') {
    return { type: 'verify_completion', label: 'Verify completion evidence', project: projectTarget(project) }
  }
  if (project.status === 'paused') {
    return { type: 'resume_project', label: 'Resume the project', project: projectTarget(project) }
  }
  if (project.status === 'archived') {
    return { type: 'reopen_project', label: 'Reopen the project', project: projectTarget(project) }
  }
  return null
}

/**
 * Derive one authorization-filtered project snapshot for REST, dashboards, and agents.
 * `null` is unrestricted; an empty list intentionally exposes no squad-owned rows.
 */
export async function loadProjectSituation(
  env: Env,
  project: Project,
  readableSquadIds: string[] | null,
  options: ProjectSituationOptions = {},
): Promise<ProjectSituation> {
  const ids = jsonIds(readableSquadIds)
  const unrestricted = readableFlag(readableSquadIds)
  const excludedTaskIds = jsonIds(options.excludeTaskIds ?? [])
  const excludedFlightIds = jsonIds(options.excludeFlightIds ?? [])
  const excludedActivity = new Set([
    ...(options.excludeTaskIds ?? []).map(id => `task:${id}`),
    ...(options.excludeFlightIds ?? []).map(id => `flight:${id}`),
    ...(options.excludeMessageIds ?? []).map(id => `message:${id}`),
  ])
  const safeMeta = "CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END"
  const snapshotLimit = PROJECT_SITUATION_COUNT_CAP + 1
  // Routine control snapshots exclude their own Task/Flight and must retain a stable digest.
  const controlSnapshot = Boolean(
    options.excludeTaskIds?.length || options.excludeFlightIds?.length || options.excludeMessageIds?.length,
  )

  const [taskResult, flightResult, routineResult, nextRoutineResult, activeRunResult, terminalRunResult, needsYouResult, activity] = await Promise.all([
    env.DB.prepare(
      `WITH
       blocked_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 2 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'blocked'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
            AND t.id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?6))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       review_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 1 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'review'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
            AND t.id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?6))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       in_progress_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 3 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'in_progress'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
            AND t.id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?6))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       open_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 4 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'open'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
            AND t.id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?6))
          ORDER BY t.updated_at, t.id LIMIT ?4
       )
       SELECT * FROM review_rows
       UNION ALL SELECT * FROM blocked_rows
       UNION ALL SELECT * FROM in_progress_rows
       UNION ALL SELECT * FROM open_rows
       ORDER BY status_order, updated_at, id
       LIMIT ?5`,
    ).bind(project.id, unrestricted, ids, snapshotLimit, snapshotLimit * 4, excludedTaskIds).all<SituationTaskRow>(),
    env.DB.prepare(
      `SELECT f.id, f.agent, f.goal, f.status, f.created_at
         FROM flights f
        WHERE f.project_id = ?1
          AND f.tenant = ?2
          AND f.status IN ('preflight', 'running', 'waiting', 'sleeping')
          AND f.id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?6))
          ${canonicalFlightMetaSql('f')}
          AND (?3 = 1 OR NOT EXISTS (
            SELECT 1
              FROM json_each(${safeMeta}, '$.squad_ids') squad_ref
             WHERE NOT EXISTS (
               SELECT 1
                 FROM json_each(?4) readable
                WHERE CAST(readable.value AS TEXT) = CAST(squad_ref.value AS TEXT)
             )
          ))
        ORDER BY f.created_at, f.id
        LIMIT ?5`,
    ).bind(project.id, env.TENANT_SLUG, unrestricted, ids, snapshotLimit, excludedFlightIds).all<SituationFlightRow>(),
    controlSnapshot ? Promise.resolve({ results: [] as SituationRoutineRow[] }) : env.DB.prepare(
      `WITH
       enabled AS (
         SELECT r.id, r.name, r.status, r.next_run_at, r.timezone, r.responsible_squad_id, r.preferred_agent_id
           FROM routines r
          WHERE r.tenant = ?1 AND r.project_id = ?2 AND r.status = 'enabled'
            AND (?3 = 1 OR r.responsible_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
          ORDER BY r.id LIMIT ?5
       ),
       paused AS (
         SELECT r.id, r.name, r.status, r.next_run_at, r.timezone, r.responsible_squad_id, r.preferred_agent_id
           FROM routines r
          WHERE r.tenant = ?1 AND r.project_id = ?2 AND r.status = 'paused'
            AND (?3 = 1 OR r.responsible_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
          ORDER BY r.updated_at DESC, r.id LIMIT ?5
       )
       SELECT * FROM enabled UNION ALL SELECT * FROM paused`,
    ).bind(env.TENANT_SLUG, project.id, unrestricted, ids, snapshotLimit).all<SituationRoutineRow>(),
    controlSnapshot ? Promise.resolve({ results: [] as SituationRoutineRow[] }) : env.DB.prepare(
      `SELECT r.id, r.name, r.status, r.next_run_at, r.timezone, r.responsible_squad_id, r.preferred_agent_id
         FROM routines r INDEXED BY idx_routines_project_next_occurrence
        WHERE r.tenant = ?1 AND r.project_id = ?2 AND r.status = 'enabled' AND r.next_run_at IS NOT NULL
          AND (?3 = 1 OR r.responsible_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
        ORDER BY r.next_run_at, r.id LIMIT 1`,
    ).bind(env.TENANT_SLUG, project.id, unrestricted, ids).all<SituationRoutineRow>(),
    controlSnapshot ? Promise.resolve({ results: [] as SituationRoutineRunRow[] }) : env.DB.prepare(
      `SELECT rr.id, rr.routine_id, r.name AS routine_name, rr.status, rr.waiting_reason,
              r.responsible_squad_id, rr.assigned_agent_id, rr.scheduled_for, rr.updated_at
         FROM routine_runs rr INDEXED BY idx_routine_runs_project_active_keyset
         JOIN routines r ON r.id = rr.routine_id AND r.tenant = rr.tenant AND r.project_id = rr.project_id
        WHERE rr.tenant = ?1 AND rr.project_id = ?2
          AND rr.status IN ('leased', 'observing', 'waiting', 'running')
          AND (?3 = 1 OR r.responsible_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
        ORDER BY CASE rr.status WHEN 'waiting' THEN 0 ELSE 1 END, ${epochMs('rr.updated_at')} DESC, rr.id
        LIMIT ?5`,
    ).bind(env.TENANT_SLUG, project.id, unrestricted, ids, snapshotLimit).all<SituationRoutineRunRow>(),
    controlSnapshot ? Promise.resolve({ results: [] as SituationRoutineRunRow[] }) : env.DB.prepare(
      `SELECT rr.id, rr.routine_id, r.name AS routine_name, rr.status, rr.waiting_reason,
              r.responsible_squad_id, rr.assigned_agent_id, rr.scheduled_for, rr.result_summary,
              rr.cost_micro_usd, rr.finished_at, rr.updated_at
         FROM routine_runs rr INDEXED BY idx_routine_runs_project_outcome_keyset
         JOIN routines r ON r.id = rr.routine_id AND r.tenant = rr.tenant AND r.project_id = rr.project_id
        WHERE rr.tenant = ?1 AND rr.project_id = ?2
          AND rr.status IN ('succeeded', 'failed', 'skipped', 'cancelled')
          AND (?3 = 1 OR r.responsible_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
        ORDER BY ${epochMs('COALESCE(rr.finished_at, rr.updated_at)')} DESC, rr.id LIMIT ?5`,
    ).bind(env.TENANT_SLUG, project.id, unrestricted, ids, snapshotLimit).all<SituationRoutineRunRow>(),
    controlSnapshot ? Promise.resolve({ results: [] as SituationNeedsYouRow[] }) : env.DB.prepare(
      `WITH
       approvals AS (
         SELECT 'approval' AS kind, 'task' AS source_type, t.id AS source_id, t.title,
                'Approval required by ' || t.gate_owner AS reason, 'urgent' AS urgency,
                0 AS urgency_rank, t.gate_owner AS responsible, t.created_at, p.target_date AS deadline_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ?1 AND t.status = 'review' AND t.gate_owner IS NOT NULL
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY COALESCE(p.target_date, '9999-12-31T23:59:59.999Z'), t.created_at DESC, 'task', t.id LIMIT ?4
       ),
       routine_waits AS (
         SELECT CASE rr.waiting_reason
                  WHEN 'agent' THEN 'routine_agent' WHEN 'answer' THEN 'routine_answer'
                  WHEN 'review' THEN 'routine_review' WHEN 'approval' THEN 'routine_approval'
                  ELSE 'routine_budget' END AS kind,
                'routine_run' AS source_type, rr.id AS source_id, r.name AS title,
                'Routine is waiting for ' || rr.waiting_reason AS reason,
                CASE WHEN rr.waiting_reason IN ('approval', 'review', 'budget') THEN 'urgent' ELSE 'high' END AS urgency,
                CASE WHEN rr.waiting_reason IN ('approval', 'review', 'budget') THEN 0 ELSE 1 END AS urgency_rank,
                r.responsible_squad_id AS responsible, rr.created_at, rr.scheduled_for AS deadline_at
           FROM routine_runs rr INDEXED BY idx_routine_runs_project_needs_you_keyset
           JOIN routines r ON r.id = rr.routine_id AND r.tenant = rr.tenant AND r.project_id = rr.project_id
          WHERE rr.tenant = ?5 AND rr.project_id = ?1 AND rr.status = 'waiting' AND rr.waiting_reason IS NOT NULL
            AND NOT (rr.waiting_reason = 'review' AND rr.task_id IS NOT NULL)
            AND (?2 = 1 OR r.responsible_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY CASE WHEN rr.waiting_reason IN ('approval', 'review', 'budget') THEN 0 ELSE 1 END,
                   COALESCE(rr.scheduled_for, '9999-12-31T23:59:59.999Z'), rr.created_at DESC, 'routine_run', rr.id LIMIT ?4
       ),
       blocked_tasks AS (
         SELECT 'blocked_task' AS kind, 'task' AS source_type, t.id AS source_id, t.title,
                'Blocked work requires ' || t.gate_owner AS reason, 'normal' AS urgency,
                2 AS urgency_rank, t.gate_owner AS responsible, t.created_at, p.target_date AS deadline_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ?1 AND t.status = 'blocked' AND t.assignee_agent_id IS NULL AND t.gate_owner IS NOT NULL
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY COALESCE(p.target_date, '9999-12-31T23:59:59.999Z'), t.created_at DESC, 'task', t.id LIMIT ?4
       ),
       publishable_outputs AS (
         SELECT 'publishable_output' AS kind, 'task' AS source_type, t.id AS source_id, t.title,
                'Approved output awaits publication' AS reason, 'low' AS urgency,
                3 AS urgency_rank, 'workspace_admin' AS responsible, t.created_at, p.target_date AS deadline_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = ?1 AND t.status = 'approved' AND t.gate_owner = 'gate:content' AND t.result IS NOT NULL
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY COALESCE(p.target_date, '9999-12-31T23:59:59.999Z'), t.created_at DESC, 'task', t.id LIMIT ?4
       )
       SELECT * FROM (
         SELECT * FROM approvals UNION ALL SELECT * FROM routine_waits
         UNION ALL SELECT * FROM blocked_tasks UNION ALL SELECT * FROM publishable_outputs
       )
       ORDER BY urgency_rank, COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'), created_at DESC, source_type, source_id
       LIMIT ?4`,
    ).bind(project.id, unrestricted, ids, snapshotLimit, env.TENANT_SLUG).all<SituationNeedsYouRow>(),
    listProjectActivity(env, {
      projectId: project.id,
      readableSquadIds,
      excludeRoutineEvents: controlSnapshot,
      limit: Math.min(100, excludedActivity.size + 1),
    }),
  ])

  const taskRows = taskResult.results ?? []
  const rowsByStatus = {
    blocked: taskRows.filter((row) => row.status === 'blocked'),
    review: taskRows.filter((row) => row.status === 'review'),
    in_progress: taskRows.filter((row) => row.status === 'in_progress'),
    open: taskRows.filter((row) => row.status === 'open'),
  }
  const taskCounts: ProjectSituationTaskCounts = {
    blocked: cappedCount(rowsByStatus.blocked),
    review: cappedCount(rowsByStatus.review),
    in_progress: cappedCount(rowsByStatus.in_progress),
    open: cappedCount(rowsByStatus.open),
  }
  const taskCountsTruncated: ProjectSituationTaskTruncation = {
    blocked: rowsByStatus.blocked.length > PROJECT_SITUATION_COUNT_CAP,
    review: rowsByStatus.review.length > PROJECT_SITUATION_COUNT_CAP,
    in_progress: rowsByStatus.in_progress.length > PROJECT_SITUATION_COUNT_CAP,
    open: rowsByStatus.open.length > PROJECT_SITUATION_COUNT_CAP,
    overall: false,
  }
  taskCountsTruncated.overall = taskCountsTruncated.blocked
    || taskCountsTruncated.review
    || taskCountsTruncated.in_progress
    || taskCountsTruncated.open

  const blockers = rowsByStatus.blocked.slice(0, PROJECT_SITUATION_DETAIL_CAP).map(safeBlocker)
  const pendingReviews = rowsByStatus.review.slice(0, PROJECT_SITUATION_DETAIL_CAP).map(safeReview)
  const blockerDetailsTruncated = rowsByStatus.blocked.length > PROJECT_SITUATION_DETAIL_CAP
  const pendingReviewDetailsTruncated = rowsByStatus.review.length > PROJECT_SITUATION_DETAIL_CAP
  const inProgress = rowsByStatus.in_progress[0] ? safeTask(rowsByStatus.in_progress[0]) : null
  const open = rowsByStatus.open[0] ? safeTask(rowsByStatus.open[0]) : null
  const activeWorkCount = taskCounts.blocked + taskCounts.review + taskCounts.in_progress + taskCounts.open

  const flightRows = flightResult.results ?? []
  const activeFlightCountTruncated = flightRows.length > PROJECT_SITUATION_COUNT_CAP
  const activeFlightCount = Math.min(flightRows.length, PROJECT_SITUATION_COUNT_CAP)
  const flight = flightRows[0] ? safeFlight(flightRows[0]) : null
  const health = healthFor(project, taskCounts, activeFlightCount)
  const routineRows = routineResult.results ?? []
  const nextRoutineRows = nextRoutineResult.results ?? []
  const enabledRoutines = routineRows.filter(row => row.status === 'enabled')
  const pausedRoutines = routineRows.filter(row => row.status === 'paused')
  const activeRuns = activeRunResult.results ?? []
  const terminalRuns = terminalRunResult.results ?? []
  const needsYouRows = needsYouResult.results ?? []
  const routines: ProjectSituationRoutines = {
    enabled_count: Math.min(enabledRoutines.length, PROJECT_SITUATION_COUNT_CAP),
    paused_count: Math.min(pausedRoutines.length, PROJECT_SITUATION_COUNT_CAP),
    enabled_count_truncated: enabledRoutines.length > PROJECT_SITUATION_COUNT_CAP,
    paused_count_truncated: pausedRoutines.length > PROJECT_SITUATION_COUNT_CAP,
    active_run_truncated: activeRuns.length > PROJECT_SITUATION_COUNT_CAP,
    latest_terminal_run_truncated: terminalRuns.length > PROJECT_SITUATION_COUNT_CAP,
    next: nextRoutineRows[0] ? safeRoutine(nextRoutineRows[0]) : null,
    active_run: activeRuns[0] ? safeRoutineRun(activeRuns[0]) : null,
    latest_terminal_run: terminalRuns[0] ? safeTerminalRoutineRun(terminalRuns[0]) : null,
    truncated: enabledRoutines.length > PROJECT_SITUATION_COUNT_CAP
      || pausedRoutines.length > PROJECT_SITUATION_COUNT_CAP
      || activeRuns.length > PROJECT_SITUATION_COUNT_CAP
      || terminalRuns.length > PROJECT_SITUATION_COUNT_CAP,
  }
  const needsYou: ProjectSituationNeedsYou = {
    count: Math.min(needsYouRows.length, PROJECT_SITUATION_COUNT_CAP),
    highest_priority: needsYouRows[0] ? safeNeedsYou(needsYouRows[0]) : null,
    truncated: needsYouRows.length > PROJECT_SITUATION_COUNT_CAP,
  }

  return {
    health,
    summary: summaryFor(
      health,
      taskCounts,
      taskCountsTruncated,
      activeWorkCount,
      activeFlightCount,
      activeFlightCountTruncated,
    ),
    blockers,
    pending_reviews: pendingReviews,
    task_counts: taskCounts,
    task_counts_truncated: taskCountsTruncated,
    active_work_count: activeWorkCount,
    active_work_count_truncated: taskCountsTruncated.overall,
    active_flight_count: activeFlightCount,
    active_flight_count_truncated: activeFlightCountTruncated,
    blocker_details_truncated: blockerDetailsTruncated,
    pending_review_details_truncated: pendingReviewDetailsTruncated,
    snapshot_truncated: taskCountsTruncated.overall
      || activeFlightCountTruncated
      || blockerDetailsTruncated
      || pendingReviewDetailsTruncated,
    routines,
    needs_you: needsYou,
    latest_activity: activity.rows.find(row => !excludedActivity.has(`${row.source_type}:${row.source_id}`)) ?? null,
    next_action: nextAction(project, needsYou.highest_priority, routines.active_run, pendingReviews, blockers, inProgress, open, flight, routines.next),
  }
}
