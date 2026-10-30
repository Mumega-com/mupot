import type { Env } from '../types'
import { routineTablesReady } from './schema-ready'
import { ROUTINE_ACTOR } from './running-action'

export const DEFAULT_ROUTINE_REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000
export const MAX_ROUTINE_REVIEW_WINDOW_MS = 7 * DEFAULT_ROUTINE_REVIEW_WINDOW_MS

/** Configuration applies to new asks; the server snapshots it in the review event. */
export function routineReviewDeadline(env: Env, requestedAt: string): string {
  const configured = Number(env.ROUTINE_REVIEW_WINDOW_MS)
  const window = Number.isSafeInteger(configured) && configured >= DEFAULT_ROUTINE_REVIEW_WINDOW_MS
    && configured <= MAX_ROUTINE_REVIEW_WINDOW_MS ? configured : DEFAULT_ROUTINE_REVIEW_WINDOW_MS
  return new Date(Date.parse(requestedAt) + window).toISOString()
}

const ISO = '%Y-%m-%dT%H:%M:%fZ'

/** SQL expressions only, never caller text. Current proposal/action + immutable ask.
 * Legacy asks without a snapshot get exactly 24h, not a mutable updated_at clock.
 * An invalid snapshot/binding grants no watchdog exemption. */
function reviewEventValueSql(run: string, field: 'requested' | 'deadline'): string {
  const metadata = "CASE WHEN json_valid(e.metadata_json) THEN e.metadata_json ELSE '{}' END"
  const snapshot = `json_extract(${metadata}, '$.review_deadline_at')`
  const minimum = `strftime('${ISO}', e.occurred_at, '+24 hours')`
  const maximum = `strftime('${ISO}', e.occurred_at, '+168 hours')`
  const deadline = `(CASE WHEN json_type(${metadata}, '$.review_deadline_at') IS NULL THEN ${minimum}
    WHEN typeof(${snapshot}) = 'text' AND ${snapshot} = strftime('${ISO}', ${snapshot})
      AND ${snapshot} >= ${minimum} AND ${snapshot} <= ${maximum} THEN ${snapshot} ELSE NULL END)`
  return `(CASE WHEN ${run}.status = 'waiting' AND ${run}.waiting_reason = 'review' THEN (
    SELECT ${field === 'requested' ? 'e.occurred_at' : deadline}
      FROM routine_run_events e
      JOIN routine_run_actions a ON a.run_id = e.run_id AND a.tenant = e.tenant AND a.project_id = e.project_id
     WHERE e.run_id = ${run}.id AND e.tenant = ${run}.tenant AND e.project_id = ${run}.project_id
       AND e.kind = 'approval_requested' AND json_valid(e.metadata_json)
       AND e.actor_type = 'system' AND e.actor_id = '${ROUTINE_ACTOR}'
       AND json_valid(${run}.proposal_json)
       AND a.action_key = json_extract(CASE WHEN json_valid(${run}.proposal_json) THEN ${run}.proposal_json ELSE '{}' END, '$.action.key')
       AND a.action_key = json_extract(${metadata}, '$.action_key')
       AND (json_type(${metadata}, '$.attempt') IS NULL OR json_extract(${metadata}, '$.attempt') = ${run}.attempt)
       AND a.source_type = 'task' AND a.source_id = ${run}.task_id
       AND a.status IN ('waiting','pending') AND a.gate_status IN ('pending','approved')
       AND e.occurred_at >= a.created_at
     ORDER BY e.occurred_at DESC, e.id ASC LIMIT 1
  ) ELSE NULL END)`
}

export const routineReviewRequestedSql = (run: string) => reviewEventValueSql(run, 'requested')
export const routineReviewDeadlineSql = (run: string) => reviewEventValueSql(run, 'deadline')

export function flightReviewValueSql(flight: string, field: 'requested' | 'deadline'): string {
  return `(SELECT ${reviewEventValueSql('review_run', field)} FROM routine_runs review_run
    WHERE ${flight}.status = 'running' AND review_run.flight_id = ${flight}.id AND review_run.tenant = ${flight}.tenant
      AND review_run.project_id = ${flight}.project_id
      AND (SELECT COUNT(*) FROM routine_runs bound_run
        WHERE bound_run.flight_id = ${flight}.id AND bound_run.tenant = ${flight}.tenant
          AND bound_run.status IN ('queued','leased','observing','waiting','running')) = 1
    LIMIT 1)`
}

export function taskReviewDeadlineSql(task: string, tenantExpression: string): string {
  return `(SELECT ${routineReviewDeadlineSql('review_run')} FROM routine_runs review_run
    WHERE review_run.task_id = ${task}.id AND review_run.project_id = ${task}.project_id
      AND review_run.tenant = ${tenantExpression} AND review_run.status = 'waiting'
      AND review_run.waiting_reason = 'review' LIMIT 1)`
}

/** Decorate already-authorized task reads, never a physical Task column or write. */
export async function withRoutineReviewDeadlines<T extends { id: string; project_id?: string | null; status?: string }>(
  env: Env, tasks: T[],
): Promise<Array<T & { routine_review_deadline_at?: string }>> {
  if (!tasks.length) return []
  const candidates = tasks.filter(task => task.status === undefined || task.status === 'review' || task.status === 'approved')
  const empty = () => tasks
  if (!candidates.length) return empty()
  try {
    if (!await routineTablesReady(env)) return empty()
    const rows = await env.DB.prepare(`SELECT t.id, ${taskReviewDeadlineSql('t', '?1')} AS deadline
      FROM tasks t WHERE EXISTS (SELECT 1 FROM json_each(?2) authorized
        WHERE json_extract(authorized.value, '$.id') = t.id
          AND t.project_id IS json_extract(authorized.value, '$.project_id'))`)
      .bind(env.TENANT_SLUG, JSON.stringify(candidates.map(task => ({ id: task.id, project_id: task.project_id ?? null }))))
      .all<{ id: string; deadline: string | null }>()
    const deadlines = new Map(rows.results.map(row => [row.id, row.deadline]))
    return tasks.map(task => {
      const deadline = deadlines.get(task.id)
      return deadline ? { ...task, routine_review_deadline_at: deadline } : task
    })
  } catch {
    // Optional read hint: absence never permits extending or reaping a run.
    return empty()
  }
}
