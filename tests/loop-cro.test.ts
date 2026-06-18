// tests/loop-cro.test.ts — the CRO reason + KPI seams (S5).

import { describe, expect, it, vi } from 'vitest'
import { makeCroReason, makeCroObserveKpi, DEFAULT_CONVERSION_FLOOR } from '../src/loops/cro'
import type { ReasonInput } from '../src/loops/runtime'
import type { LoopManifest } from '../src/loops/manifest'
import type { Env, ModelPort } from '../src/types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

const loop = { id: 'loop1', okr: 'lift signups', kpi: { signal: 'avg_conversion_bps', target: 200 } } as LoopManifest

const okModel = (json: string): ModelPort => ({ chat: vi.fn(async () => json) })
const REC = '{"recommendation":"Tighten the headline to the core benefit and move the CTA above the fold."}'

// No pending proposals by default (cross-tick dedup empty).
const noPending = async () => new Set<string>()

function input(over: Partial<ReasonInput> = {}): ReasonInput {
  return {
    loop,
    budget: 1,
    context: [{ id: 'pricing', slug: 'pricing', title: 'Pricing', conversion_rate: 0.005 }],
    ...over,
  }
}

describe('makeCroReason', () => {
  it('proposes ONE gated content-update act for an underperforming page', async () => {
    const reason = makeCroReason({ model: okModel(REC), proposedSlugs: noPending })
    const acts = await reason(ENV, input())
    expect(acts).toHaveLength(1)
    expect(acts[0].tool).toBe('cro_content_update') // content-kind, NOT a CRM kind → review task
    expect(acts[0].channel_index).toBe(-1) // internal proposal, never a channel send
    expect(acts[0].args).toMatchObject({
      slug: 'pricing',
      current_conversion_bps: 50, // 0.005 * 10_000
      basis: 'low_conversion',
    })
    expect(acts[0].args.recommendation).toContain('headline')
  })

  it('derives conversion from a conversions/views pair when no explicit rate', async () => {
    const reason = makeCroReason({ model: okModel(REC), proposedSlugs: noPending })
    const acts = await reason(ENV, input({ context: [{ id: 'x', slug: 'home', conversions: 1, views: 1000 }] }))
    expect(acts).toHaveLength(1)
    expect(acts[0].args).toMatchObject({ slug: 'home', current_conversion_bps: 10 }) // 0.001
  })

  it('skips pages at/above the conversion floor (only weak pages targeted)', async () => {
    const reason = makeCroReason({ model: okModel(REC), proposedSlugs: noPending })
    const acts = await reason(
      ENV,
      input({ context: [{ id: 'good', slug: 'good', conversion_rate: DEFAULT_CONVERSION_FLOOR + 0.01 }] }),
    )
    expect(acts).toHaveLength(0)
  })

  it('ranks worst-first and respects the effort budget', async () => {
    const reason = makeCroReason({ model: okModel(REC), proposedSlugs: noPending })
    const ctx = [
      { id: 'a', slug: 'a', conversion_rate: 0.015 },
      { id: 'b', slug: 'b', conversion_rate: 0.001 }, // worst
      { id: 'c', slug: 'c', conversion_rate: 0.008 },
    ]
    const acts = await reason(ENV, input({ budget: 2, context: ctx }))
    expect(acts.map((a) => a.args.slug)).toEqual(['b', 'c']) // two worst, in order
  })

  it('within-tick dedup: the same slug appears once even if perceived twice', async () => {
    const reason = makeCroReason({ model: okModel(REC), proposedSlugs: noPending })
    const ctx = [
      { id: 'dup1', slug: 'pricing', conversion_rate: 0.002 },
      { id: 'dup2', slug: 'pricing', conversion_rate: 0.003 },
    ]
    const acts = await reason(ENV, input({ budget: 5, context: ctx }))
    expect(acts).toHaveLength(1)
  })

  it('cross-tick dedup: a slug already pending is skipped', async () => {
    const reason = makeCroReason({ model: okModel(REC), proposedSlugs: async () => new Set(['pricing']) })
    const acts = await reason(ENV, input())
    expect(acts).toHaveLength(0)
  })

  it('a failed proposedSlugs read is treated as none-pending (within-tick guard still holds)', async () => {
    const reason = makeCroReason({
      model: okModel(REC),
      proposedSlugs: async () => {
        throw new Error('db down')
      },
    })
    const ctx = [
      { id: 'd1', slug: 'pricing', conversion_rate: 0.002 },
      { id: 'd2', slug: 'pricing', conversion_rate: 0.003 },
    ]
    const acts = await reason(ENV, input({ budget: 5, context: ctx }))
    expect(acts).toHaveLength(1) // proposes (read failed → none pending), but de-dups within the tick
  })

  it('is inert on a non-CRO source (items with no conversion signal)', async () => {
    const reason = makeCroReason({ model: okModel(REC), proposedSlugs: noPending })
    const acts = await reason(ENV, input({ context: [{ id: 'n', title: 'a memory note', text: 'hello' }] }))
    expect(acts).toHaveLength(0)
  })

  it('skips a page when the model returns unparseable output (no act)', async () => {
    const reason = makeCroReason({ model: okModel('sorry, no JSON here'), proposedSlugs: noPending })
    const acts = await reason(ENV, input())
    expect(acts).toHaveLength(0)
  })
})

describe('makeCroObserveKpi', () => {
  it('progress = signal ÷ target × 100', async () => {
    const observe = makeCroObserveKpi({ readSignal: async () => 50 })
    expect(await observe(ENV, loop)).toBe(25) // 50 / 200
  })
  it('clamps to 100', async () => {
    const observe = makeCroObserveKpi({ readSignal: async () => 9999 })
    expect(await observe(ENV, loop)).toBe(100)
  })
  it('defaults to honest 0 when no signal source is wired', async () => {
    const observe = makeCroObserveKpi()
    expect(await observe(ENV, loop)).toBe(0)
  })
  it('a failed signal read is honest 0, never a fabricated KPI', async () => {
    const observe = makeCroObserveKpi({
      readSignal: async () => {
        throw new Error('source down')
      },
    })
    expect(await observe(ENV, loop)).toBe(0)
  })
})
