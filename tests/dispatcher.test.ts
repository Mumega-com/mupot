import { describe, it, expect, vi } from 'vitest'
import dispatcher, { extractTenantSlug, renderUnprovisionedPotHtml, DEFAULT_ROOT_DOMAIN, DEFAULT_FALLBACK_POT } from '../src/dispatcher'

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

    // mupot#1299. This test used to be `honors x-mupot-tenant-slug header override`, and
    // it asserted that a client-supplied header BEAT the hostname. That was the defect
    // written down as an expectation: it made tenant selection an unauthenticated choice
    // at an entry point that runs before any auth. The capability is now gone from the
    // signature, so the assertion is that the hostname is the only input.
    // NAME CHANGED (mupot#1301 review): this was called "ignores any client-supplied slug",
    // which overclaimed — both assertions below pass IDENTICALLY under the old
    // three-parameter signature, because neither passes a third argument. The cheapest
    // implementation that satisfies this test is the pre-fix code. The real guards are the
    // behavioural case at the dispatcher.fetch seam below and the composition test at
    // worker.fetch; both were confirmed by mutation, this one was not. It is named for
    // what it actually pins so nobody counts it as the security guard.
    it('resolves root, www and custom domains from the hostname', () => {
      // Sanity: these are the two hostnames the old override test smuggled a tenant into.
      expect(extractTenantSlug('mupot.mumega.com', DEFAULT_ROOT_DOMAIN)).toBe(DEFAULT_FALLBACK_POT)
      expect(extractTenantSlug('anything.com', DEFAULT_ROOT_DOMAIN)).toBe('anything-com')
      // NOTE: do not try to pin this with `extractTenantSlug.length`. Function.length
      // counts parameters before the first DEFAULTED one, and `rootDomain` has a default,
      // so it reads 1 whether the signature is (hostname, rootDomain) or
      // (hostname, rootDomain, headerSlug) — verified, and it silently survived the
      // mutation that restored the third parameter. The real guards are the behavioural
      // case below at the dispatcher.fetch seam, the composition test at worker.fetch,
      // and tsc rejecting a third argument at every call site.
    })

    // mupot#1301 review, F2. Reproduced LIVE on production before the fix:
    //   curl --resolve 'mupot.mumega.com.:443:<ip>' https://mupot.mumega.com./health
    //   -> {"error":"pot_not_found","tenant":"mupot-mumega-com-"}
    // A trailing dot is a legal FQDN, survives the Cloudflare edge, and is preserved in
    // req.url. It defeated both the apex equality test and the suffix test, fell through
    // to the custom-domain branch, and delivered an attacker-shaped string to
    // DISPATCHER.get() unauthenticated, ahead of all auth. It failed closed only because
    // no Worker happens to be named `mupot-mumega-com-`.
    it('normalizes a trailing dot — an FQDN apex is the apex, not a custom domain', () => {
      expect(extractTenantSlug('mupot.mumega.com.', DEFAULT_ROOT_DOMAIN)).toBe(DEFAULT_FALLBACK_POT)
      expect(extractTenantSlug('mupot.mumega.com..', DEFAULT_ROOT_DOMAIN)).toBe(DEFAULT_FALLBACK_POT)
      expect(extractTenantSlug('www.mupot.mumega.com.', DEFAULT_ROOT_DOMAIN)).toBe(DEFAULT_FALLBACK_POT)
      // and a real tenant subdomain still resolves to itself, not to a mangled slug
      expect(extractTenantSlug('gaf.mupot.mumega.com.', DEFAULT_ROOT_DOMAIN)).toBe('gaf')
      // the specific string that reached DISPATCHER.get() on prod must be unreachable
      expect(extractTenantSlug('mupot.mumega.com.', DEFAULT_ROOT_DOMAIN)).not.toBe('mupot-mumega-com-')
    })

    // mupot#1301 review, F7. The subdomain branch used to return its label RAW while the
    // custom-domain branch sanitized, and that value is interpolated into HTML by
    // renderUnprovisionedPotHtml. The only thing preventing reflected XSS was WHATWG
    // `new URL()` rejecting forbidden host code points before `url.hostname` exists — an
    // implicit dependency, never stated, on a surface that runs before all auth.
    it('sanitizes the subdomain label on the same terms as a custom domain', () => {
      expect(extractTenantSlug('a_b.mupot.mumega.com', DEFAULT_ROOT_DOMAIN)).toBe('a-b')
      expect(extractTenantSlug('a b.mupot.mumega.com', DEFAULT_ROOT_DOMAIN)).toBe('a-b')
    })

    it('sanitizes custom CNAME domains', () => {
      expect(extractTenantSlug('ai.gafmaterials.com')).toBe('ai-gafmaterials-com')
    })
  })

  // mupot#1301 review, F7 — the render half. Sanitization and escaping are two guards;
  // testing only the slug leaves the interpolation unproven.
  describe('unprovisioned-pot page', () => {
    // Calls the renderer DIRECTLY with hostile input. Routing the same string through
    // dispatcher.fetch does not test this: sanitizeSlug strips `<` first, so removing the
    // escaping entirely leaves such a test green — confirmed by mutation. Sanitization and
    // escaping are two independent guards and each needs its own proof.
    it('escapes hostile input regardless of what the sanitizer would have done', () => {
      const html = renderUnprovisionedPotHtml('</span><script>alert(1)</script>')
      expect(html).not.toMatch(/<script\b/i)
      expect(html).toContain('&lt;script&gt;')
    })

    it('still renders an ordinary slug readably', () => {
      expect(renderUnprovisionedPotHtml('gaf')).toContain('<span class="code">gaf</span>')
    })
  })

  describe('fetch routing', () => {
    // mupot#1299 — the behavioural half. Arity proves the parameter is gone; this proves
    // dispatcher.fetch does not re-derive the same capability from the raw request, which
    // it did independently of src/index.ts (two readers, one predicate).
    it('does not let a request header redirect the request to another tenant', async () => {
      const mockGet = vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response('ok')),
      })
      const env = { DISPATCHER: { get: mockGet } }

      // Addressed to gaf by hostname; asks for `victim` by header, both spellings.
      const req = new Request('https://gaf.mupot.mumega.com/health', {
        headers: {
          'x-mupot-tenant-slug': 'victim',
          'x-pot-tenant': 'victim',
        },
      })

      await dispatcher.fetch(req, env)
      expect(mockGet).toHaveBeenCalledTimes(1)
      expect(mockGet.mock.calls[0][0]).toBe('gaf')
    })

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
