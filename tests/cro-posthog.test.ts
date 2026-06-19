// tests/cro-posthog.test.ts — the PostHog CRO source (slice 2): the first external connector.
//
// Covers: fail-closed availability, the HogQL aggregate call shape, secret-in-header-only,
// https-host validation (no SSRF), graceful failure on non-2xx / malformed body, and the
// poison-resistant normalization into CroMetric points.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { posthogCroSource, posthogHost, POSTHOG_DEFAULT_HOST } from '../src/cro/posthog'
import type { Env } from '../src/types'

function env(over: Partial<Env> = {}): Env {
  return {
    TENANT_SLUG: 'mumega',
    POSTHOG_PERSONAL_API_KEY: 'phx_secret_key',
    POSTHOG_PROJECT_ID: '436189',
    ...over,
  } as unknown as Env
}

function mockFetchOnce(body: unknown, init?: { ok?: boolean; status?: number }) {
  const ok = init?.ok ?? true
  const status = init?.status ?? 200
  const fn = vi.fn(async () => ({
    ok,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('posthogCroSource.available — fail-closed', () => {
  it('available only when KEY + PROJECT_ID are both present', async () => {
    expect(await posthogCroSource.available(env())).toBe(true)
    expect(await posthogCroSource.available(env({ POSTHOG_PERSONAL_API_KEY: undefined }))).toBe(false)
    expect(await posthogCroSource.available(env({ POSTHOG_PROJECT_ID: undefined }))).toBe(false)
  })

  it('available() makes no network call (cheap gate)', async () => {
    const fetchFn = mockFetchOnce({})
    await posthogCroSource.available(env())
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('posthogHost — https-only, operator-set, no SSRF', () => {
  it('defaults to US cloud when unset', () => {
    expect(posthogHost(env({ POSTHOG_HOST: undefined }))).toBe(POSTHOG_DEFAULT_HOST)
  })
  it('returns the origin (no trailing path) for a valid https host', () => {
    expect(posthogHost(env({ POSTHOG_HOST: 'https://eu.posthog.com/' }))).toBe('https://eu.posthog.com')
  })
  it('rejects a non-https host (fail-closed)', () => {
    expect(() => posthogHost(env({ POSTHOG_HOST: 'http://evil.internal' }))).toThrow('posthog_host_not_https')
  })
  it('rejects an unparseable host', () => {
    expect(() => posthogHost(env({ POSTHOG_HOST: 'not a url' }))).toThrow('posthog_host_unparseable')
  })
})

describe('posthogCroSource.collect — the HogQL aggregate call', () => {
  it('POSTs a HogQLQuery to the project query endpoint with the key in the Authorization header ONLY', async () => {
    const fetchFn = mockFetchOnce({ results: [[1234, 56]] })
    const out = await posthogCroSource.collect(env())

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, opts] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]
    expect(url).toBe('https://us.posthog.com/api/projects/436189/query/')
    expect(opts.method).toBe('POST')
    // secret lives in the header, never in the URL or body
    const headers = opts.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer phx_secret_key')
    expect(url).not.toContain('phx_secret_key')
    expect(String(opts.body)).not.toContain('phx_secret_key')
    // HogQL aggregate query
    const sent = JSON.parse(String(opts.body))
    expect(sent.query.kind).toBe('HogQLQuery')
    expect(sent.query.query).toContain('count()')
    expect(sent.query.query).toContain('person_id')

    // normalized into two CroMetric points, occurred_at = strict ISO at tick time
    expect(out.map((m) => m.metric_key)).toEqual(['cro.posthog.events_24h', 'cro.posthog.users_24h'])
    expect(out[0].value).toBe(1234)
    expect(out[1].value).toBe(56)
    for (const m of out) {
      expect(m.occurred_at).toBe(new Date(m.occurred_at).toISOString()) // strict-canonical
    }
  })

  it('returns [] (never throws) when the credential is absent', async () => {
    const fetchFn = mockFetchOnce({ results: [[1, 1]] })
    expect(await posthogCroSource.collect(env({ POSTHOG_PERSONAL_API_KEY: undefined }))).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('throws on a non-2xx (carries status, not request detail) — collector records ok:false', async () => {
    mockFetchOnce({ error: 'unauthorized' }, { ok: false, status: 401 })
    await expect(posthogCroSource.collect(env())).rejects.toThrow('posthog_query_http_401')
  })

  it('returns [] on an empty / malformed result body (no row to read)', async () => {
    mockFetchOnce({ results: [] })
    expect(await posthogCroSource.collect(env())).toEqual([])
    mockFetchOnce({ results: 'not-an-array' })
    expect(await posthogCroSource.collect(env())).toEqual([])
    mockFetchOnce({})
    expect(await posthogCroSource.collect(env())).toEqual([])
  })

  it('drops a non-finite cell but keeps the finite one (poison-resistant)', async () => {
    mockFetchOnce({ results: [['NaNote', 42]] }) // events cell non-numeric, users fine
    const out = await posthogCroSource.collect(env())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ metric_key: 'cro.posthog.users_24h', value: 42 })
  })

  it('throws on a bad host (fail-closed) before any fetch', async () => {
    const fetchFn = mockFetchOnce({ results: [[1, 1]] })
    await expect(posthogCroSource.collect(env({ POSTHOG_HOST: 'http://insecure' }))).rejects.toThrow(
      'posthog_host_not_https',
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
