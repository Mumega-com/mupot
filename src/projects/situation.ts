import { projectLinkTimestampMsSql } from '../addons/project-link/timestamps'
import { getFleetAgentRuntimeStates, type Presence } from '../fleet/registry'
import { canonicalFlightMetaSql } from '../flight/meta-sql'
import type { Env, Project } from '../types'
import {
  listProjectActivity,
  listProjectEvidence,
  sanitizeProjectDetail,
  type ProjectActivitySource,
  type ProjectEvidenceSource,
  type ProjectProjectionRow,
} from './projections'

export const PROJECT_SITUATION_COUNT_CAP = 100
const PROJECT_SITUATION_DETAIL_CAP = 20

export type ProjectHealth = 'archived' | 'paused' | 'completed' | 'blocked' | 'review' | 'active' | 'ready'
export type ProjectSituationWorkStatus = 'blocked' | 'review' | 'in_progress' | 'open'
export type ProjectSituationFactKind = 'local' | 'current_remote' | 'stale_remote' | 'unknown'
export type ProjectSituationLinkHealth = 'unknown' | 'healthy' | 'failed' | 'stale' | 'revoked'

export interface ProjectSituationFact {
  kind: ProjectSituationFactKind
  source_pot: string | null
}

export interface ProjectSituationTask {
  id: string
  squad_id: string
  title: string
  status: ProjectSituationWorkStatus
  assignee_agent_id: string | null
  updated_at: string
  fact: ProjectSituationFact
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

export interface ProjectSituationLinkedPot {
  link_id: string
  source_pot: string
  remote_project_id: string
  remote_agent_id: string
  health: ProjectSituationLinkHealth
  last_synchronized_at: string | null
  agent_presence: 'unknown'
}

export interface ProjectSituationAgent {
  agent_id: string
  presence: Presence | 'unknown'
  fact: ProjectSituationFact
}

export interface ProjectSituationEvidenceItem {
  source_type: ProjectEvidenceSource
  source_id: string
  title: string
  status: string
  occurred_at: string
  fact: ProjectSituationFact
}

export interface ProjectSituation {
  health: ProjectHealth
  summary: string
  blockers: ProjectSituationBlocker[]
  pending_reviews: ProjectSituationReview[]
  remote_tasks: ProjectSituationTask[]
  task_counts: ProjectSituationTaskCounts
  task_counts_truncated: ProjectSituationTaskTruncation
  active_work_count: number
  active_work_count_truncated: boolean
  active_flight_count: number
  active_flight_count_truncated: boolean
  blocker_details_truncated: boolean
  pending_review_details_truncated: boolean
  snapshot_truncated: boolean
  linked_pots: ProjectSituationLinkedPot[]
  agents: ProjectSituationAgent[]
  evidence: ProjectSituationEvidenceItem[]
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
  source_pot: string | null
  updated_at: string
  status_order: number
}

type SituationLinkRow = {
  id: string
  remote_pot: string
  remote_project_id: string
  remote_agent_id: string
  state: 'active' | 'revoked'
  stale_after_seconds: number
  last_success_at: string | null
  last_failure_at: string | null
  success_event_at: number | null
  failure_event_at: number | null
  now_event_at: number | null
}

type SituationAgentRow = {
  agent_id: string
  agent_slug: string
}

type SituationFlightRow = ProjectSituationFlight

function jsonIds(ids: string[] | null): string {
  return JSON.stringify([...new Set(ids ?? [])])
}

function readableFlag(ids: string[] | null): number {
  return ids === null ? 1 : 0
}

/**
 * Map durable link health + source_pot onto a situation fact label.
 * Missing link or unknown health never becomes current_remote.
 */
export function projectSituationFactFor(
  sourcePot: string | null | undefined,
  linkHealthByPot: ReadonlyMap<string, ProjectSituationLinkHealth>,
): ProjectSituationFact {
  if (!sourcePot) return { kind: 'local', source_pot: null }
  const health = linkHealthByPot.get(sourcePot)
  if (health === 'healthy') return { kind: 'current_remote', source_pot: sourcePot }
  if (health === 'stale' || health === 'failed' || health === 'revoked') {
    return { kind: 'stale_remote', source_pot: sourcePot }
  }
  return { kind: 'unknown', source_pot: sourcePot }
}

export function projectLinkHealthFromRow(row: {
  state: 'active' | 'revoked'
  last_success_at: string | null
  last_failure_at: string | null
  success_event_at: number | null
  failure_event_at: number | null
  now_event_at: number | null
  stale_after_seconds: number
}): ProjectSituationLinkHealth {
  if (row.state === 'revoked') return 'revoked'
  if (!row.last_success_at && !row.last_failure_at) return 'unknown'
  if (row.last_failure_at && (
    !row.last_success_at
    || (row.failure_event_at !== null
      && row.success_event_at !== null
      && row.failure_event_at > row.success_event_at)
  )) {
    return 'failed'
  }
  const stale = row.now_event_at !== null
    && row.success_event_at !== null
    && row.now_event_at - row.success_event_at > row.stale_after_seconds * 1000
  return stale ? 'stale' : 'healthy'
}

function safeTask(
  row: SituationTaskRow,
  linkHealthByPot: ReadonlyMap<string, ProjectSituationLinkHealth>,
): ProjectSituationTask {
  return {
    id: row.id,
    squad_id: row.squad_id,
    title: sanitizeProjectDetail(row.title),
    status: row.status,
    assignee_agent_id: row.assignee_agent_id,
    updated_at: row.updated_at,
    fact: projectSituationFactFor(row.source_pot, linkHealthByPot),
  }
}

function safeBlocker(
  row: SituationTaskRow,
  linkHealthByPot: ReadonlyMap<string, ProjectSituationLinkHealth>,
): ProjectSituationBlocker {
  const detail = sanitizeProjectDetail(row.result)
  return { ...safeTask(row, linkHealthByPot), status: 'blocked', blocker_summary: detail || null }
}

function safeReview(
  row: SituationTaskRow,
  linkHealthByPot: ReadonlyMap<string, ProjectSituationLinkHealth>,
): ProjectSituationReview {
  return { ...safeTask(row, linkHealthByPot), status: 'review', gate_owner: row.gate_owner }
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
  const nowIso = new Date().toISOString()
  const successAt = projectLinkTimestampMsSql('last_success_at')
  const failureAt = projectLinkTimestampMsSql('last_failure_at')
  const nowAt = projectLinkTimestampMsSql('?5')

  const [taskResult, flightResult, activity, linkResult, agentResult, evidencePage] = await Promise.all([
    env.DB.prepare(
      `WITH
       blocked_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.source_pot, t.updated_at, 2 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'blocked'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       review_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.source_pot, t.updated_at, 1 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'review'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       in_progress_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.source_pot, t.updated_at, 3 AS status_order
           FROM tasks t
          WHERE t.project_id = ?1 AND t.status = 'in_progress'
            AND (?2 = 1 OR t.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
          ORDER BY t.updated_at, t.id LIMIT ?4
       ),
       open_rows AS (
         SELECT t.id, t.squad_id, t.title, t.status, t.assignee_agent_id,
                t.result, t.gate_owner, t.source_pot, t.updated_at, 4 AS status_order
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
    env.DB.prepare(
      `SELECT id, remote_pot, remote_project_id, remote_agent_id, state,
              stale_after_seconds, last_success_at, last_failure_at,
              ${successAt} AS success_event_at,
              ${failureAt} AS failure_event_at,
              ${nowAt} AS now_event_at
         FROM project_links
        WHERE tenant = ?1 AND local_project_id = ?2
          AND (?3 = 1 OR local_squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?4)))
        ORDER BY id
        LIMIT ?6`,
    ).bind(
      env.TENANT_SLUG,
      project.id,
      unrestricted,
      ids,
      nowIso,
      PROJECT_SITUATION_DETAIL_CAP + 1,
    ).all<SituationLinkRow>(),
    env.DB.prepare(
      `SELECT a.id AS agent_id, a.slug AS agent_slug
         FROM agents a
         JOIN project_squad_access psa ON psa.squad_id = a.squad_id
        WHERE psa.project_id = ?1
          AND (?2 = 1 OR a.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?3)))
        ORDER BY a.id
        LIMIT ?4`,
    ).bind(project.id, unrestricted, ids, PROJECT_SITUATION_DETAIL_CAP + 1).all<SituationAgentRow>(),
    listProjectEvidence(env, {
      projectId: project.id,
      readableSquadIds,
      limit: PROJECT_SITUATION_DETAIL_CAP,
    }),
  ])

  const linkRows = (linkResult.results ?? []).slice(0, PROJECT_SITUATION_DETAIL_CAP)
  const linkHealthByPot = new Map<string, ProjectSituationLinkHealth>()
  const linkedPots: ProjectSituationLinkedPot[] = linkRows.map((row) => {
    const health = projectLinkHealthFromRow(row)
    const existing = linkHealthByPot.get(row.remote_pot)
    // Prefer the most current reading when multiple links share a pot slug.
    if (
      !existing
      || (health === 'healthy' && existing !== 'healthy')
      || (health === 'stale' && existing === 'unknown')
    ) {
      linkHealthByPot.set(row.remote_pot, health)
    }
    return {
      link_id: row.id,
      source_pot: row.remote_pot,
      remote_project_id: row.remote_project_id,
      remote_agent_id: row.remote_agent_id,
      health,
      last_synchronized_at: row.last_success_at,
      agent_presence: 'unknown' as const,
    }
  })

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

  const blockers = rowsByStatus.blocked.slice(0, PROJECT_SITUATION_DETAIL_CAP).map((row) => safeBlocker(row, linkHealthByPot))
  const pendingReviews = rowsByStatus.review.slice(0, PROJECT_SITUATION_DETAIL_CAP).map((row) => safeReview(row, linkHealthByPot))
  const blockerDetailsTruncated = rowsByStatus.blocked.length > PROJECT_SITUATION_DETAIL_CAP
  const pendingReviewDetailsTruncated = rowsByStatus.review.length > PROJECT_SITUATION_DETAIL_CAP
  const inProgress = rowsByStatus.in_progress[0] ? safeTask(rowsByStatus.in_progress[0], linkHealthByPot) : null
  const open = rowsByStatus.open[0] ? safeTask(rowsByStatus.open[0], linkHealthByPot) : null
  const activeWorkCount = taskCounts.blocked + taskCounts.review + taskCounts.in_progress + taskCounts.open
  const remoteTasks = taskRows
    .filter((row) => Boolean(row.source_pot))
    .slice(0, PROJECT_SITUATION_DETAIL_CAP)
    .map((row) => safeTask(row, linkHealthByPot))

  const flightRows = flightResult.results ?? []
  const activeFlightCountTruncated = flightRows.length > PROJECT_SITUATION_COUNT_CAP
  const activeFlightCount = Math.min(flightRows.length, PROJECT_SITUATION_COUNT_CAP)
  const flight = flightRows[0] ? safeFlight(flightRows[0]) : null
  const health = healthFor(project, taskCounts, activeFlightCount)

  const localAgentRows = (agentResult.results ?? []).slice(0, PROJECT_SITUATION_DETAIL_CAP)
  const runtimeStates = await getFleetAgentRuntimeStates(
    env,
    localAgentRows.map((agent) => ({ agent_id: agent.agent_id, slug: agent.agent_slug })),
  )
  const localAgents: ProjectSituationAgent[] = localAgentRows.map((agent) => ({
    agent_id: agent.agent_id,
    presence: runtimeStates.get(agent.agent_id)?.presence ?? 'unknown',
    fact: { kind: 'local', source_pot: null },
  }))
  const remoteAgents: ProjectSituationAgent[] = linkedPots.map((link) => ({
    agent_id: link.remote_agent_id,
    presence: 'unknown' as const,
    fact: projectSituationFactFor(link.source_pot, linkHealthByPot),
  }))
  const seenAgents = new Set<string>()
  const agents: ProjectSituationAgent[] = []
  for (const agent of [...localAgents, ...remoteAgents]) {
    if (seenAgents.has(agent.agent_id)) continue
    seenAgents.add(agent.agent_id)
    agents.push(agent)
    if (agents.length >= PROJECT_SITUATION_DETAIL_CAP) break
  }

  const evidence: ProjectSituationEvidenceItem[] = evidencePage.rows.map((row) => {
    if (row.source_type !== 'project_link_receipt') {
      return {
        source_type: row.source_type,
        source_id: row.source_id,
        title: row.title,
        status: row.status,
        occurred_at: row.occurred_at,
        fact: { kind: 'local', source_pot: null },
      }
    }
    const sourcePot = row.proof?.remote_pot ?? null
    return {
      source_type: row.source_type,
      source_id: row.source_id,
      title: row.title,
      status: row.status,
      occurred_at: row.occurred_at,
      // Receipts without a resolvable remote_pot stay unknown — never local-by-default.
      fact: sourcePot
        ? projectSituationFactFor(sourcePot, linkHealthByPot)
        : { kind: 'unknown', source_pot: null },
    }
  })

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
    remote_tasks: remoteTasks,
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
    linked_pots: linkedPots,
    agents,
    evidence,
    latest_activity: activity.rows[0] ?? null,
    next_action: nextAction(project, pendingReviews, blockers, inProgress, open, flight),
  }
}
