import type { Env } from '../types'

export const BOARD_LATENCY_ROUTE = 'GET /dashboard/kanban'
export const MAX_LATENCY_SAMPLES = 20_000
export const LATENCY_SAMPLE_FLOOR = 20
const DAY_MS = 86_400_000
export const RETENTION_MS = 14 * DAY_MS

function validateRoute(route: string): void {
  if (route !== BOARD_LATENCY_ROUTE) throw new Error('invalid_latency_route')
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_latency_timestamp')
}

/** Nearest rank, not interpolation. The supplied array is never mutated. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? null
}

/** Off-path durable denominator; failures are recorded independently in KV. */
function requestStatements(env: Env, route: string, observedAt: number): D1PreparedStatement[] {
  validateRoute(route)
  validateTimestamp(observedAt)
  return [
    env.DB.prepare(`INSERT INTO route_latency_collection (tenant, route, started_at_ms)
      VALUES (?1, ?2, ?3) ON CONFLICT(tenant, route) DO NOTHING`)
      .bind(env.TENANT_SLUG, route, observedAt),
    env.DB.prepare(`INSERT INTO route_latency_requests (tenant, route, bucket_ms, total_requests)
      VALUES (?1, ?2, ?3, 1) ON CONFLICT(tenant, route, bucket_ms)
      DO UPDATE SET total_requests = total_requests + 1`)
      .bind(env.TENANT_SLUG, route, Math.floor(observedAt / DAY_MS) * DAY_MS),
  ]
}

export async function countRouteRequest(env: Env, route: string, observedAt = Date.now()): Promise<void> {
  await env.DB.batch(requestStatements(env, route, observedAt))
}

function pruneStatements(env: Env, now: number): D1PreparedStatement[] {
  const cutoff = now - RETENTION_MS
  return [
    env.DB.prepare('DELETE FROM route_latency_samples WHERE tenant = ?1 AND route = ?2 AND observed_at_ms < ?3')
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, cutoff),
    // Drop even the partially expired oldest day; reads accept at most 13 complete days.
    env.DB.prepare('DELETE FROM route_latency_requests WHERE tenant = ?1 AND route = ?2 AND bucket_ms < ?3')
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, cutoff),
    env.DB.prepare(`DELETE FROM route_latency_samples WHERE tenant = ?1 AND route = ?2 AND id IN
      (SELECT id FROM route_latency_samples WHERE tenant = ?1 AND route = ?2
       ORDER BY observed_at_ms DESC, id DESC LIMIT -1 OFFSET ?3)`)
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, MAX_LATENCY_SAMPLES),
  ]
}

/** Runs only on the separately named maintenance heartbeat, including during inactivity. */
export async function pruneRouteLatency(env: Env, now = Date.now()): Promise<void> {
  validateTimestamp(now)
  await env.DB.batch(pruneStatements(env, now))
}

function sampleStatement(env: Env, route: string, duration: number, observedAt: number, now: number): D1PreparedStatement | null {
  validateRoute(route)
  validateTimestamp(observedAt)
  validateTimestamp(now)
  if (!Number.isFinite(duration) || duration < 0) throw new Error('invalid_latency_duration')
  if (observedAt < now - RETENTION_MS || observedAt > now) return null
  return env.DB.prepare(`INSERT INTO route_latency_samples (id, tenant, route, observed_at_ms, duration_ms)
      VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(crypto.randomUUID(), env.TENANT_SLUG, route, observedAt, duration)
}

export async function saveRouteSample(
  env: Env, route: string, duration: number, observedAt: number, now = Date.now(),
): Promise<void> {
  const statement = sampleStatement(env, route, duration, observedAt, now)
  if (statement) await env.DB.batch([statement])
}

const FAILURE_PREFIX = 'board-latency-counter-failure:v1:'
const MAX_FAILURE_LIST_PAGES = 32

function failurePrefix(tenant: string, day: number): string {
  return `${FAILURE_PREFIX}${encodeURIComponent(tenant)}:${new Date(day).toISOString().slice(0, 10)}:`
}

async function persistBoardTiming(env: Env, observedAt: number, duration: number): Promise<void> {
  try {
    const sample = sampleStatement(env, BOARD_LATENCY_ROUTE, duration, observedAt, Date.now())
    await env.DB.batch([
      ...requestStatements(env, BOARD_LATENCY_ROUTE, observedAt), ...(sample ? [sample] : []),
    ])
  } catch {
    // A unique key per failed counter avoids KV read/modify/write lost increments.
    // Do not save a sample without its D1 count: the KV marker becomes a visible gap.
    try {
      await env.SESSIONS.put(failurePrefix(env.TENANT_SLUG, observedAt) + crypto.randomUUID(), '1', {
        expirationTtl: RETENTION_MS / 1000, metadata: { observed_at_ms: observedAt },
      })
    } catch {
      console.warn('[route-latency] counter failure marker persistence failed')
    }
    return
  }
}

/** Null means the independent failure ledger is unavailable or incomplete, never zero. */
async function readCounterFailures(env: Env, start: number, end: number): Promise<number | null> {
  let failures = 0
  let pages = 0
  try {
    for (let day = start; day < end; day += DAY_MS) {
      let cursor: string | undefined
      do {
        if (++pages > MAX_FAILURE_LIST_PAGES) return null
        const page = await env.SESSIONS.list<{ observed_at_ms: number }>({
          prefix: failurePrefix(env.TENANT_SLUG, day), limit: 1000, ...(cursor ? { cursor } : {}),
        })
        for (const key of page.keys) {
          const observedAt = key.metadata?.observed_at_ms
          if (typeof observedAt !== 'number' || observedAt < start || observedAt >= end) return null
          failures++
        }
        if (page.list_complete) break
        if (!page.cursor || page.cursor === cursor) return null
        cursor = page.cursor
      } while (true)
    }
    return failures
  } catch {
    return null
  }
}

/** Measure only the handler. All telemetry starts afterwards, off the response path. */
export async function measureBoardRead<T>(
  env: Env, run: () => Promise<T>, waitUntil?: (work: Promise<unknown>) => void,
): Promise<T> {
  const observedAt = Date.now()
  const start = performance.now()
  try {
    return await run()
  } finally {
    const duration = performance.now() - start
    const work = Promise.resolve().then(() => persistBoardTiming(env, observedAt, duration))
      .catch(() => { console.warn('[route-latency] telemetry persistence failed') })
    // Standalone/non-Worker callers are best-effort too; never hold a page for telemetry.
    try { if (waitUntil) waitUntil(work) } catch { console.warn('[route-latency] waitUntil unavailable') }
  }
}

/** Read one snapshot; current UTC day is excluded so counter and sample windows agree.
 * 1..13 complete days stay wholly inside the strict rolling 14-day retention boundary. */
export async function readRouteLatency(env: Env, days = 7, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 13) throw new Error('invalid_latency_window')
  validateTimestamp(now)
  const end = Math.floor(now / DAY_MS) * DAY_MS
  const start = end - days * DAY_MS
  const [results, counterFailures] = await Promise.all([env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT duration_ms FROM route_latency_samples
      WHERE tenant = ?1 AND route = ?2 AND observed_at_ms >= ?3 AND observed_at_ms < ?4
      ORDER BY observed_at_ms DESC, id DESC LIMIT ?5`)
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, start, end, MAX_LATENCY_SAMPLES),
    env.DB.prepare(`SELECT COALESCE(SUM(total_requests), 0) AS total FROM route_latency_requests
      WHERE tenant = ?1 AND route = ?2 AND bucket_ms >= ?3 AND bucket_ms < ?4`)
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, start, end),
    env.DB.prepare('SELECT started_at_ms FROM route_latency_collection WHERE tenant = ?1 AND route = ?2')
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE),
  ]), readCounterFailures(env, start, end)])
  const values = results[0].results.map(row => Number(row.duration_ms))
  const recorded = Number(results[1].results[0]?.total ?? 0)
  const total = counterFailures === null ? null : recorded + counterFailures
  const sinceRaw = results[2].results[0]?.started_at_ms
  const since = typeof sinceRaw === 'number' ? sinceRaw : null
  const consistent = total !== null && total > 0 && values.length <= total
  const enough = consistent && values.length >= LATENCY_SAMPLE_FLOOR
  const windowComplete = since !== null && since <= start
  return {
    route: BOARD_LATENCY_ROUTE, window_days: days,
    window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(),
    recording_since: since === null ? null : new Date(since).toISOString(),
    window_complete: windowComplete,
    sample_policy: 'all canonical no-query page GETs; latest 20000 observations read',
    denominator_scope: 'canonical page GETs; persisted D1 counts plus independent KV counter-failure markers',
    recorded_requests: recorded, counter_failures: counterFailures,
    failure_visibility: counterFailures === null ? 'unknown' : 'kv-eventually-consistent',
    n: values.length, total_requests: total,
    coverage: consistent && total !== null ? values.length / total : null,
    p50_ms: enough ? percentile(values, 0.5) : null,
    p95_ms: enough ? percentile(values, 0.95) : null,
    minimum_samples: LATENCY_SAMPLE_FLOOR,
    status: !enough ? 'unknown' : total === null || values.length < total || counterFailures !== 0 || !windowComplete ? 'partial' : 'observed',
  }
}
