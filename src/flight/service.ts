// flight/service — the flight record lifecycle (the dispatch spine, Flight #61/#62).
//
// A flight = one bounded run of an agent toward a goal. Lifecycle:
//   preflight → held (NO-GO) | running → waiting (human gate) | sleeping → landed | failed
// All tenant-scoped. Transition guards live in each UPDATE's WHERE (a terminal flight
// cannot be revived; a held/landed flight cannot be re-landed) — same discipline as loops.

import type { Env } from '../types'
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

export async function listFlightsForSquad(env: Env, squadId: string, limit = 100): Promise<FlightRow[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 500)
  const res = await env.DB.prepare(
    `SELECT f.* FROM flights f
      WHERE f.tenant = ?1
        AND EXISTS (
          SELECT 1
            FROM json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.squad_ids') AS squad_ref
           WHERE squad_ref.value = ?2
        )
      ORDER BY f.created_at DESC
      LIMIT ?3`,
  )
    .bind(env.TENANT_SLUG, squadId, boundedLimit)
    .all<FlightRow>()
  return res.results ?? []
}
