// Project lifecycle structural completion gate (slice 2).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// active → review → completed fires ONLY from a structural signal:
//   every child task is done AND counts as completion evidence:
//     (a) real gate_owner (not gate:agent-self-completion) + approved verdict
//         from a DIFFERENT principal than the assignee, OR
//     (b) explicit human/operator sign-off (approved verdict decided by a member)
//   + non-empty task.result on every child.
// Ungated self-reported done tasks do NOT count.
// review → completed requires a different-principal gated verdict (self-verdict blocked,
// same shape as task-level K4). Never from agent self-report via updateProject.
// completed → archived writes a lessons-capture receipt through workflow_receipts.

import type { AuthContext, Env, Project, ProjectStatus } from '../types'
import { writeReceiptToD1 } from '../workflows/pipeline'
import { lifecycleTaskId } from './circuit-breaker'
import {
  getProject,
  type ProjectMutationError,
  type ProjectMutationResult,
} from './service'

export const PROJECT_COMPLETION_GATE = 'gate:project-completion'
export const LESSONS_CAPTURE_STEP = 'lessons_capture'
export const LESSONS_CAPTURE_SCHEMA = 'mupot.lessons_capture/v1'
export const STRUCTURAL_COMPLETION_STEP = 'structural_completion'
export const STRUCTURAL_COMPLETION_SCHEMA = 'mupot.structural_completion/v1'
export const PROJECT_VERDICT_STEP = 'project_completion_verdict'
export const PROJECT_VERDICT_SCHEMA = 'mupot.project_completion_verdict/v1'

/** Same string as AGENT_SELF_COMPLETION_GATE_OWNER — not valid completion evidence. */
export const AGENT_SELF_COMPLETION_GATE = 'gate:agent-self-completion'

export type StructuralBlockReason =
  | 'no_tasks'
  | 'task_not_terminal'
  | 'gate_not_pass'
  | 'missing_evidence'
  | 'ungated_self_report'

export interface StructuralCompletionSignal {
  ready: boolean
  reason: StructuralBlockReason | null
  task_count: number
  gated_pass_count: number
  evidence_count: number
}

export interface ChildTaskRow {
  id: string
  status: string
  gate_owner: string | null
  result: string | null
  assignee_agent_id: string | null
  latest_verdict: string | null
  latest_decided_by: string | null
  /** True when latest decided_by matches an active members.id (human/operator). */
  latest_decider_is_human: boolean
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
  input: {
    status?: ProjectStatus
    completion_proposed_by?: string | null
    via_completion_gate?: boolean
    /** CAS token from the project row read before the structural check. */
    expected_updated_at?: string
    /** When true, UPDATE also re-checks incomplete child count (TOCTOU close). */
    require_structural_ready?: boolean
  },
) => Promise<ProjectMutationResult<Project>>

export interface CompletionGateDeps {
  writeReceipt: WriteReceiptFn
  updateProject: UpdateProjectFn
}

/**
 * Derive the project-completion principal from auth — never from a request body.
 * Mirrors task verdictPrincipal (src/tasks/index.ts).
 */
export function completionPrincipalFromAuth(auth: AuthContext): string {
  if (auth.boundAgentId && auth.boundAgentId.trim() !== '') return auth.boundAgentId
  if (auth.memberId && auth.memberId.trim() !== '') return auth.memberId
  if (auth.userId && auth.userId.trim() !== '') return auth.userId
  throw new Error('invalid_principal')
}

function hasEvidence(result: string | null): boolean {
  return result !== null && result.trim() !== ''
}

function hasRealGate(gateOwner: string | null): boolean {
  if (gateOwner === null) return false
  const trimmed = gateOwner.trim()
  if (trimmed === '') return false
  if (trimmed === AGENT_SELF_COMPLETION_GATE) return false
  return true
}

/**
 * A child task counts as completion evidence only when:
 *   (a) real gate_owner + approved verdict from a different principal than assignee, OR
 *   (b) human/operator sign-off (approved verdict decided by a member).
 * Ungated done + filler result does NOT count. gate:agent-self-completion does NOT count as (a).
 */
export function taskCountsAsCompletionEvidence(task: ChildTaskRow): boolean {
  if (task.status !== 'done') return false
  if (!hasEvidence(task.result)) return false
  if (task.latest_verdict !== 'approved') return false
  if (task.latest_decided_by === null || task.latest_decided_by.trim() === '') return false

  if (task.latest_decider_is_human) return true

  if (!hasRealGate(task.gate_owner)) return false
  if (
    task.assignee_agent_id !== null
    && task.assignee_agent_id.trim() !== ''
    && task.latest_decided_by === task.assignee_agent_id
  ) {
    return false
  }
  return true
}

/**
 * Pure structural signal over child task rows.
 */
export function evaluateStructuralSignal(tasks: readonly ChildTaskRow[]): StructuralCompletionSignal {
  if (tasks.length === 0) {
    return {
      ready: false,
      reason: 'no_tasks',
      task_count: 0,
      gated_pass_count: 0,
      evidence_count: 0,
    }
  }

  let gatedPassCount = 0
  let evidenceCount = 0

  for (const task of tasks) {
    if (task.status !== 'done') {
      return {
        ready: false,
        reason: 'task_not_terminal',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
    if (!hasEvidence(task.result)) {
      return {
        ready: false,
        reason: 'missing_evidence',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
    if (!taskCountsAsCompletionEvidence(task)) {
      const ungatedOrSelfGate = !hasRealGate(task.gate_owner)
      return {
        ready: false,
        reason: ungatedOrSelfGate ? 'ungated_self_report' : 'gate_not_pass',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
    if (hasRealGate(task.gate_owner)) gatedPassCount += 1
    evidenceCount += 1
  }

  return {
    ready: true,
    reason: null,
    task_count: tasks.length,
    gated_pass_count: gatedPassCount,
    evidence_count: evidenceCount,
  }
}

export function defaultCompletionGateDeps(): CompletionGateDeps {
  return {
    writeReceipt: writeReceiptToD1,
    updateProject: updateProjectStructuralFlip,
  }
}

export function completionInstanceId(projectId: string): string {
  return `project-completion:${projectId}`
}

/** True when the decider is the same principal that proposed completion review. */
export function isProjectSelfVerdict(
  completionProposedBy: string | null,
  deciderPrincipalId: string,
): boolean {
  if (completionProposedBy === null || completionProposedBy.trim() === '') return false
  if (deciderPrincipalId.trim() === '') return false
  return completionProposedBy === deciderPrincipalId
}

/**
 * Atomic status flip for the completion gate: CAS on updated_at + optional
 * incomplete-child re-check in the same UPDATE (closes TOCTOU vs concurrent
 * child-task writes). Always sets via_completion_gate.
 */
export async function updateProjectStructuralFlip(
  env: Env,
  id: string,
  input: {
    status?: ProjectStatus
    completion_proposed_by?: string | null
    via_completion_gate?: boolean
    expected_updated_at?: string
    require_structural_ready?: boolean
  },
): Promise<ProjectMutationResult<Project>> {
  const existing = await getProject(env, id)
  if (!existing) return { ok: false, error: 'project_not_found' }

  const nextStatus = input.status ?? existing.status
  const nextProposedBy = input.completion_proposed_by !== undefined
    ? input.completion_proposed_by
    : existing.completion_proposed_by
  const expectedUpdatedAt = input.expected_updated_at ?? existing.updated_at
  const nextUpdatedAt = nextUpdatedAtIso(expectedUpdatedAt)
  const requireReady = input.require_structural_ready === true

  const structuralClause = requireReady
    ? `AND EXISTS (SELECT 1 FROM tasks WHERE project_id = projects.id)
       AND NOT EXISTS (
         SELECT 1 FROM tasks
          WHERE project_id = projects.id AND status <> 'done'
       )`
    : ''

  try {
    const result = await env.DB.prepare(
      `UPDATE projects
          SET status = ?1,
              completion_proposed_by = ?2,
              updated_at = ?3
        WHERE id = ?4
          AND updated_at = ?5
          AND status = ?6
          ${structuralClause}`,
    )
      .bind(
        nextStatus,
        nextProposedBy,
        nextUpdatedAt,
        id,
        expectedUpdatedAt,
        existing.status,
      )
      .run()

    if (Number(result.meta?.changes ?? 0) === 0) {
      const current = await getProject(env, id)
      if (!current) return { ok: false, error: 'project_not_found' }
      if (requireReady) return { ok: false, error: 'completion_gate_required' }
      return { ok: false, error: 'receipt_failed' }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('structural completion required')) {
      return { ok: false, error: 'completion_gate_required' }
    }
    throw error
  }

  const updated = await getProject(env, id)
  if (!updated) return { ok: false, error: 'project_not_found' }
  return { ok: true, value: updated }
}

function nextUpdatedAtIso(previous: string): string {
  const previousMs = Date.parse(previous)
  const floor = Number.isNaN(previousMs) ? Date.now() : previousMs + 1
  return new Date(Math.max(Date.now(), floor)).toISOString()
}

export async function loadChildTaskRows(env: Env, projectId: string): Promise<ChildTaskRow[]> {
  const result = await env.DB.prepare(
    `SELECT t.id AS id,
            t.status AS status,
            t.gate_owner AS gate_owner,
            t.result AS result,
            t.assignee_agent_id AS assignee_agent_id,
            (
              SELECT v.verdict FROM task_verdicts v
               WHERE v.task_id = t.id
               ORDER BY v.decided_at DESC, v.id DESC
               LIMIT 1
            ) AS latest_verdict,
            (
              SELECT v.decided_by FROM task_verdicts v
               WHERE v.task_id = t.id
               ORDER BY v.decided_at DESC, v.id DESC
               LIMIT 1
            ) AS latest_decided_by,
            (
              SELECT CASE
                WHEN EXISTS (
                  SELECT 1 FROM members m
                   WHERE m.id = (
                     SELECT v.decided_by FROM task_verdicts v
                      WHERE v.task_id = t.id
                      ORDER BY v.decided_at DESC, v.id DESC
                      LIMIT 1
                   )
                ) THEN 1 ELSE 0
              END
            ) AS latest_decider_is_human
       FROM tasks t
      WHERE t.project_id = ?1
      ORDER BY t.id ASC`,
  )
    .bind(projectId)
    .all<{
      id: string
      status: string
      gate_owner: string | null
      result: string | null
      assignee_agent_id: string | null
      latest_verdict: string | null
      latest_decided_by: string | null
      latest_decider_is_human: number
    }>()

  return (result.results ?? []).map((row) => ({
    id: row.id,
    status: row.status,
    gate_owner: row.gate_owner,
    result: row.result,
    assignee_agent_id: row.assignee_agent_id,
    latest_verdict: row.latest_verdict,
    latest_decided_by: row.latest_decided_by,
    latest_decider_is_human: Number(row.latest_decider_is_human) === 1,
  }))
}

export async function evaluateStructuralCompletion(
  env: Env,
  projectId: string,
): Promise<StructuralCompletionSignal> {
  const tasks = await loadChildTaskRows(env, projectId)
  return evaluateStructuralSignal(tasks)
}

export type EnterReviewError =
  | 'project_not_found'
  | 'not_active'
  | 'structural_completion_required'
  | 'missing_completion_evidence'
  | 'no_tasks'
  | 'task_not_terminal'
  | 'gate_not_pass'
  | 'ungated_self_report'
  | 'invalid_principal'
  | 'receipt_failed'

export type EnterReviewResult =
  | { ok: true; value: Project; signal: StructuralCompletionSignal }
  | { ok: false; error: EnterReviewError; signal?: StructuralCompletionSignal }

function mapStructuralBlock(reason: StructuralBlockReason): EnterReviewError {
  if (reason === 'missing_evidence') return 'missing_completion_evidence'
  if (reason === 'no_tasks') return 'no_tasks'
  if (reason === 'task_not_terminal') return 'task_not_terminal'
  if (reason === 'gate_not_pass') return 'gate_not_pass'
  if (reason === 'ungated_self_report') return 'ungated_self_report'
  return 'structural_completion_required'
}

function mapStructuralBlockToVerdict(reason: StructuralBlockReason): ProjectVerdictError {
  if (reason === 'missing_evidence') return 'missing_completion_evidence'
  if (reason === 'no_tasks') return 'no_tasks'
  if (reason === 'task_not_terminal') return 'task_not_terminal'
  if (reason === 'gate_not_pass') return 'gate_not_pass'
  if (reason === 'ungated_self_report') return 'ungated_self_report'
  return 'structural_completion_required'
}

function mapFlipError(error: ProjectMutationError): EnterReviewError {
  if (error === 'receipt_failed') return 'receipt_failed'
  if (error === 'completion_gate_required') return 'structural_completion_required'
  return 'structural_completion_required'
}

/**
 * active → review when the structural signal is ready. Records the proposing principal
 * for later self-verdict checks. Never accepts agent "I'm done" without structure.
 * `principal` must be derived from auth / system loop — never from a request body field.
 */
export async function enterProjectReview(
  env: Env,
  projectId: string,
  principal: string,
  deps: CompletionGateDeps,
): Promise<EnterReviewResult> {
  if (principal.trim() === '') return { ok: false, error: 'invalid_principal' }

  const project = await getProject(env, projectId)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status === 'review') {
    return {
      ok: true,
      value: project,
      signal: await evaluateStructuralCompletion(env, projectId),
    }
  }
  if (project.status !== 'active') return { ok: false, error: 'not_active' }

  const signal = await evaluateStructuralCompletion(env, projectId)
  if (!signal.ready) {
    return {
      ok: false,
      error: signal.reason === null ? 'structural_completion_required' : mapStructuralBlock(signal.reason),
      signal,
    }
  }

  await deps.writeReceipt(env, {
    instanceId: completionInstanceId(projectId),
    taskId: lifecycleTaskId(projectId),
    stepName: STRUCTURAL_COMPLETION_STEP,
    status: 'ok',
    detail: JSON.stringify({
      schema: STRUCTURAL_COMPLETION_SCHEMA,
      project_id: projectId,
      principal,
      signal,
    }),
  })

  const updated = await deps.updateProject(env, projectId, {
    status: 'review',
    completion_proposed_by: principal,
    via_completion_gate: true,
    expected_updated_at: project.updated_at,
    require_structural_ready: true,
  })
  if (!updated.ok) {
    return { ok: false, error: mapFlipError(updated.error), signal }
  }
  return { ok: true, value: updated.value, signal }
}

export type ProjectVerdictError =
  | 'project_not_found'
  | 'not_in_review'
  | 'structural_completion_required'
  | 'missing_completion_evidence'
  | 'no_tasks'
  | 'task_not_terminal'
  | 'gate_not_pass'
  | 'ungated_self_report'
  | 'self_verdict'
  | 'invalid_principal'
  | 'invalid_verdict'
  | 'receipt_failed'

export type ProjectVerdictResult =
  | { ok: true; value: Project }
  | { ok: false; error: ProjectVerdictError }

/**
 * review → completed (approved) or review → active (rejected).
 * Self-verdict blocked when decider === completion_proposed_by.
 *
 * `principal` is a top-level auth-derived argument — never taken from a request
 * body field named principal (WARN-2). Callers must use completionPrincipalFromAuth.
 */
export async function applyProjectCompletionVerdict(
  env: Env,
  projectId: string,
  principal: string,
  input: {
    verdict: 'approved' | 'rejected'
    note: string | null
  },
  deps: CompletionGateDeps,
): Promise<ProjectVerdictResult> {
  if (principal.trim() === '') return { ok: false, error: 'invalid_principal' }
  if (input.verdict !== 'approved' && input.verdict !== 'rejected') {
    return { ok: false, error: 'invalid_verdict' }
  }

  const project = await getProject(env, projectId)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status !== 'review') return { ok: false, error: 'not_in_review' }

  if (isProjectSelfVerdict(project.completion_proposed_by, principal)) {
    return { ok: false, error: 'self_verdict' }
  }

  if (input.verdict === 'approved') {
    const signal = await evaluateStructuralCompletion(env, projectId)
    if (!signal.ready) {
      return {
        ok: false,
        error: signal.reason === null ? 'structural_completion_required' : mapStructuralBlockToVerdict(signal.reason),
      }
    }
  }

  await deps.writeReceipt(env, {
    instanceId: completionInstanceId(projectId),
    taskId: lifecycleTaskId(projectId),
    stepName: PROJECT_VERDICT_STEP,
    status: 'ok',
    detail: JSON.stringify({
      schema: PROJECT_VERDICT_SCHEMA,
      project_id: projectId,
      verdict: input.verdict,
      principal,
      note: input.note,
      proposed_by: project.completion_proposed_by,
    }),
  })

  const nextStatus: ProjectStatus = input.verdict === 'approved' ? 'completed' : 'active'
  const updated = await deps.updateProject(env, projectId, {
    status: nextStatus,
    completion_proposed_by: null,
    via_completion_gate: true,
    expected_updated_at: project.updated_at,
    require_structural_ready: input.verdict === 'approved',
  })
  if (!updated.ok) {
    if (updated.error === 'completion_gate_required') {
      return { ok: false, error: 'structural_completion_required' }
    }
    return { ok: false, error: 'receipt_failed' }
  }
  return { ok: true, value: updated.value }
}

export interface LessonsCaptureDetail {
  schema: typeof LESSONS_CAPTURE_SCHEMA
  project_id: string
  principal: string
  from_status: 'completed'
  to_status: 'archived'
  captured_at: string
}

/**
 * Write a lessons-capture receipt when completed → archived.
 * Idempotent per project via INSERT OR IGNORE on (instance_id, step_name).
 */
export async function recordLessonsCapture(
  env: Env,
  projectId: string,
  principal: string,
  capturedAt: string,
  writeReceipt: WriteReceiptFn,
): Promise<LessonsCaptureDetail> {
  const detail: LessonsCaptureDetail = {
    schema: LESSONS_CAPTURE_SCHEMA,
    project_id: projectId,
    principal,
    from_status: 'completed',
    to_status: 'archived',
    captured_at: capturedAt,
  }
  await writeReceipt(env, {
    instanceId: completionInstanceId(projectId),
    taskId: lifecycleTaskId(projectId),
    stepName: LESSONS_CAPTURE_STEP,
    status: 'ok',
    detail: JSON.stringify(detail),
  })
  return detail
}

export function parseLessonsCaptureDetail(raw: string | null): LessonsCaptureDetail | null {
  if (raw === null || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (obj.schema !== LESSONS_CAPTURE_SCHEMA) return null
    if (typeof obj.project_id !== 'string' || obj.project_id.trim() === '') return null
    if (typeof obj.principal !== 'string' || obj.principal.trim() === '') return null
    if (obj.from_status !== 'completed' || obj.to_status !== 'archived') return null
    if (typeof obj.captured_at !== 'string' || obj.captured_at.trim() === '') return null
    return {
      schema: LESSONS_CAPTURE_SCHEMA,
      project_id: obj.project_id,
      principal: obj.principal,
      from_status: 'completed',
      to_status: 'archived',
      captured_at: obj.captured_at,
    }
  } catch {
    return null
  }
}
