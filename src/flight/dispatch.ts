// flight/dispatch — create a flight + run the preflight gate + record the verdict.
//
// The single entry point that ties #60 (the gate) to the spine (#61/#62). The CALLER
// (a routine, the loop runtime, the MCPWP marketing loop, or a manual dispatch) invokes
// this BEFORE doing any expensive work; on GO it does the work then lands/fails the
// flight, on NO-GO it stops cheaply — zero expensive spend on a flight that would wander
// or run cold.

import type { Env } from '../types'
import { preflightCheck } from './preflight'
import type { FlightSignals, PreflightOptions } from './preflight'
import { createFlight, applyPreflight } from './service'
import type { NewFlight } from './service'
import { sumCostMicroUsdSince } from '../agents/meter'
import type { MeterTakeoff } from './reconcile'

export interface DispatchResult {
  id: string
  go: boolean
  status: 'running' | 'held'
  reasons: string[]
  score: number
}

export async function dispatchFlight(
  env: Env,
  flight: NewFlight,
  signals: FlightSignals,
  opts: PreflightOptions = {},
): Promise<DispatchResult> {
  // Snapshot the agent's pot-metered cost at takeoff so landing can compute the
  // metered delta and reconcile it against the caller-reported cost (reconcile.ts).
  const now = Date.now()
  const takeoff: MeterTakeoff = { at: now, cost_micro_usd: await sumCostMicroUsdSince(env, flight.agent, now) }
  const id = await createFlight(env, { ...flight, meta: { ...(flight.meta ?? {}), meter_takeoff: takeoff } })
  const r = preflightCheck(signals, opts)
  const status = await applyPreflight(env, id, r)
  return { id, go: r.go, status: status as 'running' | 'held', reasons: r.reasons, score: r.score }
}
