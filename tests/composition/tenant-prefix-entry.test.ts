// mupot#1928 — through the DEPLOYED composition (src/index.ts default fetch): the entry wrapper
// re-roots a path-routed tenant's page + redirect, and a forged prefix header on a direct request
// changes nothing.

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

const env = {
  TENANT_SLUG: 'mumega',
  BRAND: 'mupot',
  IDP_PROVIDER: 'google',
  OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
  OAUTH_CLIENT_SECRET: 'test-secret',
  PUBLIC_ORIGIN: 'https://mupot.mumega.com',
  SESSIONS: kv(),
  OAUTH_KV: kv(),
} as never

describe('tenant prefix through the real entry point', () => {
  it('/t/mumega/auth/login: redirect_uri stays the ROOT callback (home alias)', async () => {
    const res = await worker.fetch(new Request('https://mupot.mumega.com/t/mumega/auth/login'), env, ctx)
    expect(res.status).toBe(302)
    const loc = new URL(res.headers.get('location') ?? '')
    expect(loc.searchParams.get('redirect_uri')).toBe('https://mupot.mumega.com/auth/callback')
  })

  it('a direct request with a forged prefix header is not re-rooted', async () => {
    const res = await worker.fetch(
      new Request('https://mupot.mumega.com/auth/login', { headers: { 'x-mupot-path-prefix': '/t/attackerpot' } }),
      env,
      ctx,
    )
    expect(res.status).toBe(302)
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('redirect_uri')).toBe('https://mupot.mumega.com/auth/callback')
  })

  it('a prefixed signed-out page and redirect are re-rooted by the wrapper', async () => {
    const page = await worker.fetch(new Request('https://mupot.mumega.com/t/mumega/'), env, ctx)
    const ct = page.headers.get('content-type') ?? ''
    if (page.status === 200 && ct.includes('text/html')) {
      const text = await page.text()
      expect(text).toContain('__MUPOT_BASE')
      expect([...text.matchAll(/\s(?:href|action)="(\/(?!\/)[^"]*)"/g)].filter((m) => !m[1].startsWith('/t/mumega')).map((m) => m[1])).toEqual([])
    } else {
      expect(page.status).toBe(302)
      expect(page.headers.get('location')?.startsWith('/t/mumega/')).toBe(true)
    }
    const redir = await worker.fetch(new Request('https://mupot.mumega.com/t/mumega/account'), env, ctx)
    expect(redir.status).toBe(302)
    expect(redir.headers.get('location')).toBe('/t/mumega/auth/login')
  })
})
