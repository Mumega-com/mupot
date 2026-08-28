// tests/wfp-dispatcher.test.ts — Unit tests for Cloudflare Workers for Platforms dispatch router.

import { describe, it, expect, vi } from 'vitest'
import dispatcher, {
  extractTenantSlug,
  resolveTenantRouting,
  RESERVED_ROOT_ROUTES,
  type DispatcherEnv,
} from '../src/dispatcher'

describe('WFP Dispatcher Router (extractTenantSlug & resolveTenantRouting)', () => {
  it('routes root domain to fallback pot', () => {
    expect(extractTenantSlug('mupot.mumega.com', 'mupot.mumega.com')).toBe('mumega')
    expect(extractTenantSlug('www.mupot.mumega.com', 'mupot.mumega.com')).toBe('mumega')
    expect(extractTenantSlug('https://mupot.mumega.com', 'mupot.mumega.com')).toBe('mumega')
  })

  it('extracts subdomain tenant slugs cleanly', () => {
    expect(extractTenantSlug('viamar.mupot.mumega.com', 'mupot.mumega.com')).toBe('viamar')
    expect(extractTenantSlug('dnu.mupot.mumega.com', 'mupot.mumega.com')).toBe('dnu')
    expect(extractTenantSlug('dental-near-you.mupot.mumega.com', 'mupot.mumega.com')).toBe('dental-near-you')
  })

  it('handles custom domains by transforming host to slug', () => {
    expect(extractTenantSlug('agents.viamar.ca', 'mupot.mumega.com')).toBe('agents-viamar-ca')
  })

  it('resolves Linear-style workspace path routing (mupot.mumega.com/<workspace>/...)', () => {
    const r1 = resolveTenantRouting(new URL('https://mupot.mumega.com/viamar/studio'), 'mupot.mumega.com')
    expect(r1.tenantSlug).toBe('viamar')
    expect(r1.isPathScoped).toBe(true)
    expect(r1.rewrittenUrl).toBe('https://mupot.mumega.com/studio')

    const r2 = resolveTenantRouting(new URL('https://mupot.mumega.com/viamar/mcp'), 'mupot.mumega.com')
    expect(r2.tenantSlug).toBe('viamar')
    expect(r2.isPathScoped).toBe(true)
    expect(r2.rewrittenUrl).toBe('https://mupot.mumega.com/mcp')

    const r3 = resolveTenantRouting(new URL('https://mupot.mumega.com/gaf/api/health'), 'mupot.mumega.com')
    expect(r3.tenantSlug).toBe('gaf')
    expect(r3.isPathScoped).toBe(true)
    expect(r3.rewrittenUrl).toBe('https://mupot.mumega.com/api/health')

    const r4 = resolveTenantRouting(new URL('https://mupot.mumega.com/dental-near-you'), 'mupot.mumega.com')
    expect(r4.tenantSlug).toBe('dental-near-you')
    expect(r4.isPathScoped).toBe(true)
    expect(r4.rewrittenUrl).toBe('https://mupot.mumega.com/')
  })

  it('preserves reserved system routes on root domain as fallback pot', () => {
    for (const reserved of RESERVED_ROOT_ROUTES) {
      const routing = resolveTenantRouting(new URL(`https://mupot.mumega.com/${reserved}`), 'mupot.mumega.com')
      expect(routing.tenantSlug).toBe('mumega')
      expect(routing.isPathScoped).toBe(false)
      expect(routing.rewrittenUrl).toBeUndefined()
    }
  })

  it('honors explicit header override with highest precedence', () => {
    const r1 = resolveTenantRouting(new URL('https://mupot.mumega.com/health'), 'mupot.mumega.com', 'viamar')
    expect(r1.tenantSlug).toBe('viamar')
    expect(r1.isHeaderScoped).toBe(true)

    const r2 = resolveTenantRouting(new URL('https://mupot.mumega.com/viamar/studio'), 'mupot.mumega.com', 'gaf')
    expect(r2.tenantSlug).toBe('gaf')
    expect(r2.isHeaderScoped).toBe(true)
  })
})

describe('WFP Dispatcher fetch handler', () => {
  it('delegates subdomain request to matched tenant user Worker in dispatch namespace', async () => {
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
      {
        limits: {
          cpuMs: 50,
          subRequests: 50,
        },
      },
    )
    expect(mockUserWorkerFetch).toHaveBeenCalledWith(request)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ ok: true, pot: 'viamar' })
  })

  it('delegates Linear-style path request with rewritten path and tenant headers', async () => {
    let receivedUrl = ''
    let receivedTenantHeader = ''
    let receivedPrefixHeader = ''

    const mockUserWorkerFetch = vi.fn().mockImplementation(async (req: Request) => {
      receivedUrl = req.url
      receivedTenantHeader = req.headers.get('x-mupot-tenant') || ''
      receivedPrefixHeader = req.headers.get('x-mupot-workspace-prefix') || ''
      return new Response(JSON.stringify({ ok: true, pot: 'viamar', path: new URL(req.url).pathname }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const mockDispatcher = {
      get: vi.fn().mockReturnValue({
        fetch: mockUserWorkerFetch,
      }),
    }

    const env: DispatcherEnv = {
      DISPATCHER: mockDispatcher,
      ROOT_DOMAIN: 'mupot.mumega.com',
    }

    const request = new Request('https://mupot.mumega.com/viamar/studio/canvas', {
      method: 'GET',
      headers: { 'User-Agent': 'Cursor-Agent' },
    })

    const response = await dispatcher.fetch(request, env)

    expect(mockDispatcher.get).toHaveBeenCalledWith(
      'viamar',
      {},
      {
        limits: {
          cpuMs: 50,
          subRequests: 50,
        },
      },
    )

    expect(receivedUrl).toBe('https://mupot.mumega.com/studio/canvas')
    expect(receivedTenantHeader).toBe('viamar')
    expect(receivedPrefixHeader).toBe('/viamar')
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ ok: true, pot: 'viamar', path: '/studio/canvas' })
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
    expect(body).toEqual({
      error: 'pot_not_found',
      tenant: 'unprovisioned-tenant',
      message: "No active sovereign mupot instance provisioned for 'unprovisioned-tenant'.",
    })
  })

  it('returns custom HTML 404 page when browser requests unprovisioned pot', async () => {
    const mockDispatcher = {
      get: vi.fn().mockImplementation(() => {
        throw new Error('No user worker found')
      }),
    }

    const env: DispatcherEnv = {
      DISPATCHER: mockDispatcher,
      ROOT_DOMAIN: 'mupot.mumega.com',
    }

    const request = new Request('https://mupot.mumega.com/new-company/studio', {
      method: 'GET',
      headers: { 'Accept': 'text/html,application/xhtml+xml' },
    })

    const response = await dispatcher.fetch(request, env)

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('Pot Not Provisioned')
    expect(html).toContain('new-company')
  })
})
