import { describe, it, expect } from 'vitest'
import { parseDispatchBody, parseOutcomeQuery } from '../src/flight/routes'

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

const goodMeta = {
  schema: 'mupot.flight.meta/v1',
  goal_id: 'mumega-tenant-zero',
  objective_id: 'm000-constitution-census',
  squad_ids: ['squad-mmhq'],
  task_ids: ['task-m000'],
  done_when: ['the census hash verifies'],
  artifact_refs: [],
  receipt_refs: [],
  confidentiality: 'internal',
  publication_target: 'none',
  parent_flight_id: null,
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

  it('preserves valid v1 metadata on the flight record', () => {
    const r = parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, meta: goodMeta })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.flight.meta).toEqual(goodMeta)
  })

  it('rejects malformed or unknown flight metadata', () => {
    expect(parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, meta: { ...goodMeta, task_ids: [] } }))
      .toEqual({ ok: false, error: 'invalid_flight_meta' })
    expect(parseDispatchBody({ agent: 'a', goal: 'g', signals: goodSignals, meta: { ...goodMeta, hidden: 'data' } }))
      .toEqual({ ok: false, error: 'invalid_flight_meta' })
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
