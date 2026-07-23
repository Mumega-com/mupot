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
 * Breaker evaluates at/after the boundary for non-terminal projects, OR early
 * when the stall detector has raised projects.stalled=1 (slice 4). Early raise
 * still requires a scheduled cycle_boundary_at — the flag alone never kills.
 * completed is exempt (structural finish path). archived is already terminal.
 */
export function shouldEvaluateBreaker(
  status: ProjectStatus,
  cycleBoundaryAt: string | null,
  nowIso: string,
  stalled: number,
): boolean {
  if (status === 'completed' || status === 'archived' || status === 'review') return false
  if (stalled === 1 && cycleBoundaryAt !== null && cycleBoundaryAt.trim() !== '') return true
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
  const detail = await loadRecommitOrKillDetail(env, projectId, boundaryAt)
  return detail !== null && detail.decision === 'recommit' && detail.project_id === projectId
}

export async function loadRecommitOrKillDetail(
  env: Env,
  projectId: string,
  boundaryAt: string,
): Promise<RecommitOrKillReceiptDetail | null> {
  const row = await env.DB.prepare(
    `SELECT detail FROM workflow_receipts
      WHERE instance_id = ?1 AND step_name = ?2
      LIMIT 1`,
  )
    .bind(cycleInstanceId(projectId, boundaryAt), RECOMMIT_OR_KILL_STEP)
    .first<{ detail: string | null }>()
  return parseRecommitOrKillDetail(row?.detail ?? null)
}

/** Assignees on the project — self-recommit is refused for these principals. */
export async function listProjectAssigneePrincipals(
  env: Env,
  projectId: string,
): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT DISTINCT assignee_agent_id AS principal
       FROM tasks
      WHERE project_id = ?1
        AND assignee_agent_id IS NOT NULL
        AND trim(assignee_agent_id) <> ''`,
  )
    .bind(projectId)
    .all<{ principal: string }>()
  return (result.results ?? []).map((row) => row.principal)
}

/** True when the recommit principal is one of the project's own assignees. */
export function isSelfRecommit(
  principal: string,
  assigneePrincipals: readonly string[],
): boolean {
  if (principal.trim() === '') return true
  return assigneePrincipals.includes(principal)
}

/**
 * Derive recommit authority from the bound auth token — never from request body.
 * Agent-bound tokens use boundAgentId; pure members use memberId; else userId.
 */
export function recommitPrincipalFromAuth(auth: {
  boundAgentId?: string | null
  memberId?: string
  userId: string
}): string {
  if (typeof auth.boundAgentId === 'string' && auth.boundAgentId.trim() !== '') {
    return auth.boundAgentId.trim()
  }
  if (typeof auth.memberId === 'string' && auth.memberId.trim() !== '') {
    return auth.memberId.trim()
  }
  return auth.userId
}

export type ProposeRecommitError =
  | 'project_not_found'
  | 'no_boundary'
  | 'terminal_status'
  | 'invalid_principal'
  | 'self_recommit'
  | 'already_decided'
  | 'receipt_failed'

export type ProposeRecommitResult =
  | { ok: true; detail: RecommitOrKillReceiptDetail }
  | { ok: false; error: ProposeRecommitError }

/**
 * Record a recommit for the project's current boundary.
 * Principal MUST be server-derived (recommitPrincipalFromAuth) — never body-supplied.
 * Assignees cannot recommit their own project (self-recommit).
 */
export async function proposeProjectRecommit(
  env: Env,
  projectId: string,
  principal: string,
  reason: string,
  writeReceipt: WriteReceiptFn,
): Promise<ProposeRecommitResult> {
  if (principal.trim() === '') return { ok: false, error: 'invalid_principal' }
  if (reason.trim() === '') return { ok: false, error: 'invalid_principal' }

  const project = await env.DB.prepare(
    `SELECT id, status, cycle_boundary_at FROM projects WHERE id = ?1`,
  )
    .bind(projectId)
    .first<{ id: string; status: ProjectStatus; cycle_boundary_at: string | null }>()
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status === 'completed' || project.status === 'archived') {
    return { ok: false, error: 'terminal_status' }
  }
  if (project.cycle_boundary_at === null || project.cycle_boundary_at.trim() === '') {
    return { ok: false, error: 'no_boundary' }
  }

  const assignees = await listProjectAssigneePrincipals(env, projectId)
  if (isSelfRecommit(principal, assignees)) {
    return { ok: false, error: 'self_recommit' }
  }

  const existing = await loadRecommitOrKillDetail(env, projectId, project.cycle_boundary_at)
  if (existing !== null) {
    if (existing.decision === 'recommit' && existing.principal === principal) {
      return { ok: true, detail: existing }
    }
    return { ok: false, error: 'already_decided' }
  }

  const detail = await recordRecommitOrKill(
    env,
    {
      projectId,
      boundaryAt: project.cycle_boundary_at,
      decision: 'recommit',
      principal,
      reason: reason.trim(),
    },
    writeReceipt,
  )

  const stored = await loadRecommitOrKillDetail(env, projectId, project.cycle_boundary_at)
  if (stored === null || stored.decision !== 'recommit' || stored.principal !== principal) {
    return { ok: false, error: 'already_decided' }
  }
  return { ok: true, detail }
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
 * At a due boundary (or early when stalled): receipted recommit → keep status;
 * else kill receipt + archive. Stall never auto-fixes — it only advances this check.
 *
 * Atomic vs TOCTOU: write kill via INSERT OR IGNORE, then read back the durable
 * decision. If a concurrent recommit won the unique key, we observe recommit and
 * skip archive. Only a stored kill decision proceeds to the status CAS archive.
 */
export async function evaluateProjectCircuitBreaker(
  env: Env,
  project: Pick<Project, 'id' | 'status' | 'cycle_boundary_at' | 'stalled'>,
  nowIso: string,
  deps: CircuitBreakerDeps,
): Promise<CircuitBreakerOutcome> {
  if (!shouldEvaluateBreaker(project.status, project.cycle_boundary_at, nowIso, project.stalled)) {
    return 'skipped'
  }
  const boundaryAt = project.cycle_boundary_at
  if (boundaryAt === null) return 'skipped'

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

  const stored = await loadRecommitOrKillDetail(env, project.id, boundaryAt)
  if (stored !== null && stored.decision === 'recommit') {
    return 'recommitted'
  }
  if (stored === null || stored.decision !== 'kill') {
    throw new Error('circuit_breaker_decision_missing')
  }

  const archived = await deps.updateProject(env, project.id, { status: 'archived' })
  if (!archived.ok) {
    throw new Error(`circuit_breaker_archive_failed:${archived.error}`)
  }
  return 'killed'
}
