// tests/loop-cro.test.ts — the CRO reason + KPI seams (S5).

import { describe, expect, it, vi } from 'vitest'
import { makeCroReason, makeCroObserveKpi, DEFAULT_CONVERSION_FLOOR } from '../src/loops/cro'
import type { ReasonInput } from '../src/loops/runtime'
import type { LoopManifest } from '../src/loops/manifest'
import type { Env, ModelPort } from '../src/types'
import type { D1Database } from '@cloudflare/workers-types'

const ENV = { TENANT_SLUG: 't' } as unknown as Env

const loop = { id: 'loop1', okr: 'lift signups', kpi: { signal: 'avg_conversion_bps', target: 200 } } as LoopManifest

// ── In-memory metric_points mock (matches tests/pulse.test.ts's makeDb shape) ──
// Only the SELECT path readSeries uses is needed here: filter by
// (tenant_id, metric_key, occurred_at BETWEEN fromISO AND toISO).
interface MpRow {
  tenant_id: string
  metric_key: string
  value: number
  occurred_at: string
}

function makeMetricPointsDb(rows: MpRow[]): D1Database {
  return {
    prepare() {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              const [tenantId, metricKey, fromISO, toISO] = args as [string, string, string, string]
              const results = rows.filter(
                (r) =>
                  r.tenant_id === tenantId &&
                  r.metric_key === metricKey &&
                  r.occurred_at >= fromISO &&
                  r.occurred_at <= toISO,
              )
              return { results, success: true, meta: { rows_read: results.length } }
            },
          }
        },
      }
    },
  } as unknown as D1Database
}

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

// ---------------------------------------------------------------------------
// defaultReadSignal wiring — the real metric_points read (no readSignal override).
// ---------------------------------------------------------------------------

describe('makeCroObserveKpi — default readSignal (metric_points wiring)', () => {
  const NOW = Date.now()
  const inWindowISO = (hoursAgo: number) => new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString()
  const outOfWindowISO = (daysAgo: number) => new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString()

  it('averages loop.kpi.signal points from metric_points for this tenant, in-window', async () => {
    const env = {
      TENANT_SLUG: 'tenant-x',
      DB: makeMetricPointsDb([
        // matches: tenant + metric_key = loop.kpi.signal, within the trailing window
        { tenant_id: 'tenant-x', metric_key: 'avg_conversion_bps', value: 100, occurred_at: inWindowISO(1) },
        { tenant_id: 'tenant-x', metric_key: 'avg_conversion_bps', value: 200, occurred_at: inWindowISO(2) },
      ]),
    } as unknown as Env
    const observe = makeCroObserveKpi() // no override → defaultReadSignal
    // avg(100, 200) = 150; target = 200 ⇒ 150/200*100 = 75
    expect(await observe(env, loop)).toBe(75)
  })

  it('does not read another tenant\'s metric_points (tenant isolation)', async () => {
    const env = {
      TENANT_SLUG: 'tenant-x',
      DB: makeMetricPointsDb([
        { tenant_id: 'tenant-OTHER', metric_key: 'avg_conversion_bps', value: 999, occurred_at: inWindowISO(1) },
      ]),
    } as unknown as Env
    const observe = makeCroObserveKpi()
    expect(await observe(env, loop)).toBe(0)
  })

  it('does not read a different metric_key (only the loop\'s own kpi.signal)', async () => {
    const env = {
      TENANT_SLUG: 'tenant-x',
      DB: makeMetricPointsDb([
        { tenant_id: 'tenant-x', metric_key: 'growth.leads', value: 999, occurred_at: inWindowISO(1) },
      ]),
    } as unknown as Env
    const observe = makeCroObserveKpi()
    expect(await observe(env, loop)).toBe(0)
  })

  it('ignores points outside the trailing signal window', async () => {
    const env = {
      TENANT_SLUG: 'tenant-x',
      DB: makeMetricPointsDb([
        { tenant_id: 'tenant-x', metric_key: 'avg_conversion_bps', value: 500, occurred_at: outOfWindowISO(30) },
      ]),
    } as unknown as Env
    const observe = makeCroObserveKpi()
    expect(await observe(env, loop)).toBe(0)
  })

  it('no matching points ⇒ honest 0 (never fabricated)', async () => {
    const env = { TENANT_SLUG: 'tenant-x', DB: makeMetricPointsDb([]) } as unknown as Env
    const observe = makeCroObserveKpi()
    expect(await observe(env, loop)).toBe(0)
  })

  it('no TENANT_SLUG bound ⇒ honest 0, never queries with an undefined tenant', async () => {
    const env = { TENANT_SLUG: undefined, DB: makeMetricPointsDb([]) } as unknown as Env
    const observe = makeCroObserveKpi()
    expect(await observe(env, loop)).toBe(0)
  })
})
