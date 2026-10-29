import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { latencyKv } from './helpers/latency-kv'
import type { Env, AuthContext } from '../src/types'
import { boardLatencyRead } from '../src/dashboard/route-latency'
import {
  BOARD_LATENCY_ROUTE, MAX_LATENCY_SAMPLES, RETENTION_MS, countRouteRequest,
  saveRouteSample, readRouteLatency, pruneRouteLatency, measureBoardRead,
} from '../src/telemetry/route-latency'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 29, 12)
const END = Date.UTC(2026, 9, 29)
const START = END - 7 * DAY
let h: ReturnType<typeof createSqliteD1>
let env: Env
let store: ReturnType<typeof latencyKv>
beforeEach(() => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite)
  store = latencyKv()
  env = { DB: h.db, TENANT_SLUG: 'latency-test', SESSIONS: store.kv } as unknown as Env
})
afterEach(() => { vi.restoreAllMocks(); h.close() })

async function seed(total = 20, n = 20, at = START) {
  for (let i = 0; i < total; i++) await countRouteRequest(env, BOARD_LATENCY_ROUTE, at)
  for (let i = 0; i < n; i++) await saveRouteSample(env, BOARD_LATENCY_ROUTE, i + 1, at, NOW)
}

describe('round 2 independent gate regressions', () => {
  it('pins the real page label, 14-day retention and 20,000 cap to literal requirements', () => {
    expect(BOARD_LATENCY_ROUTE).toBe('GET /dashboard/kanban')
    expect(RETENTION_MS).toBe(1_209_600_000)
    expect(MAX_LATENCY_SAMPLES).toBe(20_000)
  })

  it('M6/M7: a complete window with a coverage gap is partial, never observed', async () => {
    await seed(25, 20)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({
      window_complete: true, n: 20, total_requests: 25, coverage: 0.8, status: 'partial',
    })
  })

  it('M11: collection starting exactly at the window boundary is complete', async () => {
    await seed()
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({
      recording_since: new Date(START).toISOString(), window_complete: true, status: 'observed', coverage: 1,
    })
  })

  it('M13: another tenant cannot make our collection warmup look complete', async () => {
    await countRouteRequest({ ...env, TENANT_SLUG: 'a-other' }, BOARD_LATENCY_ROUTE, START - DAY)
    await seed(20, 20, END - DAY)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({
      recording_since: new Date(END - DAY).toISOString(), window_complete: false, status: 'partial',
    })
  })

  it('M5: samples and counters at exactly window_end are excluded', async () => {
    await seed()
    await seed(20, 20, END)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ n: 20, total_requests: 20, p50_ms: 10, coverage: 1 })
  })

  it('M1: an authenticated org owner from another tenant cannot read the metric', async () => {
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
    // Exercise the real read handler after auth, without replacing its tenant guard.
    app.get('/read', c => {
      c.set('auth', { role: 'owner', tenant: 'other', userId: 'owner-fixture' })
      return boardLatencyRead(c)
    })
    const res = await app.request('/read', {}, env)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
  })

  it('the page returns before a blocked counter and its latency excludes that write', async () => {
    const work: Promise<unknown>[] = []
    let clock = 100
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const realBatch = h.db.batch.bind(h.db)
    const batch = vi.spyOn(h.db, 'batch').mockImplementationOnce(async statements => {
      clock = 1000; await blocked; return realBatch(statements)
    })
    let settled = false
    const response = measureBoardRead(env, async () => {
      expect(batch).not.toHaveBeenCalled(); clock = 107; return 'page'
    }, p => work.push(p)).then(value => { settled = true; return value })
    try {
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(settled).toBe(true)
      expect(await response).toBe('page')
    } finally { release(); await response; await Promise.all(work) }
    expect(batch).toHaveBeenCalledTimes(1)
    expect(h.sqlite.prepare('SELECT duration_ms FROM route_latency_samples').get()?.duration_ms).toBe(7)
  })

  it('counter failure cannot fail the page and creates a separate KV coverage gap', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(END - DAY)
    const work: Promise<unknown>[] = []
    vi.spyOn(h.db, 'batch').mockRejectedValueOnce(new Error('injected-counter-failure'))
    expect(await measureBoardRead(env, async () => 'page', p => work.push(p))).toBe('page')
    await Promise.all(work)
    expect(store.puts).toHaveLength(1)
    expect(store.puts[0].expirationTtl).toBe(1_209_600)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({
      n: 0, total_requests: 1, counter_failures: 1, coverage: 0, status: 'unknown',
    })
  })

  it('concurrent counter failures use unique KV records rather than racing increments', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(END - DAY)
    const batch = vi.spyOn(h.db, 'batch').mockRejectedValue(new Error('counter-down'))
    const work: Promise<unknown>[] = []
    await Promise.all(Array.from({ length: 5 }, () => measureBoardRead(env, async () => 'page', p => work.push(p))))
    await Promise.all(work); batch.mockRestore()
    expect(store.entries.size).toBe(5)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ total_requests: 5, counter_failures: 5, coverage: 0 })
  })

  it('cannot report observed when the independent failure store cannot be read', async () => {
    await seed()
    vi.spyOn(store.kv, 'list').mockRejectedValueOnce(new Error('kv-unavailable'))
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({
      counter_failures: null, coverage: null, status: 'unknown', p50_ms: null,
    })
  })

  it('a KV counter failure makes a previously complete window partial with coverage below one', async () => {
    await seed()
    vi.spyOn(Date, 'now').mockReturnValue(END - DAY)
    vi.spyOn(h.db, 'batch').mockRejectedValueOnce(new Error('counter-down'))
    const work: Promise<unknown>[] = []
    await measureBoardRead(env, async () => 'page', p => work.push(p))
    await Promise.all(work)
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({
      n: 20, total_requests: 21, counter_failures: 1, window_complete: true,
      coverage: 20 / 21, status: 'partial',
    })
  })

  it('pages the tenant-scoped independent ledger instead of silently undercounting beyond 1000 failures', async () => {
    for (let i = 0; i < 1001; i++) store.entries.set(`board-latency-counter-failure:v1:latency-test:2026-10-28:${i}`, {
      value: '1', metadata: { observed_at_ms: END - DAY },
    })
    store.entries.set('board-latency-counter-failure:v1:other:2026-10-28:1', {
      value: '1', metadata: { observed_at_ms: END - DAY },
    })
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ counter_failures: 1001, total_requests: 1001, coverage: 0 })
  })

  it('an incomplete KV cursor is unknown, never a zero-failure read', async () => {
    await seed()
    vi.spyOn(store.kv, 'list').mockResolvedValueOnce({ keys: [], list_complete: false, cursor: '', cacheStatus: null })
    expect(await readRouteLatency(env, 7, NOW)).toMatchObject({ counter_failures: null, coverage: null, status: 'unknown' })
  })

  it('counter and sample writes do not prune; maintenance prunes them', async () => {
    const batch = vi.spyOn(h.db, 'batch')
    await countRouteRequest(env, BOARD_LATENCY_ROUTE, END - DAY)
    await saveRouteSample(env, BOARD_LATENCY_ROUTE, 2, END - DAY, NOW)
    expect(batch).toHaveBeenCalledTimes(2)
    // Real SQLite trace via prepare spy, never a string-matching SQL engine.
    const prepare = vi.spyOn(h.db, 'prepare')
    await countRouteRequest(env, BOARD_LATENCY_ROUTE, END - DAY)
    await saveRouteSample(env, BOARD_LATENCY_ROUTE, 2, END - DAY, NOW)
    expect(prepare.mock.calls.some(([sql]) => /DELETE/i.test(sql))).toBe(false)
    await pruneRouteLatency(env, NOW)
    expect(prepare.mock.calls.filter(([sql]) => /DELETE FROM route_latency_(samples|requests)/.test(sql))
      .every(([sql]) => /tenant = \?1 AND route = \?2/.test(sql))).toBe(true)
  })
})
