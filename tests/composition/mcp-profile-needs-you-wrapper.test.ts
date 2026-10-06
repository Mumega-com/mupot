// tests/composition/mcp-profile-needs-you-wrapper.test.ts — the curated ChatGPT profile door
// THROUGH THE REAL OAuthProvider wrapper (workerd). Sub-app tests cannot see this seam:
// the 401 + resource_metadata pointer and the well-known discovery document are produced by
// the wrapper, not by mcpApp.
import { applyD1Migrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext

function kv() {
  const store = new Map<string, string>()
  return {
    // The provider reads with { type: 'json' }; honour it (the sibling tests' stub ignores it).
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

// A REAL D1 (Miniflare, workerd) carrying the committed migration chain — see
// vitest.composition.config.ts. One live directory seat (member + token) is seeded with real
// SQL; capability resolution, token liveness and presence all run against real tables.
const testEnv = cfEnv as unknown as { MUPOT_DB: D1Database; TEST_MIGRATIONS: never }

beforeAll(async () => {
  await applyD1Migrations(testEnv.MUPOT_DB, testEnv.TEST_MIGRATIONS)
  // exec() takes one statement per line.
  await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO members (id, email, display_name, status, tenant) VALUES ('mbr-1', 'm@example.test', 'M', 'active', 'mumega')")
  await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('tok-1', 'mbr-1', 'hash-not-a-bearer', 'oauth', 'directory', datetime('now'), 'mumega')")
}, 120_000) // applying the whole migration chain to a fresh D1 is slow on a loaded runner

const env = () =>
  ({
    DB: testEnv.MUPOT_DB,
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-secret',
    SESSIONS: kv(),
    OAUTH_KV: kv(),
  }) as never

const PROFILE_URL = 'https://pot.test/mcp/profile/needs-you'
const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })

describe('/mcp/profile/needs-you through the OAuthProvider wrapper', () => {
  it('unauthenticated POST is 401 and its resource_metadata points at the PROFILE path', async () => {
    const res = await worker.fetch(
      new Request(PROFILE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: listBody }),
      env(),
      ctx,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate') ?? '').toContain(
      'resource_metadata="https://pot.test/.well-known/oauth-protected-resource/mcp/profile/needs-you"',
    )
  })

  it('unauthenticated /mcp tools/call is 401 WITH WWW-Authenticate resource_metadata (#1667: OAuth discovery must not regress)', async () => {
    const res = await worker.fetch(
      new Request('https://pot.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'status', arguments: {} } }),
      }),
      env(),
      ctx,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate') ?? '').toContain(
      'resource_metadata="https://pot.test/.well-known/oauth-protected-resource/mcp"',
    )
  })

  it('an invalid bearer is 401 with the same pointer, never a tool list', async () => {
    const res = await worker.fetch(
      new Request(PROFILE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
        body: listBody,
      }),
      env(),
      ctx,
    )
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('boot_context')
  })

  it('protected-resource metadata for the profile path names the profile URL as the resource', async () => {
    const res = await worker.fetch(
      new Request('https://pot.test/.well-known/oauth-protected-resource/mcp/profile/needs-you'),
      env(),
      ctx,
    )
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { resource?: string; authorization_servers?: string[] }
    expect(doc.resource).toBe(PROFILE_URL)
    expect(doc.authorization_servers?.length).toBeGreaterThan(0)
  })

  it('the existing /mcp discovery is untouched: still points at /mcp', async () => {
    const meta = await worker.fetch(new Request('https://pot.test/.well-known/oauth-protected-resource/mcp'), env(), ctx)
    expect(((await meta.json()) as { resource?: string }).resource).toBe('https://pot.test/mcp')
    const res = await worker.fetch(
      new Request('https://pot.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: listBody }),
      env(),
      ctx,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate') ?? '').toContain(
      'resource_metadata="https://pot.test/.well-known/oauth-protected-resource/mcp"',
    )
  })
})

// ── a REAL minted token, through the real provider ───────────────────────────
interface OAuthHelpersLike {
  createClient(o: Record<string, unknown>): Promise<{ clientId: string }>
  completeAuthorization(o: Record<string, unknown>): Promise<{ redirectTo: string }>
}

async function mintToken(resource: string): Promise<{ token: string; e: never }> {
  const e = env()
  await worker.fetch(new Request('https://pot.test/health'), e, ctx) // the wrapper injects OAUTH_PROVIDER helpers
  const helpers = (e as unknown as { OAUTH_PROVIDER: OAuthHelpersLike }).OAUTH_PROVIDER
  const client = await helpers.createClient({
    redirectUris: ['https://client.test/cb'],
    clientName: 'profile-test',
    tokenEndpointAuthMethod: 'none',
  })
  const verifier = 'v'.repeat(64)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const { redirectTo } = await helpers.completeAuthorization({
    request: {
      responseType: 'code',
      clientId: client.clientId,
      redirectUri: 'https://client.test/cb',
      scope: [],
      state: 's',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      resource,
    },
    userId: 'mbr-1',
    metadata: {},
    scope: [],
    props: { memberId: 'mbr-1', tokenId: 'tok-1', email: null, channel: 'directory' },
  })
  const code = new URL(redirectTo).searchParams.get('code')!
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://client.test/cb',
    client_id: client.clientId,
    code_verifier: verifier,
    resource,
  })
  // Same env object: the KV holding the grant is per-env in this test.
  const tokRes = await worker.fetch(
    new Request('https://pot.test/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form }),
    e,
    ctx,
  )
  expect(tokRes.status).toBe(200)
  const token = ((await tokRes.json()) as { access_token: string }).access_token
  return { token, e }
}

const rpcAt = (path: string, e: never, token: string, method = 'tools/list', params?: unknown) =>
  worker.fetch(
    new Request(`https://pot.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    e,
    ctx,
  )

describe('with a real minted token (profile-audience), through the wrapper', () => {
  it('exact profile path: exactly 8 annotated tools; a non-profile tool call is refused', async () => {
    const { token, e } = await mintToken(PROFILE_URL)
    const list = await rpcAt('/mcp/profile/needs-you', e, token)
    expect(list.status).toBe(200)
    const tools = ((await list.json()) as { result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } }).result.tools
    expect(tools).toHaveLength(8)
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
    const call = await rpcAt('/mcp/profile/needs-you', e, token, 'tools/call', { name: 'status', arguments: {} })
    expect(call.status).toBe(403)
    expect(JSON.stringify(await call.json())).toContain('tool_not_in_profile')
  })

  for (const path of ['/mcp/profile/needs-you/', '/mcp/profile/needs-you/x', '/mcp/profile/needs-you/..%2F..']) {
    it(`${path} is a 404 — never the full /mcp`, async () => {
      const { token, e } = await mintToken(PROFILE_URL)
      const res = await rpcAt(path, e, token)
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('task_create')
      const call = await rpcAt(path, e, token, 'tools/call', { name: 'status', arguments: {} })
      expect(call.status).toBe(404)
    })
  }

  it('the provider itself refuses this profile-audience token on /mcp (audience mismatch)', async () => {
    const { token, e } = await mintToken(PROFILE_URL)
    const res = await rpcAt('/mcp', e, token)
    expect(res.status).toBe(401)
  })
})

describe('with a real minted token (/mcp-audience), through the wrapper', () => {
  it('/mcp is unchanged: full un-annotated registry; the same token on the profile path gets the 8-tool list', async () => {
    const { token, e } = await mintToken('https://pot.test/mcp')
    const full = await rpcAt('/mcp', e, token)
    expect(full.status).toBe(200)
    const fullTools = ((await full.json()) as { result: { tools: Array<Record<string, unknown>> } }).result.tools
    expect(fullTools.length).toBeGreaterThan(100)
    expect(fullTools.some((t) => 'annotations' in t)).toBe(false)
    const prof = await rpcAt('/mcp/profile/needs-you', e, token)
    expect(prof.status).toBe(200)
    expect(((await prof.json()) as { result: { tools: unknown[] } }).result.tools).toHaveLength(8)
    // Path-prefix audience matching: this token is also accepted on the reserved-namespace
    // sub-paths by the provider, but they answer 404, not the full /mcp.
    expect((await rpcAt('/mcp/profile/needs-you/x', e, token)).status).toBe(404)
  })
})
