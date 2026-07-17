// flight/service — the flight record lifecycle (the dispatch spine, Flight #61/#62).
//
// A flight = one bounded run of an agent toward a goal. Lifecycle:
//   preflight → held (NO-GO) | running → waiting (human gate) | sleeping → landed | failed
// All tenant-scoped. Transition guards live in each UPDATE's WHERE (a terminal flight
// cannot be revived; a held/landed flight cannot be re-landed) — same discipline as loops.

import type { Env } from '../types'
import { createBus } from '../bus'
import type { PreflightResult } from './preflight'
import type { FlightMetaV1 } from './meta'

export type FlightStatus =
  | 'preflight'
  | 'held'
  | 'running'
  | 'waiting'
  | 'sleeping'
  | 'landed'
  | 'failed'

export type TriggerSource = 'manual' | 'schedule' | 'api' | 'event' | 'cron'

export interface FlightRow {
  id: string
  tenant: string
  project_id: string | null
  agent: string
  goal: string
  status: FlightStatus
  trigger_source: TriggerSource
  gate_verdict: string | null
  gate_reason: string
  score: number | null
  budget_micro_usd: number | null
  cost_micro_usd: number
  next_run_at: number | null
  created_at: number
  started_at: number | null
  ended_at: number | null
  meta: string
}

export interface NewFlight {
  agent: string
  goal: string
  project_id?: string | null
  trigger_source?: TriggerSource
  budget_micro_usd?: number
  meta?: FlightMetaV1
}

export type FlightProjectErrorCode =
  | 'invalid_project_id'
  | 'project_not_found'
  | 'archived_project'
  | 'project_access_forbidden'
  | 'flight_task_project_mismatch'

export class FlightProjectError extends Error {
  constructor(readonly code: FlightProjectErrorCode) {
    super(code)
    this.name = 'FlightProjectError'
  }
}

export async function validateFlightProjectTarget(
  env: Env,
  projectId: NewFlight['project_id'],
): Promise<void> {
  projectId = projectId ?? null
  if (projectId === null) return
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new FlightProjectError('invalid_project_id')
  }
  const project = await env.DB.prepare('SELECT status FROM projects WHERE id = ?1')
    .bind(projectId)
    .first<{ status: string }>()
  if (!project) throw new FlightProjectError('project_not_found')
  if (project.status === 'archived') throw new FlightProjectError('archived_project')
}

export async function validateFlightTaskProjectConsistency(
  env: Env,
  projectId: NewFlight['project_id'],
  meta: NewFlight['meta'],
): Promise<void> {
  projectId = projectId ?? null
  if (projectId !== null && meta) {
    const placeholders = meta.task_ids.map((_, index) => `?${index + 1}`).join(',')
    const rows = await env.DB.prepare(
      `SELECT id, project_id FROM tasks WHERE id IN (${placeholders})`,
    ).bind(...meta.task_ids).all<{ id: string; project_id: string | null }>()
    const tasks = new Map((rows.results ?? []).map((task) => [task.id, task]))
    if (meta.task_ids.some((taskId) => tasks.get(taskId)?.project_id !== projectId)) {
      throw new FlightProjectError('flight_task_project_mismatch')
    }
  }
}

export async function validateFlightProjectAttribution(env: Env, flight: NewFlight): Promise<void> {
  await validateFlightProjectTarget(env, flight.project_id)
  await validateFlightTaskProjectConsistency(env, flight.project_id, flight.meta)
}

function mapFlightProjectInsertError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('flight project not found')) throw new FlightProjectError('project_not_found')
  if (message.includes('flight project archived')) throw new FlightProjectError('archived_project')
  if (message.includes('flight project access denied')) {
    throw new FlightProjectError('project_access_forbidden')
  }
  if (message.includes('flight task project mismatch')) {
    throw new FlightProjectError('flight_task_project_mismatch')
  }
  throw error
}

// Create a flight in `preflight` — it has not launched; the gate decides next.
export async function createFlight(env: Env, f: NewFlight): Promise<string> {
  await validateFlightProjectAttribution(env, f)
  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO flights (id, tenant, project_id, agent, goal, status, trigger_source, budget_micro_usd, meta)
       VALUES (?1, ?2, ?3, ?4, ?5, 'preflight', ?6, ?7, ?8)`,
    )
      .bind(
        id,
        env.TENANT_SLUG,
        f.project_id ?? null,
        f.agent,
        f.goal,
        f.trigger_source ?? 'manual',
        f.budget_micro_usd ?? null,
        JSON.stringify(f.meta ?? {}),
      )
      .run()
  } catch (error) {
    mapFlightProjectInsertError(error)
  }
  return id
}

// Record the preflight gate (#60) outcome. GO → running (caller does the work then
// lands/fails). NO-GO → held (cheap; zero expensive spend). Only from `preflight`.
export async function applyPreflight(env: Env, id: string, r: PreflightResult): Promise<FlightStatus> {
  const now = Date.now()
  if (r.go) {
    await env.DB.prepare(
      `UPDATE flights SET status='running', gate_verdict='go', gate_reason='', score=?3, started_at=?4
       WHERE id=?1 AND tenant=?2 AND status='preflight'`,
    )
      .bind(id, env.TENANT_SLUG, r.score, now)
      .run()
    return 'running'
  }
  await env.DB.prepare(
    `UPDATE flights SET status='held', gate_verdict='no_go', gate_reason=?3, score=?4, ended_at=?5
     WHERE id=?1 AND tenant=?2 AND status='preflight'`,
  )
    .bind(id, env.TENANT_SLUG, r.reasons.join(','), r.score, now)
    .run()
  return 'held'
}

// Land a flight (completed OK). Only from an in-air state.
export async function landFlight(
  env: Env,
  id: string,
  opts: { cost_micro_usd?: number; score?: number } = {},
): Promise<void> {
  await env.DB.prepare(
    `UPDATE flights SET status='landed', cost_micro_usd=?3, score=COALESCE(?4, score), ended_at=?5
     WHERE id=?1 AND tenant=?2 AND status IN ('running','waiting','sleeping')`,
  )
    .bind(id, env.TENANT_SLUG, opts.cost_micro_usd ?? 0, opts.score ?? null, Date.now())
    .run()
}

export async function landGovernedFlight(
  env: Env,
  id: string,
  opts: {
    cost_micro_usd: number
    score?: number
    expected_agent?: string
    agent_id: string
    meta: FlightMetaV1
    actor: { kind: 'member' | 'agent'; id: string }
  },
): Promise<boolean> {
  const endedAt = Date.now()
  const createdAt = new Date(endedAt).toISOString()
  const eventId = crypto.randomUUID()
  const payload = JSON.stringify({
    outbox_id: eventId,
    flight_id: id,
    agent_id: opts.agent_id,
    squad_ids: opts.meta.squad_ids,
    task_ids: opts.meta.task_ids,
    cost_micro_usd: opts.cost_micro_usd,
    score: opts.score ?? null,
  })
  const transition = env.DB.prepare(
    `UPDATE flights SET status='landed', cost_micro_usd=?4, score=COALESCE(?5, score), ended_at=?6
     WHERE id=?1 AND tenant=?2
       AND (?3 IS NULL OR agent=?3)
       AND status IN ('running','waiting','sleeping')
       AND budget_micro_usd IS NOT NULL AND ?4 <= budget_micro_usd
       AND json_valid(meta)
       AND json_extract(meta, '$.schema') = 'mupot.flight.meta/v1'
       AND NOT EXISTS (
         SELECT 1
           FROM json_each(flights.meta, '$.task_ids') AS task_ref
           LEFT JOIN tasks AS task ON task.id = task_ref.value
          WHERE task.id IS NULL
             OR (flights.project_id IS NOT NULL AND task.project_id IS NOT flights.project_id)
             OR task.status <> 'done'
             OR (
               task.gate_owner IS NOT NULL
               AND COALESCE((
                 SELECT verdict
                   FROM task_verdicts
                  WHERE task_id = task.id
                  ORDER BY decided_at DESC, id DESC
                  LIMIT 1
               ), '') <> 'approved'
             )
       )`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      opts.expected_agent ?? null,
      opts.cost_micro_usd,
      opts.score ?? null,
      endedAt,
    )
  const outbox = env.DB.prepare(
    `INSERT INTO flight_event_outbox
       (id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at)
     SELECT ?1, ?2, ?3, 'flight.landed', ?4, ?5,
            json_set(?6, '$.score', score, '$.cost_micro_usd', cost_micro_usd), ?7
       FROM flights
      WHERE id=?3 AND tenant=?2 AND status='landed' AND ended_at=?8
     ON CONFLICT (tenant, flight_id, event_type) DO NOTHING`,
  ).bind(eventId, env.TENANT_SLUG, id, opts.actor.kind, opts.actor.id, payload, createdAt, endedAt)
  const [transitionResult, outboxResult] = await env.DB.batch([transition, outbox])
  return transitionResult.meta?.changes === 1 && outboxResult.meta?.changes === 1
}

interface FlightTaskCompletionRow {
  id: string
  status: string
  gate_owner: string | null
  latest_verdict: string | null
}

export async function listIncompleteFlightTaskIds(env: Env, taskIds: string[]): Promise<string[]> {
  if (taskIds.length === 0) return []
  const placeholders = taskIds.map(() => '?').join(',')
  const rows = await env.DB.prepare(
    `SELECT id, status, gate_owner,
            (SELECT verdict
               FROM task_verdicts
              WHERE task_id = tasks.id
              ORDER BY decided_at DESC, id DESC
              LIMIT 1) AS latest_verdict
       FROM tasks WHERE id IN (${placeholders})`,
  ).bind(...taskIds).all<FlightTaskCompletionRow>()
  const byId = new Map((rows.results ?? []).map((task) => [task.id, task]))
  return taskIds.filter((taskId) => {
    const task = byId.get(taskId)
    return !task || task.status !== 'done' || (task.gate_owner !== null && task.latest_verdict !== 'approved')
  })
}

export async function listFlightProjectMismatchTaskIds(
  env: Env,
  projectId: string | null,
  taskIds: string[],
): Promise<string[]> {
  if (projectId === null || taskIds.length === 0) return []
  const placeholders = taskIds.map(() => '?').join(',')
  const rows = await env.DB.prepare(
    `SELECT id, project_id FROM tasks WHERE id IN (${placeholders})`,
  ).bind(...taskIds).all<{ id: string; project_id: string | null }>()
  const byId = new Map((rows.results ?? []).map((task) => [task.id, task.project_id]))
  return taskIds.filter((taskId) => byId.has(taskId) && byId.get(taskId) !== projectId)
}

interface FlightEventOutboxRow {
  id: string
  tenant: string
  flight_id: string
  event_type: 'flight.landed'
  actor_kind: 'member' | 'agent'
  actor_id: string
  payload: string
  created_at: string
  delivered_at: string | null
  consumed_at: string | null
  attempts: number
  last_error: string | null
}

export async function deliverFlightLandedEvent(env: Env, flightId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT * FROM flight_event_outbox
      WHERE tenant=?1 AND flight_id=?2 AND delivered_at IS NULL
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, flightId).first<FlightEventOutboxRow>()
  if (!row) return true
  try {
    const payload = JSON.parse(row.payload) as { squad_ids?: unknown; [key: string]: unknown }
    const squadIds = Array.isArray(payload.squad_ids)
      ? payload.squad_ids.filter((value): value is string => typeof value === 'string')
      : []
    await createBus(env).emit({
      type: 'flight.landed',
      tenant: env.TENANT_SLUG,
      squad_id: squadIds[0],
      agent_id: typeof payload.agent_id === 'string' ? payload.agent_id : undefined,
      actor: { kind: row.actor_kind, id: row.actor_id },
      payload,
      ts: row.created_at,
    })
    await env.DB.prepare(
      `UPDATE flight_event_outbox
          SET delivered_at = ?3, attempts = attempts + 1, last_error = NULL
        WHERE tenant=?1 AND flight_id=?2 AND delivered_at IS NULL`,
    ).bind(env.TENANT_SLUG, flightId, new Date().toISOString()).run()
    return true
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'unknown_error').slice(0, 500)
    await env.DB.prepare(
      `UPDATE flight_event_outbox
          SET last_error = ?3, attempts = attempts + 1
        WHERE tenant=?1 AND flight_id=?2 AND delivered_at IS NULL`,
    ).bind(env.TENANT_SLUG, flightId, message).run()
    console.error('flight.landed event delivery failed', { flight_id: flightId, error: message })
    return false
  }
}

export async function flushFlightEventOutbox(env: Env, limit = 50): Promise<{ attempted: number; delivered: number }> {
  const boundedLimit = Math.min(Math.max(Math.floor(limit), 1), 100)
  const rows = await env.DB.prepare(
    `SELECT * FROM flight_event_outbox
      WHERE tenant=?1 AND delivered_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?2`,
  ).bind(env.TENANT_SLUG, boundedLimit).all<FlightEventOutboxRow>()
  let delivered = 0
  for (const row of rows.results ?? []) {
    if (await deliverFlightLandedEvent(env, row.flight_id)) delivered += 1
  }
  return { attempted: rows.results?.length ?? 0, delivered }
}

// Fail a flight (errored). From any non-terminal state.
export async function failFlight(env: Env, id: string, reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE flights SET status='failed', gate_reason=?3, ended_at=?4
     WHERE id=?1 AND tenant=?2 AND status IN ('preflight','running','waiting','sleeping')`,
  )
    .bind(id, env.TENANT_SLUG, reason.slice(0, 500), Date.now())
    .run()
}

// Put a flight to sleep until next_run_at (Unix ms). Only from an in-air state.
export async function sleepFlight(env: Env, id: string, nextRunAt: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE flights SET status='sleeping', next_run_at=?3
     WHERE id=?1 AND tenant=?2 AND status IN ('running','waiting')`,
  )
    .bind(id, env.TENANT_SLUG, nextRunAt)
    .run()
}

export async function getFlight(env: Env, id: string): Promise<FlightRow | null> {
  return (
    (await env.DB.prepare(`SELECT * FROM flights WHERE id=?1 AND tenant=?2`)
      .bind(id, env.TENANT_SLUG)
      .first<FlightRow>()) ?? null
  )
}

export async function listFlights(env: Env, limit = 100, projectId?: string): Promise<FlightRow[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  const statement = projectId === undefined
    ? env.DB.prepare(`SELECT * FROM flights WHERE tenant=?1 ORDER BY created_at DESC LIMIT ?2`)
      .bind(env.TENANT_SLUG, boundedLimit)
    : env.DB.prepare(`SELECT * FROM flights WHERE tenant=?1 AND project_id=?2 ORDER BY created_at DESC LIMIT ?3`)
      .bind(env.TENANT_SLUG, projectId, boundedLimit)
  const res = await statement
    .all<FlightRow>()
  return res.results ?? []
}

export async function listFlightsForSquad(
  env: Env,
  squadId: string,
  limit = 100,
  before?: { createdAt: number; id: string },
  projectId?: string,
): Promise<FlightRow[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  const beforeCreatedAt = before?.createdAt ?? Number.MAX_SAFE_INTEGER
  const beforeId = before?.id ?? '\uffff'
  const statement = projectId === undefined
    ? env.DB.prepare(
      `SELECT f.* FROM flights f
      WHERE f.tenant = ?1
        AND EXISTS (
          SELECT 1
            FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
           WHERE squad_ref.value = ?2
        )
        AND (f.created_at < ?3 OR (f.created_at = ?4 AND f.id < ?5))
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ?6`,
    ).bind(env.TENANT_SLUG, squadId, beforeCreatedAt, beforeCreatedAt, beforeId, boundedLimit)
    : env.DB.prepare(
      `SELECT f.* FROM flights f
      WHERE f.tenant = ?1
        AND f.project_id = ?2
        AND EXISTS (
          SELECT 1
            FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
           WHERE squad_ref.value = ?3
        )
        AND (f.created_at < ?4 OR (f.created_at = ?5 AND f.id < ?6))
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ?7`,
    ).bind(env.TENANT_SLUG, projectId, squadId, beforeCreatedAt, beforeCreatedAt, beforeId, boundedLimit)
  const res = await statement.all<FlightRow>()
  return res.results ?? []
}
