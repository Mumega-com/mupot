// tests/wfp-dispatcher.test.ts — Unit tests for Cloudflare Workers for Platforms dispatch router.

import { describe, it, expect, vi } from 'vitest'
import dispatcher, {
  extractTenantSlug,
  extractPathTenant,
  resolveApexPathTenant,
  routeApexPathTenant,
  type DispatcherEnv,
} from '../src/dispatcher'

describe('WFP Dispatcher Router (extractTenantSlug)', () => {
  it('routes root domain to fallback pot', () => {
    expect(extractTenantSlug('mupot.mumega.com', 'mupot.mumega.com')).toBe('mumega')
    expect(extractTenantSlug('www.mupot.mumega.com', 'mupot.mumega.com')).toBe('mumega')
  })

  it('extracts subdomain tenant slugs cleanly', () => {
    expect(extractTenantSlug('viamar.mupot.mumega.com', 'mupot.mumega.com')).toBe('viamar')
    expect(extractTenantSlug('dnu.mupot.mumega.com', 'mupot.mumega.com')).toBe('dnu')
    expect(extractTenantSlug('dental-near-you.mupot.mumega.com', 'mupot.mumega.com')).toBe('dental-near-you')
  })

  it('handles custom domains by transforming host to slug', () => {
    expect(extractTenantSlug('agents.viamar.ca', 'mupot.mumega.com')).toBe('agents-viamar-ca')
  })
})

describe('apex path tenant /t/{tenant}/{interface}', () => {
  it('parses /t/gaf/mcp into tenant gaf and remainder /mcp', () => {
    expect(extractPathTenant('/t/gaf/mcp')).toEqual({ slug: 'gaf', remainder: '/mcp' })
    expect(extractPathTenant('/t/gaf/mcp/')).toEqual({ slug: 'gaf', remainder: '/mcp/' })
    expect(extractPathTenant('/t/gaf')).toEqual({ slug: 'gaf', remainder: '/' })
    expect(extractPathTenant('/t/gaf/')).toEqual({ slug: 'gaf', remainder: '/' })
  })

  it('ignores paths that are not /t/{tenant}', () => {
    expect(extractPathTenant('/mcp')).toBeNull()
    expect(extractPathTenant('/tasks')).toBeNull()
    expect(extractPathTenant('/t/')).toBeNull()
    expect(extractPathTenant('/tentacles')).toBeNull()
  })

  it('rewrites the home pot onto this Worker so /t/mumega/mcp is /mcp', () => {
    const req = new Request('https://mupot.mumega.com/t/mumega/mcp')
    const resolved = resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')
    expect(resolved?.kind).toBe('home')
    if (resolved?.kind !== 'home') throw new Error('expected home')
    expect(new URL(resolved.request.url).pathname).toBe('/mcp')
    expect(new URL(resolved.request.url).hostname).toBe('mupot.mumega.com')
  })

  it('rewrites a foreign tenant onto the dispatch hostname so /t/gaf/mcp is gaf.mupot.mumega.com/mcp', () => {
    const req = new Request('https://mupot.mumega.com/t/gaf/mcp')
    const resolved = resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')
    expect(resolved?.kind).toBe('dispatch')
    if (resolved?.kind !== 'dispatch') throw new Error('expected dispatch')
    expect(resolved.slug).toBe('gaf')
    expect(new URL(resolved.request.url).hostname).toBe('gaf.mupot.mumega.com')
    expect(new URL(resolved.request.url).pathname).toBe('/mcp')
  })

  it('dispatches a rewritten /t/gaf/mcp request to the gaf user Worker', async () => {
    const mockUserWorkerFetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const mockDispatcher = {
      get: vi.fn().mockReturnValue({ fetch: mockUserWorkerFetch }),
    }
    const env: DispatcherEnv = {
      DISPATCHER: mockDispatcher,
      ROOT_DOMAIN: 'mupot.mumega.com',
    }
    const apex = new Request('https://mupot.mumega.com/t/gaf/mcp', { method: 'POST' })
    const resolved = resolveApexPathTenant(apex, 'mumega', 'mupot.mumega.com')
    if (resolved?.kind !== 'dispatch') throw new Error('expected dispatch')
    const response = await dispatcher.fetch(resolved.request, env)
    expect(mockDispatcher.get).toHaveBeenCalledWith(
      'gaf',
      {},
      { limits: { cpuMs: 50, subRequests: 50 } },
    )
    expect(new URL(mockUserWorkerFetch.mock.calls[0][0].url).pathname).toBe('/mcp')
    expect(response.status).toBe(200)
  })
})

describe('WFP Dispatcher fetch handler', () => {
  it('delegates request to matched tenant user Worker in dispatch namespace', async () => {
    const mockUserWorkerFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, pot: 'viamar' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const mockDispatcher = {
      get: vi.fn().mockReturnValue({
        fetch: mockUserWorkerFetch,
      }),
    }

    const env: DispatcherEnv = {
      DISPATCHER: mockDispatcher,
      ROOT_DOMAIN: 'mupot.mumega.com',
    }

    const request = new Request('https://viamar.mupot.mumega.com/health')
    const response = await dispatcher.fetch(request, env)

    expect(mockDispatcher.get).toHaveBeenCalledWith(
      'viamar',
      {},
      { limits: { cpuMs: 50, subRequests: 50 } },
    )
    expect(mockUserWorkerFetch).toHaveBeenCalledWith(request)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ ok: true, pot: 'viamar' })
  })

  it('returns 404 when user Worker does not exist in dispatch namespace', async () => {
    const mockDispatcher = {
      get: vi.fn().mockImplementation(() => {
        throw new Error('User worker not found in namespace mupot-pots')
      }),
    }

    const env: DispatcherEnv = {
      DISPATCHER: mockDispatcher,
      ROOT_DOMAIN: 'mupot.mumega.com',
    }

    const request = new Request('https://unprovisioned-tenant.mupot.mumega.com/health')
    const response = await dispatcher.fetch(request, env)

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toMatchObject({
      error: 'pot_not_found',
      tenant: 'unprovisioned-tenant',
    })
    expect(body.message).toContain("'unprovisioned-tenant'")
  })
})

describe('apex path tenant gate fix: header strip (Athena 2026-09-04)', () => {
  it('a client tenant header cannot retarget the dispatch isolate', () => {
    const req = new Request('https://mupot.mumega.com/t/gaf/mcp', {
      method: 'POST',
      headers: { 'x-mupot-tenant-slug': 'other', 'x-pot-tenant': 'other' },
    })
    const resolved = resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')
    expect(resolved?.kind).toBe('dispatch')
    if (resolved?.kind !== 'dispatch') throw new Error('expected dispatch')
    expect(resolved.slug).toBe('gaf')
    expect(new URL(resolved.request.url).hostname).toBe('gaf.mupot.mumega.com')
    expect(resolved.request.headers.get('x-mupot-tenant-slug')).toBeNull()
    expect(resolved.request.headers.get('x-pot-tenant')).toBeNull()
  })

  it('colony credentials do not ride into the foreign isolate', async () => {
    const req = new Request('https://mupot.mumega.com/t/gaf/mcp', {
      method: 'POST',
      headers: {
        cookie: 'session=colony',
        authorization: 'Bearer colony-token',
        'x-test': '1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ hello: 'world' }),
    })
    const resolved = resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')
    expect(resolved?.kind).toBe('dispatch')
    if (resolved?.kind !== 'dispatch') throw new Error('expected dispatch')
    expect(resolved.request.headers.get('cookie')).toBeNull()
    expect(resolved.request.headers.get('authorization')).toBeNull()
    expect(resolved.request.headers.get('x-test')).toBe('1')
    expect(await resolved.request.text()).toBe(JSON.stringify({ hello: 'world' }))
  })

  it('home keeps colony credentials but drops tenant-override headers', () => {
    const req = new Request('https://mupot.mumega.com/t/mumega/mcp', {
      headers: {
        cookie: 'session=colony',
        authorization: 'Bearer colony-token',
        'x-mupot-tenant-slug': 'other',
      },
    })
    const resolved = resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')
    expect(resolved?.kind).toBe('home')
    if (resolved?.kind !== 'home') throw new Error('expected home')
    expect(resolved.request.headers.get('cookie')).toBe('session=colony')
    expect(resolved.request.headers.get('authorization')).toBe('Bearer colony-token')
    expect(resolved.request.headers.get('x-mupot-tenant-slug')).toBeNull()
  })
})

describe('apex path tenant follow-up: reserved + unconfigured + preservation', () => {
  it('refuses reserved infrastructure slugs before dispatch', () => {
    const req = new Request('https://mupot.mumega.com/t/mupot/mcp')
    expect(resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')).toEqual({
      kind: 'reserved',
      slug: 'mupot',
    })
  })

  it('prefers home over reserved when the slug is this worker', () => {
    const req = new Request('https://mupot.mumega.com/t/mumega/mcp')
    expect(resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')?.kind).toBe('home')
  })

  it('returns 503 JSON when the dispatch namespace is not bound', async () => {
    const routed = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/gaf/mcp'), {
      TENANT_SLUG: 'mumega',
    })
    expect(routed.kind).toBe('respond')
    if (routed.kind !== 'respond') throw new Error('expected respond')
    expect(routed.response.status).toBe(503)
    expect(await routed.response.json()).toMatchObject({ error: 'unconfigured', tenant: 'gaf' })
  })

  it('returns 404 reserved_slug JSON without touching the dispatcher', async () => {
    const get = vi.fn()
    const routed = await routeApexPathTenant(new Request('https://mupot.mumega.com/t/mupot/mcp'), {
      TENANT_SLUG: 'mumega',
      DISPATCHER: { get },
    })
    expect(routed.kind).toBe('respond')
    if (routed.kind !== 'respond') throw new Error('expected respond')
    expect(routed.response.status).toBe(404)
    expect(await routed.response.json()).toMatchObject({ error: 'reserved_slug', tenant: 'mupot' })
    expect(get).not.toHaveBeenCalled()
  })

  it('preserves method, headers, query, and body across the rewrite', async () => {
    const req = new Request('https://mupot.mumega.com/t/gaf/mcp?token=abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test': '1' },
      body: JSON.stringify({ hello: 'world' }),
    })
    const resolved = resolveApexPathTenant(req, 'mumega', 'mupot.mumega.com')
    expect(resolved?.kind).toBe('dispatch')
    if (resolved?.kind !== 'dispatch') throw new Error('expected dispatch')
    expect(resolved.request.method).toBe('POST')
    expect(resolved.request.headers.get('x-test')).toBe('1')
    expect(new URL(resolved.request.url).search).toBe('?token=abc')
    expect(await resolved.request.text()).toBe(JSON.stringify({ hello: 'world' }))
  })
})
