// tests/pot-provisioner-route-auth.test.ts — pins POST /api/pots/provision's OWN
// operator-principal and tenant-fence refusals AT THE HTTP LAYER (mupot#1507-v2 P1-B).
//
// WHY A SEPARATE FILE
//
// `tests/pot-provisioner.test.ts` drives `potsApp` through the REAL `requireAuth`
// middleware (`src/auth/index.ts`'s cookie-session loader) — its `ownerEnv()` helper seeds
// a real session in a fake SESSIONS KV and lets `loadAuthFromCookie` build the `AuthContext`
// from that. That loader NEVER sets `boundAgentId` (it is a dashboard-cookie session
// builder; `boundAgentId` is populated only by the MCP/OAuth auth paths — see
// `src/mcp/index.ts`, `src/mcp/oauth-authorize.ts`), and it derives `tenant` unconditionally
// from `c.env.TENANT_SLUG`, so `auth.tenant !== env.TENANT_SLUG` can never be reached
// through that loader either. Both of `routes.ts`'s own checks
// (`auth.boundAgentId` / `auth.tenant !== c.env.TENANT_SLUG`) are therefore DEFENSE IN
// DEPTH against a caller shape the real cookie loader cannot currently produce — but a
// future change to auth resolution (a bearer path added to this router, an auth-context
// merge) could make either state reachable, and this file's job is to pin the ROUTE's own
// refusal so a regression there is caught independent of whether today's cookie loader
// happens to shield it.
//
// This repo's own established pattern for driving an arbitrary `AuthContext` through a
// real Hono route (bypassing cookie parsing) is `vi.mock('../src/auth', ...)` with a
// hoisted mutable auth slot — see tests/org-agent-membership.test.ts. Reused verbatim here.
// A SEPARATE test file is required because vi.mock is module-scoped: mocking `../src/auth`
// in the SAME file as tests/pot-provisioner.test.ts's real-cookie-session tests would
// silently break every one of those (their `ownerEnv()` sessions would never be read).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AuthContext, Env } from '../src/types'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { potsApp } = await import('../src/pots/routes')

function provisionRequest(body: Record<string, unknown>): Request {
  return new Request('http://localhost/provision', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  })
}

const BASE_BODY = { slug: 'routeauth', brand_name: 'Route Auth Co', admin_email: 'a@routeauth.test' }

describe('POST /api/pots/provision — route-level operator-principal + tenant fence (mupot#1507-v2 P1-B)', () => {
  beforeEach(() => {
    authState.current = null
  })

  it('refuses a bound-agent session with operator_principal_required, before provisionSovereignPot ever runs', async () => {
    authState.current = {
      userId: 'agent-user', email: null, role: 'admin', tenant: 'mumega',
      memberId: 'agent-member', boundAgentId: 'agent-caller',
    }
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const env = { TENANT_SLUG: 'mumega', SECRET_ENV_CF_API_TOKEN: 'cf-tok' } as unknown as Env

    const res = await potsApp.request(provisionRequest(BASE_BODY), {}, env)

    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('operator_principal_required')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses a caller whose tenant does not match this deployment, with tenant_mismatch', async () => {
    authState.current = {
      userId: 'foreign-user', email: null, role: 'admin', tenant: 'foreign-tenant',
    }
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy as any
    const env = { TENANT_SLUG: 'mumega', SECRET_ENV_CF_API_TOKEN: 'cf-tok' } as unknown as Env

    const res = await potsApp.request(provisionRequest(BASE_BODY), {}, env)

    expect(res.status).toBe(403)
    const json = await res.json() as { error: string }
    expect(json.error).toBe('tenant_mismatch')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSITIVE CONTROL: an operator (no boundAgentId, matching tenant) reaches past both fences (fails later, for an unrelated reason — no D1 harness wired here)', async () => {
    authState.current = {
      userId: 'owner-user', email: 'owner@mumega.test', role: 'owner', tenant: 'mumega', memberId: 'owner-mem',
    }
    const env = { TENANT_SLUG: 'mumega', SECRET_ENV_CF_API_TOKEN: 'cf-tok' } as unknown as Env

    const res = await potsApp.request(provisionRequest(BASE_BODY), {}, env)

    // Neither route-level fence fired — this test would otherwise pass FALSELY (a fence
    // that refuses EVERYONE, including legitimate operators, also produces 403s the two
    // tests above cannot tell apart from a correctly-scoped one).
    const json = await res.json() as { error?: string }
    expect(json.error).not.toBe('operator_principal_required')
    expect(json.error).not.toBe('tenant_mismatch')
  })
})
