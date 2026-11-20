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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { dashboardApp } from '../src/dashboard/index'
import { addConnector } from '../src/connectors/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

const GATE_ID = 'task-content-1'

let h: SqliteD1Harness
let env: Env

function req(path: string): Request {
  return new Request(`https://pot.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'mupot_session=s', Origin: 'https://pot.test' },
  })
}

// Real schema: a task at `status` in a squad with a squad-scoped Inkwell connector (B3c), plus
// optionally an APPROVED content-publish proposal + verdict under gate_id === the task id.
function seed(opts: { status?: string; approved?: boolean } = {}): void {
  const { status = 'approved', approved = true } = opts
  h.sqlite
    .prepare(`INSERT INTO tasks (id, squad_id, title, body, status, done_when) VALUES (?, 'squad-a', 't', 'b', ?, 'd')`)
    .run(GATE_ID, status)
  if (!approved) return
  h.sqlite
    .prepare(`INSERT INTO department_proposals (gate_id, tenant_id, department_key, action, payload_json) VALUES (?, 't', 'growth', 'content-publish', ?)`)
    .run(GATE_ID, JSON.stringify({ executor: 'inkwell-content', title: 'mupot closes the loop', content: 'body', status: 'draft' }))
  h.sqlite
    .prepare(`INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES ('v1', ?, 'approved', NULL, 'm1', '2026-07-16T12:00:00.000Z')`)
    .run(GATE_ID)
}

const taskRow = () =>
  h.sqlite.prepare('SELECT status, result, completed_at FROM tasks WHERE id = ?').get(GATE_ID) as {
    status: string
    result: string | null
    completed_at: string | null
  }

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.prepare('INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)').run('dept-1', 'growth', 'Growth')
  h.sqlite.prepare('INSERT INTO squads (id, department_id, slug, name, charter) VALUES (?, ?, ?, ?, ?)').run('squad-a', 'dept-1', 'squad-a', 'squad-a', 'c')
  env = {
    TENANT_SLUG: 't',
    BRAND: 'Test',
    INKWELL_API_URL: 'https://inkwell-api.mumega.com',
    CONNECTOR_MASTER_KEY: 'a'.repeat(64),
    DB: h.db,
    SESSIONS: {
      get: vi.fn(async () => JSON.stringify({ userId: 'u1', email: 'a@b.com', role: 'owner', createdAt: '2026-01-01T00:00:00Z' })),
    },
    OAUTH_KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env
  // B3c: Inkwell resolves via the task's squad-scoped connector (meta.tenantSlug), not the pot connector.
  const r = await addConnector(env, {
    type: 'inkwell',
    label: 'inkwell-squad-a',
    secret: 'tok',
    meta: JSON.stringify({ tenantSlug: 'tenant-a' }),
    scope_type: 'squad',
    scope_id: 'squad-a',
    created_by: 'm1',
  })
  if (!r.ok) throw new Error(`addConnector failed: ${r.error}`)
})

describe('POST /admin/departments/:dept/execute/:gateId — closes the loop on a real write', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    h.close()
  })

  it('outcome.executed=true flips the matching task approved → done, stamping the artifact URL', async () => {
    seed()
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/mupot-closes-the-loop' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))

    const res = await dashboardApp.fetch(req(`/admin/departments/growth/execute/${GATE_ID}`), env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { executed: boolean; artifactUrl?: string }
    expect(body.executed).toBe(true)
    expect(body.artifactUrl).toBe('/blog/mupot-closes-the-loop')

    // The close-the-loop write, observed on the real row: status/result/completed_at stamped.
    const row = taskRow()
    expect(row.status).toBe('done')
    expect(row.result).toContain('/blog/mupot-closes-the-loop')
    expect(row.completed_at).toBeTruthy()
  })

  it('outcome.executed=false (adapter/connector failure) never touches tasks', async () => {
    seed()
    // fetch throws → inkwellContentWrite throws InkwellExecutorError('inkwell_unreachable') → executed:false.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))

    const res = await dashboardApp.fetch(req(`/admin/departments/growth/execute/${GATE_ID}`), env)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { executed: boolean }
    expect(body.executed).toBe(false)
    const row = taskRow()
    expect(row.status).toBe('approved')
    expect(row.result).toBeNull()
    expect(row.completed_at).toBeNull()
  })

  it('not_approved (409) never touches tasks', async () => {
    // A task row exists (inkwell wiring needs it) but no approved verdict/proposal → not_approved.
    seed({ approved: false })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const res = await dashboardApp.fetch(req(`/admin/departments/growth/execute/${GATE_ID}`), env)
    expect(res.status).toBe(409)
    expect(taskRow().status).toBe('approved')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the flip UPDATE is a harmless no-op when the task is not at approved (already closed)', async () => {
    // The route does not pre-check task state — the WHERE status='approved' guard is the filter.
    seed({ status: 'done' })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, slug: 's', url: '/blog/x' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ))

    const res = await dashboardApp.fetch(req(`/admin/departments/growth/execute/${GATE_ID}`), env)
    expect(res.status).toBe(200)
    const row = taskRow()
    expect(row.status).toBe('done')
    expect(row.result).toBeNull() // the guarded UPDATE matched zero rows: nothing re-stamped
  })
})
