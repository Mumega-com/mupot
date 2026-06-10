import { describe, it, expect } from 'vitest'
import { parseDispatchBody, parseOutcomeQuery, hourlyDispatchCap, DEFAULT_FLIGHT_MAX_DISPATCH_HOUR } from '../src/flight/routes'

const goodSignals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 1_000_000,
  budgetEstimateMicroUsd: 200_000,
  recentProgress: 0.8,
  progressPerStep: 0.5,
  wastePerStep: 0.1,
  stepSeconds: 20,
}

describe('parseDispatchBody', () => {
  it('accepts a full body + defaults trigger to api', () => {
    const r = parseDispatchBody({ agent: 'opus', goal: 'fix the loop', signals: goodSignals })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.flight.agent).toBe('opus')
    expect(r.value.flight.trigger_source).toBe('api')
    expect(r.value.signals.budgetRemainingMicroUsd).toBe(1_000_000)
  })

  it('rejects a non-object body', () => {
    expect(parseDispatchBody(null)).toEqual({ ok: false, error: 'body_required' })
    expect(parseDispatchBody('x')).toEqual({ ok: false, error: 'body_required' })
  })

  it('requires agent + goal', () => {
    expect(parseDispatchBody({ goal: 'g', signals: goodSignals })).toEqual({ ok: false, error: 'agent_required' })
    expect(parseDispatchBody({ agent: 'a', signals: goodSignals })).toEqual({ ok: false, error: 'goal_required' })
  })

  it('rejects a missing signal block (never defaults to a launch)', () => {
    expect(parseDispatchBody({ agent: 'a', goal: 'g' })).toEqual({ ok: false, error: 'signals_required' })
  })

  it('coerces bad signal types safely (NaN/string → fail-closed numbers, non-true → false)', () => {
    const r = parseDispatchBody({
      agent: 'a',
      goal: 'g',
      signals: { ...goodSignals, contextComplete: 'yes', budgetRemainingMicroUsd: 'lots', recentProgress: 5 },
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.signals.contextComplete).toBe(false) // only literal true counts
    expect(r.value.signals.budgetRemainingMicroUsd).toBe(0) // string → fallback
    expect(r.value.signals.recentProgress).toBe(1) // clamped 0..1
  })

  it('keeps a known trigger_source + clamps negative budget to 0', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', trigger_source: 'cron', budget_micro_usd: -50, signals: goodSignals })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.flight.trigger_source).toBe('cron')
    expect(r.value.flight.budget_micro_usd).toBe(0)
  })

  it('passes through opts only when present + clamps them', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, opts: { scoreThreshold: 2, cacheWindowSeconds: 120 } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.opts.scoreThreshold).toBe(1) // clamped 0..1
    expect(r.value.opts.cacheWindowSeconds).toBe(120)
    expect(r.value.opts.minProgressRatio).toBeUndefined()
  })
})

describe('parseOutcomeQuery', () => {
  it('parses a status csv, dropping unknown statuses', () => {
    const q = parseOutcomeQuery(new URLSearchParams('status=landed,failed,bogus'))
    expect(q.statuses).toEqual(['landed', 'failed'])
  })
  it('null statuses when none valid → all', () => {
    expect(parseOutcomeQuery(new URLSearchParams('status=bogus')).statuses).toBeNull()
    expect(parseOutcomeQuery(new URLSearchParams('')).statuses).toBeNull()
  })
  it('parses since cursor + clamps limit', () => {
    const q = parseOutcomeQuery(new URLSearchParams('since=1700000000000&limit=9999'))
    expect(q.sinceMs).toBe(1_700_000_000_000)
    expect(q.limit).toBe(500)
  })
  it('ignores a non-positive/garbage since, defaults limit', () => {
    const q = parseOutcomeQuery(new URLSearchParams('since=-5'))
    expect(q.sinceMs).toBeNull()
    expect(q.limit).toBe(200)
  })
})

describe('parseDispatchBody — strict signal presence (absent ≠ zero)', () => {
  it('rejects when an individual signal is absent, naming the holes', () => {
    const { recentProgress: _drop, ...partial } = goodSignals
    const r = parseDispatchBody({ agent: 'a', goal: 'g', signals: partial })
    expect(r).toEqual({ ok: false, error: 'signals_incomplete:recentProgress' })
  })
  it('names every missing signal', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', signals: { contextComplete: true } })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('signals_incomplete:')
    expect(r.error).toContain('toolsReachable')
    expect(r.error).toContain('stepSeconds')
    expect(r.error).not.toContain('contextComplete')
  })
  it('present-but-mistyped still coerces fail-closed (presence is the contract)', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', signals: { ...goodSignals, stepSeconds: 'fast' } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.signals.stepSeconds).toBe(0)
  })
})

describe('hourlyDispatchCap — the per-tenant dispatch fuse', () => {
  it('defaults to 30 and honors a positive env override', () => {
    expect(hourlyDispatchCap({} as never)).toBe(DEFAULT_FLIGHT_MAX_DISPATCH_HOUR)
    expect(hourlyDispatchCap({ FLIGHT_MAX_DISPATCH_HOUR: '5' } as never)).toBe(5)
  })
  it('falls back on garbage / non-positive overrides (fail-closed to the default)', () => {
    expect(hourlyDispatchCap({ FLIGHT_MAX_DISPATCH_HOUR: 'lots' } as never)).toBe(DEFAULT_FLIGHT_MAX_DISPATCH_HOUR)
    expect(hourlyDispatchCap({ FLIGHT_MAX_DISPATCH_HOUR: '0' } as never)).toBe(DEFAULT_FLIGHT_MAX_DISPATCH_HOUR)
    expect(hourlyDispatchCap({ FLIGHT_MAX_DISPATCH_HOUR: '-3' } as never)).toBe(DEFAULT_FLIGHT_MAX_DISPATCH_HOUR)
  })
})
