// GET / for a completely unauthenticated visitor — mupot#1445.
//
// Before this fix, EVERY unauthenticated HTML request anywhere on the
// dashboard (including the bare root) got a blind 302 straight to
// /auth/login, which sails a stranger directly into Google's account chooser
// with zero context about what they're signing into. This pins the ONE
// carve-out: exact root + GET + HTML-navigating renders a real landing page
// instead. Every other unauthenticated path — and GET / itself when the
// caller explicitly wants JSON — must keep the original blind redirect
// unchanged; the carve-out must never widen past root.
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

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, { headers })
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

  it('GET / with an explicit JSON Accept keeps the original redirect, not the landing page', async () => {
    const res = await dashboardApp.fetch(get('/', { Accept: 'application/json' }), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('GET /?format=json keeps the original redirect too', async () => {
    const res = await dashboardApp.fetch(get('/?format=json'), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('every OTHER unauthenticated dashboard path still 302s to /auth/login — carve-out never widens past root', async () => {
    const res = await dashboardApp.fetch(get('/approvals'), envFor())
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })
})
