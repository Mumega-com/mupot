// tests/s4-live-wiring.test.ts — S4 live-wire: SSRF guard + the owner-only execute route.
//
// A. SSRF (WARN-1): inkwellContentWrite must reject non-https / internal / metadata
//    apiUrl BEFORE any fetch.
// B. POST /admin/departments/:dept/execute/:gateId — owner/admin gate + fail-closed
//    wiring (no INKWELL_API_URL → 503, no connector → 503, unknown dept → 404,
//    unapproved proposal → 409). The full executed:true path is covered at the kernel
//    level (executor-inkwell-s4 / department-proposals-durability).

import { describe, it, expect, vi } from 'vitest'

// Mock only resolveConnector; keep the rest of the connector service intact.
vi.mock('../src/connectors/service', async (orig) => ({
  ...(await orig<typeof import('../src/connectors/service')>()),
  resolveConnector: vi.fn(),
}))

import { dashboardApp } from '../src/dashboard/index'
import { resolveConnector } from '../src/connectors/service'
import { inkwellContentWrite } from '../src/departments/executors/inkwell'
import type { Env } from '../src/types'

const mockResolve = vi.mocked(resolveConnector)

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
    await expect(inkwellContentWrite({ apiUrl, token: 'tok' }, payload, neverFetch)).rejects.toMatchObject({
      reason: 'inkwell_bad_apiurl',
    })
    expect(neverFetch).not.toHaveBeenCalled()
  })

  it('allows a public https host', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/s' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const r = await inkwellContentWrite({ apiUrl: 'https://inkwell-api.mumega.com', token: 'tok' }, payload, ok)
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

  it('no INKWELL_API_URL → 503 executor_not_configured', async () => {
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g1'), envForRole('owner'))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('executor_not_configured')
  })

  it('no inkwell connector (resolveConnector null) → 503 connector_not_configured', async () => {
    mockResolve.mockResolvedValue(null)
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g1'), envForRole('owner', INKWELL))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { error: string }).error).toBe('connector_not_configured')
  })

  it('connector present but proposal not approved → 409 not_executable (gate holds)', async () => {
    mockResolve.mockResolvedValue('tok')
    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g-unapproved'), envForRole('owner', INKWELL))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { executed: boolean; reason: string }
    expect(body.executed).toBe(false)
    expect(body.reason).toMatch(/not_approved/)
  })
})
