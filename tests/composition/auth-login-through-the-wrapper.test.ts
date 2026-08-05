// tests/composition/auth-login-through-the-wrapper.test.ts — mupot#704 / #712.
//
// The first test to ever exercise the DEPLOYED composition: src/index.ts, the Hono app
// wrapped in OAuthProvider, running in workerd.
//
// Everything else in this repo imports a sub-app and hand-builds an env. That is why GET
// /auth/login could 500 in production under ~20 green auth tests: the wrapper injects a
// binding named OAUTH_PROVIDER, src/auth read that name as a config string, and a
// hand-built env never carries an injected binding. The defect lived in the seam between
// the app and its wrapper — the one place no test could reach.

import { describe, expect, it } from 'vitest'
import worker from '../../src/index'

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

function env(overrides: Record<string, unknown> = {}) {
  return {
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-secret',
    SESSIONS: kv(),
    OAUTH_KV: kv(),
    ...overrides,
  } as never
}

const get = (path: string, e = env()) =>
  worker.fetch(new Request(`https://pot.test${path}`), e, ctx)

describe('the deployed composition (workerd)', () => {
  it('imports at all — the thing that was impossible before', () => {
    expect(typeof worker.fetch).toBe('function')
  })

  it('GET /auth/login does not 500 THROUGH THE WRAPPER', async () => {
    // The production defect, reachable for the first time. Asserting the exact status:
    // a 400 unsupported_provider would also be "not 500" while still meaning the injected
    // binding was misread as configuration.
    const res = await get('/auth/login')
    expect(res.status).toBe(302)
    expect(res.headers.get('location') ?? '').toContain('accounts.google.com')
  })

  it('the wrapper really does inject an OAUTH_PROVIDER binding', async () => {
    // Pins the PREMISE, not just the symptom. If a future library version stops injecting
    // under this name, the fix stays correct but the hazard has changed shape — and this
    // is the test that says so, instead of us rediscovering it in production.
    let injected: unknown = '(handler never ran)'
    const probe = env({
      SESSIONS: {
        ...kv(),
        put: async function (this: unknown, k: string, v: string) {
          void k; void v
        },
      },
    })
    // /health is answered by the Hono app, so reaching it proves the wrapper delegated.
    const res = await worker.fetch(new Request('https://pot.test/health'), probe, ctx)
    expect(res.status).toBe(200)
    injected = (probe as Record<string, unknown>).OAUTH_PROVIDER
    // The wrapper mutates the env object it forwards; if this is ever undefined the
    // collision this suite guards against no longer exists in that form.
    expect(injected, 'OAuthProvider no longer injects OAUTH_PROVIDER — re-read #712').toBeDefined()
  })

  it('IDP_PROVIDER is genuinely READ — not merely survived by failing open', async () => {
    // Athena's finding on #717. The suite passed a naive IDP_PROVIDER -> OAUTH_PROVIDER
    // rename 4/4, because `typeof configured === 'string'` is FALSE for the injected
    // helpers object, so provider() fell back to 'google' and login still 302'd.
    //
    // That means the previous tests could not distinguish "reads the right binding" from
    // "reads the wrong binding and fails safe". The code was accidentally correct, and the
    // day someone removes the typeof guard the 500 returns with nothing going red.
    //
    // Setting IDP_PROVIDER to a value that must CHANGE the outcome closes it: if provider()
    // reads OAUTH_PROVIDER instead, it gets the injected object, typeof rejects it, the
    // default wins, and this returns 302 rather than 400. Only reading the correct binding
    // produces a 400 here.
    const res = await get('/auth/login', env({ IDP_PROVIDER: 'telegram' }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'unsupported_provider', provider: 'telegram' })
  })

  it('routes the app owns still work through the wrapper', async () => {
    const res = await get('/health')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true })
  })
})
