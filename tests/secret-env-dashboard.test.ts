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
import type { AuthContext, Env } from '../src/types'

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

// ── minimal D1 mock — secret_env_* tables only, patterned on the identical
// harness in tests/secret-env-service.test.ts so requestSecretEnv / bindSecretEnv
// / rejectSecretEnv behave exactly as their unit tests already prove. Any other
// query (loadApprovals/loadPublishable's task/squad/agent reads) falls back to
// empty results — those code paths are covered elsewhere. ────────────────────

interface CallRecord { sql: string; binds: unknown[] }

function makeEnv(tenant = 'test-tenant'): { env: Env; calls: CallRecord[] } {
  const calls: CallRecord[] = []
  const requests = new Map<string, Record<string, unknown>>()
  const bindings = new Map<string, Record<string, unknown>>()
  const audit: Record<string, unknown>[] = []

  const envBase: Record<string, unknown> = {
    TENANT_SLUG: tenant,
    BRAND: 'Test',
    SECRET_ENV_CF_ACCOUNT_ID: 'acct',
    SECRET_ENV_CF_SCRIPT_NAME: 'mupot-t',
    SECRET_ENV_CF_API_TOKEN: 'ops-tok',
    SESSIONS: { get: vi.fn(), put: vi.fn() },
  }

  envBase.DB = {
    prepare(sql: string) {
      const call: CallRecord = { sql, binds: [] }
      calls.push(call)
      const sNorm = sql.replace(/\s+/g, ' ').trim().toUpperCase()
      const stmt = {
        bind(...args: unknown[]) { call.binds = args; return stmt },
        async run() {
          if (sNorm.startsWith('INSERT INTO SECRET_ENV_REQUESTS')) {
            const [id, ten, reason, schemaJson, requestedBy, createdAt] = call.binds
            requests.set(id as string, {
              id, tenant: ten, reason, schema_json: schemaJson, status: 'pending',
              requested_by: requestedBy, decided_by: null, created_at: createdAt, decided_at: null,
            })
            return { meta: { changes: 1 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_REQUESTS') && sNorm.includes("STATUS = 'APPROVED'")) {
            const [actorId, decidedAt, requestId, ten] = call.binds
            const row = requests.get(requestId as string)
            if (row && row.tenant === ten) {
              row.status = 'approved'; row.decided_by = actorId; row.decided_at = decidedAt
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_REQUESTS') && sNorm.includes("STATUS = 'REJECTED'")) {
            const [actorId, decidedAt, requestId, ten] = call.binds
            const row = requests.get(requestId as string)
            if (row && row.tenant === ten) {
              row.status = 'rejected'; row.decided_by = actorId; row.decided_at = decidedAt
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          if (sNorm.startsWith('INSERT INTO SECRET_ENV_BINDINGS')) {
            const [id, ten, bindingName, purpose, adapterHint, requestedBy, requestId, createdAt] = call.binds
            bindings.set(id as string, {
              id, tenant: ten, binding_name: bindingName, purpose, adapter_hint: adapterHint,
              status: 'pending', requested_by: requestedBy, bound_by: null, request_id: requestId,
              created_at: createdAt, bound_at: null, revoked_at: null,
            })
            return { meta: { changes: 1 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_BINDINGS') && sNorm.includes("STATUS = 'BOUND'")) {
            const [actorId, boundAt, bindingId, ten] = call.binds
            const row = bindings.get(bindingId as string)
            if (row && row.tenant === ten) {
              row.status = 'bound'; row.bound_by = actorId; row.bound_at = boundAt
              return { meta: { changes: 1 } }
            }
            return { meta: { changes: 0 } }
          }
          if (sNorm.startsWith('UPDATE SECRET_ENV_BINDINGS') && sNorm.includes("STATUS = 'REVOKED'")) {
            const [revokedAt, ten, requestId] = call.binds
            let changes = 0
            for (const row of bindings.values()) {
              if (row.tenant === ten && row.request_id === requestId && row.status === 'pending') {
                row.status = 'revoked'; row.revoked_at = revokedAt
                changes += 1
              }
            }
            return { meta: { changes } }
          }
          if (sNorm.startsWith('INSERT INTO SECRET_ENV_AUDIT')) {
            const [id, ten, requestId, bindingName, action, actorId, detail, recordedAt] = call.binds
            audit.push({ id, tenant: ten, request_id: requestId, binding_name: bindingName, action, actor_id: actorId, detail, recorded_at: recordedAt })
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 1 } }
        },
        async first<T>(): Promise<T | null> {
          if (sNorm.includes('FROM SECRET_ENV_REQUESTS') && sNorm.includes('LIMIT 1')) {
            const [requestId, ten] = call.binds
            const row = requests.get(requestId as string)
            if (row && row.tenant === ten) return row as unknown as T
            return null
          }
          return null
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sNorm.includes('FROM SECRET_ENV_REQUESTS') && sNorm.includes("STATUS = 'PENDING'")) {
            const [ten] = call.binds
            return { results: [...requests.values()].filter((r) => r.tenant === ten && r.status === 'pending') as unknown as T[] }
          }
          if (sNorm.includes('FROM SECRET_ENV_BINDINGS') && sNorm.includes('REQUEST_ID') && sNorm.includes("STATUS = 'PENDING'")) {
            const [ten, requestId] = call.binds
            return { results: [...bindings.values()].filter((r) => r.tenant === ten && r.request_id === requestId && r.status === 'pending') as unknown as T[] }
          }
          return { results: [] }
        },
      }
      return stmt
    },
  }

  return { env: envBase as unknown as Env, calls }
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

    const plaintext = 'sk-super-secret-plaintext-XYZ-123'
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

    authState.current = auth('member', { memberId: 'm-1', userId: 'm-1' })
    const res = await dashboardApp.fetch(new Request('https://pot.test/approvals'), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('Secret env grants')
    expect(body).not.toContain('/admin/secret-env/')
  })
})
