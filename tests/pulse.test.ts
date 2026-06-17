// tests/pulse.test.ts — pulse spine data layer (src/metrics/pulse.ts).
//
// Coverage:
//   - emitMetric: round-trip via readSeries; tenant isolation.
//   - emitMetric rejects: non-finite value, non-canonical occurred_at, oversized /
//     invalid metric_key, 0-row write receipt guard, UNIQUE collision → 'duplicate'.
//   - aggregateOHLC: multi-reading day (real OHLC); single-reading day (O==H==L==C).
//   - seriesShape: any day with count>=2 → 'candle'; all single-reading → 'bar'.
//
// Mock DB design: matches the real D1 API shape (prepare().bind().run() / .all()).
// An in-memory store keyed by (tenant_id, metric_key, occurred_at, source) replicates
// the UNIQUE constraint behavior. assertWritten is exercised by returning changes=0
// on a simulated 0-row write so the receipt guard fires.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  emitMetric,
  readSeries,
  aggregateOHLC,
  seriesShape,
  type MetricPoint,
  type OHLCBucket,
} from '../src/metrics/pulse'
import type { D1Database } from '@cloudflare/workers-types'

// ── In-memory D1 mock ────────────────────────────────────────────────────────

interface StoredRow {
  id: string
  tenant_id: string
  metric_key: string
  value: number
  occurred_at: string
  source: string
  created_at: string
}

function makeDb(opts: { phantomZeroOnInsert?: boolean } = {}): {
  db: D1Database
  rows: () => StoredRow[]
} {
  const store: StoredRow[] = []

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            // INSERT path
            async run() {
              const isInsert = sql.trim().toUpperCase().startsWith('INSERT')
              if (isInsert) {
                // args: id, tenant_id, metric_key, value, occurred_at, source, created_at
                const [id, tenant_id, metric_key, value, occurred_at, source, created_at] =
                  args as [string, string, string, number, string, string, string]

                // UNIQUE(tenant_id, metric_key, occurred_at, source) — throw like real D1
                const dup = store.some(
                  (r) =>
                    r.tenant_id === tenant_id &&
                    r.metric_key === metric_key &&
                    r.occurred_at === occurred_at &&
                    r.source === source,
                )
                if (dup) {
                  throw new Error('D1_ERROR: UNIQUE constraint failed: metric_points.tenant_id, metric_points.metric_key, metric_points.occurred_at, metric_points.source')
                }

                // phantomZeroOnInsert: simulate a non-dup insert where D1 reports
                // success=true but changes=0 (the phantom-success scenario the
                // write-receipt guard defends against). Row is NOT added to store.
                if (opts.phantomZeroOnInsert) {
                  return { success: true, meta: { changes: 0 } }
                }

                store.push({ id, tenant_id, metric_key, value, occurred_at, source, created_at })
                return { success: true, meta: { changes: 1 } }
              }
              return { success: true, meta: { changes: 0 } }
            },
            // SELECT path
            async all() {
              // args for readSeries: tenantId, metricKey, fromISO, toISO
              const [tenantId, metricKey, fromISO, toISO] = args as [
                string,
                string,
                string,
                string,
              ]
              const results = store.filter(
                (r) =>
                  r.tenant_id === tenantId &&
                  r.metric_key === metricKey &&
                  r.occurred_at >= fromISO &&
                  r.occurred_at <= toISO,
              )
              // ORDER BY occurred_at ASC
              results.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
              return { results, success: true, meta: { rows_read: results.length } }
            },
          }
        },
      }
    },
  } as unknown as D1Database

  return { db, rows: () => [...store] }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TENANT_A = 'tenant-alpha'
const TENANT_B = 'tenant-beta'
const KEY = 'growth.leads'
const T1 = '2026-06-17T08:00:00.000Z'
const T2 = '2026-06-17T14:00:00.000Z'
const T3 = '2026-06-17T20:00:00.000Z'
const T_DAY2 = '2026-06-18T09:00:00.000Z'
const CREATED = '2026-06-17T00:00:00.000Z'

// ── emitMetric + readSeries round-trip ───────────────────────────────────────

describe('emitMetric + readSeries round-trip', () => {
  it('inserts a reading and reads it back', async () => {
    const { db } = makeDb()
    const id = 'abc123'
    const out = await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T1, source: 'manual' }, id, CREATED)
    expect(out).toEqual({ ok: true, id })

    const pts = await readSeries(db, TENANT_A, KEY, T1, T1)
    expect(pts).toHaveLength(1)
    expect(pts[0]).toMatchObject({ id, tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T1, source: 'manual' })
  })

  it('returns points in occurred_at ASC order', async () => {
    const { db } = makeDb()
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 3, occurredAt: T3, source: 'connector' }, 'id3', CREATED)
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 1, occurredAt: T1, source: 'connector' }, 'id1', CREATED)
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 2, occurredAt: T2, source: 'connector' }, 'id2', CREATED)

    const pts = await readSeries(db, TENANT_A, KEY, T1, T3)
    expect(pts.map((p) => p.value)).toEqual([1, 2, 3])
  })
})

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('tenant A cannot see tenant B readings', async () => {
    const { db } = makeDb()
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 10, occurredAt: T1, source: 'manual' }, 'ida', CREATED)
    await emitMetric(db, { tenantId: TENANT_B, metricKey: KEY, value: 99, occurredAt: T1, source: 'manual' }, 'idb', CREATED)

    const forA = await readSeries(db, TENANT_A, KEY, T1, T1)
    const forB = await readSeries(db, TENANT_B, KEY, T1, T1)

    expect(forA).toHaveLength(1)
    expect(forA[0].value).toBe(10)
    expect(forB).toHaveLength(1)
    expect(forB[0].value).toBe(99)
  })

  it('readSeries with tenant B returns empty when only A has data', async () => {
    const { db } = makeDb()
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 10, occurredAt: T1, source: 'manual' }, 'ida2', CREATED)
    const pts = await readSeries(db, TENANT_B, KEY, T1, T1)
    expect(pts).toHaveLength(0)
  })
})

// ── emitMetric: UNIQUE collision → 'duplicate' ──────────────────────────────

describe('emitMetric — UNIQUE collision', () => {
  it('returns { ok: false, reason: "duplicate" } on same tenant+key+time+source', async () => {
    const { db } = makeDb()
    const input = { tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T1, source: 'manual' }
    const first = await emitMetric(db, input, 'id-first', CREATED)
    expect(first.ok).toBe(true)

    const second = await emitMetric(db, input, 'id-second', CREATED)
    expect(second).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('does NOT throw on duplicate — clean outcome only', async () => {
    const { db } = makeDb()
    const input = { tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T1, source: 'manual' }
    await emitMetric(db, input, 'id-x', CREATED)
    // second call must resolve (not reject)
    await expect(emitMetric(db, input, 'id-y', CREATED)).resolves.toEqual({ ok: false, reason: 'duplicate' })
  })
})

// ── emitMetric: write-receipt guard (0-row write → throw) ───────────────────

describe('emitMetric — receipt guard', () => {
  it('throws receipt_failed when DB writes 0 rows (phantom success — non-duplicate insert)', async () => {
    // phantomZeroOnInsert: the mock simulates D1 reporting success=true + changes=0
    // on a fresh (non-duplicate) insert. This is the phantom-success scenario the
    // write-receipt guard (#186) defends against.
    const { db } = makeDb({ phantomZeroOnInsert: true })
    await expect(
      emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 1, occurredAt: T1, source: 'brain' }, 'new-id', CREATED),
    ).rejects.toThrow(/receipt_failed/)
  })
})

// ── emitMetric: input validation guards ─────────────────────────────────────

describe('emitMetric — input validation', () => {
  const base = { tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T1, source: 'manual' }

  describe('value: non-finite rejected', () => {
    it('rejects NaN', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, value: NaN }, 'id', CREATED)).rejects.toThrow(/value.*finite/)
    })
    it('rejects Infinity', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, value: Infinity }, 'id', CREATED)).rejects.toThrow(/value.*finite/)
    })
    it('rejects -Infinity', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, value: -Infinity }, 'id', CREATED)).rejects.toThrow(/value.*finite/)
    })
    it('accepts 0 and negative finite values', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, value: 0 }, 'id0', CREATED)).resolves.toMatchObject({ ok: true })
      await expect(emitMetric(db, { ...base, value: -5.5, occurredAt: T2 }, 'id1', CREATED)).resolves.toMatchObject({ ok: true })
    })
  })

  describe('occurredAt: non-canonical ISO rejected', () => {
    it('rejects a date-only string', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, occurredAt: '2026-06-17' }, 'id', CREATED)).rejects.toThrow(/occurred_at.*ISO/)
    })
    it('rejects a non-UTC timestamp', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, occurredAt: '2026-06-17T08:00:00+05:30' }, 'id', CREATED)).rejects.toThrow(/occurred_at.*ISO/)
    })
    it('accepts a strict Z-terminated ISO timestamp', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, occurredAt: '2026-06-17T08:00:00.000Z' }, 'id', CREATED)).resolves.toMatchObject({ ok: true })
    })
  })

  describe('createdAt: non-canonical ISO rejected', () => {
    it('rejects non-canonical createdAt', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, base, 'id', '2026-06-17')).rejects.toThrow(/created_at.*ISO/)
    })
  })

  describe('metricKey: charset + length', () => {
    it('rejects uppercase characters', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, metricKey: 'Growth.Leads' }, 'id', CREATED)).rejects.toThrow(/metric_key/)
    })
    it('rejects spaces', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, metricKey: 'growth leads' }, 'id', CREATED)).rejects.toThrow(/metric_key/)
    })
    it('rejects empty string', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, metricKey: '' }, 'id', CREATED)).rejects.toThrow(/metric_key/)
    })
    it('rejects a key longer than 64 chars', async () => {
      const { db } = makeDb()
      const long = 'a'.repeat(65)
      await expect(emitMetric(db, { ...base, metricKey: long }, 'id', CREATED)).rejects.toThrow(/metric_key/)
    })
    it('accepts valid keys with dots and underscores', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, metricKey: 'growth.leads_7d' }, 'id', CREATED)).resolves.toMatchObject({ ok: true })
    })
    it('accepts exactly 64-char key', async () => {
      const { db } = makeDb()
      const k64 = 'a'.repeat(64)
      await expect(emitMetric(db, { ...base, metricKey: k64 }, 'id64', CREATED)).resolves.toMatchObject({ ok: true })
    })
  })

  describe('source: length bounds', () => {
    it('rejects empty source', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, source: '' }, 'id', CREATED)).rejects.toThrow(/source/)
    })
    it('rejects source longer than 64 chars', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, source: 'x'.repeat(65) }, 'id', CREATED)).rejects.toThrow(/source/)
    })
    it('accepts source of exactly 64 chars', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, source: 'x'.repeat(64) }, 'id-src64', CREATED)).resolves.toMatchObject({ ok: true })
    })
  })
})

// ── aggregateOHLC ─────────────────────────────────────────────────────────────

describe('aggregateOHLC', () => {
  it('single reading: O == H == L == C, count = 1', () => {
    const rows = [{ value: 42, occurredAt: T1 }]
    const [b] = aggregateOHLC(rows, { bucket: 'day' })
    expect(b.open).toBe(42)
    expect(b.high).toBe(42)
    expect(b.low).toBe(42)
    expect(b.close).toBe(42)
    expect(b.count).toBe(1)
    expect(b.date).toBe('2026-06-17')
  })

  it('multi-reading day: real distinct O/H/L/C + count', () => {
    // T1=8am(5), T2=2pm(15), T3=8pm(3) — open=5, high=15, low=3, close=3
    const rows = [
      { value: 5, occurredAt: T1 },
      { value: 15, occurredAt: T2 },
      { value: 3, occurredAt: T3 },
    ]
    const [b] = aggregateOHLC(rows, { bucket: 'day' })
    expect(b.open).toBe(5)
    expect(b.high).toBe(15)
    expect(b.low).toBe(3)
    expect(b.close).toBe(3)
    expect(b.count).toBe(3)
  })

  it('two days bucketed separately', () => {
    const rows = [
      { value: 10, occurredAt: T1 },      // day 1
      { value: 20, occurredAt: T2 },      // day 1
      { value: 5, occurredAt: T_DAY2 },   // day 2
    ]
    const buckets = aggregateOHLC(rows, { bucket: 'day' })
    expect(buckets).toHaveLength(2)
    expect(buckets[0].date).toBe('2026-06-17')
    expect(buckets[0].count).toBe(2)
    expect(buckets[1].date).toBe('2026-06-18')
    expect(buckets[1].count).toBe(1)
  })

  it('empty input → empty output', () => {
    expect(aggregateOHLC([], { bucket: 'day' })).toEqual([])
  })

  it('output is sorted by date ASC', () => {
    // insert in reverse order to ensure sorting is applied
    const rows = [
      { value: 5, occurredAt: T_DAY2 },   // day 2 first
      { value: 10, occurredAt: T1 },      // day 1 second
    ]
    const buckets = aggregateOHLC(rows, { bucket: 'day' })
    expect(buckets[0].date).toBe('2026-06-17')
    expect(buckets[1].date).toBe('2026-06-18')
  })

  it('open = first reading by time; close = last reading by time', () => {
    // Already sorted by occurred_at (as readSeries would deliver)
    const rows = [
      { value: 100, occurredAt: '2026-06-17T06:00:00.000Z' },
      { value: 200, occurredAt: '2026-06-17T12:00:00.000Z' },
      { value: 150, occurredAt: '2026-06-17T18:00:00.000Z' },
    ]
    const [b] = aggregateOHLC(rows, { bucket: 'day' })
    expect(b.open).toBe(100)  // first
    expect(b.close).toBe(150) // last
    expect(b.high).toBe(200)
    expect(b.low).toBe(100)
  })
})

// ── seriesShape ───────────────────────────────────────────────────────────────

describe('seriesShape', () => {
  it('returns "candle" when at least one day has count >= 2', () => {
    const buckets: OHLCBucket[] = [
      { date: '2026-06-17', open: 1, high: 2, low: 1, close: 2, count: 2 },
      { date: '2026-06-18', open: 3, high: 3, low: 3, close: 3, count: 1 },
    ]
    expect(seriesShape(buckets)).toBe('candle')
  })

  it('returns "bar" when ALL days have count = 1 (daily scalar — no fake candle)', () => {
    const buckets: OHLCBucket[] = [
      { date: '2026-06-17', open: 10, high: 10, low: 10, close: 10, count: 1 },
      { date: '2026-06-18', open: 12, high: 12, low: 12, close: 12, count: 1 },
    ]
    expect(seriesShape(buckets)).toBe('bar')
  })

  it('returns "bar" for an empty series', () => {
    expect(seriesShape([])).toBe('bar')
  })

  it('returns "candle" when every day has count >= 2', () => {
    const buckets: OHLCBucket[] = [
      { date: '2026-06-17', open: 1, high: 5, low: 1, close: 5, count: 4 },
      { date: '2026-06-18', open: 2, high: 7, low: 2, close: 7, count: 3 },
    ]
    expect(seriesShape(buckets)).toBe('candle')
  })

  it('returns "candle" even if only ONE day of many has count >= 2', () => {
    const buckets: OHLCBucket[] = [
      { date: '2026-06-15', open: 1, high: 1, low: 1, close: 1, count: 1 },
      { date: '2026-06-16', open: 2, high: 3, low: 2, close: 3, count: 2 }, // the one with range
      { date: '2026-06-17', open: 4, high: 4, low: 4, close: 4, count: 1 },
    ]
    expect(seriesShape(buckets)).toBe('candle')
  })
})

// ── Integration: emit multiple points → aggregate → shape ────────────────────

describe('integration: emit → read → aggregate → shape', () => {
  it('multiple intraday readings → candle; single daily → bar', async () => {
    const { db } = makeDb()

    // Day 1: 3 readings (should yield candle-eligible)
    for (const [i, ts] of [[0, T1], [1, T2], [2, T3]] as [number, string][]) {
      await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: (i + 1) * 10, occurredAt: ts, source: 'connector' }, `day1-${i}`, CREATED)
    }
    // Day 2: 1 reading (daily scalar)
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T_DAY2, source: 'connector' }, 'day2-0', CREATED)

    const pts = await readSeries(db, TENANT_A, KEY, T1, T_DAY2)
    const buckets = aggregateOHLC(pts, { bucket: 'day' })
    const shape = seriesShape(buckets)

    expect(buckets).toHaveLength(2)
    expect(buckets[0].count).toBe(3) // day 1: real OHLC
    expect(buckets[1].count).toBe(1) // day 2: scalar
    expect(shape).toBe('candle')     // candle because day 1 qualifies
  })

  it('all single-reading days → bar (fake-candle guard)', async () => {
    const { db } = makeDb()
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 10, occurredAt: T1, source: 'manual' }, 'x1', CREATED)
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 20, occurredAt: T_DAY2, source: 'manual' }, 'x2', CREATED)

    const pts = await readSeries(db, TENANT_A, KEY, T1, T_DAY2)
    const buckets = aggregateOHLC(pts, { bucket: 'day' })
    expect(seriesShape(buckets)).toBe('bar')
  })
})
