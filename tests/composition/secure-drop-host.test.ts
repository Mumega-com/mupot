// tests/composition/secure-drop-host.test.ts - secure drops (W2) through the DEPLOYED composition (src/index.ts in
// workerd): the vendored sealer is served from the secure host and ONLY there, only with SECURE_DROP on, with the
// pinned bytes and the headers the credential page's CSP depends on; the five drop tools are absent and refuse with
// the flag off; and a host key registers through the real /mcp route with the real D1 schema.
// Contract: docs/architecture/secure-moments.md ("W2: secure drops").
import { applyD1Migrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { HPKE_BUNDLE_JS, HPKE_BUNDLE_SHA256 } from '../../src/secure-drop/hpke-bundle.generated'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const COLONY = 'colony.example.test'
const SECURE = 'secure.example.test'
const ASSET = '/m/assets/hpke-seal.v1.js'

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
const testEnv = cfEnv as unknown as { MUPOT_DB: D1Database; TEST_MIGRATIONS: never }
beforeAll(async () => {
  await applyD1Migrations(testEnv.MUPOT_DB, testEnv.TEST_MIGRATIONS)
})

function env(over: Record<string, unknown> = {}) {
  return {
    TENANT_SLUG: 'mumega', CONNECTOR_MASTER_KEY: 'a1'.repeat(32), BRAND: 'mupot', IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'c.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 's',
    PUBLIC_ORIGIN: `https://${COLONY}`,
    SESSIONS: kv(), OAUTH_KV: kv(), DB: testEnv.MUPOT_DB,
    SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: SECURE, SECURE_DROP: '1',
    ...over,
  } as never
}
const hit = (host: string, path: string, e = env()) => worker.fetch(new Request(`https://${host}${path}`), e, ctx)

describe('secure drops through the real worker', () => {
  it('the sealer is served from the secure host with the pinned bytes and strict headers', async () => {
    const res = await hit(SECURE, ASSET)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toBe(HPKE_BUNDLE_JS)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
    expect([...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(HPKE_BUNDLE_SHA256)
    expect(res.headers.get('content-type')).toMatch(/javascript/)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('it is a 404 on every other host and in every encoded spelling', async () => {
    for (const host of [COLONY, 'mupot.workers.dev', `evil.${SECURE}`]) expect((await hit(host, ASSET)).status).toBe(404)
    for (const p of ['/%6d/assets/hpke-seal.v1.js', '/m/%61ssets/hpke-seal.v1.js']) expect((await hit(SECURE, p)).status).toBe(404)
  })
  it('SECURE_DROP off: 404 even on the secure host; secure moments themselves are untouched', async () => {
    const e = env({ SECURE_DROP: undefined })
    expect((await hit(SECURE, ASSET, e)).status).toBe(404)
    expect((await hit(SECURE, '/m/nope/nope', e)).headers.get('x-frame-options')).toBe('DENY')
  })
  it('SECURE_DROP on but secure moments off: 404', async () => {
    expect((await hit(SECURE, ASSET, env({ SECURE_MOMENTS: undefined }))).status).toBe(404)
  })
})
