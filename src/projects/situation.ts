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
  | { type: 'review_task'; label: string; task: ProjectSituationReview }
  | { type: 'unblock_task'; label: string; task: ProjectSituationBlocker }
  | { type: 'continue_task'; label: string; task: ProjectSituationTask }
  | { type: 'start_task'; label: string; task: ProjectSituationTask }
  | { type: 'monitor_flight'; label: string; flight: ProjectSituationFlight }
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
  snapshot_truncated: boolean
  latest_activity: ProjectProjectionRow<ProjectActivitySource> | null
  next_action: ProjectSituationNextAction | null
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

function jsonIds(ids: string[] | null): string {
  return JSON.stringify([...new Set(ids ?? [])])
}

function readableFlag(ids: string[] | null): number {
  return ids === null ? 1 : 0
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
  reviews: ProjectSituationReview[],
  blockers: ProjectSituationBlocker[],
  inProgress: ProjectSituationTask | null,
  open: ProjectSituationTask | null,
  flight: ProjectSituationFlight | null,
): ProjectSituationNextAction | null {
  const review = reviews[0]
  if (review) return { type: 'review_task', label: `Review "${review.title}"`, task: review }
  const blocker = blockers[0]
  if (blocker) return { type: 'unblock_task', label: `Unblock "${blocker.title}"`, task: blocker }
  if (inProgress) return { type: 'continue_task', label: `Continue "${inProgress.title}"`, task: inProgress }
  if (open) return { type: 'start_task', label: `Start "${open.title}"`, task: open }
  if (flight) return { type: 'monitor_flight', label: `Monitor "${flight.goal}"`, flight }
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
): Promise<ProjectSituation> {
  const ids = jsonIds(readableSquadIds)
  const unrestricted = readableFlag(readableSquadIds)
  const safeMeta = "CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END"
  const snapshotLimit = PROJECT_SITUATION_COUNT_CAP + 1

  const [taskResult, flightResult, activity] = await Promise.all([
    env.DB.prepare(
      `WITH
       blocked_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 2 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'blocked'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       review_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 1 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'review'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       in_progress_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 3 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'in_progress'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       open_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at, 4 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'open'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY t.updated_at, t.id LIMIT ?4
       )
       SELECT * FROM review_rows
       UNION ALL SELECT * FROM blocked_rows
       UNION ALL SELECT * FROM in_progress_rows
       UNION ALL SELECT * FROM open_rows
       ORDER BY status_order, updated_at, id
       LIMIT ?5`,
    ).bind(project.id, unrestricted, ids, snapshotLimit, snapshotLimit * 4).all<SituationTaskRow>(),
    env.DB.prepare(
      `SELECT f.id, f.agent, f.goal, f.status, f.created_at
         FROM flights f
        WHERE f.project_id = ?1
          AND f.tenant = ?2
          AND f.status IN ('preflight', 'running', 'waiting', 'sleeping')
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
    ).bind(project.id, env.TENANT_SLUG, unrestricted, ids, snapshotLimit).all<SituationFlightRow>(),
    listProjectActivity(env, { projectId: project.id, readableSquadIds, limit: 1 }),
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
  const inProgress = rowsByStatus.in_progress[0] ? safeTask(rowsByStatus.in_progress[0]) : null
  const open = rowsByStatus.open[0] ? safeTask(rowsByStatus.open[0]) : null
  const activeWorkCount = taskCounts.blocked + taskCounts.review + taskCounts.in_progress + taskCounts.open

  const flightRows = flightResult.results ?? []
  const activeFlightCountTruncated = flightRows.length > PROJECT_SITUATION_COUNT_CAP
  const activeFlightCount = Math.min(flightRows.length, PROJECT_SITUATION_COUNT_CAP)
  const flight = flightRows[0] ? safeFlight(flightRows[0]) : null
  const health = healthFor(project, taskCounts, activeFlightCount)

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
    snapshot_truncated: taskCountsTruncated.overall || activeFlightCountTruncated,
    latest_activity: activity.rows[0] ?? null,
    next_action: nextAction(project, pendingReviews, blockers, inProgress, open, flight),
  }
}
