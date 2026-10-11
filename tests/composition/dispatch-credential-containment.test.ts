// Through the deployed composition (src/index.ts default fetch): the tenant HOSTNAME branch
// goes through the own-origin forward policy, and the `/t/` door fails closed for any name
// the pot registry does not list. No DB binding on purpose: with none, `/t/` must refuse
// without consulting the dispatch namespace.

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

function envCapturing() {
  const seen: Request[] = []
  const asked: string[] = []
  const env = {
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    IDP_PROVIDER: 'google',
    OAUTH_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-secret',
    PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    SESSIONS: kv(),
    OAUTH_KV: kv(),
    DISPATCHER: {
      get: (name: string) => {
        asked.push(name)
        return {
          fetch: async (request: Request) => {
            seen.push(request)
            const r = new Response('ok')
            r.headers.append('set-cookie', 'own=1; Path=/')
            r.headers.append('set-cookie', 'planted=1; Domain=mupot.mumega.com; Path=/')
            return r
          },
        }
      },
    },
  }
  return { env: env as never, seen, asked }
}

describe('hostname branch through the real entry point', () => {
  it('drops gateway identity headers, keeps the tenant\'s own, preserves cf, drops Domain cookies', async () => {
    const { env, seen } = envCapturing()
    const res = await worker.fetch(
      new Request('https://gaf.mupot.mumega.com/page', {
        headers: {
          cookie: 'own=1',
          authorization: 'Bearer tenant',
          'mcp-session-id': 'sid',
          'cf-access-jwt-assertion': 'jwt',
          'cf-access-client-id': 'id',
          'x-mupot-seat': 'seat',
          'proxy-authorization': 'Basic x',
        },
        cf: { colo: 'TST', country: 'CA' },
      } as RequestInit),
      env,
      ctx,
    )
    expect(seen).toHaveLength(1)
    const fwd = seen[0]
    for (const name of ['cf-access-jwt-assertion', 'cf-access-client-id', 'x-mupot-seat', 'proxy-authorization']) {
      expect(fwd.headers.has(name), name).toBe(false)
    }
    expect(fwd.headers.get('cookie')).toBe('own=1')
    expect(fwd.headers.get('authorization')).toBe('Bearer tenant')
    expect(fwd.headers.get('mcp-session-id')).toBe('sid')
    expect(fwd.cf?.colo).toBe('TST')
    const cookies = (res.headers as Headers & { getSetCookie(): string[] }).getSetCookie()
    expect(cookies).toEqual(['own=1; Path=/'])
  })
})

describe('/t/ door through the real entry point', () => {
  it.each(['/t/agent-project/', '/t/gaf/mcp'])('%s is refused when the registry cannot list it', async (path) => {
    const { env, asked } = envCapturing()
    const res = await worker.fetch(new Request(`https://mupot.mumega.com${path}`), env, ctx)
    expect(res.status).toBe(404)
    expect(asked).toEqual([])
  })
})
