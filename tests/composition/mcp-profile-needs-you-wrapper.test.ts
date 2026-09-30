// tests/composition/mcp-profile-needs-you-wrapper.test.ts — the curated ChatGPT profile door
// THROUGH THE REAL OAuthProvider wrapper (workerd). Sub-app tests cannot see this seam:
// the 401 + resource_metadata pointer and the well-known discovery document are produced by
// the wrapper, not by mcpApp.
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

const env = () =>
  ({
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
