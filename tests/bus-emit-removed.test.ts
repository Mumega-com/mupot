// mupot#2395 — POST /api/bus/emit is gone. The route registered requireAuth as
// undefined in the production bundle, the wake contract pointed at /bus/emit
// (wrong prefix), and nothing called the mounted path. Keep createBus() and
// GET /api/bus/health; assert the HTTP emit surface is 404.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { busApp } from '../src/bus'
import { ROUTES } from '../src/types'
import type { Env } from '../src/types'

// Same mount src/index.ts uses: app.route(ROUTES.bus, busApp).
const app = new Hono<{ Bindings: Env }>()
app.route(ROUTES.bus, busApp)

const env = { TENANT_SLUG: 'local' } as unknown as Env

describe('mupot#2395 dead POST /api/bus/emit', () => {
  it('POST /api/bus/emit returns 404 (route removed)', async () => {
    const res = await app.request(
      '/api/bus/emit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'agent.wake', payload: {} }),
      },
      env,
    )
    expect(res.status).toBe(404)
  })

  it('GET /api/bus/health still serves', async () => {
    const res = await app.request('/api/bus/health', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, component: 'bus', tenant: 'local' })
  })
})
