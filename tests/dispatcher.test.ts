import { describe, it, expect, vi } from 'vitest'
import dispatcher, { extractTenantSlug, DEFAULT_ROOT_DOMAIN, DEFAULT_FALLBACK_POT } from '../src/dispatcher'

describe('WFP Dynamic Dispatcher', () => {
  describe('extractTenantSlug', () => {
    it('resolves root domain and www to default fallback pot (mumega)', () => {
      expect(extractTenantSlug('mupot.mumega.com')).toBe(DEFAULT_FALLBACK_POT)
      expect(extractTenantSlug('www.mupot.mumega.com')).toBe(DEFAULT_FALLBACK_POT)
      expect(extractTenantSlug('MUPOT.MUMEGA.COM:443')).toBe(DEFAULT_FALLBACK_POT)
    })

    it('resolves customer subdomains cleanly', () => {
      expect(extractTenantSlug('gaf.mupot.mumega.com')).toBe('gaf')
      expect(extractTenantSlug('viamar.mupot.mumega.com')).toBe('viamar')
      expect(extractTenantSlug('dme-corp.mupot.mumega.com')).toBe('dme-corp')
    })

    it('honors x-mupot-tenant-slug header override', () => {
      expect(extractTenantSlug('mupot.mumega.com', DEFAULT_ROOT_DOMAIN, 'gaf')).toBe('gaf')
      expect(extractTenantSlug('anything.com', DEFAULT_ROOT_DOMAIN, 'viamar_custom')).toBe('viamar_custom')
    })

    it('sanitizes custom CNAME domains', () => {
      expect(extractTenantSlug('ai.gafmaterials.com')).toBe('ai-gafmaterials-com')
    })
  })

  describe('fetch routing', () => {
    it('dispatches request to target User Worker with limits', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ pot: 'gaf', ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      const mockGet = vi.fn().mockReturnValue({ fetch: mockFetch })

      const env = {
        DISPATCHER: { get: mockGet },
        DEFAULT_CPU_MS: 40,
        DEFAULT_SUBREQUESTS: 25,
      }

      const req = new Request('https://gaf.mupot.mumega.com/api/squads', {
        headers: { Authorization: 'Bearer token-123' },
      })

      const res = await dispatcher.fetch(req, env)
      expect(res.status).toBe(200)
      expect(mockGet).toHaveBeenCalledWith('gaf', {}, { limits: { cpuMs: 40, subRequests: 25 } })
      expect(mockFetch).toHaveBeenCalledWith(req)

      const body = await res.json()
      expect(body).toEqual({ pot: 'gaf', ok: true })
    })

    it('returns JSON 404 when pot is not provisioned (API request)', async () => {
      const mockGet = vi.fn().mockImplementation(() => {
        throw new Error('No user worker found for tenant')
      })

      const env = {
        DISPATCHER: { get: mockGet },
      }

      const req = new Request('https://unknown-tenant.mupot.mumega.com/api/ping', {
        headers: { Accept: 'application/json' },
      })

      const res = await dispatcher.fetch(req, env)
      expect(res.status).toBe(404)
      const data = await res.json()
      expect(data.error).toBe('pot_not_found')
      expect(data.tenant).toBe('unknown-tenant')
    })

    it('returns HTML 404 onboarding card when browser navigates to unprovisioned pot', async () => {
      const mockGet = vi.fn().mockImplementation(() => {
        throw new Error('user worker not found')
      })

      const env = {
        DISPATCHER: { get: mockGet },
      }

      const req = new Request('https://newclient.mupot.mumega.com/', {
        headers: { Accept: 'text/html,application/xhtml+xml' },
      })

      const res = await dispatcher.fetch(req, env)
      expect(res.status).toBe(404)
      expect(res.headers.get('content-type')).toContain('text/html')
      const html = await res.text()
      expect(html).toContain('Pot Not Provisioned')
      expect(html).toContain('newclient')
      expect(html).toContain('Provision Sovereign Pot')
    })

    it('returns 502 when dispatcher encounters unexpected failure', async () => {
      const mockGet = vi.fn().mockImplementation(() => {
        throw new Error('Cloudflare internal V8 panic')
      })

      const env = {
        DISPATCHER: { get: mockGet },
      }

      const req = new Request('https://gaf.mupot.mumega.com/mcp')
      const res = await dispatcher.fetch(req, env)
      expect(res.status).toBe(502)
      const data = await res.json()
      expect(data.error).toBe('dispatcher_error')
      expect(data.detail).toContain('Cloudflare internal V8 panic')
    })
  })
})
