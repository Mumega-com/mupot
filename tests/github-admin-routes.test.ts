// Tests for the GitHub admin JSON routes on dashboardApp.
//   GET  /admin/github/status
//   POST /admin/github/agent-def
//   POST /admin/github/assign-copilot
//
// These assert the auth gate (isAdmin), input handling, and that the routes wire into the
// already-tested service layer. Success paths that require live GitHub fetch are covered in
// github-repo-write.test.ts (with injected fetch); here we drive the deterministic gate +
// fail-closed paths through the real route.

import { describe, it, expect, vi } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'

function envForRole(role: 'owner' | 'admin' | 'member', extra: Record<string, unknown> = {}): Env {
  const stmt = {
    bind: (..._a: unknown[]) => stmt,
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }
  return {
    TENANT_SLUG: 't',
    BRAND: 'Test',
    DB: { prepare: vi.fn(() => stmt) },
    SESSIONS: {
      get: vi.fn(async () =>
        JSON.stringify({ userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z' }),
      ),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    ...extra,
  } as unknown as Env
}

function req(path: string, method: 'GET' | 'POST', body?: unknown): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'mupot_session=sess1',
      Origin: 'https://pot.test',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('GET /admin/github/status', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(req('/admin/github/status', 'GET'), envForRole('member'))
    expect(res.status).toBe(403)
  })

  it('admin → 200 capability snapshot (free tier, enterprise off by default)', async () => {
    const res = await dashboardApp.fetch(req('/admin/github/status', 'GET'), envForRole('admin'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tier: string
      enterpriseEnabled: boolean
      features: Array<{ feature: string; enabled: boolean; enterprise: boolean }>
    }
    expect(body.tier).toBe('free')
    expect(body.enterpriseEnabled).toBe(false)
    // base feature on, enterprise feature off
    expect(body.features.find((f) => f.feature === 'issue_mirror')?.enabled).toBe(true)
    expect(body.features.find((f) => f.feature === 'org_mcp_allowlist')?.enabled).toBe(false)
  })
})

describe('POST /admin/github/agent-def', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/agent-def', 'POST', { repo: 'a/b', agentName: 'kasra', content: '# x' }),
      envForRole('member'),
    )
    expect(res.status).toBe(403)
  })

  it('admin, bad json → 400 invalid_json', async () => {
    const r = new Request('https://pot.test/admin/github/agent-def', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'mupot_session=sess1', Origin: 'https://pot.test' },
      body: '{not json',
    })
    const res = await dashboardApp.fetch(r, envForRole('admin'))
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_json')
  })

  it('admin, valid input but no token configured → 400 no_token (fail-closed)', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/agent-def', 'POST', { repo: 'Mumega-com/mumega-com', agentName: 'kasra', content: '# Kasra' }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('no_token')
  })

  it('admin, bad agent name → 400 invalid_agent_name (before any network)', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/agent-def', 'POST', { repo: 'a/b', agentName: '../escape', content: '# x' }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('invalid_agent_name')
  })
})

describe('POST /admin/github/assign-copilot', () => {
  it('non-admin → 403', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/assign-copilot', 'POST', { repo: 'a/b', issueNumber: 1 }),
      envForRole('member'),
    )
    expect(res.status).toBe(403)
  })

  it('admin, free tier → 400 capability_disabled (needs paid plan)', async () => {
    const res = await dashboardApp.fetch(
      req('/admin/github/assign-copilot', 'POST', { repo: 'a/b', issueNumber: 1 }),
      envForRole('admin'),
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('capability_disabled')
  })
})
