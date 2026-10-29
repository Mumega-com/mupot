import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'
import { latencyKv } from './helpers/latency-kv'
import {
  BOARD_LATENCY_ROUTE, MAX_LATENCY_SAMPLES, RETENTION_MS, percentile,
  countRouteRequest, saveRouteSample, readRouteLatency, pruneRouteLatency, measureBoardRead,
} from '../src/telemetry/route-latency'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 29, 12)
const OBSERVED = NOW - DAY
let h: ReturnType<typeof createSqliteD1>
let env: Env
beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: 'latency-test', SESSIONS: latencyKv().kv } as unknown as Env
})
afterEach(() => h.close())

async function seed(requests: number, values: number[], tenant = env.TENANT_SLUG, observed = OBSERVED) {
  const e = { ...env, TENANT_SLUG: tenant }
  for (let i = 0; i < requests; i++) await countRouteRequest(e, BOARD_LATENCY_ROUTE, observed)
  for (const value of values) await saveRouteSample(e, BOARD_LATENCY_ROUTE, value, observed, NOW)
}

describe('route latency retention: real migration chain', () => {
  it('nearest-rank percentiles use a sorted fixed distribution, without changing the input', () => {
    const values = [100, 4, 3, 2, 1]
    expect(percentile(values, 0.5)).toBe(3)
    expect(percentile(values, 0.95)).toBe(100)
    expect(values).toEqual([100, 4, 3, 2, 1])
    expect(percentile([], 0.5)).toBeNull()
  })

  it('a seven-day read names the route, n, p50, p95 and the covered fraction', async () => {
    await seed(25, Array.from({ length: 20 }, (_, i) => i + 1))
    const r = await readRouteLatency(env, 7, NOW)
    expect(r).toMatchObject({ route: BOARD_LATENCY_ROUTE, n: 20, total_requests: 25,
      p50_ms: 10, p95_ms: 19, coverage: 0.8, status: 'partial', window_days: 7 })
    expect(r.window_end).toBe('2026-10-29T00:00:00.000Z')
    expect(r.window_start).toBe('2026-10-22T00:00:00.000Z')
  })

  it('does not invent a denominator or a distribution for zero requests, or fewer than 20 samples', async () => {
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ n: 0, coverage: null, status: 'unknown', p50_ms: null, p95_ms: null })
    await seed(20, Array.from({ length: 19 }, () => 5))
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ n: 19, total_requests: 20,
      coverage: 0.95, status: 'unknown', p50_ms: null, p95_ms: null })
  })

  it('does not hide a silent sample gap or call collection warmup complete', async () => {
    await seed(21, Array.from({ length: 20 }, () => 5))
    const r = await readRouteLatency(env, 7, NOW)
    expect(r.coverage).toBeCloseTo(20 / 21)
    expect(r.status).toBe('partial')
    expect(r.window_complete).toBe(false)
    expect(r.recording_since).not.toBeNull()
  })

  it('recognizes complete coverage only after a full collection window', async () => {
    await countRouteRequest(env, BOARD_LATENCY_ROUTE, NOW - 10 * DAY)
    await seed(20, Array.from({ length: 20 }, () => 7))
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ coverage: 1, status: 'observed', window_complete: true })
  })

  it('refuses inconsistent sample counts instead of reporting coverage above one', async () => {
    await seed(1, Array.from({ length: 20 }, () => 7))
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ coverage: null, status: 'unknown', p50_ms: null })
  })

  it('reads one tenant and the requested complete days, excluding the current day', async () => {
    await seed(20, Array.from({ length: 20 }, () => 9))
    await seed(100, Array.from({ length: 100 }, () => 900), 'other-tenant')
    await seed(100, Array.from({ length: 100 }, () => 800), env.TENANT_SLUG, NOW)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ n: 20, total_requests: 20, p50_ms: 9 })
  })

  it.each([0, -1, 14, 1.5, NaN, Infinity])('rejects an invalid day window %s', async (days) => {
    await expect(readRouteLatency(env, days, NOW)).rejects.toThrow('window')
  })

  it('prunes samples and request totals older than 14 days, without touching another tenant', async () => {
    await seed(1, [1], env.TENANT_SLUG, NOW - RETENTION_MS - 1)
    await seed(1, [2], env.TENANT_SLUG, OBSERVED)
    await seed(1, [3], 'other-tenant', NOW - RETENTION_MS - 1)
    // Seed expired rows directly: the writer itself must not retain late samples.
    h.sqlite.prepare(`INSERT INTO route_latency_samples (id, tenant, route, observed_at_ms, duration_ms)
      VALUES ('expired', ?, ?, ?, 1)`).run(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, NOW - RETENTION_MS - 1)
    h.sqlite.prepare(`INSERT INTO route_latency_samples (id, tenant, route, observed_at_ms, duration_ms)
      VALUES ('other-expired', 'other-tenant', ?, ?, 1)`).run(BOARD_LATENCY_ROUTE, NOW - RETENTION_MS - 1)
    h.sqlite.prepare(`INSERT INTO route_latency_requests (tenant, route, bucket_ms, total_requests)
      VALUES (?, ?, ?, 1)`).run(env.TENANT_SLUG, BOARD_LATENCY_ROUTE, NOW - RETENTION_MS - DAY)
    await pruneRouteLatency(env, NOW)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM route_latency_samples WHERE tenant=?`).get(env.TENANT_SLUG)?.n).toBe(1)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM route_latency_requests WHERE tenant=?`).get(env.TENANT_SLUG)?.n).toBe(1)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM route_latency_samples WHERE tenant='other-tenant'`).get()?.n).toBe(1)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM route_latency_requests WHERE tenant='other-tenant'`).get()?.n).toBe(1)
  })

  it('caps latest retained samples but retains total requests so eviction remains a coverage gap', async () => {
    await seed(1, [])
    h.sqlite.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?)
      INSERT INTO route_latency_samples (id, tenant, route, observed_at_ms, duration_ms)
      SELECT CAST(x AS TEXT), ?, ?, ?, x FROM n`).run(MAX_LATENCY_SAMPLES, env.TENANT_SLUG, BOARD_LATENCY_ROUTE, OBSERVED)
    h.sqlite.prepare(`UPDATE route_latency_requests SET total_requests=? WHERE tenant=?`).run(MAX_LATENCY_SAMPLES + 1, env.TENANT_SLUG)
    await saveRouteSample(env, BOARD_LATENCY_ROUTE, 99, OBSERVED + 1, NOW)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_samples').get()?.n).toBe(20_001)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ n: 20_000, total_requests: 20_001, status: 'partial' })
    await pruneRouteLatency(env, NOW)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_samples').get()?.n).toBe(20_000)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ n: MAX_LATENCY_SAMPLES, total_requests: MAX_LATENCY_SAMPLES + 1, status: 'partial' })
  })

  it('accepts only the fixed route label and never stores URL/query/auth material', async () => {
    for (const route of ["GET /dashboard/kanban'; DROP TABLE tasks;--", 'GET /dashboard/kanban?token=private', 'other']) {
      await expect(countRouteRequest(env, route, OBSERVED)).rejects.toThrow('invalid_latency_route')
      await expect(saveRouteSample(env, route, 2, OBSERVED, NOW)).rejects.toThrow('invalid_latency_route')
    }
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM route_latency_requests`).get()?.n).toBe(0)
    expect(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM route_latency_samples`).get()?.n).toBe(0)
  })

  it('the migration also forbids storing a user-controlled route label', () => {
    const route = "GET /private?token=x'; DROP TABLE tasks;--"
    expect(() => h.sqlite.prepare(`INSERT INTO route_latency_samples (id, tenant, route, observed_at_ms, duration_ms)
      VALUES ('injection', ?, ?, ?, 1)`).run(env.TENANT_SLUG, route, OBSERVED)).toThrow()
    expect(() => h.sqlite.prepare(`INSERT INTO route_latency_requests (tenant, route, bucket_ms, total_requests)
      VALUES (?, ?, ?, 1)`).run(env.TENANT_SLUG, route, OBSERVED)).toThrow()
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n).toBe(0)
  })

  it.each([-1, NaN, Infinity])('refuses invalid duration %s', async (duration) => {
    await expect(saveRouteSample(env, BOARD_LATENCY_ROUTE, duration, OBSERVED, NOW)).rejects.toThrow('invalid_latency_duration')
  })

  it.each([-1, NaN, Infinity, 1.5])('refuses invalid timestamp %s', async (value) => {
    await expect(countRouteRequest(env, BOARD_LATENCY_ROUTE, value)).rejects.toThrow('invalid_latency_timestamp')
    await expect(saveRouteSample(env, BOARD_LATENCY_ROUTE, 1, value, NOW)).rejects.toThrow('invalid_latency_timestamp')
  })

  it('does not write stale or future-dated samples', async () => {
    const batch = vi.spyOn(h.db, 'batch')
    await saveRouteSample(env, BOARD_LATENCY_ROUTE, 1, NOW - RETENTION_MS - 1, NOW)
    await saveRouteSample(env, BOARD_LATENCY_ROUTE, 1, NOW + 1, NOW)
    expect(batch).not.toHaveBeenCalled()
    batch.mockRestore()
  })

  it('records handler errors off path without replacing the original error', async () => {
    const work: Promise<unknown>[] = []
    const error = new Error('handler-failed')
    await expect(measureBoardRead(env, async () => { throw error }, p => work.push(p))).rejects.toBe(error)
    await Promise.all(work)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_samples').get()?.n).toBe(1)
    expect(h.sqlite.prepare('SELECT SUM(total_requests) AS n FROM route_latency_requests').get()?.n).toBe(1)
  })
})
