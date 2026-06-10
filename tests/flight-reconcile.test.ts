// tests/flight-reconcile.test.ts — the land-cost reconciliation seam (pure parts).
//
// reconcileCost compares the caller-reported landed cost against the pot-metered
// delta; divergence flags (never blocks) only when it clears BOTH the ratio bar
// and the absolute floor, so rounding noise and tiny flights stay quiet.

import { describe, it, expect } from 'vitest'
import {
  reconcileCost,
  parseMeterTakeoff,
  metaWithReconciliation,
  RECONCILE_ABS_FLOOR_MICRO_USD,
} from '../src/flight/reconcile'

describe('reconcileCost', () => {
  it('no snapshot → unflagged, metered null', () => {
    const r = reconcileCost(50_000, null)
    expect(r.flagged).toBe(false)
    expect(r.metered_micro_usd).toBeNull()
    expect(r.variance_micro_usd).toBeNull()
    expect(r.note).toBe('no_takeoff_snapshot')
  })

  it('agreement within the ratio bar → ok', () => {
    const r = reconcileCost(100_000, 80_000) // 1.25× apart
    expect(r.flagged).toBe(false)
    expect(r.note).toBe('ok')
    expect(r.variance_micro_usd).toBe(20_000)
  })

  it('big divergence under the absolute floor → ok (tiny flights stay quiet)', () => {
    // 5× apart but only $0.008 of variance — below the $0.01 floor.
    const r = reconcileCost(10_000, 2_000)
    expect(r.flagged).toBe(false)
  })

  it('under-report past both bars → flagged', () => {
    // pot metered $1.00, caller claims $0.10
    const r = reconcileCost(100_000, 1_000_000)
    expect(r.flagged).toBe(true)
    expect(r.note).toBe('under_reported_vs_meter')
    expect(r.variance_micro_usd).toBe(-900_000)
  })

  it('over-report past both bars → flagged (spend the pot never saw)', () => {
    const r = reconcileCost(1_000_000, 100_000)
    expect(r.flagged).toBe(true)
    expect(r.note).toBe('over_reported_vs_meter')
  })

  it('reported zero against real metered spend → flagged (ratio bar covers lo=0)', () => {
    const r = reconcileCost(0, RECONCILE_ABS_FLOOR_MICRO_USD + 1)
    expect(r.flagged).toBe(true)
    expect(r.note).toBe('under_reported_vs_meter')
  })

  it('both zero → ok', () => {
    const r = reconcileCost(0, 0)
    expect(r.flagged).toBe(false)
  })
})

describe('parseMeterTakeoff', () => {
  it('reads a valid snapshot from meta', () => {
    const meta = JSON.stringify({ meter_takeoff: { at: 1_780_000_000_000, cost_micro_usd: 42 } })
    expect(parseMeterTakeoff(meta)).toEqual({ at: 1_780_000_000_000, cost_micro_usd: 42 })
  })
  it('null on absent / malformed / non-finite shapes', () => {
    expect(parseMeterTakeoff('{}')).toBeNull()
    expect(parseMeterTakeoff('not json')).toBeNull()
    expect(parseMeterTakeoff(JSON.stringify({ meter_takeoff: { at: 'x', cost_micro_usd: 1 } }))).toBeNull()
    expect(parseMeterTakeoff(JSON.stringify({ meter_takeoff: { at: 1, cost_micro_usd: -5 } }))).toBeNull()
  })
})

describe('metaWithReconciliation', () => {
  it('merges into existing meta without dropping other keys', () => {
    const rec = reconcileCost(10, 10)
    const out = JSON.parse(metaWithReconciliation(JSON.stringify({ chain_id: 'c1' }), rec))
    expect(out.chain_id).toBe('c1')
    expect(out.cost_reconciliation.note).toBe('ok')
  })
  it('survives unparseable meta (starts fresh rather than failing the land)', () => {
    const rec = reconcileCost(10, 10)
    const out = JSON.parse(metaWithReconciliation('broken{', rec))
    expect(out.cost_reconciliation).toBeDefined()
  })
})
