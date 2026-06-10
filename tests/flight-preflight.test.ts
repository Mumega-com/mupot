import { describe, it, expect } from 'vitest'
import { readinessScore, preflightCheck } from '../src/flight/preflight'
import type { FlightSignals } from '../src/flight/preflight'

// A healthy flight: context loaded, tools up, budget ample, progress beats waste,
// steps fit the cache window.
const HEALTHY: FlightSignals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 5_000_000,
  budgetEstimateMicroUsd: 1_000_000,
  recentProgress: 0.8,
  progressPerStep: 0.7,
  wastePerStep: 0.2,
  stepSeconds: 60,
}

describe('readinessScore', () => {
  it('healthy flight scores high (readiness)', () => {
    expect(readinessScore(HEALTHY)).toBeGreaterThan(0.7)
  })
  it('missing context tanks the score toward zero', () => {
    expect(readinessScore({ ...HEALTHY, contextComplete: false })).toBeLessThan(0.2)
  })
  it('unreachable tools tanks the score toward zero', () => {
    expect(readinessScore({ ...HEALTHY, toolsReachable: false })).toBeLessThan(0.2)
  })
  it('is bounded to [0,1]', () => {
    const s = readinessScore(HEALTHY)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(1)
  })
  it('a half-funded flight scores lower than a fully funded one', () => {
    const poor = readinessScore({ ...HEALTHY, budgetRemainingMicroUsd: 500_000 }) // < estimate
    expect(poor).toBeLessThan(readinessScore(HEALTHY))
  })
})

describe('preflightCheck — GO', () => {
  it('a healthy flight gets GO with all checks true and no reasons', () => {
    const r = preflightCheck(HEALTHY)
    expect(r.go).toBe(true)
    expect(r.reasons).toEqual([])
    expect(r.checks.contextComplete).toBe(true)
    expect(r.checks.progressBeatsWaste).toBe(true)
    expect(r.checks.cacheStaysWarm).toBe(true)
  })
})

describe('preflightCheck — NO-GO (hard prerequisites)', () => {
  it('no context → NO-GO with reason', () => {
    const r = preflightCheck({ ...HEALTHY, contextComplete: false })
    expect(r.go).toBe(false)
    expect(r.checks.contextComplete).toBe(false)
    expect(r.reasons).toContain('context_incomplete')
  })
  it('tools unreachable → NO-GO', () => {
    const r = preflightCheck({ ...HEALTHY, toolsReachable: false })
    expect(r.go).toBe(false)
    expect(r.reasons).toContain('tools_unreachable')
  })
  it('budget below estimate → NO-GO', () => {
    const r = preflightCheck({ ...HEALTHY, budgetRemainingMicroUsd: 100_000 })
    expect(r.go).toBe(false)
    expect(r.checks.budgetHeadroom).toBe(false)
    expect(r.reasons).toContain('insufficient_budget')
  })
})

describe('preflightCheck — the two checks', () => {
  it('progress does not beat waste → NO-GO (would wander)', () => {
    const r = preflightCheck({ ...HEALTHY, progressPerStep: 0.1, wastePerStep: 0.6 })
    expect(r.go).toBe(false)
    expect(r.checks.progressBeatsWaste).toBe(false)
    expect(r.reasons).toContain('would_wander')
  })
  it('step longer than the cache window → NO-GO (cache would cool)', () => {
    const r = preflightCheck({ ...HEALTHY, stepSeconds: 600 }) // > 300s default window
    expect(r.go).toBe(false)
    expect(r.checks.cacheStaysWarm).toBe(false)
    expect(r.reasons).toContain('cache_would_cool')
  })
  it('cache window is configurable', () => {
    const r = preflightCheck({ ...HEALTHY, stepSeconds: 400 }, { cacheWindowSeconds: 500 })
    expect(r.checks.cacheStaysWarm).toBe(true)
  })
})

describe('preflightCheck — score threshold', () => {
  it('a passing-checks flight below the score threshold is still NO-GO', () => {
    // raise the threshold above a healthy score to isolate the threshold gate
    const r = preflightCheck(HEALTHY, { scoreThreshold: 0.99 })
    expect(r.go).toBe(false)
    expect(r.reasons).toContain('low_readiness')
  })
})

describe('agent reliability (pot-owned history friction)', () => {
  it('no history → neutral: same score, gate unaffected', () => {
    const withHistory = readinessScore({ ...HEALTHY, endedFlightSample: 0 })
    expect(withHistory).toBeCloseTo(readinessScore(HEALTHY), 10)
    const r = preflightCheck({ ...HEALTHY, endedFlightSample: 0 })
    expect(r.checks.agentReliable).toBe(true)
  })
  it('below the sample bar → neutral even with a bad rate (2 crashes prove nothing)', () => {
    const r = preflightCheck({ ...HEALTHY, recentFailureRate: 1, endedFlightSample: 2 })
    expect(r.checks.agentReliable).toBe(true)
    expect(r.go).toBe(true)
  })
  it('enough sample + rate past the bar → grounded with agent_unreliable', () => {
    const r = preflightCheck({ ...HEALTHY, recentFailureRate: 0.7, endedFlightSample: 5 })
    expect(r.checks.agentReliable).toBe(false)
    expect(r.go).toBe(false)
    expect(r.reasons).toContain('agent_unreliable')
  })
  it('rate at the bar exactly → still flies (bar is exclusive)', () => {
    const r = preflightCheck({ ...HEALTHY, recentFailureRate: 0.5, endedFlightSample: 4 })
    expect(r.checks.agentReliable).toBe(true)
  })
  it('a sub-bar rate still drags the score smoothly (friction before the wall)', () => {
    const clean = readinessScore({ ...HEALTHY, recentFailureRate: 0, endedFlightSample: 5 })
    const shaky = readinessScore({ ...HEALTHY, recentFailureRate: 0.4, endedFlightSample: 5 })
    expect(shaky).toBeLessThan(clean)
  })
  it('opts tune both the bar and the sample size', () => {
    const strict = preflightCheck(
      { ...HEALTHY, recentFailureRate: 0.2, endedFlightSample: 2 },
      { maxFailureRate: 0.1, minFailureSample: 2 },
    )
    expect(strict.reasons).toContain('agent_unreliable')
  })
})
