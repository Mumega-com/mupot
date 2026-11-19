// Close a routine run's control board task when a DEAD run ends (close-only).
// Auto-pause after repeated unclaimed runs is out of scope (see mupot#2424).
//
// Scope cut (PR #2425 final): only open control tasks (open / in_progress / blocked)
// with no gate_owner and no pending verdict. Never walk review → rejected → done.
// Never clear the assignee (KPI honesty keeps failures in task_count).

import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { TASK_SELECT_COLUMNS } from '../tasks/ranking'
import {
  checkTransition,
  emitTaskEvent,
  persistTaskUpdate,
  stampTaskUpdate,
  TaskUpdateConflictError,
  type TaskStatus,
} from '../tasks/service'
import type { Env, Task } from '../types'
import { routineControlId } from './identity'

const ROUTINE_ACTOR = 'mupot-routines'

export type ControlTaskOutcomeKind = 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'unclaimed'

/** Format stored on tasks.result when a control task is closed. */
export function controlTaskOutcome(kind: ControlTaskOutcomeKind, reason?: string | null): string {
  if (kind === 'succeeded') return 'succeeded'
  const detail = (reason ?? kind).trim() || kind
  return `${kind}: ${detail}`.slice(0, 4000)
}

export function isSuccessControlOutcome(outcome: string): boolean {
  return outcome === 'succeeded' || outcome.startsWith('succeeded')
}

/**
 * Resolve the control task id minted for THIS attempt.
 * Prefers routineControlId(run:attempt). Never returns a prior attempt's id
 * still hanging on routine_runs.task_id after a pause/retry (lens P1).
 * Allows a non-hashed fixture id on the current attempt only when it is not
 * equal to any earlier attempt's mint.
 */
export async function resolveAttemptControlTaskId(
  env: Env,
  run: { id: string; attempt: number; task_id: string | null; project_id: string },
): Promise<string | null> {
  const attemptId = await routineControlId('task', `${run.id}:${run.attempt}`)
  const minted = await env.DB.prepare(
    `SELECT id, project_id FROM tasks WHERE id = ?`,
  ).bind(attemptId).first<{ id: string; project_id: string }>()
  if (minted && minted.project_id === run.project_id) return attemptId

  if (!run.task_id || run.task_id === attemptId) return minted ? attemptId : null

  for (let a = 1; a < run.attempt; a++) {
    if (run.task_id === await routineControlId('task', `${run.id}:${a}`)) return null
  }
  const live = await env.DB.prepare(
    `SELECT id, project_id FROM tasks WHERE id = ?`,
  ).bind(run.task_id).first<{ id: string; project_id: string }>()
  if (live && live.project_id === run.project_id) return run.task_id
  return null
}

/** Statuses the system close may advance (never review / approved / rejected). */
const CLOSABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(['open', 'in_progress', 'blocked'])

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  return env.DB.prepare(
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE id = ?`,
  ).bind(taskId).first<Task>()
}

/**
 * Write the outcome onto a done row. Fenced on updated_at + project_id and
 * refuses archived rows (task-archive-action-boundary). Empty-result only so a
 * second close is a no-op.
 */
async function writeResultFenced(
  env: Env,
  task: Pick<Task, 'id' | 'project_id' | 'updated_at'>,
  outcome: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET result = ?
      WHERE id = ? AND project_id = ? AND status = 'done' AND updated_at = ?
        AND (result IS NULL OR result = '')
        AND ${TASK_NOT_ARCHIVED_SQL()}`,
  ).bind(outcome, task.id, task.project_id, task.updated_at).run()
}

async function persistStep(
  env: Env,
  existing: Task,
  next: Task,
  actorId: string,
): Promise<Task> {
  try {
    await persistTaskUpdate(env, existing, next)
  } catch (error) {
    if (!(error instanceof TaskUpdateConflictError)) throw error
    const raced = await loadTask(env, existing.id)
    if (!raced || raced.project_id !== existing.project_id) throw error
    return raced
  }
  await emitTaskEvent(env, 'task.updated', next, { kind: 'member', id: actorId })
  return next
}

/** One legal transition toward done for an open control task (no gate). */
async function stepTowardDone(env: Env, task: Task, now: string): Promise<Task> {
  let nextStatus: TaskStatus | null = null
  if (task.status === 'open' || task.status === 'blocked') nextStatus = 'in_progress'
  else if (task.status === 'in_progress') nextStatus = 'done'
  else return task

  const transitionError = checkTransition(task.status, nextStatus)
  if (transitionError) return task

  const existing = task
  const next: Task = { ...task, status: nextStatus }
  stampTaskUpdate(next, existing.status, now)
  return persistStep(env, existing, next, ROUTINE_ACTOR)
}

/**
 * System close for a routine control task. Lands in terminal `done` with the
 * outcome on `result` when the task is closable.
 *
 * Closable: status in {open, in_progress, blocked}, no gate_owner, not archived.
 * Leaves review / approved / rejected / any gated task untouched (outcome stays
 * on the run only). Keeps assignee_agent_id. Idempotent when already done.
 *
 * Returns true when the task is done (or absent / left untouched by design),
 * false when ownership does not match.
 */
export async function closeRoutineControlTask(
  env: Env,
  run: { task_id: string | null; project_id: string },
  outcome: string,
): Promise<boolean> {
  if (!run.task_id) return true
  let task = await loadTask(env, run.task_id)
  // Absent row = this attempt never minted a control task (no-op, not an error).
  if (!task) return true
  if (task.project_id !== run.project_id) return false

  if (task.status === 'done') {
    if (task.result == null || task.result === '') {
      await writeResultFenced(env, task, outcome)
    }
    return true
  }

  // Any gate (including gate:routines) or a non-open status → leave untouched.
  if (task.gate_owner || !CLOSABLE_STATUSES.has(task.status)) {
    return true
  }

  const now = new Date().toISOString()
  // open/blocked → in_progress → done (at most two steps).
  for (let i = 0; i < 2; i++) {
    if (task.status === 'done') break
    if (task.gate_owner || !CLOSABLE_STATUSES.has(task.status)) return true
    const before = `${task.status}:${task.updated_at}`
    task = await stepTowardDone(env, task, now)
    const after = `${task.status}:${task.updated_at}`
    if (before === after) break
  }

  if (task.status !== 'done') {
    const raced = await loadTask(env, task.id)
    if (raced?.status === 'done') {
      await writeResultFenced(env, raced, outcome)
      return true
    }
    // Left open (race / transition refused) — outcome stays on the run only.
    return true
  }

  await writeResultFenced(env, task, outcome)
  return true
}
