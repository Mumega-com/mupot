// Close a routine run's control board task on every terminal end state.
// Auto-pause after repeated unclaimed runs is out of scope (see mupot#2424).

import { GATE_ROUTINES } from '../gates/lanes'
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

const ROUTINE_ACTOR = 'mupot-routines'

export type ControlTaskOutcomeKind = 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'unclaimed'

/** Format stored on tasks.result when a control task is closed. */
export function controlTaskOutcome(kind: ControlTaskOutcomeKind, reason?: string | null): string {
  if (kind === 'succeeded') return 'succeeded'
  const detail = (reason ?? kind).trim() || kind
  return `${kind}: ${detail}`.slice(0, 4000)
}

export function isSuccessControlOutcome(outcome: string): boolean {
  return outcome === 'succeeded'
}

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  return env.DB.prepare(
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE id = ?`,
  ).bind(taskId).first<Task>()
}

/** Human / council / other gates must keep their own verdict path (Law 4). */
export function isProtectedHumanGate(gateOwner: string | null | undefined): boolean {
  if (!gateOwner) return false
  return gateOwner !== GATE_ROUTINES
}

async function writeResultFenced(
  env: Env,
  task: Pick<Task, 'id' | 'project_id' | 'updated_at'>,
  outcome: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE tasks SET result = ?
      WHERE id = ? AND project_id = ? AND status = 'done' AND updated_at = ?
        AND (result IS NULL OR result = '')`,
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

/**
 * Advance one legal transition toward done (open/blocked need in_progress first;
 * review under gate:routines is rejected then done — never a human-gate bypass).
 */
async function stepTowardDone(
  env: Env,
  task: Task,
  opts: { clearRoutineGate: boolean; clearAssignee: boolean; now: string },
): Promise<Task> {
  let nextStatus: TaskStatus | null = null
  if (task.status === 'open' || task.status === 'blocked') nextStatus = 'in_progress'
  else if (task.status === 'review') nextStatus = 'rejected'
  else if (task.status === 'in_progress' || task.status === 'approved' || task.status === 'rejected') {
    nextStatus = 'done'
  } else if (task.status === 'done') {
    return task
  } else {
    return task
  }

  const transitionError = checkTransition(task.status, nextStatus)
  if (transitionError) return task

  const existing = task
  const next: Task = {
    ...task,
    status: nextStatus,
    gate_owner: opts.clearRoutineGate && task.gate_owner === GATE_ROUTINES ? null : task.gate_owner,
    assignee_agent_id: opts.clearAssignee && nextStatus === 'done' ? null : task.assignee_agent_id,
  }
  stampTaskUpdate(next, existing.status, opts.now)
  return persistStep(env, existing, next, ROUTINE_ACTOR)
}

/**
 * System close for a routine control task. Lands in terminal `done` with the
 * outcome on `result` when the task is closable. Clears ONLY `gate:routines`.
 * Leaves human gates untouched. Idempotent when already done.
 *
 * Returns true when the task is done (or absent), false when a protected human
 * gate blocks the close or ownership does not match.
 */
export async function closeRoutineControlTask(
  env: Env,
  run: { task_id: string | null; project_id: string },
  outcome: string,
): Promise<boolean> {
  if (!run.task_id) return true
  let task = await loadTask(env, run.task_id)
  if (!task || task.project_id !== run.project_id) return false

  if (task.status === 'done') {
    if (task.result == null || task.result === '') {
      await writeResultFenced(env, task, outcome)
    }
    return true
  }

  if (isProtectedHumanGate(task.gate_owner)) {
    return false
  }

  const clearAssignee = !isSuccessControlOutcome(outcome)
  const now = new Date().toISOString()
  // At most open/blocked → in_progress → (review → rejected →) done.
  for (let i = 0; i < 4; i++) {
    if (task.status === 'done') break
    if (isProtectedHumanGate(task.gate_owner)) return false
    const before = `${task.status}:${task.updated_at}:${task.gate_owner ?? ''}`
    task = await stepTowardDone(env, task, {
      clearRoutineGate: true,
      clearAssignee,
      now,
    })
    const after = `${task.status}:${task.updated_at}:${task.gate_owner ?? ''}`
    if (before === after) break
  }

  if (task.status !== 'done') {
    const raced = await loadTask(env, task.id)
    if (raced?.status === 'done') {
      await writeResultFenced(env, raced, outcome)
      return true
    }
    return false
  }

  await writeResultFenced(env, task, outcome)
  return true
}
