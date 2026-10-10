// src/agents/execution-brake-sql.ts - LEAF module (imports types only) holding the pure SQL
// fragments + labels of the loop brakes, so low-level writers (agents/messages.ts, the runtime
// receipts, task_dispatch) can embed the brake predicates without an import cycle through
// execution-brakes.ts (which depends on runtime-receipts, which depends on messages).
// execution-brakes.ts re-exports everything here; import from either.

import type { Env } from '../types'

/** Refused/failed completions for the same TASK (any agent, any dispatch) before it is held. */
export const EXECUTION_RETRY_CEILING = 3

/** Terminal executor refusals the dispatch receipt must be settled-failed for (nothing executed). */
export const EXECUTION_PAUSED_ERROR = 'execution_paused'
export const RETRY_CEILING_ERROR = 'retry_ceiling_reached'
export const TASK_HELD_ERROR = 'task_held'

/**
 * Boolean SQL fragment: an ACTIVE pause covers this agent, directly or via its CURRENT squad
 * (resolved in-statement, so an agent moved between squads follows the squad pause of the moment).
 * `agentIdExpr` is a bind placeholder / column expression holding agents.id. It is embedded
 * verbatim, never user text.
 */
export function executionPausedSql(agentIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM execution_pauses ep
     WHERE ep.resumed_at IS NULL
       AND (
         (ep.scope_type = 'agent' AND ep.scope_id = ${agentIdExpr})
         OR (ep.scope_type = 'squad'
             AND ep.scope_id = (SELECT pa.squad_id FROM agents pa WHERE pa.id = ${agentIdExpr}))
       )
  )`
}

export async function isExecutionPaused(env: Env, agentId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS paused WHERE ${executionPausedSql('?1')}`)
    .bind(agentId)
    .first<{ paused: number }>()
  return row !== null
}

/** Boolean SQL fragment: the task has an UNRELEASED escalation hold (any agent). */
export function taskHeldSql(taskIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM execution_holds eh
     WHERE eh.task_id = ${taskIdExpr} AND eh.released_at IS NULL
  )`
}

/** Boolean SQL fragment: the task's refusal counter has reached the ceiling. */
export function retryCeilingReachedSql(taskIdExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM task_execution_attempts tea
     WHERE tea.task_id = ${taskIdExpr}
       AND tea.refused_count >= ${EXECUTION_RETRY_CEILING}
  )`
}

export async function isTaskHeld(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS held WHERE ${taskHeldSql('?1')}`)
    .bind(taskId)
    .first<{ held: number }>()
  return row !== null
}

export async function isRetryCeilingReached(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS hit WHERE ${retryCeilingReachedSql('?1')}`)
    .bind(taskId)
    .first<{ hit: number }>()
  return row !== null
}

export type DispatchBrakeReason = typeof TASK_HELD_ERROR | typeof EXECUTION_PAUSED_ERROR | typeof RETRY_CEILING_ERROR

/**
 * Boolean SQL fragment: NONE of the three brakes covers (agent, task) - the task has no unreleased
 * hold, its counter is under the ceiling, and neither the agent nor its CURRENT squad is paused.
 * ONE conjunct for every point where a task becomes "being worked on" outside the in-Worker
 * executor (task_dispatch receipt INSERT, runtime_consumed UPDATE, inbox envelope INSERT), so the
 * refusal rides inside the same write as the effect (a hold placed concurrently cannot slip
 * between a read and the write). Both exprs are bind placeholders / column expressions.
 */
export function dispatchBrakesClearSql(agentIdExpr: string, taskIdExpr: string): string {
  return `(NOT ${taskHeldSql(taskIdExpr)}
    AND NOT ${retryCeilingReachedSql(taskIdExpr)}
    AND NOT ${executionPausedSql(agentIdExpr)})`
}

/**
 * Name WHICH brake refuses (agent, task) right now, or null if none does. Diagnosis only - called
 * AFTER a guarded write changed 0 rows, never used as the guard. Same precedence as the in-Worker
 * pre-check: hold, then pause, then ceiling.
 */
export async function diagnoseDispatchBrake(
  env: Env, agentId: string, taskId: string,
): Promise<DispatchBrakeReason | null> {
  const row = await env.DB.prepare(
    `SELECT CASE
        WHEN ${taskHeldSql('?2')} THEN '${TASK_HELD_ERROR}'
        WHEN ${executionPausedSql('?1')} THEN '${EXECUTION_PAUSED_ERROR}'
        WHEN ${retryCeilingReachedSql('?2')} THEN '${RETRY_CEILING_ERROR}'
        ELSE NULL END AS reason`,
  ).bind(agentId, taskId).first<{ reason: DispatchBrakeReason | null }>()
  return row?.reason ?? null
}

/** Task-id prefix of the per-task RELEASE EPOCH row kept in task_execution_attempts (no migration: the
 *  row is keyed 'release-epoch:<task_id>', its last_at is the time of the last HUMAN release or
 *  reassign; it never matches a real task id lookup, so the counter / ceiling SQL cannot see it). */
export const RELEASE_EPOCH_PREFIX = 'release-epoch:'

/**
 * Boolean SQL fragment: a human release/reassign of the task landed AFTER the attempt started
 * (`startedExpr` = an ISO/SQL timestamp expression of the attempt's start). Retry bookkeeping of such
 * a STALE attempt must not count (it would re-hold the task for the agent a human just assigned,
 * without that agent ever executing). julianday() on both sides: ISO and 'YYYY-MM-DD HH:MM:SS' agree.
 */
export function releasedSinceSql(taskIdExpr: string, startedExpr: string): string {
  return `EXISTS (
    SELECT 1 FROM task_execution_attempts rel
     WHERE rel.task_id = '${RELEASE_EPOCH_PREFIX}' || ${taskIdExpr}
       AND julianday(rel.last_at) > julianday(${startedExpr})
  )`
}
