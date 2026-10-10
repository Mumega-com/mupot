// src/agents/execution-brakes.ts — loop brakes for autonomous execution ("agents as themselves",
// step 1; incident 2026-10-09, mupot#1780).
//
// Defect class: an effectful fan-out with no kill switch and no retry ceiling. Brakes here (the third,
// dry-run-by-default for bulk MCP tools, lives on the tools themselves):
//
//   1. EXECUTION PAUSE — execution_pauses (migration 0203). An org-admin pauses one agent or a whole
//      squad; while ACTIVE, wakeAgent / AgentDO.wake / the executor's claim UPDATE all refuse. This
//      stops IN-WORKER execution only; inbox/poll delivery to an external runtime is not touched.
//   2. PER-TASK RETRY CEILING + HOLD — task_execution_attempts / execution_holds. Each refused attempt
//      bumps ONE atomic per-task counter (all agents, all dispatches). At EXECUTION_RETRY_CEILING the
//      task gets a HOLD: out of executor pickup for EVERY agent until a HUMAN releases it. Nothing
//      resets implicitly (a column change or a re-dispatch must not re-arm the loop); the reset is
//      code, in releaseExecutionHold, called only with a human principal.

import type { Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { GATE_AGENT_SELF_COMPLETION, GATE_ESCALATION } from '../gates/lanes'
import { humanGateHolderExistsSql } from '../tasks/runtime-receipts'

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

/**
 * Count one refused/failed completion for the TASK in ONE atomic statement and return the new
 * count. Concurrent refusals each get a distinct count (the UPDATE branch increments in-row).
 * Per task, not per (agent, task): reassigning to another agent must not buy a fresh budget.
 */
export async function recordRefusedAttempt(
  env: Env,
  agentId: string,
  taskId: string,
  reason: string,
): Promise<number> {
  const now = new Date().toISOString()
  const row = await env.DB.prepare(
    `INSERT INTO task_execution_attempts (task_id, refused_count, last_agent_id, last_reason, first_at, last_at)
     VALUES (?1, 1, ?2, ?3, ?4, ?4)
     ON CONFLICT (task_id) DO UPDATE
        SET refused_count = refused_count + 1,
            last_agent_id = excluded.last_agent_id,
            last_reason = excluded.last_reason,
            last_at = excluded.last_at
     RETURNING refused_count`,
  ).bind(taskId, agentId, reason.slice(0, 500), now).first<{ refused_count: number }>()
  return row?.refused_count ?? 0
}

const RAISABLE_STATUSES_SQL = `('open', 'blocked', 'rejected')`

/**
 * HOLD a task whose counter hit the ceiling and raise it to the human queue. Idempotent: only the
 * call that INSERTs (or re-arms a RELEASED) execution_holds row — the TRANSITION row — goes on to
 * write; the audit entry and the task UPDATE are anchored on that row's escalation_id, not on
 * changes() chaining.
 *
 *   - hold: per TASK; every executor entry (claim UPDATE both branches, the WORKABLE pickup) refuses
 *     the task while released_at IS NULL, whichever agent asks. Only a human releases it.
 *   - eligibility (in the hold statement itself): the task is not archived, is in a raisable status
 *     (open/blocked/rejected - never in_progress/review/done) and is assigned to THIS agent or to
 *     nobody (reassigned elsewhere = not this agent's loop).
 *   - tasks: status 'blocked', assignee cleared (attention/service.ts blocked_tasks source needs
 *     assignee_agent_id IS NULL AND gate_owner IS NOT NULL). gate_owner is kept ONLY when its lane has a
 *     HUMAN holder (or no agent holder at all) - exactly the needs_you humanHolder test; otherwise
 *     (NULL, self-completion, or an agent-held lane such as gate:athena) it becomes GATE_ESCALATION so the
 *     task really lands in a human's queue.
 *   - A task without a project does not appear in needs_you (that source joins projects); it is still
 *     held, blocked and unassigned, and the executor's task.blocked event already notified.
 *
 * Returns true iff THIS call performed the escalation.
 */
export async function escalateRefusedTask(env: Env, agentId: string, taskId: string): Promise<boolean> {
  const now = new Date().toISOString()
  const escalationId = crypto.randomUUID()
  const humanLane = humanGateHolderExistsSql({
    gateOwnerExpr: 'tasks.gate_owner',
    assigneeIdExpr: '?1',
    squadIdExpr: 'tasks.squad_id',
    tenantParam: '?5',
  })
  const results = await env.DB.batch([
    // 1. The transition row: place the hold once, only at/over the ceiling AND while the task is
    //    still raisable by this agent.
    env.DB.prepare(
      `INSERT INTO execution_holds (task_id, escalation_id, agent_id, refused_count, reason, held_at)
       SELECT ?2, ?4, ?1, a.refused_count, a.last_reason, ?3
         FROM task_execution_attempts a
        WHERE a.task_id = ?2
          AND a.refused_count >= ${EXECUTION_RETRY_CEILING}
          AND EXISTS (
            SELECT 1 FROM tasks
             WHERE id = ?2
               AND (assignee_agent_id = ?1 OR assignee_agent_id IS NULL)
               AND status IN ${RAISABLE_STATUSES_SQL}
               AND ${TASK_NOT_ARCHIVED_SQL()}
          )
       ON CONFLICT (task_id) DO UPDATE
          SET escalation_id = excluded.escalation_id, agent_id = excluded.agent_id,
              refused_count = excluded.refused_count, reason = excluded.reason, held_at = excluded.held_at,
              released_at = NULL, released_by_member_id = NULL, release_id = NULL, release_reason = NULL
        WHERE execution_holds.released_at IS NOT NULL`,
    ).bind(agentId, taskId, now, escalationId),
    // 2. Audit receipt, anchored on the hold row.
    env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, agent_id,
         credential_id, origin, handler, operation, target_kind, target_id,
         task_id, request_id, idempotency_key, evidence_json, recorded_at
       )
       SELECT ?1, ?2, 'system', 'execution_retry_ceiling', NULL, ?3,
              NULL, 'worker_callback', 'execution_retry_ceiling', 'escalate_to_human', 'task', ?4,
              ?4, ?5, ?5,
              json_object('agent_id', ?3, 'task_id', ?4, 'refused_count', refused_count,
                          'reason', reason, 'ceiling', ${EXECUTION_RETRY_CEILING}),
              ?6
         FROM execution_holds
        WHERE task_id = ?4 AND escalation_id = ?5`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, agentId, taskId, escalationId, now),
    // 3. The raise itself, anchored on the hold row.
    env.DB.prepare(
      `UPDATE tasks
          SET status = 'blocked',
              assignee_agent_id = NULL,
              gate_owner = CASE
                WHEN gate_owner IS NULL OR gate_owner = '${GATE_AGENT_SELF_COMPLETION}' THEN '${GATE_ESCALATION}'
                WHEN ${humanLane} THEN gate_owner
                WHEN NOT EXISTS (
                  SELECT 1 FROM gate_grants agent_lane
                   WHERE agent_lane.capability = tasks.gate_owner AND agent_lane.principal_type = 'agent'
                ) THEN gate_owner
                ELSE '${GATE_ESCALATION}' END,
              updated_at = ?3
        WHERE id = ?2
          AND status IN ${RAISABLE_STATUSES_SQL}
          AND ${TASK_NOT_ARCHIVED_SQL()}
          AND EXISTS (
            SELECT 1 FROM execution_holds WHERE task_id = ?2 AND escalation_id = ?4
          )`,
    ).bind(agentId, taskId, now, escalationId, env.TENANT_SLUG),
  ])
  return (results[2]?.meta as { changes?: number } | undefined)?.changes === 1
}

export type ReleaseOutcome = 'released' | 'not_held'

/**
 * Release a task's execution hold and reset its refusal counter. The ONLY reset: callers must have
 * established a HUMAN principal (execution_release's operator check; task_update with no agent
 * binding) - this function does not take an agent. One batch, anchored on the released row's
 * release_id: the audit entry and the counter reset only land if THIS call released the hold.
 */
export async function releaseExecutionHold(
  env: Env,
  input: { taskId: string; memberId: string; reason: string; via: 'execution_release' | 'human_reassign' },
): Promise<ReleaseOutcome> {
  const now = new Date().toISOString()
  const releaseId = crypto.randomUUID()
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE execution_holds
          SET released_at = ?2, released_by_member_id = ?3, release_id = ?4, release_reason = ?5
        WHERE task_id = ?1 AND released_at IS NULL`,
    ).bind(input.taskId, now, input.memberId, releaseId, input.reason.slice(0, 2000)),
    env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, agent_id,
         credential_id, origin, handler, operation, target_kind, target_id,
         task_id, request_id, idempotency_key, evidence_json, recorded_at
       )
       SELECT ?1, ?2, 'member', ?3, ?3, NULL,
              NULL, 'mcp', 'execution_release', ?4, 'task', ?5,
              ?5, ?6, ?6,
              json_object('task_id', ?5, 'reason', release_reason, 'via', ?4, 'held_agent_id', agent_id),
              ?7
         FROM execution_holds
        WHERE task_id = ?5 AND release_id = ?6`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, input.memberId, input.via, input.taskId, releaseId, now),
    env.DB.prepare(
      `DELETE FROM task_execution_attempts
        WHERE task_id = ?1
          AND EXISTS (SELECT 1 FROM execution_holds WHERE task_id = ?1 AND release_id = ?2)`,
    ).bind(input.taskId, releaseId),
  ])
  return (results[0]?.meta as { changes?: number } | undefined)?.changes === 1 ? 'released' : 'not_held'
}
