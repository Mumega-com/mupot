// tests/staleness-check.test.ts — scripts/staleness-check.mjs, the mupot#443
// Part B staleness detector. Covers the pure decision logic (current / drift /
// unstamped / unreachable / error) with an injected fetch mock — no network
// calls, no dependency on any pot actually being live.

import { describe, it, expect } from 'vitest'
import { checkPot, checkAllPots, formatReport } from '../scripts/staleness-check.mjs'

const HEAD = 'a'.repeat(40)

function jsonFetch(body, ok = true, status = 200) {
  return async () => ({
    ok,
    status,
    json: async () => body,
  })
}

describe('checkPot', () => {
  it('reports "current" when the live commit exactly matches HEAD', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: HEAD }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'current', head: HEAD, live: HEAD })
  })

  it('matches case-insensitively (git shas are case-insensitive)', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD.toUpperCase(), {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: HEAD }),
    })
    expect(r.status).toBe('current')
  })

  it('reports "drift" when the live commit differs from HEAD — the exact #443 scenario', async () => {
    const staleSha = 'b'.repeat(40)
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: staleSha }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'drift', head: HEAD, live: staleSha })
  })

  it('reports "unstamped" when commit is null (the bug this closes)', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: null }),
    })
    expect(r.status).toBe('unstamped')
  })

  it('reports "unstamped" when commit is missing from the response entirely', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega' }),
    })
    expect(r.status).toBe('unstamped')
  })

  it('reports "unreachable" with the http status on a non-2xx response', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({}, false, 503),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'unreachable', head: HEAD, http: 503 })
  })

  it('reports "error" when the fetch itself throws (network failure, DNS, timeout)', async () => {
    const r = await checkPot(
      { slug: 'mumega', health: 'https://x/health' },
      HEAD,
      { fetchImpl: async () => { throw new Error('boom') } },
    )
    expect(r.status).toBe('error')
    expect(r.error).toContain('boom')
  })

  // mupot#571 fix 3 — a 2xx HTTP response with a matching commit is NOT
  // enough on its own. Require app-level ok:true AND the expected tenant.
  it('reports "unhealthy" when the app-level ok flag is false, even though HTTP is 2xx and the commit matches', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: false, tenant: 'mumega', commit: HEAD }),
    })
    expect(r.status).toBe('unhealthy')
  })

  it('reports "unhealthy" when the ok field is missing entirely', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ tenant: 'mumega', commit: HEAD }),
    })
    expect(r.status).toBe('unhealthy')
  })

  it('reports "wrong_tenant" when a healthy-looking response names a DIFFERENT tenant, even with a matching commit — the exact misroute this closes', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'digid', commit: HEAD }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'wrong_tenant', head: HEAD, tenant: 'digid', expected: 'mumega' })
  })

  it('validates against an explicit pot.tenant field when the manifest entry carries one', () => {
    return checkPot({ slug: 'mumega-alias', tenant: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'mumega', commit: HEAD }),
    }).then((r) => expect(r.status).toBe('current'))
  })

  it('reports "wrong_tenant" before ever looking at "unstamped" — tenant identity is checked first', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, tenant: 'viamar' }),
    })
    expect(r.status).toBe('wrong_tenant')
  })
})

describe('checkAllPots', () => {
  it('checks every pot in the manifest and preserves per-pot results', async () => {
    const manifestPath = new URL('./fixtures/staleness-manifest.json', import.meta.url).pathname
    const results = await checkAllPots({
      manifestPath,
      head: HEAD,
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          tenant: String(url).includes('drifted') ? 'drifted-pot' : 'current-pot',
          commit: String(url).includes('drifted') ? 'c'.repeat(40) : HEAD,
        }),
      }),
    })
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.slug === 'current-pot')?.status).toBe('current')
    expect(results.find((r) => r.slug === 'drifted-pot')?.status).toBe('drift')
  })
})

describe('formatReport', () => {
  it('renders a human-readable line per pot with the right marker for each status', () => {
    const out = formatReport(HEAD, [
      { slug: 'a', status: 'current', head: HEAD, live: HEAD },
      { slug: 'b', status: 'drift', head: HEAD, live: 'c'.repeat(40) },
      { slug: 'c', status: 'unstamped', head: HEAD },
      { slug: 'd', status: 'unreachable', head: HEAD, http: 500 },
      { slug: 'e', status: 'error', head: HEAD, error: 'timeout' },
      { slug: 'f', status: 'unhealthy', head: HEAD, ok: false },
      { slug: 'g', status: 'wrong_tenant', head: HEAD, tenant: 'digid', expected: 'mumega' },
    ])
    expect(out).toContain(HEAD)
    expect(out).toContain('✓ current')
    expect(out).toContain('⚠ DRIFT')
    expect(out).toContain('✘ UNSTAMPED')
    expect(out).toContain('✘ UNREACHABLE (http 500)')
    expect(out).toContain('✘ ERROR (timeout)')
    expect(out).toContain('✘ UNHEALTHY (ok=false)')
    expect(out).toContain("✘ WRONG TENANT (got 'digid', expected 'mumega')")
  })

  // mupot#571 fix 5 — the report header must never assert a ref it didn't
  // verify. Pre-fix, this was hardcoded to "main HEAD" unconditionally,
  // regardless of what ref a workflow_dispatch run actually built.
  describe('ref honesty (mupot#571 fix 5)', () => {
    it('does not assume "main" when no ref is supplied', () => {
      const out = formatReport(HEAD, [])
      expect(out).not.toMatch(/\bmain\b/i)
      expect(out).toContain(`HEAD ${HEAD}`)
    })

    it('reports the actual ref a workflow_dispatch run built against, not an assumed default', () => {
      const out = formatReport(HEAD, [], { ref: 'fix/some-other-branch' })
      expect(out).toContain(`ref 'fix/some-other-branch' @ ${HEAD}`)
      expect(out).not.toMatch(/main HEAD/)
    })

    it('reports "main" only when that IS the real supplied ref — never by default', () => {
      const out = formatReport(HEAD, [], { ref: 'main' })
      expect(out).toContain(`ref 'main' @ ${HEAD}`)
    })
  })
})
