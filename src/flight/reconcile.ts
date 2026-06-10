// flight/reconcile — verify a caller-reported landed cost against the pot's own meter.
//
// The land endpoint trusts whatever cost_micro_usd the caller (the brain / executor)
// reports. That is correct for work that ran outside the pot, but for pot-metered work
// the execution_meter already recorded the real spend — so the seam can be VERIFIED,
// not just trusted. At dispatch the pot snapshots the agent's metered cost (takeoff);
// at land it reads the same range again and the delta is what the pot itself saw the
// flight spend. A large divergence is FLAGGED (recorded in the flight's meta + returned
// to the caller), never blocked — the meter is day-granular and a flight may legally
// include off-pot spend, so this is a tripwire for drift, not a gate.

export interface MeterTakeoff {
  at: number // Unix ms when the flight was dispatched
  cost_micro_usd: number // the agent's metered cost over [day(at)..today] at that moment
}

export interface CostReconciliation {
  reported_micro_usd: number
  metered_micro_usd: number | null // null = no takeoff snapshot (pre-seam flight)
  variance_micro_usd: number | null // reported − metered
  flagged: boolean
  note: string
}

// Divergence must clear BOTH bars to flag — a ratio (>2× apart) and an absolute floor
// ($0.01) — so tiny flights and rounding noise never page anyone.
export const RECONCILE_ABS_FLOOR_MICRO_USD = 10_000 // $0.01
export const RECONCILE_RATIO = 2

/** Compare the caller-reported cost with the pot-metered delta. Pure. */
export function reconcileCost(
  reportedMicroUsd: number,
  meteredMicroUsd: number | null,
): CostReconciliation {
  const reported = Math.max(0, Math.round(reportedMicroUsd))
  if (meteredMicroUsd == null) {
    return {
      reported_micro_usd: reported,
      metered_micro_usd: null,
      variance_micro_usd: null,
      flagged: false,
      note: 'no_takeoff_snapshot',
    }
  }
  const metered = Math.max(0, Math.round(meteredMicroUsd))
  const variance = reported - metered
  const lo = Math.min(reported, metered)
  const hi = Math.max(reported, metered)
  // ratio bar: hi > lo·RATIO covers the lo=0 case (any hi>0 diverges infinitely).
  const flagged = Math.abs(variance) > RECONCILE_ABS_FLOOR_MICRO_USD && hi > lo * RECONCILE_RATIO
  const note = !flagged
    ? 'ok'
    : variance < 0
      ? 'under_reported_vs_meter' // caller claims less than the pot itself metered
      : 'over_reported_vs_meter' // caller claims spend the pot never saw (may be off-pot)
  return {
    reported_micro_usd: reported,
    metered_micro_usd: metered,
    variance_micro_usd: variance,
    flagged,
    note,
  }
}

/** Parse a flight's meta JSON for the takeoff snapshot. Returns null on any shape problem. */
export function parseMeterTakeoff(metaJson: string): MeterTakeoff | null {
  try {
    const meta = JSON.parse(metaJson) as Record<string, unknown>
    const t = meta.meter_takeoff as Record<string, unknown> | undefined
    if (!t || typeof t !== 'object') return null
    const at = t.at
    const cost = t.cost_micro_usd
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return null
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null
    return { at, cost_micro_usd: cost }
  } catch {
    return null
  }
}

/** Merge the reconciliation into the flight's meta JSON (never throws; falls back to fresh meta). */
export function metaWithReconciliation(metaJson: string, rec: CostReconciliation): string {
  let meta: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(metaJson)
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
  } catch {
    // unparseable meta from an old row — start fresh rather than fail the land
  }
  meta.cost_reconciliation = rec
  return JSON.stringify(meta)
}
