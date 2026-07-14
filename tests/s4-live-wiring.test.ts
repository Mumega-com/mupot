// tests/s4-live-wiring.test.ts — S4 live-wire: SSRF guard + the owner-only execute route.
//
// A. SSRF (WARN-1): inkwellContentWrite / wpContentWrite must reject non-https /
//    internal / metadata URLs BEFORE any fetch.
// B. POST /admin/departments/:dept/execute/:gateId — owner/admin gate + fail-closed
//    wiring. #370: this route now resolves BOTH adapters additively (neither is
//    fatal alone — only "neither resolves" is fatal), since the route cannot know
//    which adapter the approved record targets (content-bound, kernel-internal).
//    unknown dept → 404, unapproved proposal → 409. The full executed:true path is
//    covered at the kernel level (executor-inkwell-s4 / executor-mcpwp-s4 /
//    department-proposals-durability).

import { describe, it, expect, vi } from 'vitest'

// Mock resolveConnector + resolveConnectorWithMeta; keep the rest of the connector
// service intact. Both are made type-aware so inkwell and mcpwp resolution can be
// controlled independently per test.
vi.mock('../src/connectors/service', async (orig) => ({
  ...(await orig<typeof import('../src/connectors/service')>()),
  resolveConnector: vi.fn(),
  resolveConnectorWithMeta: vi.fn(),
}))

import { dashboardApp } from '../src/dashboard/index'
import { resolveConnector, resolveConnectorWithMeta } from '../src/connectors/service'
import { inkwellContentWrite } from '../src/departments/executors/inkwell'
import { wpContentWrite } from '../src/departments/executors/mcpwp'
import type { Env } from '../src/types'

const mockResolve = vi.mocked(resolveConnector)
const mockResolveWithMeta = vi.mocked(resolveConnectorWithMeta)

// Default: no mcpwp connector configured, unless a test overrides it. Declared here
// (not per-test) so every pre-existing inkwell-focused test keeps its original,
// single-adapter behavior without having to know mcpwp now exists.
mockResolveWithMeta.mockResolvedValue(null)

// ── A. SSRF guard ─────────────────────────────────────────────────────────────
describe('inkwellContentWrite — SSRF guard on apiUrl', () => {
  const payload = { title: 't', content: 'c' }
  const neverFetch = vi.fn(async () => new Response('{}')) as unknown as typeof fetch

  it.each([
    ['http://inkwell-api.mumega.com', 'non-https'],
    ['https://127.0.0.1', 'loopback'],
    ['https://169.254.169.254', 'metadata'],
    ['https://localhost', 'localhost'],
    ['https://10.0.0.5', 'rfc1918-10'],
    ['https://192.168.1.1', 'rfc1918-192'],
    ['https://172.16.0.1', 'rfc1918-172'],
    ['https://100.64.0.1', 'cgnat'],
    ['https://api.internal', 'internal-tld'],
    ['https://svc.local', 'mdns-local'],
    ['https://metadata.google.internal', 'gcp-metadata'],
    ['https://[::1]', 'ipv6-loopback'],
    ['https://[::]', 'ipv6-unspecified'],
    ['https://[fd00::1]', 'ipv6-ula'],
    ['https://[fe80::1]', 'ipv6-linklocal'],
    ['https://[::ffff:127.0.0.1]', 'ipv4-mapped-loopback'],
    ['https://[::ffff:169.254.169.254]', 'ipv4-mapped-metadata'],
    ['https://user@169.254.169.254', 'userinfo-metadata'],
    ['https://2130706433', 'decimal-ip-loopback'],
    ['https://0x7f000001', 'hex-ip-loopback'],
    ['https://127.0.0.1.', 'trailing-dot-loopback'],
    ['not-a-url', 'unparseable'],
  ])('rejects %s (%s) with inkwell_bad_apiurl, no fetch', async (apiUrl) => {
    await expect(inkwellContentWrite({ apiUrl, token: 'tok', tenantSlug: 'mumega' }, payload, neverFetch)).rejects.toMatchObject({
      reason: 'inkwell_bad_apiurl',
    })
    expect(neverFetch).not.toHaveBeenCalled()
  })

  it('allows a public https host', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/s' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const r = await inkwellContentWrite({ apiUrl: 'https://inkwell-api.mumega.com', token: 'tok', tenantSlug: 'mumega' }, payload, ok)
    expect(r.ok).toBe(true)
    expect(ok).toHaveBeenCalledOnce()
  })
})

// #370: wpContentWrite reuses the SAME shared guard (src/lib/ssrf.ts) — a smaller
// spot-check here; the full private-host matrix is exercised above for inkwell and
// unit-tested directly in tests/executor-mcpwp-s4.test.ts.
describe('wpContentWrite — SSRF guard on siteUrl', () => {
  const payload = { title: 't', content: 'c' }
  const neverFetch = vi.fn(async () => new Response('{}')) as unknown as typeof fetch
  const cfg = { username: 'agent', appPassword: 'pw' }

  it.each([
    ['http://example.com', 'non-https'],
    ['https://169.254.169.254', 'metadata'],
    ['https://localhost', 'localhost'],
  ])('rejects %s (%s) with mcpwp_bad_siteurl, no fetch', async (siteUrl) => {
    await expect(wpContentWrite({ ...cfg, siteUrl }, payload, neverFetch)).rejects.toMatchObject({
      reason: 'mcpwp_bad_siteurl',
    })
    expect(neverFetch).not.toHaveBeenCalled()
  })

  it('allows a public https host', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 1, link: 'https://example.com/?p=1' }), { status: 201, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const r = await wpContentWrite({ ...cfg, siteUrl: 'https://example.com' }, payload, ok)
    expect(r.ok).toBe(true)
    expect(ok).toHaveBeenCalledOnce()
  })
})

// ── B. The execute route ──────────────────────────────────────────────────────
function envForRole(role: 'owner' | 'admin' | 'member', extra: Record<string, unknown> = {}): Env {
  const stmt = {
    bind: (..._a: unknown[]) => stmt,
    first: vi.fn(async () => null), // no approved verdict, no durable proposal → not_approved
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }
  return {
    TENANT_SLUG: 't',
    BRAND: 'Test',
    DB: { prepare: vi.fn(() => stmt) },
    SESSIONS: {
      get: vi.fn(async () => JSON.stringify({ userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z' })),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    ...extra,
  } as unknown as Env
}

function req(path: string): Request {
  return new Request(`https://pot.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'mupot_session=s', Origin: 'https://pot.test' },
  })
}

const INKWELL = { INKWELL_API_URL: 'https://inkwell-api.mumega.com' }

describe('POST /admin/departments/:dept/execute/:gateId', () => {
  it('non-admin → 403', async () => {
    mockResolve.mockResolvedValue('tok')
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g1'), envForRole('member', INKWELL))
    expect(res.status).toBe(403)
  })

  it('unknown department → 404 (before any connector/url work)', async () => {
    const res = await dashboardApp.fetch(req('/admin/departments/nope/execute/g1'), envForRole('owner', INKWELL))
    expect(res.status).toBe(404)
  })

  it('no INKWELL_API_URL and no mcpwp connector → 503 executor_not_configured', async () => {
    mockResolveWithMeta.mockResolvedValue(null)
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g1'), envForRole('owner'))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('executor_not_configured')
  })

  // #370: neither adapter resolves (inkwell connector missing, no mcpwp connector
  // either) → still 503. The specific per-adapter 'connector_not_configured' error
  // code is gone now that the route resolves multiple adapters additively — see the
  // route's header comment in src/dashboard/index.ts for why (content-bound dispatch
  // means the route can't know in advance which single adapter the record needs).
  it('inkwell connector missing AND no mcpwp connector → 503 executor_not_configured', async () => {
    mockResolve.mockResolvedValue(null)
    mockResolveWithMeta.mockResolvedValue(null)
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g1'), envForRole('owner', INKWELL))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('executor_not_configured')
  })

  it('connector present but proposal not approved → 409 not_executable (gate holds)', async () => {
    mockResolve.mockResolvedValue('tok')
    mockResolveWithMeta.mockResolvedValue(null)
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g-unapproved'), envForRole('owner', INKWELL))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { executed: boolean; reason: string }
    expect(body.executed).toBe(false)
    expect(body.reason).toMatch(/not_approved/)
  })

  // ── #370: mcpwp resolution at the route level ──────────────────────────────

  it('mcpwp-only pot (no INKWELL_API_URL, valid mcpwp connector) reaches execute() — not blocked by 503', async () => {
    mockResolveWithMeta.mockResolvedValue({
      secret: 'app-pw-123',
      meta: JSON.stringify({ siteUrl: 'https://example.com', username: 'agent' }),
    })
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g-unapproved'), envForRole('owner'))
    // Reaches the kernel's fail-closed not_approved check (409), NOT the route's
    // 503 executor_not_configured — proving the mcpwp connector alone satisfies the gate.
    expect(res.status).toBe(409)
    const body = (await res.json()) as { executed: boolean; reason: string }
    expect(body.reason).toMatch(/not_approved/)
  })

  it('mcpwp connector present but meta malformed, and no inkwell → 503 executor_not_configured', async () => {
    mockResolveWithMeta.mockResolvedValue({ secret: 'app-pw-123', meta: 'not json' })
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g1'), envForRole('owner'))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('executor_not_configured')
  })
})
