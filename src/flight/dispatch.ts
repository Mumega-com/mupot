// flight/dispatch — create a flight + run the preflight gate + record the verdict.
//
// The single entry point that ties #60 (the gate) to the spine (#61/#62). The CALLER
// (a routine, the loop runtime, the MCPWP marketing loop, or a manual dispatch) invokes
// this BEFORE doing any expensive work; on GO it does the work then lands/fails the
// flight, on NO-GO it stops cheaply — zero expensive spend on a flight that would wander
// or run cold.
//
// CLEARANCE (the ATC tower, flight/clearance.ts) is a SECOND, orthogonal gate added
// alongside preflight: preflight asks "is this flight itself ready," clearance asks
// "does this flight's airspace collide with a flight already in the air." A flight
// departs only if BOTH pass — go = preflight.go && clearance.cleared. Clearance is
// computed BEFORE the flight row is created (not after) specifically so the flight
// being dispatched never collides with itself in the active-flights read. It only runs
// when `flight.meta` is present — an unscoped flight has no task_ids/artifact_refs to
// compare, so there is nothing to check (and nothing for a later flight to collide
// against it on). Preflight is unchanged; this is purely additive.

import type { Env } from '../types'
import { preflightCheck } from './preflight'
import type { FlightSignals, PreflightOptions, PreflightResult } from './preflight'
import { createFlight, applyPreflight, listFlights } from './service'
import type { NewFlight } from './service'
import { checkFlightClearance } from './clearance'
import type { ClearanceResult } from './clearance'

export interface DispatchExtra {
  // The override mechanism: an intentional co-work flight that already knows about and
  // accepts collision with specific active flights names them here to depart despite a
  // HOLD. The tower INFORMS, never dead-locks legitimate collaboration — but the
  // default (no override) is HOLD-on-hard-conflict.
  allowCollisionWith?: string[]
  /** Internal deterministic identity for crash-safe control-plane replay. */
  id?: string
}

export interface DispatchResult {
  id: string
  go: boolean
  status: 'running' | 'held'
  reasons: string[]
  score: number
  clearance?: ClearanceResult
}

function clearanceReasonTags(clearance: ClearanceResult): string[] {
  return clearance.holds.flatMap((hold) => hold.reasons.map((reason) => `clearance_${reason}:${hold.flight_b_id}`))
}

export async function dispatchFlight(
  env: Env,
  flight: NewFlight,
  signals: FlightSignals,
  opts: PreflightOptions = {},
  extra: DispatchExtra = {},
): Promise<DispatchResult> {
  const preflight = preflightCheck(signals, opts)

  let clearance: ClearanceResult | undefined
  if (flight.meta) {
    // Thin DB read (mirrors board.ts's philosophy) — recent flights for this tenant,
    // then checkFlightClearance filters to live statuses internally.
    const active = await listFlights(env, 500)
    clearance = checkFlightClearance(flight.meta, active, {
      tenant: env.TENANT_SLUG,
      ignoreFlightIds: extra.allowCollisionWith,
    })
  }

  const cleared = clearance ? clearance.cleared : true
  const combined: PreflightResult = cleared
    ? preflight
    : {
        go: false,
        score: preflight.score,
        checks: preflight.checks,
        reasons: [...preflight.reasons, 'flight_clearance_hold', ...clearanceReasonTags(clearance as ClearanceResult)],
      }

  const id = await createFlight(env, flight, { id: extra.id })
  const status = await applyPreflight(env, id, combined)
  return {
    id,
    go: combined.go,
    status: status as 'running' | 'held',
    reasons: combined.reasons,
    score: combined.score,
    clearance,
  }
}
