// Project lifecycle structural completion gate (slice 2).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// active → review → completed fires ONLY from a structural signal:
//   all child tasks terminal (done) + gated tasks have latest verdict=approved (PASS)
//   + completion evidence present (non-empty task.result on every child).
// review → completed requires a different-principal gated verdict (self-verdict blocked,
// same shape as task-level K4). Never from agent self-report via updateProject.
// completed → archived writes a lessons-capture receipt through workflow_receipts.

import type { Env, Project, ProjectStatus } from '../types'
import { writeReceiptToD1 } from '../workflows/pipeline'
import { lifecycleTaskId } from './circuit-breaker'
import { getProject, updateProject, type ProjectMutationResult } from './service'

/** Must match AGENT_SELF_COMPLETION_GATE_OWNER in agents/execute.ts — never structural evidence. */
export const AGENT_SELF_COMPLETION_GATE = 'gate:agent-self-completion'

export const PROJECT_COMPLETION_GATE = 'gate:project-completion'
export const LESSONS_CAPTURE_STEP = 'lessons_capture'
export const LESSONS_CAPTURE_SCHEMA = 'mupot.lessons_capture/v1'
export const STRUCTURAL_COMPLETION_STEP = 'structural_completion'
export const STRUCTURAL_COMPLETION_SCHEMA = 'mupot.structural_completion/v1'
export const PROJECT_VERDICT_STEP = 'project_completion_verdict'
export const PROJECT_VERDICT_SCHEMA = 'mupot.project_completion_verdict/v1'

export type StructuralBlockReason =
  | 'no_tasks'
  | 'task_not_terminal'
  | 'gate_not_pass'
  | 'missing_evidence'
  | 'self_gated'
  | 'self_verdict'

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
  latest_verdict_by: string | null
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
  },
) => Promise<ProjectMutationResult<Project>>

export interface CompletionGateDeps {
  writeReceipt: WriteReceiptFn
  updateProject: UpdateProjectFn
}

export function defaultCompletionGateDeps(): CompletionGateDeps {
  return {
    writeReceipt: writeReceiptToD1,
    updateProject: (env, id, input) => updateProject(env, id, { ...input, via_completion_gate: true }),
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

function hasEvidence(result: string | null): boolean {
  return result !== null && result.trim() !== ''
}

function hasRealGateOwner(gateOwner: string | null): boolean {
  if (gateOwner === null || gateOwner.trim() === '') return false
  // Self-satisfiable agent gate is never structural completion evidence.
  if (gateOwner === AGENT_SELF_COMPLETION_GATE) return false
  return true
}

/**
 * Approved verdict must come from a DIFFERENT principal than the assignee
 * (or be a human/member sign-off whose id ≠ assignee). Assignee self-verdict
 * and missing decider are rejected.
 */
export function isTaskSelfVerdict(
  assigneeAgentId: string | null,
  verdictBy: string | null,
): boolean {
  if (verdictBy === null || verdictBy.trim() === '') return true
  if (assigneeAgentId === null || assigneeAgentId.trim() === '') return false
  return assigneeAgentId === verdictBy
}

/**
 * Pure structural signal over child task rows.
 * Every child must be done, carry a real (non-self) gate_owner, an approved
 * verdict from a different principal than the assignee, and non-empty evidence.
 * Ungated done+result and gate:agent-self-completion never count.
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
    if (task.gate_owner === AGENT_SELF_COMPLETION_GATE) {
      return {
        ready: false,
        reason: 'self_gated',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
    if (!hasRealGateOwner(task.gate_owner)) {
      return {
        ready: false,
        reason: 'gate_not_pass',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
    if (task.latest_verdict !== 'approved') {
      return {
        ready: false,
        reason: 'gate_not_pass',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
    if (isTaskSelfVerdict(task.assignee_agent_id, task.latest_verdict_by)) {
      return {
        ready: false,
        reason: 'self_verdict',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
    gatedPassCount += 1
    if (!hasEvidence(task.result)) {
      return {
        ready: false,
        reason: 'missing_evidence',
        task_count: tasks.length,
        gated_pass_count: gatedPassCount,
        evidence_count: evidenceCount,
      }
    }
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
            ) AS latest_verdict_by
       FROM tasks t
      WHERE t.project_id = ?1
      ORDER BY t.id ASC`,
  )
    .bind(projectId)
    .all<ChildTaskRow>()
  return result.results ?? []
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
  | 'invalid_principal'
  | 'receipt_failed'

export type EnterReviewResult =
  | { ok: true; value: Project; signal: StructuralCompletionSignal }
  | { ok: false; error: EnterReviewError; signal?: StructuralCompletionSignal }

function mapStructuralBlock(reason: StructuralBlockReason): EnterReviewError {
  if (reason === 'missing_evidence') return 'missing_completion_evidence'
  if (reason === 'no_tasks') return 'no_tasks'
  if (reason === 'task_not_terminal') return 'task_not_terminal'
  if (reason === 'gate_not_pass' || reason === 'self_gated' || reason === 'self_verdict') {
    return 'gate_not_pass'
  }
  return 'structural_completion_required'
}

function mapStructuralBlockToVerdict(reason: StructuralBlockReason): ProjectVerdictError {
  if (reason === 'missing_evidence') return 'missing_completion_evidence'
  if (reason === 'no_tasks') return 'no_tasks'
  if (reason === 'task_not_terminal') return 'task_not_terminal'
  if (reason === 'gate_not_pass' || reason === 'self_gated') return 'gate_not_pass'
  if (reason === 'self_verdict') return 'self_verdict'
  return 'structural_completion_required'
}

/**
 * active → review when the structural signal is ready. Records the proposing principal
 * for later self-verdict checks. Never accepts agent "I'm done" without structure.
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
  })
  if (!updated.ok) {
    return { ok: false, error: updated.error === 'receipt_failed' ? 'receipt_failed' : 'structural_completion_required', signal }
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
 */
export async function applyProjectCompletionVerdict(
  env: Env,
  projectId: string,
  input: {
    verdict: 'approved' | 'rejected'
    principal: string
    note: string | null
  },
  deps: CompletionGateDeps,
): Promise<ProjectVerdictResult> {
  if (input.principal.trim() === '') return { ok: false, error: 'invalid_principal' }
  if (input.verdict !== 'approved' && input.verdict !== 'rejected') {
    return { ok: false, error: 'invalid_verdict' }
  }

  const project = await getProject(env, projectId)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (project.status !== 'review') return { ok: false, error: 'not_in_review' }

  if (isProjectSelfVerdict(project.completion_proposed_by, input.principal)) {
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
      principal: input.principal,
      note: input.note,
      proposed_by: project.completion_proposed_by,
    }),
  })

  const nextStatus: ProjectStatus = input.verdict === 'approved' ? 'completed' : 'active'
  const updated = await deps.updateProject(env, projectId, {
    status: nextStatus,
    completion_proposed_by: null,
  })
  if (!updated.ok) return { ok: false, error: 'receipt_failed' }
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
