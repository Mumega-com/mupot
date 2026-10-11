// tests/composition/access-approval-host.test.ts — the approval host gate, through the DEPLOYED composition
// (src/index.ts wrapped in OAuthProvider, in workerd). The Access cookie is host-scoped, so the dedicated
// approval hostname must serve ONLY /approve/*, and /approve/* must exist on no other host. The gate is the
// first statement of fetch: these requests never reach tenant routing, MCP, preview or the dashboard.
// Contract: docs/architecture/access-approve-page.md.
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const COLONY = 'colony.example.test'
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

function env(over: Record<string, unknown> = {}) {
  return {
    TENANT_SLUG: 'mumega', BRAND: 'mupot', IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'c.apps.googleusercontent.com', OAUTH_CLIENT_SECRET: 's',
    PUBLIC_ORIGIN: `https://${COLONY}`,
    SESSIONS: kv(), OAUTH_KV: kv(),
    ACCESS_APPROVE_ENABLED: '1', ACCESS_TEAM_DOMAIN: 'acme.cloudflareaccess.com', ACCESS_AUD: 'aud', ACCESS_CANONICAL_HOST: APPROVAL,
    ...over,
  } as never
}

const hit = (host: string, path: string, method = 'GET', e = env()) =>
  worker.fetch(new Request(`https://${host}${path}`, { method }), e, ctx)

describe('approval host gate (real worker)', () => {
  it.each(['/preview/x', '/preview/x/index.html', '/mcp', '/', '/health', '/auth/login', '/api/fleet', '/.well-known/oauth-authorization-server', '/token', '/register', '/authorize', '/invite/x', '/dashboard', '/%61pi/fleet'])(
    'approval host + %s => 404 and nothing behind it runs', async (path) => {
      const res = await hit(APPROVAL, path)
      expect(res.status).toBe(404)
      expect(await res.text()).toBe('Not found')
    },
  )
  it('approval host + POST /mcp => 404', async () => {
    expect((await hit(APPROVAL, '/mcp', 'POST')).status).toBe(404)
  })
  it('colony host + /approve/x (any spelling, any method) => 404', async () => {
    for (const p of ['/approve/seed/x', '/approve/elevation/x', '/approve', '/approve/', '/%61pprove/seed/x']) {
      expect((await hit(COLONY, p)).status).toBe(404)
    }
    expect((await hit(COLONY, '/approve/seed/x', 'POST')).status).toBe(404)
  })
  it('approval host + /approve/* reaches the page (403 without an Access JWT, not 404)', async () => {
    const res = await hit(APPROVAL, '/approve/seed/x')
    expect(res.status).toBe(403)
  })
  it('colony host keeps serving its own routes while the page is on', async () => {
    expect((await hit(COLONY, '/mcp/tools')).status).not.toBe(404)
  })
  it('misconfigured (canonical host == colony host): the page never enables; /approve is 404 on the colony host', async () => {
    const e = env({ ACCESS_CANONICAL_HOST: COLONY })
    expect((await hit(COLONY, '/approve/seed/x', 'GET', e)).status).toBe(404)
  })
  it('approval host + /approve/* never reaches tenant routing or any user Worker (the Access cookie stays put)', async () => {
    const calls: string[] = []
    const DISPATCHER = { get: (name: string) => { calls.push(name); return { fetch: async () => new Response('USER WORKER') } } }
    const e = env({ DISPATCHER, DEFAULT_POT_HOST_SUFFIX: 'pots.example.test' })
    const req = new Request(`https://${APPROVAL}/approve/seed/x`, { headers: { cookie: 'CF_Authorization=jwt' } })
    const res = await worker.fetch(req, e, ctx)
    expect(await res.text()).not.toBe('USER WORKER')
    expect(res.status).toBe(403)
    expect(calls).toEqual([])
  })
  it('misconfigured (approval host UNDER the colony domain): the page never enables, so no approve host exists', async () => {
    const e = env({ ACCESS_CANONICAL_HOST: `approve.${COLONY}` })
    expect((await hit(`approve.${COLONY}`, '/approve/seed/x', 'GET', e)).status).toBe(404)
    expect((await hit(COLONY, '/approve/seed/x', 'GET', e)).status).toBe(404)
  })
  it('flag off: the approval host is not special (gate inert) and /approve is still 404', async () => {
    const e = env({ ACCESS_APPROVE_ENABLED: undefined })
    expect((await hit(COLONY, '/approve/seed/x', 'GET', e)).status).toBe(404)
  })
})
