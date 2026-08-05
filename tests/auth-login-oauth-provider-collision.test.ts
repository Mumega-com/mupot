// tests/auth-login-oauth-provider-collision.test.ts — GET /auth/login 500 in production.
//
// THE DEFECT
//
// /auth/login returned 500 on mupot.mumega.com for as long as the OAuthProvider wrapper
// has been mounted. @cloudflare/workers-oauth-provider RESERVES the binding name
// OAUTH_PROVIDER and injects its own OAuthHelpersImpl instance there at runtime.
// src/auth/index.ts read that same name as a config string:
//
//     provider(env) -> <OAuthHelpersImpl>          (an object, not 'google')
//     -> !== 'google'                              -> unsupported_provider branch
//     -> c.json({ provider: <OAuthHelpersImpl> })
//     -> TypeError: Converting circular structure to JSON     -> 500
//
// wrangler.toml already carried the rename (IDP_PROVIDER = "google", with the reason in a
// comment). No code had followed it, and src/types.ts still declared OAUTH_PROVIDER as
// 'google' | 'telegram' — a declaration that was simply false at runtime. Typecheck could
// not catch the contradiction because the one place that read the binding CORRECTLY
// (src/mcp/oauth-authorize.ts) reached it through `as unknown as`.
//
// WHY ~20 GREEN AUTH TESTS COULD NOT HAVE CAUGHT IT
//
// Every one of them imports the bare `authApp` sub-app and hand-builds an env. Production
// runs that app INSIDE the wrapper, and a hand-built env never carries the injected
// binding. So the tests were green about a composition production does not run.
//
// The decisive test below therefore does not ask the library to inject anything: it puts a
// self-referential object on the reserved name itself — the exact hazard shape — and
// requires the route to survive it. That keeps biting even if the library stops injecting,
// changes the name, or is replaced.
//
// STILL OPEN, deliberately not papered over: nothing here exercises src/index.ts (the
// deployed Hono-inside-OAuthProvider composition), because it transitively imports
// 'cloudflare:workers', which plain Vitest cannot load. That is the structural reason this
// class of defect is invisible to the suite, and it outlives this fix. Filed separately —
// this file closes the bug, not the blind spot.

import { describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-client-secret',
    SESSIONS: kv(),
    ...overrides,
  } as unknown as Env
}

/** The shape the wrapper actually puts on env.OAUTH_PROVIDER: helpers -> env -> helpers. */
function circularHelpersBinding(): Record<string, unknown> {
  const helpers: Record<string, unknown> = {}
  helpers.env = { OAUTH_PROVIDER: helpers }
  return helpers
}

const login = (env: Env) => authApp.request('https://pot.test/login', {}, env)

describe('GET /auth/login — OAUTH_PROVIDER name collision (production 500)', () => {
  it('THE DEFECT: survives a circular object on the reserved OAUTH_PROVIDER name', async () => {
    const res = await login(makeEnv({ OAUTH_PROVIDER: circularHelpersBinding() }))
    // Asserting the exact outcome, not merely `not 500`: a 400 unsupported_provider would
    // also be "not 500" while still meaning the binding was misread as configuration.
    expect(res.status).toBe(302)
  })

  it('redirects to Google consent carrying the configured client_id and state', async () => {
    const res = await login(makeEnv({ OAUTH_PROVIDER: circularHelpersBinding() }))
    const location = new URL(res.headers.get('location') ?? '')
    expect(`${location.origin}${location.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(location.searchParams.get('client_id')).toBe('test-client-id.apps.googleusercontent.com')
    expect(location.searchParams.get('redirect_uri')).toBe('https://pot.test/auth/callback')
    expect(location.searchParams.get('state')).toBeTruthy()
  })

  it('reads IDP_PROVIDER, and telegram still reaches the unsupported branch', async () => {
    const res = await login(makeEnv({ IDP_PROVIDER: 'telegram', OAUTH_PROVIDER: circularHelpersBinding() }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'unsupported_provider', provider: 'telegram' })
  })

  it('FAIL CLOSED: an unrecognised IDP_PROVIDER is refused, not coerced to google', async () => {
    // The tempting fix was `=== 'telegram' ? 'telegram' : 'google'`, which would turn a
    // config typo into a silently-enabled Google login — a fail-open added while fixing a
    // crash. An unknown value must still reach unsupported_provider, and the body must be
    // renderable, because the crash was IN the error path.
    const res = await login(makeEnv({ IDP_PROVIDER: 'githbu' }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'unsupported_provider', provider: 'githbu' })
  })

  it('an unset IDP_PROVIDER still defaults to google', async () => {
    const res = await login(makeEnv())
    expect(res.status).toBe(302)
  })

  it('missing client id reports oauth_not_configured rather than crashing', async () => {
    const res = await login(makeEnv({ OAUTH_CLIENT_ID: undefined }))
    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({ error: 'oauth_not_configured' })
  })
})
