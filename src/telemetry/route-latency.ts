import type { Env } from '../types'

export const BOARD_LATENCY_ROUTE = 'GET /api/kanban/board'
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

/** Independent durable denominator. Called before admitting the authenticated handler.
 * One D1 batch on the response path, no request identity or URL retained. */
export async function countRouteRequest(env: Env, route: string, observedAt = Date.now()): Promise<void> {
  validateRoute(route)
  validateTimestamp(observedAt)
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO route_latency_collection (tenant, route, started_at_ms)
      VALUES (?1, ?2, ?3) ON CONFLICT(tenant, route) DO NOTHING`)
      .bind(env.TENANT_SLUG, route, observedAt),
    env.DB.prepare(`INSERT INTO route_latency_requests (tenant, route, bucket_ms, total_requests)
      VALUES (?1, ?2, ?3, 1) ON CONFLICT(tenant, route, bucket_ms)
      DO UPDATE SET total_requests = total_requests + 1`)
      .bind(env.TENANT_SLUG, route, Math.floor(observedAt / DAY_MS) * DAY_MS),
    env.DB.prepare('DELETE FROM route_latency_requests WHERE tenant = ?1 AND bucket_ms < ?2')
      .bind(env.TENANT_SLUG, observedAt - RETENTION_MS),
  ])
}

function pruneStatements(env: Env, now: number): D1PreparedStatement[] {
  const cutoff = now - RETENTION_MS
  return [
    env.DB.prepare('DELETE FROM route_latency_samples WHERE tenant = ?1 AND observed_at_ms < ?2')
      .bind(env.TENANT_SLUG, cutoff),
    // Drop even the partially expired oldest day; reads accept at most 13 complete days.
    env.DB.prepare('DELETE FROM route_latency_requests WHERE tenant = ?1 AND bucket_ms < ?2')
      .bind(env.TENANT_SLUG, cutoff),
    env.DB.prepare(`DELETE FROM route_latency_samples WHERE tenant = ?1 AND route = ?2 AND id IN
      (SELECT id FROM route_latency_samples WHERE tenant = ?1 AND route = ?2
       ORDER BY observed_at_ms DESC, id DESC LIMIT -1 OFFSET ?3)`)
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, MAX_LATENCY_SAMPLES),
  ]
}

/** Also runs on the existing retention maintenance heartbeat during inactivity. */
export async function pruneRouteLatency(env: Env, now = Date.now()): Promise<void> {
  validateTimestamp(now)
  await env.DB.batch(pruneStatements(env, now))
}

export async function saveRouteSample(
  env: Env, route: string, duration: number, observedAt: number, now = Date.now(),
): Promise<void> {
  validateRoute(route)
  validateTimestamp(observedAt)
  validateTimestamp(now)
  if (!Number.isFinite(duration) || duration < 0) throw new Error('invalid_latency_duration')
  // A delayed task cannot resurrect an expired sample. Its durable count remains a gap.
  if (observedAt < now - RETENTION_MS || observedAt > now) return
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO route_latency_samples (id, tenant, route, observed_at_ms, duration_ms)
      VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(crypto.randomUUID(), env.TENANT_SLUG, route, observedAt, duration),
    ...pruneStatements(env, now),
  ])
}

/** Post-auth duration, including denominator persistence, through response creation.
 * Save all samples asynchronously. A failed save never erases its request count. */
export async function measureBoardRead<T>(
  env: Env, run: () => Promise<T>, waitUntil?: (work: Promise<unknown>) => void,
): Promise<T> {
  const observedAt = Date.now()
  const start = performance.now()
  try {
    await countRouteRequest(env, BOARD_LATENCY_ROUTE, observedAt)
  } catch {
    throw new Error('route_latency_unavailable')
  }
  try {
    return await run()
  } finally {
    const work = saveRouteSample(env, BOARD_LATENCY_ROUTE, performance.now() - start, observedAt)
      .catch(() => { console.warn('[route-latency] sample persistence failed') })
    if (waitUntil) waitUntil(work)
    else await work
  }
}

/** Read one snapshot; current UTC day is excluded so counter and sample windows agree.
 * 1..13 complete days stay wholly inside the strict rolling 14-day retention boundary. */
export async function readRouteLatency(env: Env, days = 7, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 13) throw new Error('invalid_latency_window')
  validateTimestamp(now)
  const end = Math.floor(now / DAY_MS) * DAY_MS
  const start = end - days * DAY_MS
  const results = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(`SELECT duration_ms FROM route_latency_samples
      WHERE tenant = ?1 AND route = ?2 AND observed_at_ms >= ?3 AND observed_at_ms < ?4`)
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, start, end),
    env.DB.prepare(`SELECT COALESCE(SUM(total_requests), 0) AS total FROM route_latency_requests
      WHERE tenant = ?1 AND route = ?2 AND bucket_ms >= ?3 AND bucket_ms < ?4`)
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, start, end),
    env.DB.prepare('SELECT started_at_ms FROM route_latency_collection WHERE tenant = ?1 AND route = ?2')
      .bind(env.TENANT_SLUG, BOARD_LATENCY_ROUTE),
  ])
  const values = results[0].results.map(row => Number(row.duration_ms))
  const total = Number(results[1].results[0]?.total ?? 0)
  const sinceRaw = results[2].results[0]?.started_at_ms
  const since = typeof sinceRaw === 'number' ? sinceRaw : null
  const consistent = total > 0 && values.length <= total
  const enough = consistent && values.length >= LATENCY_SAMPLE_FLOOR
  const windowComplete = since !== null && since <= start
  return {
    route: BOARD_LATENCY_ROUTE, window_days: days,
    window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString(),
    recording_since: since === null ? null : new Date(since).toISOString(),
    window_complete: windowComplete,
    sample_policy: 'all admitted authenticated executions; latest 20000 samples retained',
    denominator_scope: 'durably admitted authenticated handler executions, including handler errors',
    n: values.length, total_requests: total,
    coverage: consistent ? values.length / total : null,
    p50_ms: enough ? percentile(values, 0.5) : null,
    p95_ms: enough ? percentile(values, 0.95) : null,
    minimum_samples: LATENCY_SAMPLE_FLOOR,
    status: !enough ? 'unknown' : values.length < total || !windowComplete ? 'partial' : 'observed',
  }
}
