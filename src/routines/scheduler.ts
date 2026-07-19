import type { D1Result } from '@cloudflare/workers-types'
import type { Env } from '../types'
import { nextRoutineOccurrence, routineOccurrenceKey } from './schedule'
import type { Routine, RoutinePolicySnapshot, RoutineSchedule } from './types'
import { sqlNotCancellationPending } from './cancellation-fence'

// D1 free-tier invocations allow 50 SQL statements. Worst-case scheduler work is
// bounded below that ceiling before an external dispatch processor does any work.
export const MAX_DUE_ROUTINES_PER_TICK = 2
export const MAX_RECOVERIES_PER_TICK = 2
export const MAX_CLAIMS_PER_TICK = 1
export const MAX_SCHEDULER_DB_STATEMENTS = 3
  + MAX_RECOVERIES_PER_TICK * 2
  + MAX_DUE_ROUTINES_PER_TICK * 3
  + MAX_CLAIMS_PER_TICK * 6
const LEASE_SECONDS = 300
const ACTIVE_RUN_STATUSES = "'leased','observing','waiting','running'"
const NON_TERMINAL_RUN_STATUSES = "'queued','leased','observing','waiting','running'"

interface DueRoutine extends Routine {
  occurrence_count: number
}

interface RecoverableRun {
  id: string
  tenant: string
  project_id: string
  attempt: number
  policy_json: string
}

export interface RoutineSchedulerSummary {
  scanned: number
  occurrences_created: number
  occurrences_skipped: number
  recovered: number
  queued_scanned: number
  claimed: number
  dispatch_errors: number
}

export type RoutineRunProcessor = (runId: string) => Promise<void>

export function shouldRunMaintenanceHeartbeat(now: Date): boolean {
  return Number.isFinite(now.getTime()) && now.getUTCMinutes() % 15 === 0
}

function wrote(result: D1Result<unknown>): boolean {
  return Number(result.meta?.changes ?? 0) > 0
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0)
}

function scheduleFrom(routine: Routine): RoutineSchedule {
  if (routine.trigger_kind === 'once') {
    return { kind: 'once', timezone: routine.timezone, runOnceAt: routine.run_once_at as string }
  }
  if (routine.trigger_kind === 'cron') {
    return { kind: 'cron', timezone: routine.timezone, cronExpression: routine.cron_expression as string }
  }
  return { kind: 'manual', timezone: routine.timezone }
}

function policySnapshot(routine: Routine): RoutinePolicySnapshot {
  return {
    execution_mode: routine.execution_mode,
    overlap_policy: routine.overlap_policy,
    responsible_squad_id: routine.responsible_squad_id,
    preferred_agent_id: routine.preferred_agent_id,
    budget_micro_usd: routine.budget_micro_usd,
    max_attempts: routine.max_attempts,
    retry_backoff_seconds: routine.retry_backoff_seconds,
  }
}

function nextAfterOccurrence(routine: DueRoutine, scheduledFor: Date): string | null {
  if (routine.trigger_kind === 'once') return null
  if (routine.max_occurrences !== null && routine.occurrence_count + 1 >= routine.max_occurrences) {
    return null
  }
  const next = nextRoutineOccurrence(scheduleFrom(routine), scheduledFor)
  if (!next) return null
  if (routine.stop_at !== null && next.getTime() >= Date.parse(routine.stop_at)) return null
  return next.toISOString()
}

function occurrenceAlreadyExhausted(routine: DueRoutine, scheduledFor: Date): boolean {
  if (routine.max_occurrences !== null && routine.occurrence_count >= routine.max_occurrences) return true
  return routine.stop_at !== null && scheduledFor.getTime() >= Date.parse(routine.stop_at)
}

async function exhaustOccurrence(env: Env, routine: DueRoutine, now: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE routines SET next_run_at = NULL, updated_at = ?
      WHERE id = ? AND tenant = ? AND revision = ? AND status = 'enabled'
        AND next_run_at = ?`,
  ).bind(now, routine.id, routine.tenant, routine.revision, routine.next_run_at).run()
}

async function createDueOccurrence(
  env: Env,
  routine: DueRoutine,
  now: Date,
  owner: string,
): Promise<{ created: boolean; skipped: boolean }> {
  if (!routine.next_run_at) return { created: false, skipped: false }
  const scheduledFor = new Date(routine.next_run_at)
  const nowIso = now.toISOString()
  if (occurrenceAlreadyExhausted(routine, scheduledFor)) {
    await exhaustOccurrence(env, routine, nowIso)
    return { created: false, skipped: false }
  }

  const runId = crypto.randomUUID()
  const occurrenceKey = routineOccurrenceKey(scheduleFrom(routine), scheduledFor)
  const nextRunAt = nextAfterOccurrence(routine, scheduledFor)
  const policyJson = JSON.stringify(policySnapshot(routine))
  const createdEventId = crypto.randomUUID()
  const skippedEventId = crypto.randomUUID()

  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, result_summary, finished_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = ? AND status = 'active') THEN 'skipped'
          WHEN ? = 'skip' AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE tenant = ? AND routine_id = ? AND status IN (${NON_TERMINAL_RUN_STATUSES})
          ) THEN 'skipped'
          WHEN ? = 'queue' AND (
            SELECT COUNT(*) FROM routine_runs
             WHERE tenant = ? AND routine_id = ? AND status = 'queued'
          ) >= 10 THEN 'skipped'
          ELSE 'queued'
        END,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = ? AND status = 'active') THEN 'project_not_active'
          WHEN ? = 'skip' AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE tenant = ? AND routine_id = ? AND status IN (${NON_TERMINAL_RUN_STATUSES})
          ) THEN 'overlap'
          WHEN ? = 'queue' AND (
            SELECT COUNT(*) FROM routine_runs
             WHERE tenant = ? AND routine_id = ? AND status = 'queued'
          ) >= 10 THEN 'queue_cap'
          ELSE NULL
        END,
        CASE
          WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = ? AND status = 'active') THEN ?
          WHEN ? = 'skip' AND EXISTS (
            SELECT 1 FROM routine_runs
             WHERE tenant = ? AND routine_id = ? AND status IN (${NON_TERMINAL_RUN_STATUSES})
          ) THEN ?
          WHEN ? = 'queue' AND (
            SELECT COUNT(*) FROM routine_runs
             WHERE tenant = ? AND routine_id = ? AND status = 'queued'
          ) >= 10 THEN ?
          ELSE NULL
        END,
        ?, ?
      WHERE EXISTS (
        SELECT 1 FROM routines
         WHERE id = ? AND tenant = ? AND project_id = ? AND revision = ?
           AND status = 'enabled' AND next_run_at = ?
      ) AND NOT EXISTS (
        SELECT 1 FROM routine_runs
         WHERE tenant = ? AND routine_id = ? AND occurrence_key = ?
      )`,
    ).bind(
      runId, routine.tenant, routine.project_id, routine.id, routine.revision, policyJson,
      occurrenceKey, routine.trigger_kind, routine.next_run_at,
      routine.project_id, routine.overlap_policy, routine.tenant, routine.id,
      routine.overlap_policy, routine.tenant, routine.id,
      routine.project_id, routine.overlap_policy, routine.tenant, routine.id,
      routine.overlap_policy, routine.tenant, routine.id,
      routine.project_id, nowIso, routine.overlap_policy, routine.tenant, routine.id, nowIso,
      routine.overlap_policy, routine.tenant, routine.id, nowIso,
      nowIso, nowIso,
      routine.id, routine.tenant, routine.project_id, routine.revision, routine.next_run_at,
      routine.tenant, routine.id, occurrenceKey,
    ),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, ?, ?, ?, 'created', 'system', ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM routine_runs WHERE id = ?)
      UNION ALL
      SELECT ?, ?, ?, ?, 'skipped', 'system', ?, ?,
             json_object('reason', result_summary), ?
        FROM routine_runs WHERE id = ? AND status = 'skipped'`,
    ).bind(
      createdEventId, routine.tenant, routine.project_id, runId, owner, nowIso,
      JSON.stringify({ scheduled_for: routine.next_run_at, routine_revision: routine.revision }),
      runId, runId,
      skippedEventId, routine.tenant, routine.project_id, runId, owner, nowIso, runId, runId,
    ),
    env.DB.prepare(
      `UPDATE routines SET next_run_at = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND project_id = ? AND revision = ?
          AND status = 'enabled' AND next_run_at = ?`,
    ).bind(
      nextRunAt, nowIso, routine.id, routine.tenant, routine.project_id,
      routine.revision, routine.next_run_at,
    ),
  ])

  return {
    created: wrote(outcomes[0]),
    skipped: changes(outcomes[1]) === 2,
  }
}

async function skipStaleRun(env: Env, runId: string, owner: string, now: string): Promise<boolean> {
  const eventId = crypto.randomUUID()
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'skipped',
              result_summary = CASE
                WHEN NOT EXISTS (
                  SELECT 1 FROM projects p
                   WHERE p.id = routine_runs.project_id AND p.status = 'active'
                ) THEN 'project_not_active'
                ELSE 'routine_policy_changed'
              END,
              finished_at = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ? AND tenant = ? AND status = 'queued' AND (
          NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = routine_runs.project_id AND p.status = 'active')
          OR NOT EXISTS (
            SELECT 1 FROM routines r
             WHERE r.id = routine_runs.routine_id AND r.tenant = routine_runs.tenant
               AND r.project_id = routine_runs.project_id AND r.status = 'enabled'
               AND r.revision = routine_runs.routine_revision
          )
        )`,
    ).bind(now, now, runId, env.TENANT_SLUG),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, 'skipped', 'system', ?, ?,
             json_object('reason', result_summary), id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = 'skipped'
         AND result_summary IN ('project_not_active','routine_policy_changed')
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = 'skipped'
         )`,
    ).bind(eventId, owner, now, runId, env.TENANT_SLUG),
  ])
  return wrote(outcomes[0])
}

async function failExhaustedQueuedRun(
  env: Env,
  runId: string,
  owner: string,
  now: string,
): Promise<boolean> {
  const eventId = crypto.randomUUID()
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'failed', result_summary = 'retry_exhausted',
              finished_at = ?, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'queued'
          AND attempt >= CAST(json_extract(policy_json, '$.max_attempts') AS INTEGER)`,
    ).bind(now, now, runId, env.TENANT_SLUG),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, 'failed', 'system', ?, ?,
             json_object('reason', 'retry_exhausted', 'attempt', attempt), id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = 'failed'
         AND result_summary = 'retry_exhausted'
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = 'failed'
              AND json_extract(e.metadata_json, '$.reason') = 'retry_exhausted'
         )`,
    ).bind(eventId, owner, now, runId, env.TENANT_SLUG),
  ])
  return wrote(outcomes[0]) && wrote(outcomes[1])
}

export async function claimRoutineRun(
  env: Env,
  runId: string,
  owner: string,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString()
  if (await skipStaleRun(env, runId, owner, nowIso)) return false
  if (await failExhaustedQueuedRun(env, runId, owner, nowIso)) return false
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString()
  const eventId = crypto.randomUUID()
  const outcomes = await env.DB.batch([
    env.DB.prepare(
      `UPDATE routine_runs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
              attempt = attempt + 1, retry_at = NULL, updated_at = ?
        WHERE id = ? AND tenant = ? AND status = 'queued'
          AND (retry_at IS NULL OR retry_at <= ?)
          AND attempt < CAST(json_extract(policy_json, '$.max_attempts') AS INTEGER)
          AND EXISTS (
            SELECT 1 FROM projects p
             WHERE p.id = routine_runs.project_id AND p.status = 'active'
          )
          AND EXISTS (
            SELECT 1 FROM routines r
             WHERE r.id = routine_runs.routine_id AND r.tenant = routine_runs.tenant
               AND r.project_id = routine_runs.project_id AND r.status = 'enabled'
               AND r.revision = routine_runs.routine_revision
          )
          AND NOT EXISTS (
            SELECT 1 FROM routine_runs active
             WHERE active.tenant = routine_runs.tenant
               AND active.routine_id = routine_runs.routine_id
               AND active.id <> routine_runs.id
               AND active.status IN (${ACTIVE_RUN_STATUSES})
          )
          AND NOT EXISTS (
            SELECT 1 FROM routine_runs earlier
             WHERE earlier.tenant = routine_runs.tenant
               AND earlier.routine_id = routine_runs.routine_id
               AND earlier.status = 'queued'
               AND (earlier.created_at < routine_runs.created_at
                 OR (earlier.created_at = routine_runs.created_at AND earlier.id < routine_runs.id))
          )
          AND ${sqlNotCancellationPending('id', 'tenant')}`,
    ).bind(owner, leaseExpiresAt, nowIso, runId, env.TENANT_SLUG, nowIso),
    env.DB.prepare(
      `INSERT INTO routine_run_events (
        id, tenant, project_id, run_id, kind, actor_type, actor_id,
        occurred_at, metadata_json, correlation_id
      )
      SELECT ?, tenant, project_id, id, 'leased', 'system', ?, ?,
             json_object('lease_expires_at', lease_expires_at, 'attempt', attempt), id
        FROM routine_runs
       WHERE id = ? AND tenant = ? AND status = 'leased'
         AND lease_owner = ? AND lease_expires_at = ?
         AND NOT EXISTS (
           SELECT 1 FROM routine_run_events e
            WHERE e.run_id = routine_runs.id AND e.kind = 'leased'
              AND CAST(json_extract(e.metadata_json, '$.attempt') AS INTEGER) = routine_runs.attempt
         )`,
    ).bind(eventId, owner, nowIso, runId, env.TENANT_SLUG, owner, leaseExpiresAt),
  ])
  return wrote(outcomes[0]) && wrote(outcomes[1])
}

function retryPolicy(value: string): { maxAttempts: number; backoffSeconds: number } {
  try {
    const parsed = JSON.parse(value) as Partial<RoutinePolicySnapshot>
    const maxAttempts = Number.isInteger(parsed.max_attempts) ? Number(parsed.max_attempts) : 1
    const backoffSeconds = Number.isInteger(parsed.retry_backoff_seconds)
      ? Number(parsed.retry_backoff_seconds)
      : 300
    return { maxAttempts, backoffSeconds }
  } catch {
    return { maxAttempts: 1, backoffSeconds: 300 }
  }
}

export async function recoverExpiredRoutineLeases(
  env: Env,
  now: Date,
): Promise<number> {
  const nowIso = now.toISOString()
  const result = await env.DB.prepare(
    `SELECT id, tenant, project_id, attempt, policy_json FROM routine_runs
      WHERE tenant = ? AND status IN ('leased','observing') AND lease_expires_at <= ?
      ORDER BY lease_expires_at ASC, id ASC LIMIT ?`,
  ).bind(env.TENANT_SLUG, nowIso, MAX_RECOVERIES_PER_TICK).all<RecoverableRun>()
  let recovered = 0
  for (const run of result.results ?? []) {
    const policy = retryPolicy(run.policy_json)
    const exhausted = run.attempt >= policy.maxAttempts
    const retryAt = exhausted
      ? null
      : new Date(now.getTime() + policy.backoffSeconds * 1000).toISOString()
    const eventKind = exhausted ? 'failed' : 'retry_scheduled'
    const eventId = crypto.randomUUID()
    const outcomes = await env.DB.batch([
      env.DB.prepare(
        `UPDATE routine_runs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
                retry_at = ?, result_summary = ?, finished_at = ?, updated_at = ?
          WHERE id = ? AND tenant = ? AND status IN ('leased','observing')
            AND lease_expires_at <= ?`,
      ).bind(
        exhausted ? 'failed' : 'queued', retryAt, exhausted ? 'retry_exhausted' : null,
        exhausted ? nowIso : null, nowIso, run.id, env.TENANT_SLUG, nowIso,
      ),
      env.DB.prepare(
        `INSERT INTO routine_run_events (
          id, tenant, project_id, run_id, kind, actor_type, actor_id,
          occurred_at, metadata_json, correlation_id
        )
        SELECT ?, tenant, project_id, id, ?, 'system', 'routine-scheduler', ?, ?, id
          FROM routine_runs WHERE id = ? AND tenant = ? AND status = ?
           AND NOT EXISTS (
             SELECT 1 FROM routine_run_events e
              WHERE e.run_id = routine_runs.id AND e.kind = ?
                AND CAST(json_extract(e.metadata_json, '$.attempt') AS INTEGER) = ?
           )`,
      ).bind(
        eventId, eventKind, nowIso,
        JSON.stringify({ reason: 'lease_expired', retry_at: retryAt, attempt: run.attempt }),
        run.id, env.TENANT_SLUG, exhausted ? 'failed' : 'queued', eventKind, run.attempt,
      ),
    ])
    if (wrote(outcomes[0]) && wrote(outcomes[1])) recovered++
  }
  return recovered
}

export async function runRoutineScheduler(
  env: Env,
  now: Date,
  owner: string,
  processClaimed?: RoutineRunProcessor,
): Promise<RoutineSchedulerSummary> {
  const recovered = await recoverExpiredRoutineLeases(env, now)
  const nowIso = now.toISOString()
  const due = await env.DB.prepare(
    `SELECT r.*,
            (SELECT COUNT(*) FROM routine_runs rr
              WHERE rr.tenant = r.tenant AND rr.routine_id = r.id) AS occurrence_count
       FROM routines r JOIN projects p ON p.id = r.project_id
      WHERE r.tenant = ? AND r.status = 'enabled' AND r.next_run_at IS NOT NULL
        AND r.next_run_at <= ?
      ORDER BY r.next_run_at ASC, r.id ASC LIMIT ?`,
  ).bind(env.TENANT_SLUG, nowIso, MAX_DUE_ROUTINES_PER_TICK).all<DueRoutine>()

  let occurrencesCreated = 0
  let occurrencesSkipped = 0
  for (const routine of due.results ?? []) {
    const occurrence = await createDueOccurrence(env, routine, now, owner)
    if (occurrence.created) occurrencesCreated++
    if (occurrence.skipped) occurrencesSkipped++
  }

  const queued = processClaimed && !shouldRunMaintenanceHeartbeat(now)
    ? await env.DB.prepare(
      `SELECT rr.id FROM routine_runs rr
        WHERE rr.tenant = ? AND rr.status = 'queued'
          AND (rr.retry_at IS NULL OR rr.retry_at <= ?)
          AND NOT EXISTS (
            SELECT 1 FROM routine_runs earlier
             WHERE earlier.tenant = rr.tenant AND earlier.routine_id = rr.routine_id
               AND earlier.status = 'queued'
               AND (earlier.created_at < rr.created_at
                 OR (earlier.created_at = rr.created_at AND earlier.id < rr.id))
          )
          AND (
            NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = rr.project_id AND p.status = 'active')
            OR NOT EXISTS (
              SELECT 1 FROM routines r
               WHERE r.id = rr.routine_id AND r.tenant = rr.tenant
                 AND r.project_id = rr.project_id AND r.status = 'enabled'
                 AND r.revision = rr.routine_revision
            )
            OR rr.attempt >= CAST(json_extract(rr.policy_json, '$.max_attempts') AS INTEGER)
            OR NOT EXISTS (
              SELECT 1 FROM routine_runs active
               WHERE active.tenant = rr.tenant AND active.routine_id = rr.routine_id
                 AND active.id <> rr.id AND active.status IN (${ACTIVE_RUN_STATUSES})
            )
          )
        ORDER BY rr.created_at ASC, rr.id ASC LIMIT ?`,
    ).bind(env.TENANT_SLUG, nowIso, MAX_CLAIMS_PER_TICK).all<{ id: string }>()
    : { results: [] as { id: string }[] }
  let claimed = 0
  let dispatchErrors = 0
  for (const run of queued.results ?? []) {
    if (!await claimRoutineRun(env, run.id, owner, now)) continue
    claimed++
    try {
      await processClaimed?.(run.id)
    } catch (error) {
      dispatchErrors++
      console.error(`[routine-dispatch:${run.id}]`, error)
    }
  }

  return {
    scanned: due.results?.length ?? 0,
    occurrences_created: occurrencesCreated,
    occurrences_skipped: occurrencesSkipped,
    recovered,
    queued_scanned: queued.results?.length ?? 0,
    claimed,
    dispatch_errors: dispatchErrors,
  }
}
