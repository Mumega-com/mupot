// tests/cost.test.ts — the cost model (src/agents/cost.ts, issue #15).
//
// Pure functions, no D1, no env. nowMs is injected so burn-rate math is
// deterministic. Covers: rate lookup + fallback, micro-USD derivation, dollar
// formatting at sub-cent / cent / zero, hours-since-midnight floor, burn rate.

import { describe, expect, it } from 'vitest'
import {
  MODEL_RATE_USD_PER_M,
  FALLBACK_RATE_USD_PER_M,
  rateUsdPerMillion,
  costMicroUsd,
  microUsdToDollars,
  formatUsd,
  hoursSinceUtcMidnight,
  burnUsdPerHour,
  formatBurn,
} from '../src/agents/cost'

describe('rateUsdPerMillion', () => {
  it('returns the table rate for a known model', () => {
    expect(rateUsdPerMillion('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(
      MODEL_RATE_USD_PER_M['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    )
    expect(rateUsdPerMillion('claude-sonnet-4-5')).toBe(9.0)
  })

  it('falls back for unknown / null / empty model', () => {
    expect(rateUsdPerMillion('some-unknown-model')).toBe(FALLBACK_RATE_USD_PER_M)
    expect(rateUsdPerMillion(null)).toBe(FALLBACK_RATE_USD_PER_M)
    expect(rateUsdPerMillion(undefined)).toBe(FALLBACK_RATE_USD_PER_M)
    expect(rateUsdPerMillion('')).toBe(FALLBACK_RATE_USD_PER_M)
  })

  // #15 adversarial gate: an off-table family member must price at a CEILING,
  // never the cheap floor — so burn can't be understated by naming a model the
  // exact table doesn't list.
  it('prices off-table family members at the family ceiling (never low)', () => {
    // dated/pinned Claude variant not in the table → claude- ceiling (15), not 9
    expect(rateUsdPerMillion('claude-sonnet-4-5-20260101')).toBe(15.0)
    // premium Opus-class → opus ceiling (30)
    expect(rateUsdPerMillion('claude-opus-4-1')).toBe(30.0)
    // GPT-4-class variant → 10
    expect(rateUsdPerMillion('gpt-4o-2026')).toBe(10.0)
    // any other GPT → 5
    expect(rateUsdPerMillion('gpt-5-mini')).toBe(5.0)
    // Gemini variant → 5
    expect(rateUsdPerMillion('gemini-3.0-pro')).toBe(5.0)
    // exact table entries still win over the family ceiling
    expect(rateUsdPerMillion('claude-sonnet-4-5')).toBe(9.0)
    expect(rateUsdPerMillion('gpt-4o-mini')).toBe(0.4)
  })

  it('the flat fallback is a premium ceiling, not a cheap floor', () => {
    expect(FALLBACK_RATE_USD_PER_M).toBeGreaterThanOrEqual(10)
  })
})

describe('costMicroUsd', () => {
  it('tokens × rate is already micro-USD', () => {
    // 2048 tokens × 0.5 USD/1M = 1024 micro-USD ($0.001024)
    expect(costMicroUsd('@cf/meta/llama-3.3-70b-instruct-fp8-fast', 2048)).toBe(1024)
    // 1_000_000 tokens × 9.0 = 9_000_000 micro-USD = $9.00
    expect(costMicroUsd('claude-sonnet-4-5', 1_000_000)).toBe(9_000_000)
  })

  it('uses the fallback ceiling for wholly-unknown models', () => {
    // 2048 × 15.0 (premium fallback) = 30720 micro-USD
    expect(costMicroUsd('mystery', 2048)).toBe(30720)
  })

  it('rounds to an integer', () => {
    // 333 × 0.3 = 99.9 → 100
    expect(costMicroUsd('gemini-2.5-flash', 333)).toBe(100)
  })

  it('is 0 for non-positive or non-finite tokens', () => {
    expect(costMicroUsd('claude-sonnet-4-5', 0)).toBe(0)
    expect(costMicroUsd('claude-sonnet-4-5', -10)).toBe(0)
    expect(costMicroUsd('claude-sonnet-4-5', NaN)).toBe(0)
    expect(costMicroUsd('claude-sonnet-4-5', Infinity)).toBe(0)
  })
})

describe('microUsdToDollars', () => {
  it('divides by 1e6', () => {
    expect(microUsdToDollars(1_000_000)).toBe(1)
    expect(microUsdToDollars(1024)).toBeCloseTo(0.001024, 9)
  })
  it('clamps non-positive / non-finite to 0', () => {
    expect(microUsdToDollars(0)).toBe(0)
    expect(microUsdToDollars(-5)).toBe(0)
    expect(microUsdToDollars(NaN)).toBe(0)
  })
})

describe('formatUsd', () => {
  it('zero renders $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00')
  })
  it('sub-cent shows 4 dp', () => {
    expect(formatUsd(1024)).toBe('$0.0010') // $0.001024 → 4dp
  })
  it('cent-or-more shows 2 dp', () => {
    expect(formatUsd(1_230_000)).toBe('$1.23')
    expect(formatUsd(50_000)).toBe('$0.05')
  })
})

describe('hoursSinceUtcMidnight', () => {
  it('computes elapsed hours from UTC midnight', () => {
    // 2026-06-08T06:00:00Z → 6 hours
    const ms = Date.UTC(2026, 5, 8, 6, 0, 0)
    expect(hoursSinceUtcMidnight(ms)).toBeCloseTo(6, 6)
  })
  it('floors the denominator at 1 minute (fresh window)', () => {
    // exactly midnight → elapsed clamped to 60s = 1/60 h
    const ms = Date.UTC(2026, 5, 8, 0, 0, 0)
    expect(hoursSinceUtcMidnight(ms)).toBeCloseTo(1 / 60, 9)
  })
})

describe('burnUsdPerHour', () => {
  it('spend / hours-elapsed', () => {
    // $0.60 spent, 6 hours in → $0.10/hr
    const ms = Date.UTC(2026, 5, 8, 6, 0, 0)
    expect(burnUsdPerHour(600_000, ms)).toBeCloseTo(0.1, 9)
  })
  it('zero spend → zero burn', () => {
    const ms = Date.UTC(2026, 5, 8, 6, 0, 0)
    expect(burnUsdPerHour(0, ms)).toBe(0)
  })
})

describe('formatBurn', () => {
  it('zero spend renders $0.00/hr', () => {
    const ms = Date.UTC(2026, 5, 8, 6, 0, 0)
    expect(formatBurn(0, ms)).toBe('$0.00/hr')
  })
  it('formats a normal burn rate at 2 dp', () => {
    const ms = Date.UTC(2026, 5, 8, 6, 0, 0)
    // $6.00 over 6h = $1.00/hr
    expect(formatBurn(6_000_000, ms)).toBe('$1.00/hr')
  })
  it('formats a sub-cent burn rate at 4 dp', () => {
    const ms = Date.UTC(2026, 5, 8, 12, 0, 0)
    // 1200 micro-USD over 12h = $0.0001/hr
    expect(formatBurn(1200, ms)).toBe('$0.0001/hr')
  })
})
