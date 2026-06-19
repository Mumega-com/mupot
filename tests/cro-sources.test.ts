// tests/cro-sources.test.ts — the CRO data fabric: graceful degradation + first-party floor.

import { describe, it, expect } from 'vitest'
import { collectFromSources, MAX_POINTS_PER_SOURCE } from '../src/cro/sources'
import type { CroSource, CroMetric } from '../src/cro/sources'
import { firstPartyCroSource, CRO_FIRST_PARTY_PREFIXES } from '../src/cro/first-party'
import type { Env } from '../src/types'

const ENV = { TENANT_SLUG: 'mumega' } as unknown as Env

function source(key: string, over: Partial<CroSource> = {}): CroSource {
  return {
    key,
    label: key,
    available: async () => true,
    collect: async () => [{ metric_key: `${key}.signals`, value: 1, occurred_at: '2026-06-19T00:00:00Z' }],
    ...over,
  }
}

describe('collectFromSources — graceful degradation', () => {
  it('aggregates metrics from every available source, stamped with the source key', async () => {
    const res = await collectFromSources(ENV, [source('first_party'), source('posthog')])
    expect(res.metrics).toHaveLength(2)
    expect(res.metrics.map((m) => m.source).sort()).toEqual(['first_party', 'posthog'])
    expect(res.sources.every((s) => s.ok && s.available)).toBe(true)
  })

  it('SKIPS an unavailable source (not connected) without failing the sweep', async () => {
    const res = await collectFromSources(ENV, [
      source('first_party'),
      source('posthog', { available: async () => false }),
    ])
    expect(res.metrics).toHaveLength(1)
    expect(res.metrics[0].source).toBe('first_party')
    const ph = res.sources.find((s) => s.key === 'posthog')!
    expect(ph).toMatchObject({ available: false, ok: true, count: 0 })
  })

  it('a source whose collect() THROWS never aborts the others (degrades, records the error)', async () => {
    const res = await collectFromSources(ENV, [
      source('posthog', { collect: async () => { throw new Error('posthog 503') } }),
      source('first_party'),
    ])
    // first_party still collected despite posthog blowing up
    expect(res.metrics.map((m) => m.source)).toEqual(['first_party'])
    const ph = res.sources.find((s) => s.key === 'posthog')!
    expect(ph).toMatchObject({ available: true, ok: false, count: 0 })
    expect(ph.error).toContain('posthog 503')
  })

  it('a source whose available() THROWS is treated as not connected (never blocks)', async () => {
    const res = await collectFromSources(ENV, [
      source('crm', { available: async () => { throw new Error('auth check failed') } }),
      source('first_party'),
    ])
    expect(res.metrics.map((m) => m.source)).toEqual(['first_party'])
    expect(res.sources.find((s) => s.key === 'crm')).toMatchObject({ available: false, count: 0 })
  })

  it('drops poison points (NaN/∞ value, non-string key, missing timestamp) without failing the source', async () => {
    const dirty: CroMetric[] = [
      { metric_key: 'good.rate', value: 0.1, occurred_at: '2026-06-19T00:00:00Z' },
      { metric_key: 'bad.nan', value: NaN, occurred_at: '2026-06-19T00:00:00Z' },
      { metric_key: 'bad.inf', value: Infinity, occurred_at: '2026-06-19T00:00:00Z' },
      { metric_key: '', value: 1, occurred_at: '2026-06-19T00:00:00Z' },
      { metric_key: 'bad.nots', value: 1, occurred_at: '' },
    ]
    const res = await collectFromSources(ENV, [source('posthog', { collect: async () => dirty })])
    expect(res.metrics).toHaveLength(1)
    expect(res.metrics[0].metric_key).toBe('good.rate')
    expect(res.sources[0].count).toBe(1)
  })

  it('zero external sources still works — first-party-only is a valid fabric', async () => {
    const res = await collectFromSources(ENV, [source('first_party')])
    expect(res.metrics).toHaveLength(1)
    expect(res.sources).toHaveLength(1)
  })

  it('BLOCK-1: caps a source returning more than MAX_POINTS_PER_SOURCE (truncate + flag, never amplify)', async () => {
    const huge: CroMetric[] = Array.from({ length: MAX_POINTS_PER_SOURCE + 500 }, (_, i) => ({
      metric_key: `posthog.m${i}`,
      value: i,
      occurred_at: '2026-06-19T00:00:00Z',
    }))
    const res = await collectFromSources(ENV, [source('posthog', { collect: async () => huge })])
    expect(res.metrics).toHaveLength(MAX_POINTS_PER_SOURCE)
    expect(res.sources[0]).toMatchObject({ ok: true, count: MAX_POINTS_PER_SOURCE, capped: true })
  })

  it('BLOCK-1: a non-array return is rejected (ok:false), the sweep continues', async () => {
    const res = await collectFromSources(ENV, [
      // hostile adapter: returns an object instead of an array
      source('crm', { collect: async () => ({ not: 'an array' }) as unknown as CroMetric[] }),
      source('first_party'),
    ])
    expect(res.metrics.map((m) => m.source)).toEqual(['first_party'])
    const crm = res.sources.find((s) => s.key === 'crm')!
    expect(crm).toMatchObject({ available: true, ok: false, count: 0, error: 'non_array_return' })
  })
})

describe('firstPartyCroSource — the zero-cred floor', () => {
  function dbEnv(rows: Array<{ metric_key: string; value: number; occurred_at: string }>, capture?: (sql: string, binds: unknown[]) => void): Env {
    return {
      TENANT_SLUG: 'mumega',
      DB: {
        prepare(sql: string) {
          const binds: unknown[] = []
          const stmt = {
            bind(...args: unknown[]) {
              binds.push(...args)
              return stmt
            },
            async all() {
              capture?.(sql, binds)
              return { results: rows }
            },
          }
          return stmt
        },
      },
    } as unknown as Env
  }

  it('is always available (the floor needs no credential)', async () => {
    expect(await firstPartyCroSource.available(ENV)).toBe(true)
  })

  it('reads CRO-relevant metric_points for the pot and normalizes them', async () => {
    let seenSql = ''
    let seenBinds: unknown[] = []
    const env = dbEnv(
      [
        { metric_key: 'growth.signups', value: 12, occurred_at: '2026-06-19T01:00:00Z' },
        { metric_key: 'seo.clicks', value: 340, occurred_at: '2026-06-19T00:00:00Z' },
      ],
      (sql, binds) => { seenSql = sql; seenBinds = binds },
    )
    const out = await firstPartyCroSource.collect(env)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ metric_key: 'growth.signups', value: 12, occurred_at: '2026-06-19T01:00:00Z' })
    // tenant-scoped + prefix-bound (first bind is the tenant, then one LIKE bind per prefix)
    expect(seenSql).toContain('FROM metric_points')
    expect(seenBinds[0]).toBe('mumega')
    expect(seenBinds.slice(1)).toEqual(CRO_FIRST_PARTY_PREFIXES.map((p) => `${p}%`))
  })

  it('returns empty (never throws) when the pot has no tenant slug', async () => {
    const env = { TENANT_SLUG: '', DB: {} } as unknown as Env
    expect(await firstPartyCroSource.collect(env)).toEqual([])
  })

  it('filters malformed rows defensively', async () => {
    const env = dbEnv([
      { metric_key: 'growth.ok', value: 5, occurred_at: '2026-06-19T00:00:00Z' },
      { metric_key: 'growth.nan', value: NaN, occurred_at: '2026-06-19T00:00:00Z' },
    ])
    const out = await firstPartyCroSource.collect(env)
    expect(out).toHaveLength(1)
    expect(out[0].metric_key).toBe('growth.ok')
  })
})
