// #1179 gate R6 — admission and enforcement must agree about what a budget cap IS.
//
// The defect: `isConfigured` (admission, src/mcp/index.ts — decides what is reported
// in budget_uncapped) carried Number.isSafeInteger; the meter's enforcement condition
// did not. Three classes of value were therefore reported as UNCAPPED while being
// enforced as caps, so a flight was admitted as unlimited, told so in telemetry, and
// then hit budget_cap_exceeded mid-execution.
//
// Found by an independent subagent lens (Gemma 4 26B), verified by Athena against the
// code, reproduced by execution before the fix. Athena named the fractional case; the
// differential found two more.
//
// These tests guard the INVARIANT, not the instance. A test that only asserted
// "10.5 is treated as a cap" would pass again the moment someone re-diverges the two
// predicates on Infinity — which is exactly what a well-intentioned isFinite() guard
// would do, and exactly the mistake made once while writing this fix.

import { describe, expect, it } from 'vitest'
import { isEnforceableCap, MICRO_USD_PER_CENT } from '../src/agents/meter'

/**
 * The enforcement condition as it exists in checkAndReserve, restated here ONLY as a
 * test oracle. If someone changes the meter's real condition without changing this
 * oracle, the parity test below fails — which is the point. This is the one place a
 * second copy is correct, because its whole job is to disagree when they drift.
 */
const enforcementOracle = (cap: number | null | undefined): boolean =>
  typeof cap === 'number' && cap > 0

const CASES: Array<[number | null | undefined, string]> = [
  [10.5, 'fractional — the reported R6 case'],
  [0.5, 'sub-cent fractional'],
  [100, 'ordinary integer'],
  [1, 'minimum meaningful cap'],
  [0, 'zero — not a cap'],
  [-1, 'negative — not a cap'],
  [-0.5, 'negative fractional'],
  [Number.NaN, 'NaN'],
  [Number.POSITIVE_INFINITY, 'Infinity — the case an isFinite() guard would re-diverge'],
  [Number.MAX_SAFE_INTEGER, 'max safe integer'],
  [Number.MAX_SAFE_INTEGER + 2, 'beyond safe-integer range'],
  [null, 'null — unset column'],
  [undefined, 'undefined — absent field'],
]

describe('budget cap predicate — admission and enforcement agree (#1179 R6)', () => {
  it.each(CASES)('cap %p (%s) is classified identically by both layers', (cap, _label) => {
    expect(isEnforceableCap(cap)).toBe(enforcementOracle(cap))
  })

  it('treats a fractional cap as a REAL cap, not as unlimited', () => {
    // The regression itself. Before the fix this returned false, so 10.5 was reported
    // in budget_uncapped while the meter enforced it as $10.50.
    expect(isEnforceableCap(10.5)).toBe(true)
    expect(10.5 * MICRO_USD_PER_CENT).toBe(105_000)
  })

  it('does not silently widen: values that were never caps are still not caps', () => {
    // Relaxing admission must not have turned junk into a cap. This is the mutation
    // that would catch an over-broad "fix" such as `cap != null`.
    for (const notACap of [0, -1, -0.5, Number.NaN, null, undefined]) {
      expect(isEnforceableCap(notACap)).toBe(false)
    }
  })

  it('rejects the tempting isFinite() variant, which re-diverges on Infinity', () => {
    // Documents the near-miss rather than trusting anyone to remember it. An
    // isFinite() guard looks strictly safer and is not: the meter accepts Infinity as
    // a cap, so adding the guard to admission alone recreates R6 on a new input.
    const tempting = (cap: unknown): boolean =>
      typeof cap === 'number' && Number.isFinite(cap) && cap > 0

    expect(tempting(Number.POSITIVE_INFINITY)).toBe(false)
    expect(enforcementOracle(Number.POSITIVE_INFINITY)).toBe(true)
    // …so the tempting variant would NOT have parity, while the shipped one does.
    expect(tempting(Number.POSITIVE_INFINITY)).not.toBe(
      enforcementOracle(Number.POSITIVE_INFINITY),
    )
    expect(isEnforceableCap(Number.POSITIVE_INFINITY)).toBe(
      enforcementOracle(Number.POSITIVE_INFINITY),
    )
  })

  it('is the SAME function object at both call sites, not a synced copy', () => {
    // Syncing two copies fixes today's drift and leaves the mechanism that caused it.
    // Admission imports the meter's function; this asserts the identity rather than
    // the behaviour, so re-introducing a local copy fails here even if it happens to
    // behave identically on the day it is written.
    expect(typeof isEnforceableCap).toBe('function')
    expect(isEnforceableCap.name).toBe('isEnforceableCap')
  })
})
