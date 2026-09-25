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

/** D1 stand-in that records every statement. Slug lookups return "no row" (slug free). */
function recordingDb() {
  const statements: string[] = []
  const db = {
    prepare(sql: string) {
      statements.push(sql)
      const stmt = {
        bind: () => stmt,
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ success: true, meta: {} }),
        raw: async () => [],
      }
      return stmt
    },
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  }
  return { db, statements }
}

function makeEnv(flag: string | undefined) {
  const { db, statements } = recordingDb()
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
  return { env: env as never, statements }
}

// Every route that reaches publicPotsApp's POST /checkout (src/index.ts mounts it at
// /api/pots/public and /api/pots; the /t/<home-slug> apex prefix is stripped onto both).
const CHECKOUT_PATHS = [
  '/api/pots/checkout',
  '/api/pots/public/checkout',
  '/t/mumega/api/pots/checkout',
  '/t/mumega/api/pots/public/checkout',
]

const STRIPE_UPSTREAM_TEXT = 'No such price: price_leaky_upstream_detail req_ABC123 acct_1LEAK'

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

function stripeCalls(): unknown[][] {
  return fetchSpy.mock.calls.filter((call) => String(call[0]).includes('api.stripe.com'))
}

describe('anonymous pot checkout is OFF by default (mupot#1518)', () => {
  it.each(CHECKOUT_PATHS)('flag UNSET: POST %s -> 503 checkout_unavailable, no Stripe fetch, no DB read', async (path) => {
    const { env, statements } = makeEnv(undefined)
    const res = await worker.fetch(checkoutRequest(path), env, ctx)

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'checkout_unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(statements).toEqual([])
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
      const { env, statements } = makeEnv(value)
      for (const path of CHECKOUT_PATHS) {
        const res = await worker.fetch(checkoutRequest(path), env, ctx)
        expect(res.status, path).toBe(503)
        expect(await res.json()).toEqual({ ok: false, error: 'checkout_unavailable' })
      }
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(statements).toEqual([])
    },
  )
})

describe('flag "true" reaches the existing checkout behavior (stubbed Stripe)', () => {
  it.each(CHECKOUT_PATHS)('POST %s -> 200 with the Stripe session url', async (path) => {
    const { env, statements } = makeEnv('true')
    const res = await worker.fetch(checkoutRequest(path), env, ctx)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      url: 'https://checkout.stripe.com/c/pay/cs_test_stub',
      session_id: 'cs_test_stub',
    })
    expect(stripeCalls()).toHaveLength(1)
    expect(statements.some((sql) => sql.includes('FROM pots'))).toBe(true)
  })
})

describe('Stripe failure is NOT echoed to the anonymous caller (mupot#1518)', () => {
  it.each(CHECKOUT_PATHS)('Stripe HTTP 400 on %s -> generic checkout_failed, upstream text absent from body and logs', async (path) => {
    fetchSpy.mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: STRIPE_UPSTREAM_TEXT } }), { status: 400 }),
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env } = makeEnv('true')

    const res = await worker.fetch(checkoutRequest(path), env, ctx)
    const text = await res.text()

    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'checkout_failed' })
    expect(text).not.toContain('price_leaky_upstream_detail')
    expect(text).not.toContain('Stripe')
    expect(stripeCalls()).toHaveLength(1)
    const logged = JSON.stringify(errors.mock.calls)
    expect(logged).toContain('stripe_session_create_failed')
    expect(logged).not.toContain('price_leaky_upstream_detail')
    expect(logged).not.toContain('sk_test_placeholder_not_a_real_key')
  })

  it('a thrown fetch -> generic checkout_failed, no exception text echoed', async () => {
    fetchSpy.mockImplementation(async () => {
      throw new Error(`socket reset ${STRIPE_UPSTREAM_TEXT}`)
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { env } = makeEnv('true')

    const res = await worker.fetch(checkoutRequest('/api/pots/checkout'), env, ctx)
    const text = await res.text()
    expect(res.status).toBe(502)
    expect(JSON.parse(text)).toEqual({ ok: false, error: 'checkout_failed' })
    expect(text).not.toContain('price_leaky_upstream_detail')
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
