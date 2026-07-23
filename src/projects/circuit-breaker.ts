// Project lifecycle circuit breaker (slice 1) — kill default at cycle boundary.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// At cycle_boundary_at, if status ≠ completed/archived and there is no receipted
// recommit for that boundary, default action is kill → archived. Continuation must
// be justified via a recommit_or_kill receipt written through the EXISTING
// workflow_receipts path (writeReceiptToD1) — no second decision store.

import type { Env, Project, ProjectStatus } from '../types'
import { writeReceiptToD1 } from '../workflows/pipeline'
import { updateProject, type ProjectMutationResult } from './service'

export const RECOMMIT_OR_KILL_STEP = 'recommit_or_kill'
export const RECOMMIT_OR_KILL_SCHEMA = 'mupot.recommit_or_kill/v1'
export const CIRCUIT_BREAKER_PRINCIPAL = 'system:project-loop'
export const KILL_REASON_NO_RECOMMIT = 'cycle_boundary_no_recommit'

export type RecommitOrKillDecision = 'recommit' | 'kill'

export type CircuitBreakerOutcome = 'skipped' | 'recommitted' | 'killed'

export interface RecommitOrKillReceiptDetail {
  schema: typeof RECOMMIT_OR_KILL_SCHEMA
  project_id: string
  boundary_at: string
  decision: RecommitOrKillDecision
  principal: string
  reason: string
}

export interface RecordRecommitOrKillInput {
  projectId: string
  boundaryAt: string
  decision: RecommitOrKillDecision
  principal: string
  reason: string
}

export type WriteReceiptFn = (
  env: Env,
  row: {
    instanceId: string
    taskId: string
    stepName: string
    status: string
    detail?: string
  },
) => Promise<void>

export type UpdateProjectFn = (
  env: Env,
  id: string,
  input: { status: ProjectStatus },
) => Promise<ProjectMutationResult<Project>>

export type HasRecommitFn = (
  env: Env,
  projectId: string,
  boundaryAt: string,
) => Promise<boolean>

export interface CircuitBreakerDeps {
  writeReceipt: WriteReceiptFn
  updateProject: UpdateProjectFn
  hasRecommit: HasRecommitFn
  principal: string
}

/** Stable workflow instance id for one project + boundary (UNIQUE with step_name). */
export function cycleInstanceId(projectId: string, boundaryAt: string): string {
  return `project-cycle:${projectId}:${boundaryAt}`
}

/** Synthetic task id for project-scoped lifecycle receipts (no FK on workflow_receipts). */
export function lifecycleTaskId(projectId: string): string {
  return `project-cycle:${projectId}`
}

export function isAtCycleBoundary(cycleBoundaryAt: string | null, nowIso: string): boolean {
  if (cycleBoundaryAt === null || cycleBoundaryAt.trim() === '') return false
  const boundaryMs = Date.parse(cycleBoundaryAt)
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(boundaryMs) || Number.isNaN(nowMs)) return false
  return nowMs >= boundaryMs
}

/**
 * Breaker evaluates only at/after the boundary for non-terminal projects.
 * completed is exempt (structural finish path). archived is already terminal.
 */
export function shouldEvaluateBreaker(
  status: ProjectStatus,
  cycleBoundaryAt: string | null,
  nowIso: string,
): boolean {
  if (status === 'completed' || status === 'archived' || status === 'review') return false
  return isAtCycleBoundary(cycleBoundaryAt, nowIso)
}

export function buildRecommitOrKillDetail(
  input: RecordRecommitOrKillInput,
): RecommitOrKillReceiptDetail {
  return {
    schema: RECOMMIT_OR_KILL_SCHEMA,
    project_id: input.projectId,
    boundary_at: input.boundaryAt,
    decision: input.decision,
    principal: input.principal,
    reason: input.reason,
  }
}

/**
 * Record a recommit_or_kill decision through workflow_receipts (writeReceiptToD1).
 * INSERT OR IGNORE makes a second write for the same project+boundary a no-op.
 */
export async function recordRecommitOrKill(
  env: Env,
  input: RecordRecommitOrKillInput,
  writeReceipt: WriteReceiptFn,
): Promise<RecommitOrKillReceiptDetail> {
  const detail = buildRecommitOrKillDetail(input)
  await writeReceipt(env, {
    instanceId: cycleInstanceId(input.projectId, input.boundaryAt),
    taskId: lifecycleTaskId(input.projectId),
    stepName: RECOMMIT_OR_KILL_STEP,
    status: 'ok',
    detail: JSON.stringify(detail),
  })
  return detail
}

export function parseRecommitOrKillDetail(
  raw: string | null,
): RecommitOrKillReceiptDetail | null {
  if (raw === null || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (obj.schema !== RECOMMIT_OR_KILL_SCHEMA) return null
    if (typeof obj.project_id !== 'string' || obj.project_id.trim() === '') return null
    if (typeof obj.boundary_at !== 'string' || obj.boundary_at.trim() === '') return null
    if (obj.decision !== 'recommit' && obj.decision !== 'kill') return null
    if (typeof obj.principal !== 'string' || obj.principal.trim() === '') return null
    if (typeof obj.reason !== 'string' || obj.reason.trim() === '') return null
    return {
      schema: RECOMMIT_OR_KILL_SCHEMA,
      project_id: obj.project_id,
      boundary_at: obj.boundary_at,
      decision: obj.decision,
      principal: obj.principal,
      reason: obj.reason,
    }
  } catch {
    return null
  }
}

/** True when a receipted recommit exists for this project + boundary. */
export async function hasReceiptedRecommit(
  env: Env,
  projectId: string,
  boundaryAt: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT detail FROM workflow_receipts
      WHERE instance_id = ?1 AND step_name = ?2
      LIMIT 1`,
  )
    .bind(cycleInstanceId(projectId, boundaryAt), RECOMMIT_OR_KILL_STEP)
    .first<{ detail: string | null }>()
  const detail = parseRecommitOrKillDetail(row?.detail ?? null)
  return detail !== null && detail.decision === 'recommit' && detail.project_id === projectId
}

export function defaultCircuitBreakerDeps(): CircuitBreakerDeps {
  return {
    writeReceipt: writeReceiptToD1,
    updateProject: (env, id, input) => updateProject(env, id, input),
    hasRecommit: hasReceiptedRecommit,
    principal: CIRCUIT_BREAKER_PRINCIPAL,
  }
}

/**
 * At a due boundary: receipted recommit → keep status; else kill receipt + archive.
 */
export async function evaluateProjectCircuitBreaker(
  env: Env,
  project: Pick<Project, 'id' | 'status' | 'cycle_boundary_at'>,
  nowIso: string,
  deps: CircuitBreakerDeps,
): Promise<CircuitBreakerOutcome> {
  if (!shouldEvaluateBreaker(project.status, project.cycle_boundary_at, nowIso)) {
    return 'skipped'
  }
  const boundaryAt = project.cycle_boundary_at
  if (boundaryAt === null) return 'skipped'

  if (await deps.hasRecommit(env, project.id, boundaryAt)) {
    return 'recommitted'
  }

  await recordRecommitOrKill(
    env,
    {
      projectId: project.id,
      boundaryAt,
      decision: 'kill',
      principal: deps.principal,
      reason: KILL_REASON_NO_RECOMMIT,
    },
    deps.writeReceipt,
  )

  const archived = await deps.updateProject(env, project.id, { status: 'archived' })
  if (!archived.ok) {
    throw new Error(`circuit_breaker_archive_failed:${archived.error}`)
  }
  return 'killed'
}
