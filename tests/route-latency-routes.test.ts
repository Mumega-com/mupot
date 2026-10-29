import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'
import { routeLatencyApp } from '../src/dashboard/route-latency'
import { kanbanApp } from '../src/dashboard/kanban-routes'
import { dashboardApp } from '../src/dashboard'

let h: ReturnType<typeof createSqliteD1>
let env: Env
beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = {
    DB: h.db, TENANT_SLUG: 'latency-http',
    SESSIONS: {
      get: async (key: string) => key === 'sess:owner' || key === 'sess:member'
        ? JSON.stringify({ userId: key, role: key === 'sess:owner' ? 'owner' : 'member', email: null }) : null,
      delete: async () => undefined,
    },
  } as unknown as Env
})
afterEach(() => h.close())
const request = (path = '/api/telemetry/board-latency', cookie?: string) => routeLatencyApp.request(path, {
  headers: cookie ? { cookie: `mupot_session=${cookie}` } : {},
}, env)

describe('authenticated board latency HTTP integration', () => {
  it('the read is mounted on the real dashboard app', async () => {
    const res = await dashboardApp.request('/api/telemetry/board-latency', {
      headers: { cookie: 'mupot_session=owner' },
    }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ route: 'GET /api/kanban/board', window_days: 7 })
  })

  it('requires an authenticated org admin, with no diagnostics for anonymous or member callers', async () => {
    expect((await request()).status).toBe(401)
    const member = await request(undefined, 'member')
    expect(member.status).toBe(403)
    expect(await member.json()).toEqual({ error: 'forbidden' })
    const owner = await request(undefined, 'owner')
    expect(owner.status).toBe(200)
    expect(owner.headers.get('cache-control')).toBe('no-store')
    expect(await owner.json()).toMatchObject({ route: 'GET /api/kanban/board', window_days: 7, status: 'unknown', coverage: null })
  })

  it.each(['?days=0', '?days=14', '?days=7.5', '?days=7%3BDROP', '?route=GET%20/private?token=secret'])('refuses invalid selectors %s', async (query) => {
    expect((await request('/api/telemetry/board-latency' + query, 'owner')).status).toBe(400)
  })

  it('the existing authenticated board route counts and records a sample; auth refusals do not', async () => {
    expect((await kanbanApp.request('/api/kanban/board?secret=DO-NOT-STORE', {}, env)).status).toBe(401)
    const res = await kanbanApp.request('/api/kanban/board?secret=DO-NOT-STORE', {
      headers: { cookie: 'mupot_session=owner' },
    }, env)
    expect(res.status).toBe(200)
    expect(h.sqlite.prepare('SELECT SUM(total_requests) AS n FROM route_latency_requests').get()?.n).toBe(1)
    const rows = h.sqlite.prepare('SELECT * FROM route_latency_samples').all()
    expect(rows).toHaveLength(1)
    expect(rows[0].route).toBe('GET /api/kanban/board')
    expect(Number(rows[0].duration_ms)).toBeGreaterThanOrEqual(0)
    expect(JSON.stringify(rows)).not.toContain('DO-NOT-STORE')
    expect(Object.keys(rows[0]).sort()).toEqual(['duration_ms', 'id', 'observed_at_ms', 'route', 'tenant'])
  })

  it('refuses an uncounted board execution with 503 when the denominator is unavailable', async () => {
    h.sqlite.exec('DROP TABLE route_latency_requests')
    const res = await kanbanApp.request('/api/kanban/board', { headers: { cookie: 'mupot_session=owner' } }, env)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'route_latency_unavailable' })
  })

  it('HEAD requests keep their existing behavior without being mislabeled as GET samples', async () => {
    const res = await kanbanApp.request('/api/kanban/board', { method: 'HEAD', headers: { cookie: 'mupot_session=owner' } }, env)
    expect(res.status).toBe(200)
    expect(h.sqlite.prepare('SELECT COUNT(*) AS n FROM route_latency_requests').get()?.n).toBe(0)
  })

  it('returns unknown and 503 when retained telemetry cannot be read', async () => {
    h.sqlite.exec('DROP TABLE route_latency_samples')
    const res = await request(undefined, 'owner')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'route_latency_unavailable', status: 'unknown' })
  })
})
