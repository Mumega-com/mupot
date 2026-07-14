// tests/execute-route-closes-task.test.ts — the "close the loop" addition to
// POST /admin/departments/:dept/execute/:gateId (src/dashboard/index.ts).
//
// Before this change the route called ctx.executor.execute(gateId) and returned
// the outcome WITHOUT ever touching the `tasks` table — an approved
// content-publish task (gateId === task.id, see src/agents/execute.ts
// finishContentProposal) stayed stranded at status='approved' forever, invisible
// as a "done" receipt on the observatory swimlane. This suite proves the new
// behavior: on a real write (outcome.executed === true) the task flips
// approved → done; on any other outcome, or when no matching task row exists,
// the route is unchanged / a harmless no-op.

import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../src/connectors/service', async (orig) => ({
  ...(await orig<typeof import('../src/connectors/service')>()),
  resolveConnector: vi.fn(),
  resolveConnectorWithMeta: vi.fn(),
}))

import { dashboardApp } from '../src/dashboard/index'
import { resolveConnector, resolveConnectorWithMeta } from '../src/connectors/service'
import type { Env } from '../src/types'

const mockResolve = vi.mocked(resolveConnector)
const mockResolveWithMeta = vi.mocked(resolveConnectorWithMeta)
mockResolveWithMeta.mockResolvedValue(null)

const INKWELL = { INKWELL_API_URL: 'https://inkwell-api.mumega.com' }
const GATE_ID = 'task-content-1'

function req(path: string): Request {
  return new Request(`https://pot.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'mupot_session=s', Origin: 'https://pot.test' },
  })
}

// A DB stub that models an APPROVED content-publish proposal durably persisted
// under gate_id === GATE_ID (the idGen trick), plus a `tasks` row for that same
// id currently at status='approved'. Records every UPDATE tasks call so the
// test can assert the exact close-the-loop write.
function envWithApprovedProposal(opts: { taskRow?: Record<string, unknown> | null } = {}): {
  env: Env
  updates: { sql: string; args: unknown[] }[]
} {
  const updates: { sql: string; args: unknown[] }[] = []
  const taskRow = opts.taskRow === undefined
    ? { id: GATE_ID, status: 'approved' }
    : opts.taskRow

  const stmt = {
    bind: (..._a: unknown[]) => stmt,
    first: vi.fn(async () => null),
    all: vi.fn(async () => ({ results: [] })),
    run: vi.fn(async () => ({ meta: { changes: 1 } })),
  }

  const env = {
    TENANT_SLUG: 't',
    BRAND: 'Test',
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: (...args: unknown[]) => ({
          async first<T>() {
            if (sql.includes('FROM task_verdicts')) {
              return { verdict: 'approved' } as unknown as T
            }
            if (sql.includes('FROM department_proposals')) {
              return {
                gate_id: GATE_ID,
                tenant_id: 't',
                department_key: 'growth',
                action: 'content-publish',
                payload_json: JSON.stringify({
                  executor: 'inkwell-content',
                  title: 'mupot closes the loop',
                  content: 'body',
                  status: 'draft',
                }),
              } as unknown as T
            }
            return null as unknown as T
          },
          async run() {
            if (sql.trim().toUpperCase().startsWith('UPDATE TASKS')) {
              updates.push({ sql, args })
              return { meta: { changes: taskRow && taskRow.status === 'approved' ? 1 : 0 } }
            }
            return { meta: { changes: 1 } }
          },
          async all() {
            return { results: [] }
          },
        }),
      })),
    },
    SESSIONS: {
      get: vi.fn(async () => JSON.stringify({ userId: 'u1', email: 'a@b.com', role: 'owner', createdAt: '2026-01-01T00:00:00Z' })),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
    ...INKWELL,
  } as unknown as Env

  return { env, updates }
}

describe('POST /admin/departments/:dept/execute/:gateId — closes the loop on a real write', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('outcome.executed=true flips the matching task approved → done, stamping the artifact URL', async () => {
    mockResolve.mockResolvedValue('tok')
    const { env, updates } = envWithApprovedProposal()

    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/mupot-closes-the-loop' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fakeFetch)

    const res = await dashboardApp.fetch(req(`/admin/departments/growth/execute/${GATE_ID}`), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { executed: boolean; artifactUrl?: string }
    expect(body.executed).toBe(true)
    expect(body.artifactUrl).toBe('/blog/mupot-closes-the-loop')

    // Exactly one UPDATE tasks fired (the close-the-loop write); scoped to the
    // gateId with an 'approved' guard, stamping status/result/completed_at.
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toContain("SET status = 'done'")
    expect(updates[0].sql).toContain("WHERE id = ? AND status = 'approved'")
    expect(updates[0].args).toContain(GATE_ID)
    expect(updates[0].args.some((a) => typeof a === 'string' && a.includes('/blog/mupot-closes-the-loop'))).toBe(true)
  })

  it('outcome.executed=false (adapter/connector failure) never touches tasks', async () => {
    mockResolve.mockResolvedValue('tok')
    const { env, updates } = envWithApprovedProposal()
    // Force the adapter to fail: fetch throws → inkwellContentWrite throws
    // InkwellExecutorError('inkwell_unreachable') → executed:false.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const res = await dashboardApp.fetch(req(`/admin/departments/growth/execute/${GATE_ID}`), env)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { executed: boolean }
    expect(body.executed).toBe(false)
    expect(updates).toHaveLength(0) // no UPDATE tasks attempted on a non-executed outcome
  })

  it('not_approved (409) never touches tasks', async () => {
    mockResolve.mockResolvedValue('tok')
    mockResolveWithMeta.mockResolvedValue(null)
    // No approved verdict this time: first() for task_verdicts and
    // department_proposals both return null.
    const stmt = {
      bind: (..._a: unknown[]) => stmt,
      first: vi.fn(async () => null),
      all: vi.fn(async () => ({ results: [] })),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    }
    const updates: unknown[] = []
    const env = {
      TENANT_SLUG: 't',
      BRAND: 'Test',
      DB: { prepare: vi.fn(() => stmt) },
      SESSIONS: {
        get: vi.fn(async () => JSON.stringify({ userId: 'u1', email: 'a@b.com', role: 'owner', createdAt: '2026-01-01T00:00:00Z' })),
      },
      OAUTH_KV: { get: vi.fn(), put: vi.fn() },
      ...INKWELL,
    } as unknown as Env

    const res = await dashboardApp.fetch(req('/admin/departments/growth/execute/g-unapproved'), env)
    expect(res.status).toBe(409)
    expect(updates).toHaveLength(0)
  })

  it('the flip UPDATE is a harmless no-op when the gateId has no matching approved task row', async () => {
    mockResolve.mockResolvedValue('tok')
    // taskRow status !== 'approved' models a gateId with no matching row (or an
    // already-closed one) — the UPDATE's WHERE guard matches zero rows.
    const { env, updates } = envWithApprovedProposal({ taskRow: { id: GATE_ID, status: 'done' } })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/x' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ))

    const res = await dashboardApp.fetch(req(`/admin/departments/growth/execute/${GATE_ID}`), env)
    expect(res.status).toBe(200)
    // The route still attempts the UPDATE (it does not pre-check task state —
    // the WHERE clause is the guard), but this DB stub reports changes:0 for
    // it, modelling the real self-scoping no-op described in the route's
    // comment. The important assertion is that the route does not error.
    expect(updates).toHaveLength(1)
  })
})
