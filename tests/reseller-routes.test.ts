// Tests for the reseller provisioning route (src/reseller/routes.ts).
// Drives the real Hono app: the admin gate, dry-run-only refusal, validation passthrough,
// and the size cap. Auth is injected the same way as the other admin route tests — requireAuth
// reads the mupot_session cookie → SESSIONS.get returns a session carrying the role.

import { describe, it, expect, vi } from 'vitest'
import { resellerApp } from '../src/reseller/routes'
import type { Env } from '../src/types'

function envForRole(role: 'owner' | 'admin' | 'member'): Env {
  return {
    TENANT_SLUG: 't',
    BRAND: 'Test',
    DB: { prepare: vi.fn(() => ({ bind: () => ({}), first: vi.fn(), all: vi.fn(), run: vi.fn() })) },
    SESSIONS: {
      get: vi.fn(async () =>
        JSON.stringify({ userId: 'u1', email: 'a@b.com', role, createdAt: '2026-01-01T00:00:00Z' }),
      ),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
}

function req(body?: unknown, opts: { raw?: string } = {}): Request {
  return new Request('https://pot.test/provision-plan', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'mupot_session=sess1',
      Origin: 'https://pot.test',
    },
    body: opts.raw !== undefined ? opts.raw : body === undefined ? undefined : JSON.stringify(body),
  })
}

describe('POST /api/reseller/provision-plan', () => {
  it('non-admin (member) → 403', async () => {
    const res = await resellerApp.fetch(req({ resellerDomain: 'example.com' }), envForRole('member'))
    expect(res.status).toBe(403)
  })

  it('admin + valid → 200 with the plan', async () => {
    const res = await resellerApp.fetch(req({ resellerDomain: 'eztek.ca' }), envForRole('admin'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; slug: string; tier: string }
    expect(body.ok).toBe(true)
    expect(body.slug).toBe('eztek')
    expect(body.tier).toBe('pro')
  })

  it('owner + valid → 200', async () => {
    const res = await resellerApp.fetch(req({ resellerDomain: 'example.com' }), envForRole('owner'))
    expect(res.status).toBe(200)
  })

  it('admin + invalid input → 422 with reason', async () => {
    const res = await resellerApp.fetch(req({ resellerDomain: 'localhost' }), envForRole('admin'))
    expect(res.status).toBe(422)
    const body = (await res.json()) as { ok: boolean; reason: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('invalid_domain')
  })

  it('dryRun:false → 501 (live stand-up is Hadi-go ops, not this endpoint)', async () => {
    const res = await resellerApp.fetch(
      req({ resellerDomain: 'example.com', dryRun: false }),
      envForRole('admin'),
    )
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_implemented')
  })

  it('oversized body → 413', async () => {
    const huge = JSON.stringify({ resellerDomain: 'example.com', pad: 'x'.repeat(9000) })
    const res = await resellerApp.fetch(req(undefined, { raw: huge }), envForRole('admin'))
    expect(res.status).toBe(413)
  })

  it('invalid JSON → 400', async () => {
    const res = await resellerApp.fetch(req(undefined, { raw: '{not json' }), envForRole('admin'))
    expect(res.status).toBe(400)
  })

  it('empty body → 422 (missing domain)', async () => {
    const res = await resellerApp.fetch(req(undefined, { raw: '' }), envForRole('admin'))
    expect(res.status).toBe(422)
  })
})
