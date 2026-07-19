import { canonicalFlightMetaSql } from '../flight/meta-sql'
import type { Env, Project } from '../types'
import {
  listProjectActivity,
  sanitizeProjectDetail,
  type ProjectActivitySource,
  type ProjectProjectionRow,
} from './projections'

export type ProjectHealth = 'archived' | 'paused' | 'completed' | 'blocked' | 'review' | 'active' | 'ready'

export interface ProjectSituationTask {
  id: string
  squad_id: string
  title: string
  status: 'open' | 'in_progress' | 'blocked' | 'review'
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
  active_work_count: number
  active_flight_count: number
  latest_activity: ProjectProjectionRow<ProjectActivitySource> | null
  next_action: ProjectSituationNextAction | null
}

type SituationTaskRow = {
  id: string
  squad_id: string
  title: string
  status: ProjectSituationTask['status']
  assignee_agent_id: string | null
  result: string | null
  gate_owner: string | null
  updated_at: string
}

type SituationCounts = {
  blocked_count: number
  review_count: number
  active_work_count: number
}

type SituationFlightRow = ProjectSituationFlight & { active_flight_count: number }

const TASKS_PER_STATUS = 20
const MAX_SITUATION_TASKS = TASKS_PER_STATUS * 4

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
  return {
    ...safeTask(row),
    status: 'blocked',
    blocker_summary: detail || null,
  }
}

function safeReview(row: SituationTaskRow): ProjectSituationReview {
  return {
    ...safeTask(row),
    status: 'review',
    gate_owner: row.gate_owner,
  }
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

function healthFor(project: Project, counts: SituationCounts, activeFlightCount: number): ProjectHealth {
  if (project.status === 'archived') return 'archived'
  if (project.status === 'paused') return 'paused'
  if (project.status === 'completed') return 'completed'
  if (Number(counts.blocked_count) > 0) return 'blocked'
  if (Number(counts.review_count) > 0) return 'review'
  if (Number(counts.active_work_count) > 0 || activeFlightCount > 0) return 'active'
  return 'ready'
}

function summaryFor(
  health: ProjectHealth,
  counts: SituationCounts,
  activeFlightCount: number,
): string {
  if (health === 'archived') return 'Project is archived.'
  if (health === 'paused') return 'Project is paused.'
  if (health === 'completed') return 'Project is completed.'
  if (health === 'blocked') return `${Number(counts.blocked_count)} blocked task(s) need attention.`
  if (health === 'review') return `${Number(counts.review_count)} task(s) are awaiting review.`
  if (health === 'active') {
    return `${Number(counts.active_work_count)} active task(s) and ${activeFlightCount} active flight(s).`
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
  tasks: ProjectSituationTask[],
  flight: ProjectSituationFlight | null,
): ProjectSituationNextAction | null {
  const review = reviews[0]
  if (review) return { type: 'review_task', label: `Review "${review.title}"`, task: review }

  const blocker = blockers[0]
  if (blocker) return { type: 'unblock_task', label: `Unblock "${blocker.title}"`, task: blocker }

  const inProgress = tasks.find((task) => task.status === 'in_progress')
  if (inProgress) return { type: 'continue_task', label: `Continue "${inProgress.title}"`, task: inProgress }

  const open = tasks.find((task) => task.status === 'open')
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

  const [countRow, taskResult, flightResult, activity] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked_count,
         COALESCE(SUM(CASE WHEN t.status = 'review' THEN 1 ELSE 0 END), 0) AS review_count,
         COALESCE(SUM(CASE WHEN t.status IN ('open', 'in_progress') THEN 1 ELSE 0 END), 0) AS active_work_count
       FROM tasks t
      WHERE t.project_id = ?1
        AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
        AND t.status IN ('open', 'in_progress', 'blocked', 'review')
      LIMIT 1`,
    ).bind(project.id, unrestricted, ids).first<SituationCounts>(),
    env.DB.prepare(
      `WITH ranked AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.updated_at,
                ROW_NUMBER() OVER (PARTITION BY t.status ORDER BY t.updated_at, t.id) AS status_rank
           FROM tasks t
          WHERE t.project_id = ?1
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
            AND t.status IN ('open', 'in_progress', 'blocked', 'review')
       )
       SELECT id, squad_id, title, status, assignee_agent_id, result, gate_owner, updated_at
         FROM ranked
        WHERE status_rank <= ?4
        ORDER BY CASE status
          WHEN 'review' THEN 1 WHEN 'blocked' THEN 2 WHEN 'in_progress' THEN 3 ELSE 4
        END, updated_at, id
        LIMIT ?5`,
    ).bind(project.id, unrestricted, ids, TASKS_PER_STATUS, MAX_SITUATION_TASKS).all<SituationTaskRow>(),
    env.DB.prepare(
      `SELECT f.id, f.agent, f.goal, f.status, f.created_at,
              COUNT(*) OVER () AS active_flight_count
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
        LIMIT 1`,
    ).bind(project.id, env.TENANT_SLUG, unrestricted, ids).all<SituationFlightRow>(),
    listProjectActivity(env, { projectId: project.id, readableSquadIds, limit: 1 }),
  ])

  const counts: SituationCounts = {
    blocked_count: Number(countRow?.blocked_count ?? 0),
    review_count: Number(countRow?.review_count ?? 0),
    active_work_count: Number(countRow?.active_work_count ?? 0),
  }
  const taskRows = taskResult.results ?? []
  const blockers = taskRows.filter((row) => row.status === 'blocked').map(safeBlocker)
  const pendingReviews = taskRows.filter((row) => row.status === 'review').map(safeReview)
  const tasks = taskRows.map(safeTask)
  const flightRow = (flightResult.results ?? [])[0] ?? null
  const flight = flightRow ? safeFlight(flightRow) : null
  const activeFlightCount = Number(flightRow?.active_flight_count ?? 0)
  const health = healthFor(project, counts, activeFlightCount)

  return {
    health,
    summary: summaryFor(health, counts, activeFlightCount),
    blockers,
    pending_reviews: pendingReviews,
    active_work_count: counts.active_work_count,
    active_flight_count: activeFlightCount,
    latest_activity: activity.rows[0] ?? null,
    next_action: nextAction(project, pendingReviews, blockers, tasks, flight),
  }
}
