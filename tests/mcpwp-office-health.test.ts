// mupot#1580 slice 1 — mcpwp-office addon health check (src/addons/office/health.ts).
//
// Schema: real D1 (node:sqlite via createSqliteD1) + applyAllMigrations() — this file
// imports production code (src/addons/office/health.ts), so per
// scripts/check-test-schema-source.mjs it must build its schema from the committed
// migration chain, never a hand-rolled D1-shaped mock (see tests/wiki-client.test.ts for
// the same pattern against the same `connectors` table).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { checkMcpwpOfficeHealth, MCPWP_OFFICE_HEALTH_TIMEOUT_MS } from '../src/addons/office/health'

const MASTER_KEY = '22'.repeat(32)
const TENANT = 'tenant-office-a'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return harness
}

/**
 * Seed a real 'mcpwp' connector row via a genuine INSERT against the full migration
 * chain's `connectors` table — matches useConnectorById's exact query shape
 * (id=?1, tenant=?2, type=?3, revoked_at IS NULL).
 */
async function connectorFixture(
  harness: SqliteD1Harness,
  siteUrl: string,
  secret: string,
  id = 'connector-wordpress-site',
): Promise<string> {
  const encrypted = await encryptConnectorSecret(MASTER_KEY, id, 'mcpwp', secret)
  const meta = JSON.stringify({ siteUrl, username: 'office-agent' })
  harness.sqlite.prepare(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES (?, ?, 'mcpwp', 'Office WordPress site', ?, ?, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  ).run(id, TENANT, encrypted, meta)
  return id
}

/** Same insert, but with a NULL meta column — proves the "no siteUrl configured" path. */
async function connectorFixtureWithoutMeta(
  harness: SqliteD1Harness,
  secret: string,
  id = 'connector-no-meta',
): Promise<string> {
  const encrypted = await encryptConnectorSecret(MASTER_KEY, id, 'mcpwp', secret)
  harness.sqlite.prepare(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES (?, ?, 'mcpwp', 'Office WordPress site', ?, NULL, 'pot', NULL, 'test-setup', '2026-01-01T00:00:00Z')`,
  ).run(id, TENANT, encrypted)
  return id
}

function vaultEnv(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY } as Env
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mcpwp-office health check', () => {
  it('reports healthy on a 200 initialize response and sends Basic auth built from the vaulted secret', async () => {
    const harness = makeHarness()
    const secret = 'wordpress-app-password-abc123'
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com', secret)
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 'mupot-office-health', result: { protocolVersion: '2025-06-18' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'available', observations: [] })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [rawUrl, init] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    const url = new URL(String(rawUrl))
    expect(url.origin).toBe('https://wordpress.example.com')
    expect(url.pathname).toBe('/wp-json/mcpwp/v1/mcp')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${btoa(`office-agent:${secret}`)}`)
    const body = JSON.parse(String(init.body)) as { jsonrpc: string; method: string }
    expect(body.jsonrpc).toBe('2.0')
    expect(body.method).toBe('initialize')
    expect(JSON.stringify(result)).not.toContain(secret)
    harness.close()
  })

  // mupot#1587 P1-A: the r2 subdirectory-path-preservation fix had NO test at all —
  // "reverting it leaves 13/13 health tests green" (the issue's own words). This pins
  // it: a WordPress install under a subdirectory must be probed at that subdirectory's
  // own path, not the bare origin. Revert the basePath logic in health.ts and this
  // must go red.
  it('pins subdirectory-path preservation: a siteUrl with a path probes that path, not the bare origin', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com/blog', 'wordpress-secret-subdir')
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 'mupot-office-health', result: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'available', observations: [] })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [rawUrl] = (fetchSpy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
    const url = new URL(String(rawUrl))
    expect(url.origin).toBe('https://wordpress.example.com')
    expect(url.pathname).toBe('/blog/wp-json/mcpwp/v1/mcp')
    harness.close()
  })

  // mupot#1587 P1-A (round-2 gate on #1582): the endpoint is REBUILT from the stored
  // siteUrl's own pathname (basePath) concatenated into a new URL string — a pathname
  // beginning `//` is parsed by the WHATWG URL spec as SCHEME-RELATIVE, silently
  // changing the HOST the probe (and its vaulted Basic credential) is sent to. Both
  // vectors below must make ZERO fetch calls and never send the credential anywhere —
  // reverting the endpoint.origin === base.origin re-check (or the second
  // assertPublicHttpsUrl call) must turn these red.
  it('refuses an SSRF vector where the stored path is scheme-relative (leading //) — zero fetches', async () => {
    const harness = makeHarness()
    const secret = 'wordpress-secret-ssrf-slashslash'
    const connectorId = await connectorFixture(
      harness,
      'https://blog.example.com//169.254.169.254/x',
      secret,
    )
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_site_url', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(secret)
    harness.close()
  })

  it('refuses an SSRF vector where the stored path starts with a backslash — zero fetches', async () => {
    const harness = makeHarness()
    const secret = 'wordpress-secret-ssrf-backslash'
    const connectorId = await connectorFixture(
      harness,
      'https://blog.example.com/\\10.0.0.5',
      secret,
    )
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_site_url', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain(secret)
    harness.close()
  })

  it('reports key_invalid on a 401 without following up or leaking the response body', async () => {
    const harness = makeHarness()
    const secret = 'wordpress-app-password-wrong'
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com', secret)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'rest_forbidden', message: `key rejected: ${secret}` }),
      { status: 401 },
    )))

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'failed', reason: 'key_invalid', observations: [] })
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('rest_forbidden')
    harness.close()
  })

  it('reports key_invalid on a 403 the same way as a 401', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com', 'wordpress-secret-403')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'failed', reason: 'key_invalid', observations: [] })
    harness.close()
  })

  it('reports unreachable on a non-2xx, non-401/403 response', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com', 'wordpress-secret-500')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 502 })))

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'failed', reason: 'unreachable', observations: [] })
    harness.close()
  })

  it('reports unreachable and refuses to follow a redirect', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com', 'wordpress-secret-redirect')
    const fetchSpy = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://redirect.example.com/mcp' },
    })) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'failed', reason: 'unreachable', observations: [] })
    expect(fetchSpy).toHaveBeenCalledOnce()
    harness.close()
  })

  it('reports unreachable on a network throw and on timeout, and never echoes the secret', async () => {
    const harness = makeHarness()
    const secret = 'wordpress-secret-network-fail'
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com', secret)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error(`connection reset while using ${secret}`)
    }))

    const thrown = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)
    expect(thrown).toEqual({ status: 'failed', reason: 'unreachable', observations: [] })
    expect(JSON.stringify(thrown)).not.toContain(secret)

    vi.useFakeTimers()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      markStarted?.()
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })))
    const pending = checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)
    await started
    await vi.advanceTimersByTimeAsync(MCPWP_OFFICE_HEALTH_TIMEOUT_MS + 1)
    const timedOut = await pending
    expect(timedOut).toEqual({ status: 'failed', reason: 'unreachable', observations: [] })
    harness.close()
  })

  it('refuses a private-host siteUrl with the SSRF guard and makes no network call', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixture(harness, 'https://127.0.0.1/wp-json', 'wordpress-secret-ssrf')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_site_url', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses a non-https siteUrl with the SSRF guard and makes no network call', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixture(harness, 'http://wordpress.example.com', 'wordpress-secret-http')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_site_url', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('refuses a cloud-metadata-shaped siteUrl (link-local) with no network call', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixture(harness, 'https://169.254.169.254/latest/meta-data', 'wordpress-secret-metadata')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_site_url', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('reports connector_unavailable for a missing connector id without invoking fetch', async () => {
    const harness = makeHarness()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), 'no-such-connector')

    expect(result).toEqual({ status: 'unavailable', reason: 'connector_unavailable', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('reports connector_unavailable for a null connector id without invoking fetch', async () => {
    const harness = makeHarness()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), null)

    expect(result).toEqual({ status: 'unavailable', reason: 'connector_unavailable', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('reports invalid_site_config when the connector meta has no siteUrl', async () => {
    const harness = makeHarness()
    const connectorId = await connectorFixtureWithoutMeta(harness, 'wordpress-secret-no-meta')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'unavailable', reason: 'invalid_site_config', observations: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })

  it('never returns the raw secret anywhere in the result even under adversarial fetch mocking', async () => {
    const harness = makeHarness()
    const secret = 'wordpress-secret-adversarial-echo'
    const connectorId = await connectorFixture(harness, 'https://wordpress.example.com', secret)
    // A hostile/misbehaving upstream that reflects the Authorization header value back
    // in its body — the health check never reads the body at all, so this cannot leak.
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify({ echoedAuth: new Headers(init?.headers).get('authorization') }),
      { status: 200 },
    )))

    const result = await checkMcpwpOfficeHealth(vaultEnv(harness), connectorId)

    expect(result).toEqual({ status: 'available', observations: [] })
    expect(JSON.stringify(result)).not.toContain(secret)
    harness.close()
  })
})
