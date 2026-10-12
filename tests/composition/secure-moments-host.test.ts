// tests/composition/secure-moments-host.test.ts — the secure-moments host gate, through the DEPLOYED composition
// (src/index.ts wrapped in OAuthProvider, in workerd). The dedicated secure hostname serves ONLY /m/*, and /m/*
// exists on no other host. The gate is the first statement of fetch: these requests never reach tenant routing,
// MCP, preview or the dashboard. Contract: docs/architecture/secure-moments.md.
import { applyD1Migrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { verifyAssertion, verifyRegistration } from '../../src/secure-moments/webauthn'
import { SoftAuthenticator } from '../helpers/webauthn-authenticator'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const COLONY = 'colony.example.test'
const SECURE = 'secure.example.test'
const APPROVAL = 'approve.example.test'

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

// The REAL committed migration chain on the local workerd D1 simulator (never a hand-faked D1).
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
    SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: SECURE,
    ...over,
  } as never
}

const hit = (host: string, path: string, method = 'GET', e = env()) =>
  worker.fetch(new Request(`https://${host}${path}`, { method }), e, ctx)

describe('secure-moments host gate (real worker)', () => {
  it.each(['/preview/x', '/mcp', '/', '/health', '/auth/login', '/api/fleet', '/.well-known/oauth-authorization-server', '/token', '/register', '/authorize', '/invite/x', '/dashboard', '/%61pi/fleet', '/approve/seed/x', '/%6d/a/b'])(
    'secure host + %s => 404 and nothing behind it runs', async (path) => {
      const res = await hit(SECURE, path)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('Not found')
    },
  )
  it('secure host + POST /mcp => 404', async () => {
    expect((await hit(SECURE, '/mcp', 'POST')).status).toBe(404)
  })
  it('colony host + /m/* (any spelling, any method) => 404', async () => {
    for (const p of ['/m/a/b', '/m/enrol/x', '/m', '/m/', '/%6d/a/b', '/%6D/a/b', '/%256d/a/b']) {
      expect((await hit(COLONY, p)).status).toBe(404)
    }
    expect((await hit(COLONY, '/m/a/b/decide', 'POST')).status).toBe(404)
    expect((await hit('mupot.workers.dev', '/m/a/b')).status).toBe(404)
  })
  it('secure host + /m/* reaches the page (unknown link is the moments app\'s own 404 page, with its security headers)', async () => {
    const res = await hit(SECURE, '/m/nope/nope')
    expect(res.status).toBe(404)
    expect(res.headers.get('x-frame-options')).toBe('DENY') // only the moments app sets this
    expect(res.headers.get('set-cookie')).toBeNull()
  })
  it('colony host keeps serving its own routes while secure moments are on', async () => {
    expect((await hit(COLONY, '/mcp/tools')).status).not.toBe(404)
  })
  it('flag off: /m/* is a 404 everywhere, including the would-be secure host, and other routes are untouched', async () => {
    const e = env({ SECURE_MOMENTS: undefined })
    expect((await hit(SECURE, '/m/a/b', 'GET', e)).status).toBe(404)
    expect((await hit(COLONY, '/m/a/b', 'GET', e)).status).toBe(404)
    expect((await hit(COLONY, '/mcp/tools', 'GET', e)).status).not.toBe(404)
  })
  it('misconfigured (secure host == colony host, or UNDER it, or == the Access host): never enables', async () => {
    for (const e of [env({ SECURE_MOMENTS_HOST: COLONY }), env({ SECURE_MOMENTS_HOST: `m.${COLONY}` }), env({ ACCESS_CANONICAL_HOST: SECURE })]) {
      expect((await hit(COLONY, '/m/a/b', 'GET', e)).status).toBe(404)
      expect((await hit(SECURE, '/m/a/b', 'GET', e)).status).toBe(404)
      expect((await hit(`m.${COLONY}`, '/m/a/b', 'GET', e)).status).toBe(404)
    }
    expect((await hit(COLONY, '/mcp/tools', 'GET', env({ SECURE_MOMENTS_HOST: COLONY }))).status).not.toBe(404)
  })
  it('secure host + /m/* never reaches tenant routing or any user Worker', async () => {
    const calls: string[] = []
    const DISPATCHER = { get: (name: string) => { calls.push(name); return { fetch: async () => new Response('USER WORKER') } } }
    const e = env({ DISPATCHER, DEFAULT_POT_HOST_SUFFIX: 'pots.example.test' })
    const res = await worker.fetch(new Request(`https://${SECURE}/m/x/y`, { headers: { cookie: 'a=b' } }), e, ctx)
    expect(await res.text()).not.toBe('USER WORKER')
    expect(calls).toEqual([])
  })
  it('both gates coexist: the Access approval host still serves /approve and 404s /m', async () => {
    const e = env({ ACCESS_APPROVE_ENABLED: '1', ACCESS_TEAM_DOMAIN: 'acme.cloudflareaccess.com', ACCESS_AUD: 'aud', ACCESS_CANONICAL_HOST: APPROVAL })
    expect((await hit(APPROVAL, '/approve/seed/x', 'GET', e)).status).toBe(403)
    expect((await hit(APPROVAL, '/m/a/b', 'GET', e)).status).toBe(404)
    expect((await hit(SECURE, '/approve/seed/x', 'GET', e)).status).toBe(404)
  })
  it('the moments app has no auth surface beyond its own routes (no cookie, bearer or OAuth route exists on the secure host)', async () => {
    const res = await worker.fetch(new Request(`https://${SECURE}/m/enrol/x/finish`, { method: 'POST', headers: { authorization: 'Bearer x', cookie: 'sid=1', origin: `https://${SECURE}`, 'content-type': 'application/json' }, body: '{}' }), env(), ctx)
    expect([403, 404]).toContain(res.status)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})

describe('WebAuthn verification runs on the Workers runtime (workerd WebCrypto)', () => {
  const want = (challenge: string) => ({ challenge, origin: `https://${SECURE}`, rpId: SECURE })
  it('registers an ES256 passkey and verifies / refuses assertions', async () => {
    const a = await SoftAuthenticator.create()
    const reg = await verifyRegistration((await a.register({ rpId: SECURE, origin: `https://${SECURE}`, challenge: 'c1' })).response, want('c1'))
    expect(reg.ok).toBe(true)
    if (!reg.ok) return
    const good = await a.assert({ rpId: SECURE, origin: `https://${SECURE}`, challenge: 'c2' })
    expect(await verifyAssertion(good.response, want('c2'), reg.registration.publicKeySpki)).toEqual({ ok: true, signCount: 1 })
    const wrongOrigin = await a.assert({ rpId: SECURE, origin: `https://${COLONY}`, challenge: 'c3' })
    expect(await verifyAssertion(wrongOrigin.response, want('c3'), reg.registration.publicKeySpki)).toEqual({ ok: false, reason: 'origin_mismatch' })
    const stranger = await SoftAuthenticator.create()
    const forged = await stranger.assert({ rpId: SECURE, origin: `https://${SECURE}`, challenge: 'c4' })
    expect(await verifyAssertion(forged.response, want('c4'), reg.registration.publicKeySpki)).toEqual({ ok: false, reason: 'bad_signature' })
  })
})

// ── end to end on the real worker + real D1 (migration 0212 incl. the seed_attach_requests rebuild) ──────────────
describe('enrol and decide through the real worker on the workerd D1 simulator', () => {
  const origin = `https://${SECURE}`
  const post = (path: string, json: unknown) => worker.fetch(new Request(`${origin}${path}`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(json),
  }), env(), ctx)
  const csrfOf = (html: string): string => /data-csrf="([0-9a-f]{64})"/.exec(html)?.[1] ?? ''

  it('a member enrols a passkey, an org admin approves a seed with it, exactly once', async () => {
    const { mintEnrolmentToken, createMoment, loadMoment } = await import('../../src/secure-moments/store')
    const { createSeedRequest, loadSeedRequest } = await import('../../src/access/seed-request')
    const { validateSeed } = await import('../../src/seeds/validate')
    const { keyRequests } = await import('../../src/seeds/apply')
    const e = env() as unknown as import('../../src/types').Env
    await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO org_settings (key, value) VALUES ('billing_state', '{\"tier\":\"scale\"}')")
    await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO users (id, email, role) VALUES ('u-admin', 'admin@x.test', 'owner')")
    await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Admin', 'active', 'mumega')")
    await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id, created_at) VALUES ('hli-1', 'mumega', 'google', 'g-admin', 'admin@x.test', 'mem-admin', datetime('now'))")

    const a = await SoftAuthenticator.create()
    const tok = (await mintEnrolmentToken(e, 'mem-admin', 'hli-1')).token
    const csrf = csrfOf(await (await hit(SECURE, `/m/enrol/${tok}`)).text())
    expect(csrf).toHaveLength(64)
    const opts = (await (await post(`/m/enrol/${tok}/options`, { csrf })).json()) as { publicKey: { challenge: string } }
    const credential = await a.register({ rpId: SECURE, origin, challenge: opts.publicKey.challenge })
    expect((await post(`/m/enrol/${tok}/finish`, { csrf, credential })).status).toBe(200)
    expect((await post(`/m/enrol/${tok}/finish`, { csrf, credential })).status).toBe(409)

    const seedText = [
      'schema: mupot.seed/v1', 'slug: composition-site', 'name: Composition Site', 'kind: site/astro',
      'goal: Prove the secure moment end to end.', 'owner: site-owner', 'repo: https://github.com/example-org/example-site',
    ].join('\n')
    const v = await validateSeed(seedText)
    if (!v.ok) throw new Error('seed')
    const requests = await keyRequests(v.requests)
    const created = await createSeedRequest(e, { requesterMemberId: 'mem-admin', requesterAgentId: null, validated: { seed: v.seed, canonical: v.canonical, seedSha256: v.seedSha256, requests } })
    if (!created.ok) throw new Error('create')
    const m = await createMoment(e, { kind: 'seed_attach', subjectId: created.id, requesterAgentId: null, subjectExpiresAtIso: created.expiresAt })
    if (!m) throw new Error('moment')
    const path = `/m/${m.id}/${m.token}`
    const page = await hit(SECURE, path)
    expect(page.status).toBe(200)
    const dcsrf = csrfOf(await page.text())
    const ch = (await (await post(`${path}/challenge`, { decision: 'approve', csrf: dcsrf })).json()) as { publicKey: { challenge: string } }
    const assertion = await a.assert({ rpId: SECURE, origin, challenge: ch.publicKey.challenge })
    const first = await post(`${path}/decide`, { decision: 'approve', csrf: dcsrf, credential: assertion })
    expect(await first.json()).toMatchObject({ ok: true, title: 'Approved' })
    const ch2 = (await (await hit(SECURE, path)).status) // closed now
    expect(ch2).toBe(410)
    const row = await loadSeedRequest(e, created.id)
    expect(row).toMatchObject({ status: 'applied', decided_via: 'webauthn' })
    expect(await loadMoment(e, m.id)).toMatchObject({ status: 'consumed', decision: 'approve' })
  })
})
