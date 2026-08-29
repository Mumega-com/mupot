// src/routines/cron-scheduler.ts — Autonomous Agent Cron Routine Scheduler & Workforce Dispatcher.

import type { Env } from '../types'
import { nextRoutineOccurrence, routineOccurrenceKey } from './schedule'
import type { Routine, RoutineSchedule } from './types'
import { createBus } from '../bus'

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
      if (routine.trigger_kind === 'once') {
        scheduleObj = {
          kind: 'once',
          timezone: routine.timezone || 'UTC',
          runOnceAt: routine.run_once_at || nowIso,
        }
      } else if (routine.trigger_kind === 'manual') {
        scheduleObj = {
          kind: 'manual',
          timezone: routine.timezone || 'UTC',
        }
      } else {
        scheduleObj = {
          kind: 'cron',
          timezone: routine.timezone || 'UTC',
          cronExpression: routine.cron_expression || '0 * * * *',
        }
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

      // 3. Create corresponding autonomous task
      const taskId = crypto.randomUUID()
      const taskTitle = `[Routine] ${routine.name}`
      const taskBody = `Autonomous routine execution:\nObjective: ${routine.objective}\nMode: ${routine.execution_mode}`

      await env.DB.prepare(`
        INSERT INTO tasks (
          id, squad_id, project_id, title, body, done_when, status,
          assignee_agent_id, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?8)
      `)
        .bind(
          taskId,
          routine.responsible_squad_id,
          routine.project_id,
          taskTitle,
          taskBody,
          routine.objective,
          routine.preferred_agent_id || null,
          nowIso,
        )
        .run()

      // 4. Record routine run
      const policyJson = JSON.stringify({
        objective: routine.objective,
        execution_mode: routine.execution_mode,
        budget_micro_usd: routine.budget_micro_usd || 0,
      })

      await env.DB.prepare(`
        INSERT INTO routine_runs (
          id, tenant, project_id, routine_id, routine_revision, policy_json,
          status, trigger_kind, occurrence_key, scheduled_for, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 1, ?5,
          'queued', ?6, ?7, ?8, ?9
        )
      `)
        .bind(
          runId,
          env.TENANT_SLUG,
          routine.project_id,
          routine.id,
          policyJson,
          routine.trigger_kind,
          occurrenceKey,
          routine.next_run_at,
          nowIso,
        )
        .run()

      // 5. Calculate and advance next occurrence
      const nextDate = nextRoutineOccurrence(scheduleObj, scheduledDate)
      const newNextRunAt = nextDate ? nextDate.toISOString() : null
      const newStatus = newNextRunAt ? 'enabled' : 'completed'

      await env.DB.prepare(`
        UPDATE routines
           SET next_run_at = ?1,
               status = ?2,
               updated_at = ?3
         WHERE id = ?4 AND tenant = ?5
      `)
        .bind(
          newNextRunAt,
          newStatus,
          nowIso,
          routine.id,
          env.TENANT_SLUG,
        )
        .run()

      // 6. Emit event to Bus
      await bus.emit({
        type: 'routine.run.started',
        actor: { kind: 'routine', id: routine.id },
        tenant: env.TENANT_SLUG,
        ts: nowIso,
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
