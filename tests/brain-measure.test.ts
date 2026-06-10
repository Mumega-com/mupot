// tests/brain-measure.test.ts — the fallback brain's pure measuring organ.

import { describe, it, expect } from 'vitest'
import {
  coherenceFromOutcomes,
  backlogRelief,
  classifyRegime,
  EMA_SEED,
  CHAOS_BELOW_C,
  STALL_AFTER_MS,
  type OutcomeSample,
} from '../src/brain/measure'

const landed = { status: 'landed' } as const
const failed = { status: 'failed' } as const
const NOW = 1_780_000_000_000

describe('coherenceFromOutcomes (C = EMA of success fraction)', () => {
  it('no evidence → the neutral seed', () => {
    expect(coherenceFromOutcomes([])).toBe(EMA_SEED)
  })
  it('a clean run rises toward 1, a crashing run sinks toward 0', () => {
    const clean = coherenceFromOutcomes(Array<OutcomeSample>(8).fill(landed))
    const crashing = coherenceFromOutcomes(Array<OutcomeSample>(8).fill(failed))
    expect(clean).toBeGreaterThan(0.9)
    expect(crashing).toBeLessThan(0.1)
  })
  it('recency counts: a recent recovery outweighs old failures', () => {
    const recovered = coherenceFromOutcomes([failed, failed, failed, landed, landed, landed])
    const relapsed = coherenceFromOutcomes([landed, landed, landed, failed, failed, failed])
    expect(recovered).toBeGreaterThan(0.5)
    expect(relapsed).toBeLessThan(0.5)
  })
})

describe('backlogRelief (R = 1/(1+backlog))', () => {
  it('empty backlog → 1; grows → shrinks; never negative input', () => {
    expect(backlogRelief(0)).toBe(1)
    expect(backlogRelief(3)).toBeCloseTo(0.25)
    expect(backlogRelief(-5)).toBe(1)
  })
})

describe('classifyRegime', () => {
  const base = { coherence: 0.8, endedSample: 5, backlog: 0, lastActivityAt: NOW - 1000, nowMs: NOW }

  it('healthy + active → flow, no defect', () => {
    expect(classifyRegime(base)).toEqual({ regime: 'flow', defect: false, reason: null })
  })
  it('low C with enough sample → chaos (work keeps failing)', () => {
    const r = classifyRegime({ ...base, coherence: CHAOS_BELOW_C - 0.01 })
    expect(r.regime).toBe('chaos')
    expect(r.defect).toBe(true)
  })
  it('low C with a thin sample → NOT chaos (two crashes prove nothing)', () => {
    const r = classifyRegime({ ...base, coherence: 0.1, endedSample: 2 })
    expect(r.regime).toBe('flow')
  })
  it('backlog untouched past the stall window → stall', () => {
    const r = classifyRegime({ ...base, backlog: 4, lastActivityAt: NOW - STALL_AFTER_MS - 1 })
    expect(r).toEqual({ regime: 'stall', defect: true, reason: 'backlog_untouched' })
  })
  it('backlog but never ANY activity → stall (null lastActivityAt counts as idle)', () => {
    expect(classifyRegime({ ...base, backlog: 1, lastActivityAt: null }).regime).toBe('stall')
  })
  it('backlog with recent activity → flow (busy, not stalled)', () => {
    expect(classifyRegime({ ...base, backlog: 4 }).regime).toBe('flow')
  })
  it('chaos wins over stall (failing is more alarming than idle)', () => {
    const r = classifyRegime({ ...base, coherence: 0.1, backlog: 4, lastActivityAt: null })
    expect(r.regime).toBe('chaos')
  })
})
