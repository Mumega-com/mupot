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
  const id = await createFlight(env, flight)
  const r = preflightCheck(signals, opts)
  const status = await applyPreflight(env, id, r)
  return { id, go: r.go, status: status as 'running' | 'held', reasons: r.reasons, score: r.score }
}
