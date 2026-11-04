// Non-canonical forms of the OAuth-owned routes, through the REAL entry point (src/index.ts default
// fetch, OAuthProvider wrapper) inside workerd. The provider matches the raw path; Hono decodes it.
// Every non-canonical form must be refused exactly like the canonical request is gated, never answered
// by the app behind the provider. Canonical requests (OAuth token, member bearer) keep working.
import { applyD1Migrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { OAUTH_API_ROUTES } from '../../src/oauth-canonical-path'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const testEnv = cfEnv as unknown as { MUPOT_DB: D1Database; TEST_MIGRATIONS: never }
const MEMBER_TOKEN = 'member-bearer-token-0123456789abcdef'

async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string, opts?: unknown) => {
      const v = store.get(k) ?? null
      const wantsJson = typeof opts === 'string' ? opts === 'json' : (opts as { type?: string } | undefined)?.type === 'json'
      return v !== null && wantsJson ? JSON.parse(v) : v
    },
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  }
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.MUPOT_DB, testEnv.TEST_MIGRATIONS)
  await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO members (id, email, display_name, status, tenant) VALUES ('mbr-1', 'm@example.test', 'M', 'active', 'mumega')")
  await testEnv.MUPOT_DB.exec(`INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-1', 'mbr-1', '${await sha256Hex(MEMBER_TOKEN)}', 'x', 'workspace', datetime('now'), 'mumega')`)
}, 120_000)

const env = () =>
  ({
    DB: testEnv.MUPOT_DB,
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    PUBLIC_ORIGIN: 'https://pot.test',
    IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-secret',
    SESSIONS: kv(),
    OAUTH_KV: kv(),
  }) as never

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

const post = (path: string, body = initialize, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://pot.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }), env(), ctx)
const get = (path: string) => worker.fetch(new Request(`https://pot.test${path}`), env(), ctx)

// Non-canonical spellings of one canonical route. Each letter of the route, both hex cases, all letters,
// a doubly-encoded form, case, doubled separators, and the tenant-addressed forms.
function variantsOf(route: string): string[] {
  const out = new Set<string>()
  const letters = [...route].map((ch, i) => ({ ch, i })).filter((x) => /[a-z]/i.test(x.ch))
  for (const { ch, i } of letters) {
    const hex = ch.charCodeAt(0).toString(16)
    for (const h of new Set([hex, hex.toUpperCase()])) out.add(route.slice(0, i) + '%' + h + route.slice(i + 1))
    out.add(route.slice(0, i) + '%25' + hex + route.slice(i + 1))
  }
  out.add([...route].map((ch) => (/[a-z]/i.test(ch) ? '%' + ch.charCodeAt(0).toString(16) : ch)).join(''))
  out.add(route.toUpperCase())
  out.add('/' + route)
  out.add('/%2f' + route.slice(1))
  out.add('/' + route.slice(1).replace(/\//g, '%2f'))
  return [...out].filter((v) => v !== route)
}

const OWNED_ROUTES = [
  ...OAUTH_API_ROUTES,
  '/mcp/profile/needs-you',
  '/mcp/tools',
  '/mcp/health',
  '/token',
  '/register',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/mcp',
]

describe('non-canonical path forms are treated like the canonical path', () => {
  it('the protected prefix list is what the test expects (a new prefix must be added here)', () => {
    expect([...OAUTH_API_ROUTES]).toEqual(['/mcp'])
  })

  // Independent of the module under test: what the provider will itself gate for a given raw path.
  const afterTenant = (p: string) => /^\/t\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?(\/.*)?$/i.exec(p)?.[1] ?? p
  const gatedByProvider = (p: string) => afterTenant(p).startsWith('/mcp')
  const publicMetadata = (p: string) => /^\/\.well-known\/oauth-protected-resource(\/|$)/.test(afterTenant(p))

  for (const route of OWNED_ROUTES) {
    const forms = [
      ...variantsOf(route),
      ...variantsOf(route).map((v) => `/t/mumega${v}`),
      ...variantsOf('/t/mumega').filter((v) => !/^\/t\/mumega$/i.test(v)).map((v) => `${v}${route}`),
    ]
    it(`${route}: ${forms.length} non-canonical forms are refused (or gated by the provider) on POST and GET`, async () => {
      const canonicalForms = new Set([route, `/t/mumega${route}`])
      for (const form of forms.filter((f) => !canonicalForms.has(f))) {
        for (const res of [await post(form), await get(form)]) {
          const text = await res.text()
          if (gatedByProvider(form)) {
            // Still starts with the protected prefix: the provider sees it, and gates it like the canonical path.
            expect(res.status, form).toBe(401)
          } else if (publicMetadata(form)) {
            // Public discovery document by design; the provider serves it.
            expect(text, form).not.toContain('non_canonical_path')
          } else {
            expect(res.status, form).toBe(400)
            expect(text, form).toContain('non_canonical_path')
          }
        }
      }
    })
  }

  it('no non-canonical form answers a pre-auth method (initialize / tools list) the canonical path withholds', async () => {
    const canonical = await post('/mcp')
    expect(canonical.status).toBe(401)
    const t = await get('/mcp/tools')
    expect(t.status).toBe(401)
    for (const form of ['/%6dcp', '/m%63p', '/mc%70', '/%6D%63%70', '/t/mumega/%6dcp', '/%6dcp/profile/needs-you']) {
      const res = await post(form)
      expect(res.status, form).not.toBe(200)
      expect(await res.text(), form).not.toContain('protocolVersion')
    }
    expect((await get('/%6dcp/tools')).status).not.toBe(200)
  })
})

describe('the entry point refuses before tenant routing', () => {
  it('a non-canonical form addressed to another tenant is refused here, before any dispatch', async () => {
    for (const form of ['/t/other-pot/%6dcp', '/t/other-pot/m%63p/profile/needs-you', '/t/other-pot//mcp']) {
      const res = await post(form)
      expect(res.status, form).toBe(400)
      expect(await res.text(), form).toContain('non_canonical_path')
    }
  })
})

describe('canonical paths keep working', () => {
  it('unauthenticated canonical requests keep their 401 with the discovery pointer', async () => {
    for (const path of ['/mcp', '/t/mumega/mcp', '/mcp/profile/needs-you']) {
      const res = await post(path)
      expect(res.status, path).toBe(401)
      expect(res.headers.get('www-authenticate') ?? '', path).toContain('resource_metadata=')
    }
  })

  it('a member bearer on the canonical path is served, with and without the tenant address', async () => {
    for (const path of ['/mcp', '/t/mumega/mcp']) {
      const res = await post(path, listTools, { authorization: `Bearer ${MEMBER_TOKEN}` })
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain('tools')
    }
  })

  it('a member bearer on a non-canonical form is refused before it is read', async () => {
    const res = await post('/%6dcp', listTools, { authorization: `Bearer ${MEMBER_TOKEN}` })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('non_canonical_path')
  })

  it('discovery documents stay served on their canonical paths', async () => {
    expect((await get('/.well-known/oauth-authorization-server')).status).toBe(200)
    expect((await get('/.well-known/oauth-protected-resource/mcp')).status).toBe(200)
    expect((await get('/health')).status).toBe(200)
  })

  it('ordinary paths with escapes in them are not affected', async () => {
    for (const path of ['/api%2Fhealth', '/health%20x', '/%61pi/health']) {
      const res = await get(path)
      expect(res.status, path).not.toBe(400)
    }
  })
})
