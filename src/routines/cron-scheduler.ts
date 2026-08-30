// src/routines/cron-scheduler.ts — Autonomous Agent Cron Routine Scheduler & Workforce Dispatcher.

import type { Env } from '../types'
import { nextRoutineOccurrence, routineOccurrenceKey } from './schedule'
import type { Routine, RoutineSchedule } from './types'
import { createBus } from '../bus'
import { assertBatchWritten } from '../lib/receipt'

export interface RoutineDispatchSummary {
  checked: number
  dispatched: number
  skipped: number
  errors: string[]
}

/**
 * Evaluates all enabled project routines whose next_run_at is due and triggers autonomous execution.
 */
export async function evaluateAndDispatchDueRoutines(
  env: Env,
  nowMs: number = Date.now(),
): Promise<RoutineDispatchSummary> {
  const summary: RoutineDispatchSummary = {
    checked: 0,
    dispatched: 0,
    skipped: 0,
    errors: [],
  }

  const nowIso = new Date(nowMs).toISOString()
  const bus = createBus(env)

  // 1. Fetch enabled routines whose scheduled next_run_at <= now
  let rows: Routine[] = []
  try {
    const result = await env.DB.prepare(`
      SELECT * FROM routines
       WHERE tenant = ?1
         AND status = 'enabled'
         AND next_run_at IS NOT NULL
         AND next_run_at <= ?2
       ORDER BY next_run_at ASC
       LIMIT 50
    `)
      .bind(env.TENANT_SLUG, nowIso)
      .all<Routine>()

    rows = result.results || []
  } catch (error) {
    summary.errors.push(`Query failed: ${error instanceof Error ? error.message : String(error)}`)
    return summary
  }

  summary.checked = rows.length

  for (const routine of rows) {
    try {
      let scheduleObj: RoutineSchedule
      const timezone = routine.timezone || 'UTC'
      if (routine.trigger_kind === 'manual') {
        scheduleObj = { kind: 'manual', timezone }
      } else if (routine.trigger_kind === 'once') {
        if (!routine.run_once_at) throw new Error('once routine missing run_once_at')
        scheduleObj = { kind: 'once', timezone, runOnceAt: routine.run_once_at }
      } else {
        if (!routine.cron_expression) throw new Error('cron routine missing cron_expression')
        scheduleObj = { kind: 'cron', timezone, cronExpression: routine.cron_expression }
      }

      const scheduledDate = new Date(routine.next_run_at || nowIso)
      const occurrenceKey = routineOccurrenceKey(scheduleObj, scheduledDate)
      const runId = crypto.randomUUID()

      // 2. Check if a run for this occurrence already exists (idempotency guard)
      const existing = await env.DB.prepare(`
        SELECT id FROM routine_runs
         WHERE routine_id = ?1 AND occurrence_key = ?2
         LIMIT 1
      `)
        .bind(routine.id, occurrenceKey)
        .first<{ id: string }>()

      if (existing) {
        summary.skipped++
        continue
      }

      // 3. Build the atomic task/run/advance write set.
      const taskId = crypto.randomUUID()
      const taskTitle = `[Routine] ${routine.name}`
      const taskBody = `Autonomous routine execution:\nObjective: ${routine.objective}\nMode: ${routine.execution_mode}`
      const nextDate = nextRoutineOccurrence(scheduleObj, scheduledDate)
      const newNextRunAt = nextDate ? nextDate.toISOString() : null
      const newStatus = newNextRunAt ? 'enabled' : 'paused'
      const policyJson = JSON.stringify({
        execution_mode: routine.execution_mode,
        overlap_policy: routine.overlap_policy,
        responsible_squad_id: routine.responsible_squad_id,
        preferred_agent_id: routine.preferred_agent_id,
        budget_micro_usd: routine.budget_micro_usd,
        max_attempts: routine.max_attempts,
        retry_backoff_seconds: routine.retry_backoff_seconds,
      })

      const writes = await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO tasks (
            id, squad_id, project_id, title, body, done_when, status,
            assignee_agent_id, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?8)
        `).bind(
          taskId,
          routine.responsible_squad_id,
          routine.project_id,
          taskTitle,
          taskBody,
          routine.objective,
          routine.preferred_agent_id || null,
          nowIso,
        ),
        env.DB.prepare(`
          INSERT INTO routine_runs (
            id, tenant, project_id, routine_id, routine_revision, policy_json,
            occurrence_key, trigger_kind, scheduled_for, status,
            assigned_agent_id, task_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, 'queued', ?10, ?11, ?12, ?12
          )
        `).bind(
          runId,
          env.TENANT_SLUG,
          routine.project_id,
          routine.id,
          routine.revision,
          policyJson,
          occurrenceKey,
          routine.trigger_kind,
          routine.next_run_at,
          routine.preferred_agent_id || null,
          taskId,
          nowIso,
        ),
        env.DB.prepare(`
          UPDATE routines
             SET next_run_at = ?1,
                 status = ?2,
                 updated_at = ?3
           WHERE id = ?4 AND tenant = ?5
        `).bind(
          newNextRunAt,
          newStatus,
          nowIso,
          routine.id,
          env.TENANT_SLUG,
        ),
      ])
      assertBatchWritten(writes, 'routine.schedule.dispatch')

      // 4. Emit the observation only after the durable batch lands.
      await bus.emit({
        type: 'routine.run.started',
        actor: { kind: 'routine', id: routine.id },
        tenant: env.TENANT_SLUG,
        agent_id: routine.preferred_agent_id || undefined,
        ts: new Date().toISOString(),
        payload: {
          routine_id: routine.id,
          run_id: runId,
          task_id: taskId,
          project_id: routine.project_id,
          name: routine.name,
          objective: routine.objective,
          preferred_agent_id: routine.preferred_agent_id,
        },
      })

      summary.dispatched++
    } catch (error) {
      summary.errors.push(`Error executing routine ${routine.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return summary
}
