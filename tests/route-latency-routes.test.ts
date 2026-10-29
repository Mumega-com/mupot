import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'
import { routeLatencyApp } from '../src/dashboard/route-latency'
import { dashboardApp } from '../src/dashboard'
import { latencyKv } from './helpers/latency-kv'

let h: ReturnType<typeof createSqliteD1>
let env: Env
beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  const store = latencyKv()
  for (const role of ['owner', 'member']) store.entries.set('sess:' + role, {
    value: JSON.stringify({ userId: role, role, email: null }),
  })
  env = { DB: h.db, TENANT_SLUG: 'latency-http', SESSIONS: store.kv } as unknown as Env

})
afterEach(() => { vi.restoreAllMocks(); h.close() })
const request = (path = '/api/telemetry/board-latency', cookie?: string) => routeLatencyApp.request(path, {
  headers: cookie ? { cookie: `mupot_session=${cookie}` } : {},
}, env)

describe('authenticated board latency HTTP integration', () => {
  it('the read is mounted on the real dashboard app', async () => {
    const res = await dashboardApp.request('/api/telemetry/board-latency', {
      headers: { cookie: 'mupot_session=owner' },
    }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ route: 'GET /dashboard/kanban', window_days: 7 })
  })

  it('requires an authenticated org admin, with no diagnostics for anonymous or member callers', async () => {
    expect((await request()).status).toBe(401)
    const member = await request(undefined, 'member')
    expect(member.status).toBe(403)
    expect(await member.json()).toEqual({ error: 'forbidden' })
    const owner = await request(undefined, 'owner')
    expect(owner.status).toBe(200)
    expect(owner.headers.get('cache-control')).toBe('no-store')
    expect(await owner.json()).toMatchObject({ route: 'GET /dashboard/kanban', window_days: 7, status: 'unknown', coverage: null })
  })

  it.each(['?days=0', '?days=14', '?days=7.5', '?days=7%3BDROP', '?route=GET%20/private?token=secret'])('refuses invalid selectors %s', async (query) => {
    expect((await request('/api/telemetry/board-latency' + query, 'owner')).status).toBe(400)
  })

  async function page(path = '/dashboard/kanban', method = 'GET', cookie = 'owner') {
    const work: Promise<unknown>[] = []
    const res = await dashboardApp.request(path, { method, headers: cookie ? { cookie: `mupot_session=${cookie}` } : {} }, env, {
      waitUntil(p: Promise<unknown>) { work.push(p) }, passThroughOnException() {}, props: {},
    })
    await Promise.all(work)
    return res
  }

  it('the actual HTML board page records organic full-board loads, not the unused API', async () => {
    const res = await page()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Kanban')
    expect(h.sqlite.prepare('SELECT SUM(total_requests) AS n FROM route_latency_requests').get()?.n).toBe(1)
    const rows = h.sqlite.prepare('SELECT * FROM route_latency_samples').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].route).toBe('GET /dashboard/kanban')
    expect(Object.keys(rows[0]).sort()).toEqual(['duration_ms', 'id', 'observed_at_ms', 'route', 'tenant'])
    await page('/api/kanban/board')
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_samples').get()?.n).toBe(1)
  })

  it('the actual HTML board page registers its telemetry with the Worker waitUntil', async () => {
    const waitUntil = vi.fn<(work: Promise<unknown>) => void>()
    try {
      const res = await dashboardApp.request('/dashboard/kanban', {
        headers: { cookie: 'mupot_session=owner' },
      }, env, { waitUntil, passThroughOnException() {}, props: {} })
      expect(res.status).toBe(200)
      expect(waitUntil).toHaveBeenCalledExactlyOnceWith(expect.any(Promise))
      await Promise.all(waitUntil.mock.calls.map(([work]) => work))
      expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_samples').get()?.n).toBe(1)
    } finally {
      await Promise.all(waitUntil.mock.calls.map(([work]) => work))
      // Drain best-effort work too when probing a deliberately removed hook.
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })

  it('a seven-day read is nonzero after organic page loads (real auth, render, telemetry and read)', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 28, 12))
    for (let i = 0; i < 20; i++) expect((await page()).status).toBe(200)
    clock.mockReturnValue(Date.UTC(2026, 9, 29, 12))
    const res = await request(undefined, 'owner')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      route: 'GET /dashboard/kanban', window_days: 7, n: 20, total_requests: 20,
      coverage: 1, p50_ms: expect.any(Number), p95_ms: expect.any(Number),
    })
  })

  it('cheap variants, HEAD and auth refusals cannot dilute or evict canonical page samples', async () => {
    await page()
    for (const query of ['?project=bogus', '?view=matrix', '?squad=bogus', '?secret=DO-NOT-STORE']) {
      expect((await page('/dashboard/kanban' + query)).status).toBe(200)
    }
    expect((await page('/dashboard/kanban', 'HEAD')).status).toBe(200)
    const anonymous = await page('/dashboard/kanban', 'GET', '')
    expect(anonymous.status).not.toBe(200)
    expect(h.sqlite.prepare('SELECT SUM(total_requests) AS n FROM route_latency_requests').get()?.n).toBe(1)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_samples').get()?.n).toBe(1)
    expect(JSON.stringify(h.sqlite.prepare('SELECT * FROM route_latency_samples').all())).not.toContain('DO-NOT-STORE')
  })

  it('counter-schema failure does not fail the actual page (no deployment-order brick)', async () => {
    h.sqlite.exec('DROP TABLE route_latency_requests')
    const res = await page()
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Kanban')
    const failures = await env.SESSIONS.list({ prefix: 'board-latency-counter-failure:v1:' })
    expect(failures.keys).toHaveLength(1)
  })

  it('returns unknown and 503 when retained telemetry cannot be read', async () => {
    h.sqlite.exec('DROP TABLE route_latency_samples')
    const res = await request(undefined, 'owner')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'route_latency_unavailable', status: 'unknown' })
  })
})
