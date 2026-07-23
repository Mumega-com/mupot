// Project lifecycle structural completion gate (slice 2).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// active → review → completed fires ONLY from a structural signal:
//   every child task counts as completion evidence only when (a) a real gate_owner
//   (not gate:agent-self-completion) has an approved verdict from a DIFFERENT
//   principal, OR (b) an explicit human/operator (members row) sign-off verdict;
//   plus non-empty task.result on every child.
// review → completed requires a different-principal gated verdict (self-verdict blocked,
// same shape as task-level K4). Never from agent self-report via updateProject.
// completed → archived writes a lessons-capture receipt through workflow_receipts.

import type { AuthContext, Env, Project, ProjectStatus } from '../types'
import { writeReceiptToD1 } from '../workflows/pipeline'
import { lifecycleTaskId } from './circuit-breaker'
import { getProject, updateProject, type ProjectMutationResult } from './service'

export const PROJECT_COMPLETION_GATE = 'gate:project-completion'
export const LESSONS_CAPTURE_STEP = 'lessons_capture'
export const LESSONS_CAPTURE_SCHEMA = 'mupot.lessons_capture/v1'
export const STRUCTURAL_COMPLETION_STEP = 'structural_completion'
export const STRUCTURAL_COMPLETION_SCHEMA = 'mupot.structural_completion/v1'
export const PROJECT_VERDICT_STEP = 'project_completion_verdict'
export const PROJECT_VERDICT_SCHEMA = 'mupot.project_completion_verdict/v1'

/** Same capability string as AGENT_SELF_COMPLETION_GATE_OWNER — never project evidence. */
export const AGENT_SELF_COMPLETION_GATE = 'gate:agent-self-completion'

export type StructuralBlockReason =
  | 'no_tasks'
  | 'task_not_terminal'
  | 'gate_not_pass'
  | 'missing_evidence'

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
  /** 1 when latest_decided_by matches an active/suspended members.id (human/operator). */
  decided_by_is_member: number | null
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

/**
 * Derive the lifecycle principal from auth context — never from a request body.
 * Used by project completion verdict routes when wired.
 */
export function lifecyclePrincipalFromAuth(auth: AuthContext): string {
  if (auth.boundAgentId !== undefined && auth.boundAgentId !== null && auth.boundAgentId.trim() !== '') {
    return auth.boundAgentId.trim()
  }
  if (auth.memberId !== undefined && auth.memberId.trim() !== '') {
    return auth.memberId.trim()
  }
  if (auth.userId.trim() !== '') return auth.userId.trim()
  return ''
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

function hasRealGate(gateOwner: string | null): boolean {
  if (gateOwner === null || gateOwner.trim() === '') return false
  return gateOwner.trim() !== AGENT_SELF_COMPLETION_GATE
}

function isHumanOperatorSignOff(task: ChildTaskRow): boolean {
  if (task.latest_verdict !== 'approved') return false
  if (task.latest_decided_by === null || task.latest_decided_by.trim() === '') return false
  if (task.decided_by_is_member !== 1) return false
  // Different principal: member must not be the assignee agent id.
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
 * A done task counts as project completion evidence only when:
 *   (a) real gate_owner (not gate:agent-self-completion) + approved verdict from
 *       a principal different from the assignee, OR
 *   (b) explicit human/operator sign-off (approved verdict by a members row).
 * Ungated self-reported done tasks do not count.
 */
export function taskCountsAsCompletionEvidence(task: ChildTaskRow): boolean {
  if (task.status !== 'done') return false
  if (!hasEvidence(task.result)) return false

  // gate:agent-self-completion is never valid project-completion evidence.
  if (task.gate_owner !== null && task.gate_owner.trim() === AGENT_SELF_COMPLETION_GATE) {
    return false
  }

  if (isHumanOperatorSignOff(task)) return true

  if (!hasRealGate(task.gate_owner)) return false
  if (task.latest_verdict !== 'approved') return false
  if (task.latest_decided_by === null || task.latest_decided_by.trim() === '') return false
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
 * Evidence rules: see taskCountsAsCompletionEvidence.
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
      return {
        ready: false,
        reason: 'gate_not_pass',
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
              SELECT CASE WHEN EXISTS (
                SELECT 1 FROM members m
                 WHERE m.id = (
                   SELECT v2.decided_by FROM task_verdicts v2
                    WHERE v2.task_id = t.id
                    ORDER BY v2.decided_at DESC, v2.id DESC
                    LIMIT 1
                 )
              ) THEN 1 ELSE 0 END
            ) AS decided_by_is_member
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
  if (reason === 'gate_not_pass') return 'gate_not_pass'
  return 'structural_completion_required'
}

function mapStructuralBlockToVerdict(reason: StructuralBlockReason): ProjectVerdictError {
  if (reason === 'missing_evidence') return 'missing_completion_evidence'
  if (reason === 'no_tasks') return 'no_tasks'
  if (reason === 'task_not_terminal') return 'task_not_terminal'
  if (reason === 'gate_not_pass') return 'gate_not_pass'
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

  // TOCTOU: re-check structural predicate immediately before the status flip.
  const signalAtWrite = await evaluateStructuralCompletion(env, projectId)
  if (!signalAtWrite.ready) {
    return {
      ok: false,
      error: signalAtWrite.reason === null
        ? 'structural_completion_required'
        : mapStructuralBlock(signalAtWrite.reason),
      signal: signalAtWrite,
    }
  }

  const updated = await deps.updateProject(env, projectId, {
    status: 'review',
    completion_proposed_by: principal,
  })
  if (!updated.ok) {
    return {
      ok: false,
      error: updated.error === 'receipt_failed'
        ? 'receipt_failed'
        : updated.error === 'completion_gate_required'
          ? 'structural_completion_required'
          : 'structural_completion_required',
      signal: signalAtWrite,
    }
  }
  return { ok: true, value: updated.value, signal: signalAtWrite }
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

export interface ProjectCompletionVerdictInput {
  verdict: 'approved' | 'rejected'
  note: string | null
}

/**
 * review → completed (approved) or review → active (rejected).
 * Self-verdict blocked when decider === completion_proposed_by.
 *
 * `principal` MUST be derived from auth via lifecyclePrincipalFromAuth — never
 * from a caller-supplied request body field.
 */
export async function applyProjectCompletionVerdict(
  env: Env,
  projectId: string,
  input: ProjectCompletionVerdictInput,
  principal: string,
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

  if (input.verdict === 'approved') {
    // TOCTOU: re-check structural predicate immediately before completed flip.
    const signalAtWrite = await evaluateStructuralCompletion(env, projectId)
    if (!signalAtWrite.ready) {
      return {
        ok: false,
        error: signalAtWrite.reason === null
          ? 'structural_completion_required'
          : mapStructuralBlockToVerdict(signalAtWrite.reason),
      }
    }
  }

  const nextStatus: ProjectStatus = input.verdict === 'approved' ? 'completed' : 'active'
  const updated = await deps.updateProject(env, projectId, {
    status: nextStatus,
    completion_proposed_by: null,
  })
  if (!updated.ok) {
    if (updated.error === 'completion_gate_required') {
      return { ok: false, error: 'structural_completion_required' }
    }
    return { ok: false, error: 'receipt_failed' }
  }
  return { ok: true, value: updated.value }
}

/**
 * Auth-bound entry point for project completion verdicts. Principal is taken
 * only from AuthContext — request bodies must never supply it.
 */
export async function applyProjectCompletionVerdictFromAuth(
  env: Env,
  projectId: string,
  input: ProjectCompletionVerdictInput,
  auth: AuthContext,
  deps: CompletionGateDeps,
): Promise<ProjectVerdictResult> {
  return applyProjectCompletionVerdict(
    env,
    projectId,
    input,
    lifecyclePrincipalFromAuth(auth),
    deps,
  )
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
