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
  trigger_source?: TriggerSource
  budget_micro_usd?: number
  meta?: FlightMetaV1
}

// Create a flight in `preflight` — it has not launched; the gate decides next.
export async function createFlight(env: Env, f: NewFlight): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO flights (id, tenant, agent, goal, status, trigger_source, budget_micro_usd, meta)
     VALUES (?1, ?2, ?3, ?4, 'preflight', ?5, ?6, ?7)`,
  )
    .bind(
      id,
      env.TENANT_SLUG,
      f.agent,
      f.goal,
      f.trigger_source ?? 'manual',
      f.budget_micro_usd ?? null,
      JSON.stringify(f.meta ?? {}),
    )
    .run()
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
  opts: { cost_micro_usd: number; score?: number; expected_agent?: string },
): Promise<boolean> {
  const result = await env.DB.prepare(
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
      Date.now(),
    )
    .run()
  return result.meta?.changes === 1
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

export async function emitFlightLanded(
  env: Env,
  flight: FlightRow,
  meta: FlightMetaV1,
  actor: { kind: 'member' | 'agent'; id: string },
): Promise<void> {
  try {
    await createBus(env).emit({
      type: 'flight.landed',
      tenant: env.TENANT_SLUG,
      squad_id: meta.squad_ids[0],
      agent_id: flight.agent,
      actor,
      payload: {
        flight_id: flight.id,
        squad_ids: meta.squad_ids,
        task_ids: meta.task_ids,
        cost_micro_usd: flight.cost_micro_usd,
        score: flight.score,
      },
      ts: new Date().toISOString(),
    })
  } catch (error) {
    console.error('flight.landed event emit failed', { flight_id: flight.id, error })
  }
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

export async function listFlights(env: Env, limit = 100): Promise<FlightRow[]> {
  const res = await env.DB.prepare(`SELECT * FROM flights WHERE tenant=?1 ORDER BY created_at DESC LIMIT ?2`)
    .bind(env.TENANT_SLUG, Math.min(Math.max(limit, 1), 500))
    .all<FlightRow>()
  return res.results ?? []
}

export async function listFlightsForSquad(
  env: Env,
  squadId: string,
  limit = 100,
  before?: { createdAt: number; id: string },
): Promise<FlightRow[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  const beforeCreatedAt = before?.createdAt ?? Number.MAX_SAFE_INTEGER
  const beforeId = before?.id ?? '\uffff'
  const res = await env.DB.prepare(
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
  )
    .bind(env.TENANT_SLUG, squadId, beforeCreatedAt, beforeCreatedAt, beforeId, boundedLimit)
    .all<FlightRow>()
  return res.results ?? []
}
