import { readFileSync } from 'node:fs'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import { platformApp } from '../src/platform/routes'
import type { Env } from '../src/types'

// mupot#981 — the dashboard CSP sets frame-ancestors 'none'. The project sandbox embeds
// /preview/:id/ in an iframe on the same origin, so that route must not receive the dashboard
// baseline. It is safe because platformApp is mounted before dashboardApp in src/index.ts.
describe('project preview stays frameable', () => {
  const env = {} as unknown as Env // requireAuth refuses before any binding is read

  it('src/index.ts mounts platformApp before dashboardApp', () => {
    const src = readFileSync('src/index.ts', 'utf8')
    const platform = src.indexOf("app.route('/', platformApp)")
    const dashboard = src.indexOf('app.route(ROUTES.dashboard, dashboardApp)')
    expect(platform).toBeGreaterThan(-1)
    expect(dashboard).toBeGreaterThan(platform)
  })

  it('a /preview response does not carry the dashboard frame-ancestors policy', async () => {
    const app = new Hono<{ Bindings: Env }>()
    app.route('/', platformApp) // same order as src/index.ts
    app.route('/', dashboardApp)
    for (const path of ['/preview/p1', '/preview/p1/', '/preview/p1/asset.js']) {
      const res = await app.fetch(new Request(`https://pot.example${path}`), env)
      expect(res.headers.get('content-security-policy') ?? '').not.toContain('frame-ancestors')
    }
  })

  it('the same composed app still sends the baseline on a dashboard route', async () => {
    const app = new Hono<{ Bindings: Env }>()
    app.route('/', platformApp)
    app.route('/', dashboardApp)
    const res = await app.fetch(new Request('https://pot.example/admin/agent-token'), env)
    expect(res.headers.get('content-security-policy') ?? '').toContain("frame-ancestors 'none'")
  })
})
