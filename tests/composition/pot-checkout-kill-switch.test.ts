// tests/composition/pot-checkout-kill-switch.test.ts — mupot#1518 hotfix.
//
// Enters through src/index.ts's exported fetch (the DEPLOYED composition: /t/<slug> apex
// rewrite -> OAuthProvider -> Hono root app), not publicPotsApp alone. The defect is a
// MOUNTING fact: publicPotsApp is mounted at /api/pots/public AND /api/pots ahead of the
// guarded potsApp, and /t/<home>/... is rewritten onto both. A sub-app test cannot see
// which of those doors reach the handler.
//
// Live defect at c14ebc8c: every anonymous POST created a live Stripe Checkout Session
// (metadata.action=create_pot) whose webhook never provisions the pot -> buyer is billed
// monthly and gets nothing. The hotfix: off unless POT_SELF_SERVE_CHECKOUT_ENABLED === "true".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { CHECKOUT_UNAVAILABLE_NOTICE } from '../../src/dashboard/pricing'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  }
}

/**
 * TRIPWIRE, not a D1. It answers no SQL: ANY property access is recorded and then throws.
 * Workerd composition tests cannot use tests/helpers/sqlite-d1 (node:sqlite), and a
 * hand-written D1 that answers queries is exactly what scripts/check-test-schema-source.mjs
 * forbids. What these root-app tests need to prove about the DB is only "was it touched",
 * which a tripwire proves without inventing a schema. The flag="true" Stripe paths, which
 * need a slug lookup that SUCCEEDS, run against real SQLite + applyAllMigrations() in
 * tests/pot-checkout-provisioning.test.ts.
 */
function tripwireDb() {
  const touched: string[] = []
  const db = new Proxy(
    {},
    {
      get(_target, prop) {
        touched.push(String(prop))
        throw new Error(`tripwire: DB.${String(prop)} touched`)
      },
    },
  )
  return { db, touched }
}

function makeEnv(flag: string | undefined) {
  const { db, touched } = tripwireDb()
  const env: Record<string, unknown> = {
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-secret',
    PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    SESSIONS: kv(),
    OAUTH_KV: kv(),
    DB: db,
    // Present on purpose: before the hotfix, this secret being set was the ONLY gate.
    STRIPE_SECRET_KEY: 'sk_test_placeholder_not_a_real_key',
  }
  if (flag !== undefined) env.POT_SELF_SERVE_CHECKOUT_ENABLED = flag
  return { env: env as never, touched }
}

// Every route that reaches publicPotsApp's POST /checkout (src/index.ts mounts it at
// /api/pots/public and /api/pots; the /t/<home-slug> apex prefix is stripped onto both).
const CHECKOUT_PATHS = [
  '/api/pots/checkout',
  '/api/pots/public/checkout',
  '/t/mumega/api/pots/checkout',
  '/t/mumega/api/pots/public/checkout',
]

function checkoutRequest(path: string, body: string = JSON.stringify({ slug: 'novacorp', owner_email: 'ceo@novacorp.test', tier: 'pro' })) {
  return new Request(`https://mupot.mumega.com${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ id: 'cs_test_stub', url: 'https://checkout.stripe.com/c/pay/cs_test_stub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Parse the request target and match the exact Stripe API host (a substring test would
// also match e.g. https://evil.example/?api.stripe.com, and would miss Request objects).
function requestHost(input: unknown): string | null {
  try {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
    return new URL(url).hostname
  } catch {
    return null
  }
}

function stripeCalls(): unknown[][] {
  return fetchSpy.mock.calls.filter((call) => requestHost(call[0]) === 'api.stripe.com')
}

describe('anonymous pot checkout is OFF by default (mupot#1518)', () => {
  it.each(CHECKOUT_PATHS)('flag UNSET: POST %s -> 503 checkout_unavailable, no Stripe fetch, no DB read', async (path) => {
    const { env, touched } = makeEnv(undefined)
    const res = await worker.fetch(checkoutRequest(path), env, ctx)

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'checkout_unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(touched).toEqual([])
  })

  it.each(CHECKOUT_PATHS)('flag UNSET: refuses %s BEFORE parsing the body (invalid JSON still 503)', async (path) => {
    const { env } = makeEnv(undefined)
    const res = await worker.fetch(checkoutRequest(path, '{not json'), env, ctx)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'checkout_unavailable' })
  })

  it.each(['TRUE', 'True', '1', 'yes', 'on', '', ' true', 'true ', 'false'])(
    'flag %j is DISABLED (only the exact string "true" enables)',
    async (value) => {
      const { env, touched } = makeEnv(value)
      for (const path of CHECKOUT_PATHS) {
        const res = await worker.fetch(checkoutRequest(path), env, ctx)
        expect(res.status, path).toBe(503)
        expect(await res.json()).toEqual({ ok: false, error: 'checkout_unavailable' })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(touched).toEqual([])
    },
  )
})

describe('flag "true" reaches the existing checkout handler through the root app', () => {
  it.each(CHECKOUT_PATHS)('POST %s with invalid JSON -> the handler own 400 invalid_json (past the guard)', async (path) => {
    const { env, touched } = makeEnv('true')
    const res = await worker.fetch(checkoutRequest(path, '{not json'), env, ctx)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_json' })
    expect(touched).toEqual([])
  })

  it.each(CHECKOUT_PATHS)('POST %s with a valid body -> reaches the slug lookup (DB touched); fail-closed lookup -> 400, no Stripe', async (path) => {
    const { env, touched } = makeEnv('true')
    const res = await worker.fetch(checkoutRequest(path), env, ctx)
    // The tripwire DB throws, checkSlugAvailability fails CLOSED (#1303) -> existing 400.
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      ok: false,
      error: 'Availability could not be verified right now. Please try again.',
    })
    expect(touched).toContain('prepare')
    expect(stripeCalls()).toHaveLength(0)
  })
})

describe('/pricing reads the same flag (mupot#1518)', () => {
  it.each([
    ['unset', undefined],
    ['"TRUE"', 'TRUE'],
    ['"1"', '1'],
  ])('flag %s: disabled notice, buttons disabled, no checkout POST wired', async (_label, value) => {
    const { env } = makeEnv(value)
    for (const path of ['/pricing', '/t/mumega/pricing']) {
      const res = await worker.fetch(new Request(`https://mupot.mumega.com${path}`), env, ctx)
      expect(res.status, path).toBe(200)
      const page = await res.text()
      expect(page).toContain(CHECKOUT_UNAVAILABLE_NOTICE)
      expect(page).not.toContain('/api/pots/checkout')
      expect(page).not.toContain('data-tier=')
      expect(page.match(/<button type="button" class="tier-cta" disabled aria-disabled="true">Contact us<\/button>/g)).toHaveLength(3)
      // Prices are still shown — only the purchase path is off.
      expect(page).toContain('$49')
      expect(page).toContain('$99')
      expect(page).toContain('$249')
    }
  })

  it('flag "true": buttons POST to checkout, no disabled notice', async () => {
    const { env } = makeEnv('true')
    const res = await worker.fetch(new Request('https://mupot.mumega.com/pricing'), env, ctx)
    const page = await res.text()
    expect(page).not.toContain(CHECKOUT_UNAVAILABLE_NOTICE)
    expect(page).toContain("fetch('/api/pots/checkout'")
    expect(page).toContain('data-tier="starter"')
    expect(page).toContain('data-tier="pro"')
    expect(page).toContain('data-tier="scale"')
    expect(page).not.toContain('aria-disabled')
  })
})
