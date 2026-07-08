// tests/pulse.test.ts — pulse spine data layer (src/metrics/pulse.ts).
//
// Coverage:
//   - emitMetric: round-trip via readSeries; tenant isolation.
//   - emitMetric rejects: non-finite value, non-canonical occurred_at, oversized /
//     invalid metric_key, 0-row write receipt guard, UNIQUE collision → 'duplicate'.
//   - FIX-1: PK (id) collision on a DISTINCT tuple → throws, not 'duplicate'.
//   - FIX-2: assertIso rejects '', whitespace, bad month, bad second → ValidationError.
//   - FIX-3: aggregateOHLC handles large bucket without spread RangeError.
//   - FIX-4: negative-year / out-of-range ISO → ValidationError.
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
  READ_SERIES_LIMIT,
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

                // PK UNIQUE (id) — checked first, like SQLite does
                const pkDup = store.some((r) => r.id === id)
                if (pkDup) {
                  throw new Error('D1_ERROR: UNIQUE constraint failed: metric_points.id')
                }

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
              const matched = store.filter(
                (r) =>
                  r.tenant_id === tenantId &&
                  r.metric_key === metricKey &&
                  r.occurred_at >= fromISO &&
                  r.occurred_at <= toISO,
              )
              // ORDER BY occurred_at ASC
              matched.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))
              // Replicate LIMIT READ_SERIES_LIMIT + 1 (the sentinel query in readSeries).
              // Real D1 never returns more rows than the LIMIT clause; the mock must
              // honour the same cap so truncation detection works in tests.
              const results = matched.slice(0, READ_SERIES_LIMIT + 1)
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

    const { points: pts } = await readSeries(db, TENANT_A, KEY, T1, T1)
    expect(pts).toHaveLength(1)
    expect(pts[0]).toMatchObject({ id, tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T1, source: 'manual' })
  })

  it('returns points in occurred_at ASC order', async () => {
    const { db } = makeDb()
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 3, occurredAt: T3, source: 'connector' }, 'id3', CREATED)
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 1, occurredAt: T1, source: 'connector' }, 'id1', CREATED)
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 2, occurredAt: T2, source: 'connector' }, 'id2', CREATED)

    const { points: pts } = await readSeries(db, TENANT_A, KEY, T1, T3)
    expect(pts.map((p) => p.value)).toEqual([1, 2, 3])
  })
})

// ── Tenant isolation ─────────────────────────────────────────────────────────

describe('tenant isolation', () => {
  it('tenant A cannot see tenant B readings', async () => {
    const { db } = makeDb()
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 10, occurredAt: T1, source: 'manual' }, 'ida', CREATED)
    await emitMetric(db, { tenantId: TENANT_B, metricKey: KEY, value: 99, occurredAt: T1, source: 'manual' }, 'idb', CREATED)

    const { points: forA } = await readSeries(db, TENANT_A, KEY, T1, T1)
    const { points: forB } = await readSeries(db, TENANT_B, KEY, T1, T1)

    expect(forA).toHaveLength(1)
    expect(forA[0].value).toBe(10)
    expect(forB).toHaveLength(1)
    expect(forB[0].value).toBe(99)
  })

  it('readSeries with tenant B returns empty when only A has data', async () => {
    const { db } = makeDb()
    await emitMetric(db, { tenantId: TENANT_A, metricKey: KEY, value: 10, occurredAt: T1, source: 'manual' }, 'ida2', CREATED)
    const { points: pts } = await readSeries(db, TENANT_B, KEY, T1, T1)
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

    const { points: pts } = await readSeries(db, TENANT_A, KEY, T1, T_DAY2)
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

    const { points: pts } = await readSeries(db, TENANT_A, KEY, T1, T_DAY2)
    const buckets = aggregateOHLC(pts, { bucket: 'day' })
    expect(seriesShape(buckets)).toBe('bar')
  })
})

// ── FIX-1: PK collision on a DISTINCT tuple → must throw, not 'duplicate' ──────
//
// Regression: the old code mapped ANY "UNIQUE constraint failed" to 'duplicate',
// including PK (id) collisions where the TUPLE is different. A caller that
// generates a collision on `id` (e.g. UUID exhaustion, a bug, or an adversarial
// replay) would have silently lost a distinct reading.  The fix matches ONLY the
// composite ingest key; a PK violation rethrows.

describe('FIX-1 — PK (id) collision on distinct tuple must throw, not duplicate', () => {
  it('re-using the same id for a different tuple throws (not "duplicate")', async () => {
    const { db } = makeDb()
    const SHARED_ID = 'shared-id-001'
    // First insert — succeeds with id=SHARED_ID for tuple-A
    const first = await emitMetric(
      db,
      { tenantId: TENANT_A, metricKey: KEY, value: 1, occurredAt: T1, source: 'manual' },
      SHARED_ID,
      CREATED,
    )
    expect(first).toEqual({ ok: true, id: SHARED_ID })

    // Second insert — DIFFERENT tuple (T2 ≠ T1) but SAME id → PK collision → must throw
    await expect(
      emitMetric(
        db,
        { tenantId: TENANT_A, metricKey: KEY, value: 999, occurredAt: T2, source: 'manual' },
        SHARED_ID,   // same id as above
        CREATED,
      ),
    ).rejects.toThrow(/metric_points\.id/)
  })

  it('different id, same composite tuple → duplicate (composite-only collision path)', async () => {
    // Guard: identical tuple AND same id → the composite check wins (real D1 would
    // hit PK first, but since the mock checks PK first too, this is consistent).
    // For the idempotent-resend scenario (same everything) the caller uses a
    // deterministic id derived from the tuple, so both constraints fire together.
    // We test with the COMPOSITE-only path (different id, same tuple):
    const { db } = makeDb()
    const input = { tenantId: TENANT_A, metricKey: KEY, value: 5, occurredAt: T1, source: 'manual' }
    await emitMetric(db, input, 'id-first-2', CREATED)
    // Different id, same tuple → composite key collision → 'duplicate'
    const second = await emitMetric(db, input, 'id-second-2', CREATED)
    expect(second).toEqual({ ok: false, reason: 'duplicate' })
  })
})

// ── FIX-2: assertIso — unparseable inputs → ValidationError, not RangeError ────
//
// Regression: `new Date(v).toISOString()` throws a native RangeError for empty
// strings, whitespace, invalid month (13), invalid second (61), 'not-a-date', etc.
// The prior code had no guard, so those inputs would surface as a 500 rather than
// the documented validation_error.

describe('FIX-2 — assertIso rejects all bad inputs with ValidationError, not RangeError', () => {
  const base = { tenantId: TENANT_A, metricKey: KEY, value: 5, source: 'manual' }

  describe('occurredAt field', () => {
    it('rejects empty string', async () => {
      const { db } = makeDb()
      const err = await emitMetric(db, { ...base, occurredAt: '' }, 'id', CREATED).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/occurred_at/)
      // Must NOT be a native RangeError from toISOString()
      expect((err as Error).constructor.name).not.toBe('RangeError')
    })

    it('rejects whitespace-only string', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, occurredAt: '   ' }, 'id', CREATED)).rejects.toThrow(/occurred_at/)
    })

    it('rejects invalid month (13)', async () => {
      const { db } = makeDb()
      await expect(
        emitMetric(db, { ...base, occurredAt: '2026-13-01T00:00:00.000Z' }, 'id', CREATED),
      ).rejects.toThrow(/occurred_at/)
    })

    it('rejects invalid second (61)', async () => {
      const { db } = makeDb()
      await expect(
        emitMetric(db, { ...base, occurredAt: '2026-06-17T00:00:61.000Z' }, 'id', CREATED),
      ).rejects.toThrow(/occurred_at/)
    })

    it('rejects "not-a-date"', async () => {
      const { db } = makeDb()
      await expect(
        emitMetric(db, { ...base, occurredAt: 'not-a-date' }, 'id', CREATED),
      ).rejects.toThrow(/occurred_at/)
    })
  })

  describe('createdAt field', () => {
    it('rejects empty string', async () => {
      const { db } = makeDb()
      const err = await emitMetric(db, { ...base, occurredAt: T1 }, 'id', '').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/created_at/)
      expect((err as Error).constructor.name).not.toBe('RangeError')
    })

    it('rejects whitespace-only createdAt', async () => {
      const { db } = makeDb()
      await expect(emitMetric(db, { ...base, occurredAt: T1 }, 'id', '   ')).rejects.toThrow(/created_at/)
    })

    it('rejects invalid month (13) in createdAt', async () => {
      const { db } = makeDb()
      await expect(
        emitMetric(db, { ...base, occurredAt: T1 }, 'id', '2026-13-01T00:00:00.000Z'),
      ).rejects.toThrow(/created_at/)
    })

    it('rejects invalid second (61) in createdAt', async () => {
      const { db } = makeDb()
      await expect(
        emitMetric(db, { ...base, occurredAt: T1 }, 'id', '2026-06-17T00:00:61.000Z'),
      ).rejects.toThrow(/created_at/)
    })
  })
})

// ── FIX-3: aggregateOHLC handles large buckets without spread RangeError ────────
//
// Regression: Math.max(...values) / Math.min(...values) throw "Maximum call stack
// exceeded" at ~120k+ arguments (all fed as individual function args via spread).
// The fix uses reduce-based min/max which handles any array length.

describe('FIX-3 — aggregateOHLC does not crash on large bucket (reduce-based min/max)', () => {
  it('handles 5 000 readings in a single day without throwing', () => {
    // Build 5000 readings all on the same UTC day.
    // Values alternate high/low so we can verify correct min/max.
    const N = 5_000
    const rows: Array<{ value: number; occurredAt: string }> = []
    for (let i = 0; i < N; i++) {
      // Use a zero-padded second to stay within one day (00:00:00 – 01:23:19)
      const hh = String(Math.floor(i / 3600)).padStart(2, '0')
      const mm = String(Math.floor((i % 3600) / 60)).padStart(2, '0')
      const ss = String(i % 60).padStart(2, '0')
      rows.push({ value: i, occurredAt: `2026-06-17T${hh}:${mm}:${ss}.000Z` })
    }

    let buckets: ReturnType<typeof aggregateOHLC>
    // Must NOT throw
    expect(() => {
      buckets = aggregateOHLC(rows, { bucket: 'day' })
    }).not.toThrow()

    expect(buckets!).toHaveLength(1)
    const b = buckets![0]
    expect(b.date).toBe('2026-06-17')
    expect(b.count).toBe(N)
    expect(b.open).toBe(0)       // first reading value=0
    expect(b.close).toBe(N - 1) // last reading value=N-1
    expect(b.high).toBe(N - 1)  // max value = N-1
    expect(b.low).toBe(0)       // min value = 0
  })
})

// ── FIX-4: negative-year and out-of-range ISO → ValidationError ─────────────────
//
// Regression: '-000001-06-17T00:00:00.000Z' passes the round-trip check (JS Date
// handles it and toISOString() emits the same string) but aggregateOHLC slices
// occurredAt.slice(0,10) → '-000' which is a malformed bucket key corrupting the
// candlestick series.  The year range guard [2000, 2200] in assertIso blocks this.

describe('FIX-4 — negative-year and out-of-range ISO rejected with ValidationError', () => {
  const base = { tenantId: TENANT_A, metricKey: KEY, value: 5, source: 'manual' }

  it('rejects negative-year occurredAt', async () => {
    const { db } = makeDb()
    // Note: '-000001-06-17T00:00:00.000Z' is a valid ECMAScript ISO extended date
    // that passes round-trip but has year=-1 which we ban.
    await expect(
      emitMetric(db, { ...base, occurredAt: '-000001-06-17T00:00:00.000Z' }, 'id', CREATED),
    ).rejects.toThrow(/occurred_at/)
  })

  it('rejects year 1999 (below MIN_YEAR=2000) in occurredAt', async () => {
    const { db } = makeDb()
    await expect(
      emitMetric(db, { ...base, occurredAt: '1999-12-31T23:59:59.999Z' }, 'id', CREATED),
    ).rejects.toThrow(/occurred_at/)
  })

  it('rejects year 2201 (above MAX_YEAR=2200) in occurredAt', async () => {
    const { db } = makeDb()
    await expect(
      emitMetric(db, { ...base, occurredAt: '2201-01-01T00:00:00.000Z' }, 'id', CREATED),
    ).rejects.toThrow(/occurred_at/)
  })

  it('rejects negative-year createdAt', async () => {
    const { db } = makeDb()
    await expect(
      emitMetric(db, { ...base, occurredAt: T1 }, 'id', '-000001-06-17T00:00:00.000Z'),
    ).rejects.toThrow(/created_at/)
  })

  it('accepts a normal in-range year (boundary: 2000)', async () => {
    const { db } = makeDb()
    await expect(
      emitMetric(
        db,
        { ...base, occurredAt: '2000-01-01T00:00:00.000Z' },
        'id-y2k',
        '2000-01-01T00:00:00.000Z',
      ),
    ).resolves.toMatchObject({ ok: true })
  })

  it('accepts a normal in-range year (boundary: 2200)', async () => {
    const { db } = makeDb()
    await expect(
      emitMetric(
        db,
        { ...base, occurredAt: '2200-12-31T23:59:59.999Z' },
        'id-y2200',
        '2200-12-31T23:59:59.999Z',
      ),
    ).resolves.toMatchObject({ ok: true })
  })
})

// ── FIX-A: readSeries truncation detection (data-honesty invariant) ────────────
//
// Invariant: if a tenant+metric window contains more than READ_SERIES_LIMIT
// readings, returning exactly READ_SERIES_LIMIT rows silently drops the newest
// ones — the final day's OHLC would be computed over a PARTIAL day and the
// seriesShape would still say 'candle' with no signal that the window is capped.
//
// Fix: query LIMIT + 1; if more than READ_SERIES_LIMIT rows come back, set
// `truncated = true` and drop the sentinel row. Callers must check this flag
// before presenting the trailing bucket as a complete candle.

describe('FIX-A — readSeries truncation detection (>READ_SERIES_LIMIT rows in window)', () => {
  it('truncated === false when readings fit within the cap', async () => {
    const { db } = makeDb()
    // Insert fewer than READ_SERIES_LIMIT readings
    await emitMetric(
      db,
      { tenantId: TENANT_A, metricKey: KEY, value: 1, occurredAt: T1, source: 'manual' },
      'trunc-small-1',
      CREATED,
    )
    await emitMetric(
      db,
      { tenantId: TENANT_A, metricKey: KEY, value: 2, occurredAt: T2, source: 'manual' },
      'trunc-small-2',
      CREATED,
    )
    const result = await readSeries(db, TENANT_A, KEY, T1, T2)
    expect(result.truncated).toBe(false)
    expect(result.points).toHaveLength(2)
  })

  it('truncated === true when window exceeds READ_SERIES_LIMIT; points capped at limit', async () => {
    // Build READ_SERIES_LIMIT + 1 readings spread across seconds of a single day.
    // Generating 10 001 unique ISO timestamps: 2026-06-17T00:00:00.000Z through
    // 2026-06-17T02:46:40.000Z (10 001 seconds apart at 1s spacing).
    const N = READ_SERIES_LIMIT + 1 // 10 001
    const { db } = makeDb()
    const baseMs = new Date('2026-06-17T00:00:00.000Z').getTime()

    for (let i = 0; i < N; i++) {
      const occurredAt = new Date(baseMs + i * 1000).toISOString()
      await emitMetric(
        db,
        { tenantId: TENANT_A, metricKey: 'growth.trunctest', value: i, occurredAt, source: 'test' },
        `trunc-id-${i}`,
        CREATED,
      )
    }

    // Window spans the full day; all 10 001 readings fall within it.
    // T1 = 08:00 so we use midnight as fromISO to capture rows that start at 00:00.
    const result = await readSeries(db, TENANT_A, 'growth.trunctest', '2026-06-17T00:00:00.000Z', '2026-06-17T23:59:59.999Z')

    // Data-honesty invariant: truncated must be true, not silently capped
    expect(result.truncated).toBe(true)
    // Points are capped at READ_SERIES_LIMIT (sentinel row dropped)
    expect(result.points).toHaveLength(READ_SERIES_LIMIT)
    // Points are the FIRST READ_SERIES_LIMIT readings (oldest), ordered ASC
    expect(result.points[0].value).toBe(0)
    expect(result.points[READ_SERIES_LIMIT - 1].value).toBe(READ_SERIES_LIMIT - 1)
  }, 15_000)
})
