// Close a routine run's control board task on every terminal end, and pause a
// routine after repeated unclaimed runs with one idempotent owner notice.

import { TASK_SELECT_COLUMNS } from '../tasks/ranking'
import { createTask, emitTaskEvent } from '../tasks/service'
import type { Env, Task } from '../types'
import { routineControlId } from './identity'

export const UNCLAIMED_PAUSE_THRESHOLD = 3
export const UNCLAIMED_RESULT_SUMMARY = 'unclaimed'
const ROUTINE_ACTOR = 'mupot-routines'
const PAUSE_NOTICE_GATE = 'gate:routines'
const PAUSE_NOTICE_PREFIX = 'Routine paused:'

export type ControlTaskOutcomeKind = 'succeeded' | 'failed' | 'cancelled' | 'skipped' | 'unclaimed'

/** Format stored on tasks.result when a control task is closed. */
export function controlTaskOutcome(kind: ControlTaskOutcomeKind, reason?: string | null): string {
  if (kind === 'succeeded') return 'succeeded'
  const detail = (reason ?? kind).trim() || kind
  return `${kind}: ${detail}`.slice(0, 4000)
}

async function loadTask(env: Env, taskId: string): Promise<Task | null> {
  return env.DB.prepare(
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE id = ?`,
  ).bind(taskId).first<Task>()
}

/**
 * System close for a routine control task. Always lands in terminal `done` with
 * the outcome on `result`. Clears gate_owner so the row cannot linger as board
 * clutter. Idempotent when already done.
 */
export async function closeRoutineControlTask(
  env: Env,
  run: { task_id: string | null; project_id: string },
  outcome: string,
): Promise<boolean> {
  if (!run.task_id) return true
  const task = await loadTask(env, run.task_id)
  if (!task || task.project_id !== run.project_id) return false
  if (task.status === 'done') {
    if (task.result == null || task.result === '') {
      const now = new Date().toISOString()
      await env.DB.prepare(
        `UPDATE tasks SET result = ?, updated_at = ? WHERE id = ? AND project_id = ? AND status = 'done'`,
      ).bind(outcome, now, task.id, run.project_id).run()
    }
    return true
  }
  const now = new Date().toISOString()
  const updated = await env.DB.prepare(
    `UPDATE tasks
        SET status = 'done',
            result = ?,
            gate_owner = NULL,
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
      WHERE id = ? AND project_id = ? AND status != 'done'`,
  ).bind(outcome, now, now, task.id, run.project_id).run()
  if (!Number(updated.meta?.changes ?? 0)) {
    const raced = await loadTask(env, task.id)
    return raced?.status === 'done'
  }
  const closed = { ...task, status: 'done' as const, result: outcome, gate_owner: null, completed_at: task.completed_at ?? now, updated_at: now }
  await emitTaskEvent(env, 'task.updated', closed, { kind: 'member', id: ROUTINE_ACTOR })
  return true
}

export function isUnclaimedResultSummary(summary: string | null | undefined): boolean {
  return summary === UNCLAIMED_RESULT_SUMMARY
}

async function pauseNoticeTaskId(routineId: string): Promise<string> {
  return routineControlId('task', `pause-notice:${routineId}`)
}

/**
 * One open needs-you (blocked + gate_owner, no assignee) per paused routine.
 * Reuses the deterministic id so ticks cannot spam notices.
 */
export async function ensureUnclaimedPauseNotice(
  env: Env,
  routine: {
    id: string
    name: string
    project_id: string
    responsible_squad_id: string
    created_by: string
  },
  unclaimedCount: number,
): Promise<void> {
  const id = await pauseNoticeTaskId(routine.id)
  const existing = await loadTask(env, id)
  const now = new Date().toISOString()
  const title = `${PAUSE_NOTICE_PREFIX} ${routine.name}`.slice(0, 240)
  const body = [
    `Routine "${routine.name}" paused after ${unclaimedCount} consecutive runs were never picked up.`,
    `Owner: ${routine.created_by}.`,
    'Resume or re-enable the routine when a worker is available; this notice closes automatically on enable.',
  ].join('\n')
  if (existing) {
    if (existing.status === 'blocked' && existing.gate_owner === PAUSE_NOTICE_GATE && existing.assignee_agent_id == null) {
      return
    }
    await env.DB.prepare(
      `UPDATE tasks
          SET status = 'blocked',
              title = ?,
              body = ?,
              result = NULL,
              gate_owner = ?,
              assignee_agent_id = NULL,
              completed_at = NULL,
              updated_at = ?
        WHERE id = ? AND project_id = ?`,
    ).bind(title, body, PAUSE_NOTICE_GATE, now, id, routine.project_id).run()
    const refreshed = await loadTask(env, id)
    if (refreshed) {
      await emitTaskEvent(env, 'task.updated', refreshed, { kind: 'member', id: ROUTINE_ACTOR })
    }
    return
  }
  await createTask(env, {
    squad_id: routine.responsible_squad_id,
    project_id: routine.project_id,
    title,
    body,
    done_when: 'Owner resumes or re-enables the routine.',
    status: 'blocked',
    gate_owner: PAUSE_NOTICE_GATE,
    assignee_agent_id: null,
  }, {
    id,
    skipMirror: true,
    allowDeferredPredicate: true,
    actor: { kind: 'member', id: ROUTINE_ACTOR },
  })
}

/** Close the pause notice when the owner enables/resumes the routine. */
export async function closeUnclaimedPauseNotice(env: Env, routineId: string, projectId: string): Promise<void> {
  const id = await pauseNoticeTaskId(routineId)
  const existing = await loadTask(env, id)
  if (!existing || existing.project_id !== projectId) return
  if (existing.status === 'done') return
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE tasks
        SET status = 'done',
            result = 'routine_resumed',
            gate_owner = NULL,
            completed_at = COALESCE(completed_at, ?),
            updated_at = ?
      WHERE id = ? AND project_id = ? AND status != 'done'`,
  ).bind(now, now, id, projectId).run()
  const closed = await loadTask(env, id)
  if (closed) {
    await emitTaskEvent(env, 'task.updated', closed, { kind: 'member', id: ROUTINE_ACTOR })
  }
}

/**
 * If the last N terminal runs for this routine are all unclaimed, pause it and
 * open one owner notice. Idempotent while already paused.
 */
export async function maybePauseAfterUnclaimedRuns(env: Env, routineId: string): Promise<boolean> {
  const routine = await env.DB.prepare(
    `SELECT id, tenant, project_id, name, status, responsible_squad_id, created_by, revision
       FROM routines WHERE id = ? AND tenant = ?`,
  ).bind(routineId, env.TENANT_SLUG).first<{
    id: string
    tenant: string
    project_id: string
    name: string
    status: string
    responsible_squad_id: string
    created_by: string
    revision: number
  }>()
  if (!routine || routine.status !== 'enabled') {
    if (routine?.status === 'paused') {
      await ensureUnclaimedPauseNotice(env, routine, UNCLAIMED_PAUSE_THRESHOLD)
    }
    return false
  }

  const recent = await env.DB.prepare(
    `SELECT status, result_summary FROM routine_runs
      WHERE tenant = ? AND routine_id = ?
        AND status IN ('succeeded','failed','skipped','cancelled')
      ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC
      LIMIT ?`,
  ).bind(env.TENANT_SLUG, routineId, UNCLAIMED_PAUSE_THRESHOLD).all<{
    status: string
    result_summary: string | null
  }>()
  const rows = recent.results ?? []
  if (rows.length < UNCLAIMED_PAUSE_THRESHOLD) return false
  if (!rows.every(row => row.status === 'skipped' && isUnclaimedResultSummary(row.result_summary))) {
    return false
  }

  const now = new Date().toISOString()
  const paused = await env.DB.prepare(
    `UPDATE routines
        SET status = 'paused', next_run_at = NULL, revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant = ? AND status = 'enabled' AND revision = ?`,
  ).bind(now, routine.id, env.TENANT_SLUG, routine.revision).run()
  if (!Number(paused.meta?.changes ?? 0)) {
    const current = await env.DB.prepare(
      `SELECT status FROM routines WHERE id = ? AND tenant = ?`,
    ).bind(routine.id, env.TENANT_SLUG).first<{ status: string }>()
    if (current?.status === 'paused') {
      await ensureUnclaimedPauseNotice(env, routine, UNCLAIMED_PAUSE_THRESHOLD)
    }
    return current?.status === 'paused'
  }
  await ensureUnclaimedPauseNotice(env, routine, UNCLAIMED_PAUSE_THRESHOLD)
  return true
}
