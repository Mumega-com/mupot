// GET / for a completely unauthenticated visitor — mupot#1445, plus round-2
// adversarial-gate fixes (P2.2 method pinning, Athena P1 JSON semantics).
//
// Before this fix, EVERY unauthenticated HTML request anywhere on the
// dashboard (including the bare root) got a blind 302 straight to
// /auth/login, which sails a stranger directly into Google's account chooser
// with zero context about what they're signing into. This pins the ONE
// carve-out, scoped to the exact root:
//   - GET / + HTML-navigating (no Accept, `Accept: text/html`, or a
//     non-JSON-only Accept like `*/*`)  → the real landing page.
//   - GET / + a caller that explicitly wants JSON (`Accept:
//     application/json` or `?format=json`) → requireAuth's own 401 JSON,
//     never a redirect and never the landing page — an API-style caller gets
//     API semantics, not an HTML-page 302 it can never follow meaningfully.
//   - Any OTHER method on root (POST/HEAD/OPTIONS/…) → the plain blind
//     redirect, unchanged.
//   - Any OTHER path at all, regardless of method or Accept → the plain
//     blind redirect, unchanged. The carve-out must never widen past root.
//
// No DB access happens on any branch under test (the unauthenticated gate
// runs before any D1 read), so no migrations/harness are needed here.

import { describe, expect, it } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import { PENDING_INVITE_COOKIE } from '../src/auth/pending-invite-link'
import type { Env } from '../src/types'

const ORIGIN = 'https://pot.test'

function envFor(): Env {
  const store = new Map<string, string>()
  return {
    DB: {} as unknown,
    TENANT_SLUG: 'pot-a',
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
    },
  } as unknown as Env
}

function req(path: string, method: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { method, headers })
}

function get(path: string, headers: Record<string, string> = {}) {
  return req(path, 'GET', headers)
}

describe('GET / signed-out landing (mupot#1445)', () => {
  it('renders a 200 HTML landing — brand, sign-in CTA to /auth/login, invite hint, no-store', async () => {
    const res = await dashboardApp.fetch(get('/'), envFor())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toContain('no-store')

    const body = await res.text()
    expect(body).toContain('Test Pot')
    expect(body).toContain('Sign in')
    expect(body).toContain('/auth/login')
    expect(body).toContain('/invite/')
  })

  it('carries no PII/token — only brand + static copy', async () => {
    const res = await dashboardApp.fetch(get('/'), envFor())
    const body = await res.text()
    // Nothing that looks like an email, a session id, or a bearer token.
    expect(body).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/)
    expect(body).not.toContain('mupot_')
  })

  it('with the pending-invite cookie, shows the "finish joining" copy — same /auth/login target', async () => {
    const res = await dashboardApp.fetch(
      get('/', { Cookie: `${PENDING_INVITE_COOKIE}=some-pending-id` }),
      envFor(),
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('You accepted an invite')
    expect(body).toContain('sign in with the same Google account to finish')
    expect(body).toContain('/auth/login')
  })

  it('without the pending-invite cookie, does NOT show the "finish joining" copy', async () => {
    const res = await dashboardApp.fetch(get('/'), envFor())
    const body = await res.text()
    expect(body).not.toContain('You accepted an invite')
  })

  it('an explicit Accept: text/html renders the landing page too', async () => {
    const res = await dashboardApp.fetch(get('/', { Accept: 'text/html' }), envFor())
    expect(res.status).toBe(200)
  })

  it('curl-style Accept: */* renders the landing page, not a redirect', async () => {
    const res = await dashboardApp.fetch(get('/', { Accept: '*/*' }), envFor())
    expect(res.status).toBe(200)
  })

  it('GET / with an explicit JSON Accept gets requireAuth\'s own 401 JSON — not a redirect, not the landing page', async () => {
    const res = await dashboardApp.fetch(get('/', { Accept: 'application/json' }), envFor())
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
  })

  it('GET /?format=json gets the same 401 JSON', async () => {
    const res = await dashboardApp.fetch(get('/?format=json'), envFor())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
  })

  it('POST / (no JSON Accept) still 302s to /auth/login — the GET-only landing branch never widens to other methods', async () => {
    // Origin required to clear hono/csrf's Origin check on an unsafe method
    // BEFORE the request ever reaches the auth gate under test here — a
    // missing/mismatched Origin is a different (pre-existing) 403, not the
    // behavior this test pins.
    const res = await dashboardApp.fetch(req('/', 'POST', { Origin: ORIGIN }), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('HEAD / still 302s to /auth/login (current behavior, pinned)', async () => {
    const res = await dashboardApp.fetch(req('/', 'HEAD'), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('OPTIONS / still 302s to /auth/login', async () => {
    const res = await dashboardApp.fetch(req('/', 'OPTIONS'), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('every OTHER unauthenticated dashboard path still 302s to /auth/login — carve-out never widens past root', async () => {
    const res = await dashboardApp.fetch(get('/approvals'), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('an OTHER path with a JSON Accept ALSO stays a plain redirect — the 401-JSON carve-out is root-only', async () => {
    const res = await dashboardApp.fetch(get('/approvals', { Accept: 'application/json' }), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })
})
