// mupot — pulse spine: metric_points ingest + OHLC aggregation.
//
// This is the data-layer kernel for the candlestick "pulse" described in
// console-department-microkernel.md §4. Department modules (Growth, Finance, Ops…)
// and connectors call emitMetric() to write timestamped readings. The console reads
// via readSeries() → aggregateOHLC() → seriesShape().
//
// Key invariants (enforced here, verified in tests):
//   - tenant_id is ALWAYS bound in SQL, never derived from a metric-row field.
//   - emitMetric() uses the write-receipt guard (assertWritten) — no phantom success.
//   - ONLY composite ingest-key collisions (tenant_id,metric_key,occurred_at,source)
//     → 'duplicate'. PK (id) or any other UNIQUE failure → rethrow (distinct reading
//     must not be silently dropped).
//   - aggregateOHLC is PURE (no I/O, no side-effects; inject timestamps, not Date.now).
//   - seriesShape refuses to label a single-reading-per-day series 'candle'.
//
// Cross-cutting discipline (from the molt gate / S184 adversarial findings):
//   - value: non-finite rejected at call site.
//   - occurred_at / createdAt: strict-canonical ISO (v === new Date(v).toISOString()).
//   - metricKey: <=64 chars, [a-z0-9._] charset, non-empty.
//   - source: bounded <=64, non-empty.
//   - All guards throw descriptive ValidationError before any DB call.

import type { D1Database } from '@cloudflare/workers-types'
import { assertWritten } from '../lib/receipt'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetricPoint {
  id: string
  tenantId: string
  metricKey: string
  value: number
  occurredAt: string
  source: string
  createdAt: string
}

export interface EmitInput {
  tenantId: string
  metricKey: string
  value: number
  occurredAt: string  // strict ISO 8601 (e.g. "2026-06-17T14:32:00.000Z")
  source: string
}

export type EmitOutcome = { ok: true; id: string } | { ok: false; reason: 'duplicate' }

export interface OHLCBucket {
  date: string    // YYYY-MM-DD (UTC)
  open: number    // value at first occurred_at of the day
  high: number
  low: number
  close: number   // value at last occurred_at of the day
  count: number   // number of readings in the day (>= 2 → real intraday range)
}

export type SeriesShape = 'candle' | 'bar'

// ── Validation helpers ────────────────────────────────────────────────────────

const METRIC_KEY_RE = /^[a-z0-9._]+$/
const MAX_KEY_LEN = 64
const MAX_SOURCE_LEN = 64

// FIX-4: year range guard for assertIso — negative-year and far-future ISO strings
// round-trip perfectly but produce malformed day-buckets (e.g. '-000001-06-17' sliced
// to '-000' as the date prefix). Restrict to [2000, 2200].
const MIN_YEAR = 2000
const MAX_YEAR = 2200

class ValidationError extends Error {
  readonly code = 'validation_error'
  constructor(field: string, reason: string) {
    super(`metric_points.${field}: ${reason}`)
  }
}

/**
 * Strict ISO 8601 round-trip + sanity guards.
 *
 * FIX-2: `new Date(v).toISOString()` itself throws a RangeError for empty strings,
 * whitespace, invalid month/second, 'not-a-date', etc.  We guard with getTime()
 * first so ALL bad inputs produce a ValidationError (not a raw RangeError → 500).
 *
 * FIX-4: Negative-year ISO timestamps round-trip correctly but `.slice(0,10)` in
 * aggregateOHLC would produce a malformed bucket key.  We reject years outside
 * [MIN_YEAR, MAX_YEAR].
 */
function assertIso(v: string, field: string): void {
  let date: Date
  try {
    date = new Date(v)
  } catch {
    throw new ValidationError(field, `unparseable timestamp (got "${v}")`)
  }
  if (isNaN(date.getTime())) {
    throw new ValidationError(field, `unparseable/non-canonical timestamp (got "${v}")`)
  }
  // Round-trip check: only strict canonical forms (e.g. "…Z" with milliseconds) pass
  let canonical: string
  try {
    canonical = date.toISOString()
  } catch {
    throw new ValidationError(field, `unparseable/non-canonical timestamp (got "${v}")`)
  }
  if (v !== canonical) {
    throw new ValidationError(field, `not strict-canonical ISO 8601 (got "${v}")`)
  }
  // Year range guard (FIX-4)
  const year = date.getUTCFullYear()
  if (year < MIN_YEAR || year > MAX_YEAR) {
    throw new ValidationError(
      field,
      `year ${year} out of allowed range [${MIN_YEAR}, ${MAX_YEAR}] (got "${v}")`,
    )
  }
}

function assertMetricKey(key: string): void {
  if (!key || key.length > MAX_KEY_LEN) {
    throw new ValidationError('metric_key', `must be 1–${MAX_KEY_LEN} chars (got ${key.length})`)
  }
  if (!METRIC_KEY_RE.test(key)) {
    throw new ValidationError('metric_key', `must match [a-z0-9._]+ (got "${key}")`)
  }
}

function assertSource(source: string): void {
  if (!source || source.length > MAX_SOURCE_LEN) {
    throw new ValidationError('source', `must be 1–${MAX_SOURCE_LEN} chars (got ${source.length})`)
  }
}

function assertFiniteValue(value: number): void {
  if (!Number.isFinite(value)) {
    throw new ValidationError('value', `must be finite (got ${value})`)
  }
}

// ── emitMetric ────────────────────────────────────────────────────────────────

/**
 * Insert one metric reading into `metric_points`.
 *
 * Tenant isolation: tenant_id is bound from `input.tenantId` (the trusted caller
 * param), never from the wider context object or any metric-row field. The SQL
 * binds it explicitly at position $1.
 *
 * Receipt guard: assertWritten() throws receipt_failed if D1 acknowledges 0 rows
 * (phantom-success protection, #186). UNIQUE collision (same tenant+key+time+source)
 * is caught as 'duplicate' — a clean outcome, not a 500.
 *
 * Timestamps: `createdAt` is injected by the caller (no Date.now inside this fn).
 */
export async function emitMetric(
  db: D1Database,
  input: EmitInput,
  id: string,       // caller-generated ID (e.g. crypto.randomUUID())
  createdAt: string // strict ISO, injected — no Date.now() inside
): Promise<EmitOutcome> {
  // ── Input discipline (baked in per adversarial gate findings) ──────────────
  assertFiniteValue(input.value)
  assertIso(input.occurredAt, 'occurred_at')
  assertIso(createdAt, 'created_at')
  assertMetricKey(input.metricKey)
  assertSource(input.source)

  // ── Write with receipt guard ──────────────────────────────────────────────
  // Plain INSERT — no ON CONFLICT DO NOTHING. Rationale: D1's `changes` field
  // cannot distinguish a UNIQUE collision (changes=0) from a phantom-success bug
  // (also changes=0). By letting the UNIQUE constraint throw, we get a clean
  // separation: a D1 constraint error → 'duplicate'; changes=0 with no error →
  // the real phantom (receipt guard fires). This is the correct layering.
  const sql = `
    INSERT INTO metric_points (id, tenant_id, metric_key, value, occurred_at, source, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `

  let result: { success?: boolean; meta?: { changes?: number; rows_written?: number } }
  try {
    result = await db
      .prepare(sql)
      .bind(
        id,
        input.tenantId,  // bound from the trusted param, never from row
        input.metricKey,
        input.value,
        input.occurredAt,
        input.source,
        createdAt,
      )
      .run()
  } catch (err: unknown) {
    // FIX-1: Only the composite ingest key (tenant_id, metric_key, occurred_at, source)
    // is a safe idempotent duplicate — the SAME reading being re-submitted.  A PK (id)
    // collision or any other/unknown UNIQUE violation means a DISTINCT reading was about
    // to be dropped; that must not be silently mapped to 'duplicate'.
    //
    // SQLite/D1 names the offending columns in the message, e.g.:
    //   "UNIQUE constraint failed: metric_points.tenant_id, metric_points.metric_key,
    //    metric_points.occurred_at, metric_points.source"
    // vs a PK collision:
    //   "UNIQUE constraint failed: metric_points.id"
    //
    // We match only the exact composite set; anything else is rethrown.
    const msg = err instanceof Error ? err.message : String(err)
    const COMPOSITE_UNIQUE_PATTERN =
      /UNIQUE constraint failed:\s*metric_points\.tenant_id,\s*metric_points\.metric_key,\s*metric_points\.occurred_at,\s*metric_points\.source/
    if (COMPOSITE_UNIQUE_PATTERN.test(msg)) {
      return { ok: false, reason: 'duplicate' }
    }
    throw err // PK collision, other UNIQUE, or any non-constraint error — fail hard
  }

  // assertWritten throws receipt_failed if D1 acknowledged 0 rows without an error
  // (the phantom-success scenario — a write that silently vanished).
  assertWritten(result, 'metric_points.insert')

  return { ok: true, id }
}

// ── readSeries ────────────────────────────────────────────────────────────────

// FIX-3: Cap rows returned by readSeries so aggregateOHLC's reduce-based min/max
// never receives an unbounded array.  10 000 rows ≈ 27 readings/day over a full year —
// a defensible upper bound for dashboard charting.  Callers needing bulk export must
// page themselves.
//
// DATA-HONESTY INVARIANT (truncation contract):
//   readSeries queries LIMIT + 1 rows as a sentinel.  If the DB returns more than
//   READ_SERIES_LIMIT rows the window is larger than the cap — the trailing bucket
//   is computed over a partial day and MUST NOT be presented as a complete candle.
//   The returned `truncated` flag signals this to every caller:
//     - truncated === false → the series is complete; OHLC is accurate.
//     - truncated === true  → data was capped at READ_SERIES_LIMIT rows; the
//                             final day's OHLC covers only a partial window.
//                             Surface a "partial — capped at N readings" warning
//                             wherever the series is displayed.
//   Receiving exactly READ_SERIES_LIMIT rows with truncated === false means the
//   window fit exactly within the cap — no ambiguity.
export const READ_SERIES_LIMIT = 10_000

export interface ReadSeriesResult {
  points: MetricPoint[]
  /** True when the DB had more rows than READ_SERIES_LIMIT in the window.
   *  The trailing bucket(s) are computed over a partial day and must not be
   *  presented as a complete candle — surface a "capped" warning to consumers. */
  truncated: boolean
}

/**
 * Fetch metric readings for one tenant + key within [fromISO, toISO] inclusive.
 * tenant_id is always in the SQL WHERE clause — no cross-tenant data ever returns.
 *
 * FIX-3: LIMIT READ_SERIES_LIMIT prevents unbounded result sets that would cause
 * Math.max/min spread-crash in aggregateOHLC for tenants with many readings.
 *
 * Truncation detection (data-honesty invariant): queries LIMIT + 1 rows. If the
 * DB returns more than READ_SERIES_LIMIT rows, `truncated` is set to true and
 * the extra sentinel row is dropped before returning. Callers MUST check
 * `truncated` before treating the trailing bucket as a complete OHLC candle.
 */
export async function readSeries(
  db: D1Database,
  tenantId: string,
  metricKey: string,
  fromISO: string,
  toISO: string,
): Promise<ReadSeriesResult> {
  // Query one extra row as a truncation sentinel. If we get back more than
  // READ_SERIES_LIMIT rows the window exceeded the cap.
  const sql = `
    SELECT id, tenant_id, metric_key, value, occurred_at, source, created_at
    FROM metric_points
    WHERE tenant_id = ?1
      AND metric_key = ?2
      AND occurred_at >= ?3
      AND occurred_at <= ?4
    ORDER BY occurred_at ASC
    LIMIT ${READ_SERIES_LIMIT + 1}
  `
  const result = await db
    .prepare(sql)
    .bind(tenantId, metricKey, fromISO, toISO)
    .all<{
      id: string
      tenant_id: string
      metric_key: string
      value: number
      occurred_at: string
      source: string
      created_at: string
    }>()

  const raw = result.results ?? []
  const truncated = raw.length > READ_SERIES_LIMIT
  // Drop the sentinel row so callers always receive at most READ_SERIES_LIMIT rows
  const capped = truncated ? raw.slice(0, READ_SERIES_LIMIT) : raw

  return {
    points: capped.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      metricKey: r.metric_key,
      value: r.value,
      occurredAt: r.occurred_at,
      source: r.source,
      createdAt: r.created_at,
    })),
    truncated,
  }
}

// ── aggregateOHLC ─────────────────────────────────────────────────────────────

/**
 * PURE function — no I/O, no side-effects.
 *
 * Given metric readings (already fetched for a single metric_key), bucket by
 * UTC day → one OHLCBucket per day. Within each day:
 *   - open  = value of the first reading by occurred_at
 *   - close = value of the last reading by occurred_at
 *   - high  = max value in the day
 *   - low   = min value in the day
 *   - count = number of readings
 *
 * Readings that share the exact same occurred_at are ordered stably by insertion
 * order (they arrive sorted from readSeries). The result is sorted by date ASC.
 *
 * Only `bucket: 'day'` is supported in v1 (the §4.2 audit covers daily context).
 */
export function aggregateOHLC(
  rows: Pick<MetricPoint, 'value' | 'occurredAt'>[],
  _opts: { bucket: 'day' },
): OHLCBucket[] {
  // Group by UTC date prefix (ISO 8601 date is the first 10 chars of any ISO ts)
  const days = new Map<string, Array<{ value: number; occurredAt: string }>>()

  for (const r of rows) {
    const date = r.occurredAt.slice(0, 10) // 'YYYY-MM-DD'
    const bucket = days.get(date)
    if (bucket) {
      bucket.push({ value: r.value, occurredAt: r.occurredAt })
    } else {
      days.set(date, [{ value: r.value, occurredAt: r.occurredAt }])
    }
  }

  // Sort dates, then compute OHLC per day
  const result: OHLCBucket[] = []
  for (const date of [...days.keys()].sort()) {
    const pts = days.get(date)! // always present by construction
    // pts already arrive sorted by occurred_at (readSeries ORDER BY occurred_at ASC)
    const values = pts.map((p) => p.value)
    // FIX-3: Use reduce-based min/max to avoid spread RangeError ("Maximum call stack")
    // on large series (>~120k elements).  Math.max(...values) applies the spread as
    // individual function arguments which exhaust the call stack at scale.
    const high = values.reduce((m, v) => (v > m ? v : m), values[0])
    const low = values.reduce((m, v) => (v < m ? v : m), values[0])
    result.push({
      date,
      open: values[0],
      high,
      low,
      close: values[values.length - 1],
      count: values.length,
    })
  }

  return result
}

// ── seriesShape ───────────────────────────────────────────────────────────────

/**
 * PURE function — no I/O, no side-effects.
 *
 * Honesty guard from spec §4.2: a series is only 'candle' if at LEAST ONE day has
 * count >= 2 (a real intraday range exists, so O/H/L/C are not all identical).
 * If every day has exactly one reading, we have daily scalars → return 'bar' to
 * signal the UI should NOT render a candle (which would have fabricated O/H/L/C).
 *
 * Empty series → 'bar' (no data to candle).
 */
export function seriesShape(buckets: OHLCBucket[]): SeriesShape {
  for (const b of buckets) {
    if (b.count >= 2) return 'candle'
  }
  return 'bar'
}
