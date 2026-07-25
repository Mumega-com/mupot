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
      fetchImpl: jsonFetch({ ok: true, commit: HEAD }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'current', head: HEAD, live: HEAD })
  })

  it('matches case-insensitively (git shas are case-insensitive)', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD.toUpperCase(), {
      fetchImpl: jsonFetch({ ok: true, commit: HEAD }),
    })
    expect(r.status).toBe('current')
  })

  it('reports "drift" when the live commit differs from HEAD — the exact #443 scenario', async () => {
    const staleSha = 'b'.repeat(40)
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, commit: staleSha }),
    })
    expect(r).toEqual({ slug: 'mumega', status: 'drift', head: HEAD, live: staleSha })
  })

  it('reports "unstamped" when commit is null (the bug this closes)', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true, commit: null }),
    })
    expect(r.status).toBe('unstamped')
  })

  it('reports "unstamped" when commit is missing from the response entirely', async () => {
    const r = await checkPot({ slug: 'mumega', health: 'https://x/health' }, HEAD, {
      fetchImpl: jsonFetch({ ok: true }),
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
    ])
    expect(out).toContain(HEAD)
    expect(out).toContain('✓ current')
    expect(out).toContain('⚠ DRIFT')
    expect(out).toContain('✘ UNSTAMPED')
    expect(out).toContain('✘ UNREACHABLE (http 500)')
    expect(out).toContain('✘ ERROR (timeout)')
  })
})
