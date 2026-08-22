// tests/wfp-dispatcher.test.ts — Unit tests for Cloudflare Workers for Platforms dispatch router.

import { describe, it, expect, vi } from 'vitest'
import dispatcher, { extractTenantSlug, type DispatcherEnv } from '../src/dispatcher'

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

    expect(mockDispatcher.get).toHaveBeenCalledWith('viamar')
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
    expect(body).toEqual({
      error: 'pot_not_found',
      tenant: 'unprovisioned-tenant',
      message: "No active mupot instance provisioned for 'unprovisioned-tenant'.",
    })
  })
})
