// flight/board — the flight board view model (Flight #61).
//
// Pure derivation from FlightRow[] (listFlights, DESC by created_at) into display
// cards: phase metaphor, accounted cost, readiness/coherence score + per-agent
// trend, and the next departure for sleeping flights. No I/O, no Hono — so the
// dashboard renders it and tests cover it without a Worker. See docs/flight-operations.md.

import type { FlightRow, FlightStatus } from './service'
import { detectFlightCollisions } from './clearance'
import type { FlightCollision } from './clearance'

// The board metaphor (plain mupot language): running=flying, waiting=holding (at a
// human gate), sleeping=between flights. preflight/held/landed/failed keep their names.
export type FlightPhase = 'preflight' | 'flying' | 'holding' | 'sleeping' | 'held' | 'landed' | 'failed'

const PHASE: Record<FlightStatus, FlightPhase> = {
  preflight: 'preflight',
  running: 'flying',
  waiting: 'holding',
  sleeping: 'sleeping',
  held: 'held',
  landed: 'landed',
  failed: 'failed',
}

// A flight is "live" (on the board now) while it is pre-launch, in the air, or sleeping
// between legs. Terminal flights (landed/failed/held) are history.
const LIVE_PHASES: ReadonlySet<FlightPhase> = new Set<FlightPhase>(['preflight', 'flying', 'holding', 'sleeping'])

export type Trend = 'up' | 'down' | 'flat'

export interface FlightCard {
  id: string
  agent: string
  goal: string
  status: FlightStatus
  phase: FlightPhase
  live: boolean
  cost_usd: string
  budget_usd: string | null
  over_budget: boolean
  score: number | null
  score_pct: string | null
  trend: Trend | null
  next_departure: string | null
  age: string
}

// micro-USD (the meter's unit) → a "$0.0000" string. 4 dp keeps sub-cent flights legible.
export function formatUsd(micro: number | null | undefined): string | null {
  if (micro == null || !Number.isFinite(micro)) return null
  return `$${(micro / 1_000_000).toFixed(4)}`
}

export function formatPct(score: number | null | undefined): string | null {
  if (score == null || !Number.isFinite(score)) return null
  return `${Math.round(score * 100)}%`
}

// Compact, sign-free duration ("45s", "12m", "3h", "2d"). Caller frames as in/ago.
export function humanDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

function nextDeparture(row: FlightRow, nowMs: number): string | null {
  if (row.status !== 'sleeping' || row.next_run_at == null) return null
  const delta = row.next_run_at - nowMs
  return delta <= 0 ? 'due' : `in ${humanDur(delta)}`
}

/**
 * Build the board. `rows` is listFlights order (newest first). Trend for each scored
 * flight = its score vs the next-older flight of the SAME agent that also has a score:
 * up if higher, down if lower, flat if equal, null if there is no prior scored flight.
 */
export function buildBoard(rows: FlightRow[], nowMs: number): FlightCard[] {
  return rows.map((row, i) => {
    const phase = PHASE[row.status]
    const over =
      row.budget_micro_usd != null && Number.isFinite(row.budget_micro_usd) && row.cost_micro_usd > row.budget_micro_usd

    let trend: Trend | null = null
    if (row.score != null && Number.isFinite(row.score)) {
      for (let j = i + 1; j < rows.length; j++) {
        const prior = rows[j]
        if (prior && prior.agent === row.agent && prior.score != null && Number.isFinite(prior.score)) {
          trend = row.score > prior.score ? 'up' : row.score < prior.score ? 'down' : 'flat'
          break
        }
      }
    }

    return {
      id: row.id,
      agent: row.agent,
      goal: row.goal,
      status: row.status,
      phase,
      live: LIVE_PHASES.has(phase),
      cost_usd: formatUsd(row.cost_micro_usd) ?? '$0.0000',
      budget_usd: formatUsd(row.budget_micro_usd),
      over_budget: over,
      score: row.score,
      score_pct: formatPct(row.score),
      trend,
      next_departure: nextDeparture(row, nowMs),
      age: `${humanDur(nowMs - row.created_at)} ago`,
    }
  })
}

// The tower's current cross-flight view (flight/clearance.ts): HOLD-level (hard
// conflict — shared task_ids/artifact_refs) and WARN-level (soft — shared
// objective/goal/squad only) collisions among the currently active flights.
// detectFlightCollisions already filters to live statuses + same-tenant pairs — this
// is a thin split-by-severity presentation wrapper, same "pure derivation" discipline
// as buildBoard above.
export interface ActiveCollisions {
  holds: FlightCollision[]
  warns: FlightCollision[]
}

export function deriveActiveCollisions(flights: FlightRow[]): ActiveCollisions {
  const collisions = detectFlightCollisions(flights)
  return {
    holds: collisions.filter((c) => c.severity === 'hold'),
    warns: collisions.filter((c) => c.severity === 'warn'),
  }
}
