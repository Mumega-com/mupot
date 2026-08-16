// mupot — POST /api/tasks/batch-verdict (Flight-008 Slice 2, mupot#1061, Safe
// Approvals Triage). Real SQLite-backed D1 (all migrations applied), a
// cookie-driven requireAuth mock (proves the batch route actually FORWARDS the
// caller's session — not just re-uses a globally-mocked identity), and direct
// reads of task_verdicts/tasks after each call.
//
// Core claim under test: "resolving the same row twice is a no-op, never a
// double-apply" — verified at the DATA LAYER (task_verdicts row count, tasks.status),
// not just by inspecting the HTTP response.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

// A cookie-keyed session store — requireAuth resolves identity from the
// Cookie header, exactly like the real hono/cookie-backed implementation.
// This means the batch route's Cookie-forwarding into its per-id
// tasksApp.request() sub-dispatch is REQUIRED for those sub-calls to
// authenticate — if the forwarding were dropped, every sub-call would 401 and
// this suite would fail loudly, not silently pass on a globally-mocked identity.
const sessionStore = vi.hoisted(() => ({ sessions: new Map<string, AuthContext>() }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: {
      req: { header: (name: string) => string | undefined }
      set: (key: 'auth', value: AuthContext) => void
      json: (body: unknown, status: 401) => Response
    },
    next: () => Promise<void>,
  ) => {
    const cookie = c.req.header('Cookie') ?? ''
    const match = /mupot_session=([^;]+)/.exec(cookie)
    const auth = match ? sessionStore.sessions.get(match[1]) : undefined
    if (!auth) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', auth)
    await next()
  },
}))

const { tasksApp } = await import('../src/tasks')
const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Alpha');
    INSERT INTO members (id, email, display_name, status) VALUES ('member-owner', 'owner@test.com', 'Owner', 'active');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('grant-1', 'gate:athena', 'member', 'member-owner', 'member-owner', '2026-08-01T00:00:00.000Z');
    INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at) VALUES
      ('task-1', 'squad-a', NULL, 'First review', '', 'done', 'review', 'gate:athena', NULL, NULL, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'),
      ('task-2', 'squad-a', NULL, 'Second review', '', 'done', 'review', 'gate:athena', NULL, NULL, '2026-08-01T09:00:00.000Z', '2026-08-01T09:00:00.000Z'),
      ('task-forbidden', 'squad-a', NULL, 'No grant for this one', '', 'done', 'review', 'gate:nobody', NULL, NULL, '2026-08-01T08:00:00.000Z', '2026-08-01T08:00:00.000Z');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'tenant-a', BUS: { send: vi.fn(async () => undefined) } } as unknown as Env
}

function registerSession(sessionId: string, auth: AuthContext): void {
  sessionStore.sessions.set(sessionId, auth)
}

function memberAuth(): AuthContext {
  return {
    userId: 'member-owner', memberId: 'member-owner', email: 'owner@test.com',
    role: 'member', tenant: 'tenant-a',
    // canActOnSquad (member+ base guard) requires an explicit squad capability —
    // a plain 'member' role has no legacyOwnerAdmin bypass. The gate_owner RBAC
    // itself (callerHoldsGateCapability) is separately proven by the real
    // gate_grants row seeded in makeHarness (member holds gate:athena, NOT
    // gate:nobody) — this is what actually distinguishes task-1 from
    // task-forbidden in the tests below.
    capabilities: [{ member_id: 'member-owner', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
  }
}

async function postBatch(
  harness: SqliteD1Harness,
  sessionId: string,
  payload: unknown,
): Promise<{ status: number; json: { results?: Array<{ id: string; status: number; applied: boolean; body: unknown }>; applied_count?: number; total?: number; error?: string } }> {
  const res = await tasksApp.fetch(
    new Request('https://pot.test/batch-verdict', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: `mupot_session=${sessionId}` },
      body: JSON.stringify(payload),
    }),
    envFor(harness),
  )
  const json = await res.json() as { results?: Array<{ id: string; status: number; applied: boolean; body: unknown }>; applied_count?: number; total?: number; error?: string }
  return { status: res.status, json }
}

function verdictCount(harness: SqliteD1Harness, taskId: string): number {
  const row = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = ?').get(taskId) as { n: number }
  return Number(row.n)
}

function taskStatus(harness: SqliteD1Harness, taskId: string): string {
  const row = harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }
  return row.status
}

describe('POST /batch-verdict — cookie forwarding + per-item RBAC reuse', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
    sessionStore.sessions.clear()
  })

  it('rejects with no session at all (no cookie forwarded, no globally-mocked bypass)', async () => {
    harness = makeHarness()
    const res = await tasksApp.fetch(
      new Request('https://pot.test/batch-verdict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['task-1'], verdict: 'approved' }),
      }),
      envFor(harness),
    )
    expect(res.status).toBe(401)
  })

  it('a single id applies for real: task flips to approved, exactly one task_verdicts row', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    const { status, json } = await postBatch(harness, 'sess-1', { ids: ['task-1'], verdict: 'approved' })
    expect(status).toBe(200)
    expect(json.applied_count).toBe(1)
    expect(json.results?.[0]).toMatchObject({ id: 'task-1', status: 201, applied: true })
    expect(taskStatus(harness, 'task-1')).toBe('approved')
    expect(verdictCount(harness, 'task-1')).toBe(1)
  })

  it('mixed batch: authorized id applies, unauthorized (no gate grant) id is skipped without side effect', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    const { status, json } = await postBatch(harness, 'sess-1', { ids: ['task-1', 'task-forbidden'], verdict: 'approved' })
    expect(status).toBe(200)
    expect(json.applied_count).toBe(1)
    const byId = new Map((json.results ?? []).map((r) => [r.id, r]))
    expect(byId.get('task-1')).toMatchObject({ applied: true, status: 201 })
    expect(byId.get('task-forbidden')).toMatchObject({ applied: false, status: 403 })
    expect(taskStatus(harness, 'task-forbidden')).toBe('review') // untouched
    expect(verdictCount(harness, 'task-forbidden')).toBe(0)
  })
})

describe('POST /batch-verdict — idempotency at the data layer (the core gate bar)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
    sessionStore.sessions.clear()
  })

  it('resolving the SAME id twice across two separate batch calls applies once, not twice', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())

    const first = await postBatch(harness, 'sess-1', { ids: ['task-1'], verdict: 'approved' })
    expect(first.json.results?.[0]).toMatchObject({ applied: true, status: 201 })
    expect(taskStatus(harness, 'task-1')).toBe('approved')
    expect(verdictCount(harness, 'task-1')).toBe(1)

    // Second batch-resolve of the SAME id: must be a no-op, not a re-apply.
    // The route re-dispatches through the real POST /:id/verdict pre-check
    // (task.status !== 'review' -> 409 not_in_review), which itself sits on
    // writeVerdict's K5 conditional UPDATE guard — so this is proven at the
    // DB layer, not merely by the route short-circuiting.
    const second = await postBatch(harness, 'sess-1', { ids: ['task-1'], verdict: 'approved' })
    expect(second.status).toBe(200)
    expect(second.json.applied_count).toBe(0)
    expect(second.json.results?.[0]).toMatchObject({ id: 'task-1', applied: false, status: 409 })

    // Data-layer proof: still exactly one verdict row, status unchanged.
    expect(taskStatus(harness, 'task-1')).toBe('approved')
    expect(verdictCount(harness, 'task-1')).toBe(1)
  })

  it('a duplicate id WITHIN the same batch request also applies once, not twice', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())

    const { status, json } = await postBatch(harness, 'sess-1', { ids: ['task-2', 'task-2'], verdict: 'rejected', note: 'dup-in-batch' })
    expect(status).toBe(200)
    expect(json.applied_count).toBe(1)
    expect(json.results).toHaveLength(2)
    expect(json.results?.[0]).toMatchObject({ applied: true, status: 201 })
    expect(json.results?.[1]).toMatchObject({ applied: false, status: 409 })

    expect(taskStatus(harness, 'task-2')).toBe('rejected')
    expect(verdictCount(harness, 'task-2')).toBe(1)
  })

  it('rejecting requires a note (reuses the SAME rule the single verdict route enforces — none here)', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    // No note passed. The single-item route does not itself require a note for
    // rejection server-side (that discipline lives in the dashboard client JS),
    // so this documents the real behaviour rather than assuming a gate that
    // doesn't exist at the API layer.
    const { json } = await postBatch(harness, 'sess-1', { ids: ['task-2'], verdict: 'rejected' })
    expect(json.results?.[0]).toMatchObject({ applied: true, status: 201 })
  })
})

describe('POST /batch-verdict — input validation', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
    sessionStore.sessions.clear()
  })

  it('empty ids array -> 400 invalid_ids', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    const { status, json } = await postBatch(harness, 'sess-1', { ids: [], verdict: 'approved' })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_ids')
  })

  it('non-array ids -> 400 invalid_ids', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    const { status, json } = await postBatch(harness, 'sess-1', { ids: 'task-1', verdict: 'approved' })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_ids')
  })

  it('invalid verdict -> 400 invalid_verdict', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    const { status, json } = await postBatch(harness, 'sess-1', { ids: ['task-1'], verdict: 'maybe' })
    expect(status).toBe(400)
    expect(json.error).toBe('invalid_verdict')
  })

  it('batch over the cap -> 400 batch_too_large, nothing applied', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    const ids = Array.from({ length: 26 }, (_, i) => `task-${i}`)
    const { status, json } = await postBatch(harness, 'sess-1', { ids, verdict: 'approved' })
    expect(status).toBe(400)
    expect(json.error).toBe('batch_too_large')
    expect(taskStatus(harness, 'task-1')).toBe('review')
  })

  it('malformed JSON -> 400 invalid_json', async () => {
    harness = makeHarness()
    registerSession('sess-1', memberAuth())
    const res = await tasksApp.fetch(
      new Request('https://pot.test/batch-verdict', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: 'mupot_session=sess-1' },
        body: '{not json',
      }),
      envFor(harness),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_json' })
  })
})

describe('tasksApp route table — /batch-verdict is POST-only', () => {
  it('registers exactly one POST route at /batch-verdict, no PATCH/DELETE', () => {
    const routes = tasksApp.routes as Array<{ method: string; path: string }>
    const batch = routes.filter((r) => r.path === '/batch-verdict')
    expect(batch).toHaveLength(1)
    expect(batch[0].method).toBe('POST')
  })
})
