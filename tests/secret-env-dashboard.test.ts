// tests/secret-env-dashboard.test.ts — Task 5: the paste-capable admin-only
// "Secret env grants" section on GET /approvals, plus its two POST routes:
//   POST /admin/secret-env/:requestId/bind
//   POST /admin/secret-env/:requestId/reject
//
// Custody invariant under test throughout: the response body (success or
// error) must NEVER contain the pasted secret value — only binding NAMES ever
// flow back to the browser. See src/secret-env/service.ts (bindSecretEnv) and
// src/dashboard/secret-env.ts (the render side of that contract).

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      get: (key: 'auth') => AuthContext | undefined
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { dashboardApp } = await import('../src/dashboard')
const { requestSecretEnv, listPendingSecretEnvRequests } = await import('../src/secret-env/service')

// ── real D1, real schema — the WHOLE committed migration chain via
// applyAllMigrations (the #684 ratchet — scripts/check-test-schema-source.mjs).
// The first draft of this file hand-rolled a D1-shaped object literal keyed
// off secret_env_* SQL substrings; any other query (loadApprovals/
// loadPublishable's task/squad/agent reads) fell back to `{ results: [] }`
// blind — a real, empty schema produces exactly that same shape honestly,
// so nothing here needs a fallback branch at all. ───────────────────────────

interface CallRecord { sql: string }

/**
 * Wraps the real D1 handle to COUNT prepare() calls without faking anything —
 * every prepare/bind/run/first/all is the genuine SqliteD1Statement, this only
 * observes how many statements were prepared. Used for the one assertion that
 * needs it: proving the 403 gate short-circuits before ANY query is issued,
 * not merely before a write. Pattern matches the existing `withPreBatchHook`
 * wrapper in tests/addon-bindings.test.ts.
 */
function countingDb(realDb: Env['DB']): { db: Env['DB']; calls: CallRecord[] } {
  const calls: CallRecord[] = []
  const db = {
    prepare(sql: string) {
      calls.push({ sql })
      return realDb.prepare(sql)
    },
    batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      return realDb.batch<T>(statements)
    },
  } as unknown as Env['DB']
  return { db, calls }
}

function makeEnv(tenant = 'test-tenant'): { env: Env; harness: SqliteD1Harness; calls: CallRecord[] } {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const { db, calls } = countingDb(harness.db)

  const envBase: Record<string, unknown> = {
    TENANT_SLUG: tenant,
    BRAND: 'Test',
    SECRET_ENV_CF_ACCOUNT_ID: 'acct',
    SECRET_ENV_CF_SCRIPT_NAME: 'mupot-t',
    SECRET_ENV_CF_API_TOKEN: 'ops-tok',
    SESSIONS: { get: vi.fn(), put: vi.fn() },
    DB: db,
  }

  return { env: envBase as unknown as Env, harness, calls }
}

function auth(role: AuthContext['role'], over: Partial<AuthContext> = {}): AuthContext {
  return { tenant: 'test-tenant', role, userId: 'admin-1', memberId: 'admin-1', ...over } as AuthContext
}

function formRequest(path: string, values: Record<string, string>): Request {
  return new Request(`https://pot.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://pot.test' },
    body: new URLSearchParams(values),
  })
}

const validKeys = [{ name: 'NOTION_API_KEY', purpose: 'Read/write Notion pages for the agent' }]

afterEach(() => {
  authState.current = null
  vi.unstubAllGlobals()
})

// ── POST /admin/secret-env/:requestId/bind ───────────────────────────────────

describe('POST /admin/secret-env/:requestId/bind', () => {
  it('non-admin -> 403, no D1 write, paste never touches the response', async () => {
    const { env, calls } = makeEnv()
    authState.current = auth('member', { memberId: 'm-1', userId: 'm-1' })

    const res = await dashboardApp.fetch(
      formRequest('/admin/secret-env/req-1/bind', { secret__NOTION_API_KEY: 'sk-paste-value' }),
      env,
    )
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
    const body = await res.text()
    expect(body).not.toContain('sk-paste-value')
  })

  it('admin bind with mocked CF -> 200 HTML confirmation listing names only, never the paste', async () => {
    const { env } = makeEnv()
    authState.current = auth('admin')

    const created = await requestSecretEnv(env, {
      keys: validKeys,
      reason: 'Need Notion access for the docs adapter',
      adapterHint: 'mcp:notion',
      requestedBy: 'agent-1',
    })
    if (!created.ok) throw new Error('setup: requestSecretEnv failed')

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const plaintext = 'CANARY-plaintext-must-never-appear-XYZ-123'
    const res = await dashboardApp.fetch(
      formRequest(`/admin/secret-env/${created.request.id}/bind`, { secret__NOTION_API_KEY: plaintext }),
      env,
    )
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const body = await res.text()
    expect(body).toContain('Secret env bound')
    expect(body).toContain('NOTION_API_KEY')
    // Custody: the pasted value must never appear anywhere in the response body.
    expect(body).not.toContain(plaintext)
  })

  it('missing paste value -> error page, still never echoes the (absent) value', async () => {
    const { env } = makeEnv()
    authState.current = auth('admin')

    const created = await requestSecretEnv(env, {
      keys: validKeys, reason: 'Need Notion access', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!created.ok) throw new Error('setup: requestSecretEnv failed')

    const res = await dashboardApp.fetch(
      formRequest(`/admin/secret-env/${created.request.id}/bind`, {}),
      env,
    )
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain('missing_value_for_NOTION_API_KEY')
  })
})

// ── POST /admin/secret-env/:requestId/reject ─────────────────────────────────

describe('POST /admin/secret-env/:requestId/reject', () => {
  it('non-admin -> 403', async () => {
    const { env } = makeEnv()
    authState.current = auth('member', { memberId: 'm-1', userId: 'm-1' })

    const res = await dashboardApp.fetch(formRequest('/admin/secret-env/req-1/reject', {}), env)
    expect(res.status).toBe(403)
  })

  it('admin reject marks the request rejected — no CF call, request drops off the pending queue', async () => {
    const { env } = makeEnv()
    authState.current = auth('admin')

    const created = await requestSecretEnv(env, {
      keys: validKeys, reason: 'Need Notion access', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!created.ok) throw new Error('setup: requestSecretEnv failed')

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await dashboardApp.fetch(formRequest(`/admin/secret-env/${created.request.id}/reject`, {}), env)
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.text()
    expect(body).toContain('rejected')

    const pending = await listPendingSecretEnvRequests(env)
    expect(pending).toHaveLength(0)
  })
})

// ── GET /approvals — the admin-only section itself ───────────────────────────

describe('GET /approvals — secret-env section', () => {
  it('admin sees the pending card with a bind form naming the key, never a paste value', async () => {
    const { env } = makeEnv()
    authState.current = auth('admin')

    const created = await requestSecretEnv(env, {
      keys: validKeys, reason: 'Need Notion access', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!created.ok) throw new Error('setup: requestSecretEnv failed')

    const res = await dashboardApp.fetch(new Request('https://pot.test/approvals'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Secret env grants')
    expect(body).toContain('NOTION_API_KEY')
    expect(body).toContain(`/admin/secret-env/${created.request.id}/bind`)
    expect(body).toContain(`/admin/secret-env/${created.request.id}/reject`)
  })

  it('non-admin never sees the secret-env section, even though a request is pending', async () => {
    const { env } = makeEnv()
    authState.current = auth('admin')
    const created = await requestSecretEnv(env, {
      keys: validKeys, reason: 'r', adapterHint: null, requestedBy: 'agent-1',
    })
    if (!created.ok) throw new Error('setup: requestSecretEnv failed')

        // The observer grant is REQUIRED for this test to test what it names. Main added a
    // dashboard-wide baseline gate (isOrgAdmin || holdsCapabilityFloor(auth, 'observer')),
    // so a member with NO capabilities is refused at the door with 403. Asserting that 403
    // would look like a passing test while proving only that the BASELINE gate works — the
    // secret-env section gating would never be reached. The principal here must be one that
    // CAN load /approvals and still must not see the secret-env section.
authState.current = auth('member', { memberId: 'm-1', userId: 'm-1', capabilities: [{ member_id: 'm-1', scope_type: 'org', scope_id: null, capability: 'observer' }] as never })
    const res = await dashboardApp.fetch(new Request('https://pot.test/approvals'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('Secret env grants')
    expect(body).not.toContain('/admin/secret-env/')
  })
})
