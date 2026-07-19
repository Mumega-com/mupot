// tests/content-proposal-loop-sqlite.test.ts — flight-1: the FULL loop against
// REAL SQLite (not a hand-rolled JS reimplementation of the SQL — see
// feedback_uuid_slug_bridge_and_real_sql_tests: test the real SQL, not a mock
// that could silently diverge from it).
//
// Proves, end to end, across the actual multi-table schema (tasks,
// task_verdicts, department_proposals, squads, agents):
//
//   1. A "publish:" task run through runTaskExecution lands 'review' with
//      gate_owner stamped — the department_proposals row exists under the
//      SAME id as the task (gateId === task.id, the idGen trick).
//   2. Simulating the real verdict route's writes (mirrors
//      src/tasks/service.ts writeVerdict — the same two statements) flips
//      review → approved and inserts the task_verdicts row.
//   3. ctx.executor.execute(gateId) — freshly minted ctx (models a different
//      Worker isolate / different request, same D1) — finds the durable
//      proposal + the approved verdict and dispatches to a stubbed
//      inkwellContentWrite fetch.
//   4. The route's new "flip approved → done" UPDATE (mirrored here with the
//      exact SQL added to src/dashboard/index.ts) closes the task, and it is
//      immediately visible to src/dashboard/observatory.ts's real queries
//      (loadSwimlaneBars / loadRecentTasks) — the receipt on the board.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Env, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { runTaskExecution } from '../src/agents/execute'
import { kernelMintCtx } from '../src/departments/kernel'
import { getRegistered } from '../src/departments/registry'
import '../src/departments/modules/growth'
import { loadSwimlaneBars, loadRecentTasks } from '../src/dashboard/observatory'

const TENANT = 'viamar-test'
const SQUAD_ID = 'squad-content'
const AGENT_ID = 'agent-editor'

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    CREATE TABLE departments (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
    CREATE TABLE squads (
      id TEXT PRIMARY KEY, department_id TEXT NOT NULL, slug TEXT NOT NULL,
      name TEXT NOT NULL, charter TEXT
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', model TEXT NOT NULL DEFAULT '@cf/meta/llama-3.3',
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE tasks (
      id                 TEXT PRIMARY KEY,
      squad_id           TEXT NOT NULL,
      project_id         TEXT,
      title              TEXT NOT NULL,
      body               TEXT NOT NULL DEFAULT '',
      status             TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','in_progress','blocked','done','review','approved','rejected')),
      assignee_agent_id  TEXT,
      github_issue_url   TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      result             TEXT,
      completed_at       TEXT,
      gate_owner         TEXT,
      cost_micro_usd     INTEGER NOT NULL DEFAULT 0,
      workflow_instance_id TEXT,
      done_when          TEXT NOT NULL DEFAULT '(backfill required)',
      execution_receipt_id TEXT,
      execution_claim_expires_at INTEGER,
      source_pot         TEXT
    );
    CREATE TABLE task_verdicts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, verdict TEXT NOT NULL CHECK(verdict IN ('approved','rejected')),
      note TEXT, decided_by TEXT NOT NULL, decided_at TEXT NOT NULL
    );
    CREATE TABLE department_proposals (
      gate_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, department_key TEXT NOT NULL,
      action TEXT NOT NULL, payload_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

describe('content-publish loop — real SQLite, propose → approve → execute → done', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
    harness.sqlite.prepare('INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)').run('dept-1', 'growth', 'Marketing & Sales')
    harness.sqlite.prepare('INSERT INTO squads (id, department_id, slug, name, charter) VALUES (?, ?, ?, ?, ?)')
      .run(SQUAD_ID, 'dept-1', 'content', 'Content', 'Write it well.')
    harness.sqlite.prepare('INSERT INTO agents (id, squad_id, slug, name) VALUES (?, ?, ?, ?)')
      .run(AGENT_ID, SQUAD_ID, 'editor', 'Editor')
    // Seeded 'open' + unassigned, execution_receipt_id NULL — the normal state
    // of a freshly-created task (IM `task:` / console / POST /api/tasks), before
    // any dispatch has claimed it. runTaskExecution's own claim step assigns +
    // marks in_progress; we don't pre-empt that here.
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, done_when)
         VALUES (?, ?, ?, ?, 'open', NULL, ?)`,
    ).run(
      'task-content-1',
      SQUAD_ID,
      'publish: mupot closes the loop',
      'Today a content request actually writes a real draft, gated by a human.',
      'Article approved and live',
    )
    env = { TENANT_SLUG: TENANT, DB: harness.db } as Env
  })

  it('closes the entire loop end to end', async () => {
    const agent = { id: AGENT_ID, squad_id: SQUAD_ID, slug: 'editor', name: 'Editor', role: 'member', model: '@cf/meta/llama-3.3', status: 'active' as const, created_at: '2026-01-01T00:00:00Z' }

    // ── Step 1: runTaskExecution proposes (the seam under test) ────────────
    const result = await runTaskExecution(env, agent, 'task-content-1', {
      executionReceiptId: 'receipt-1',
      model: { chat: async () => 'SHOULD NOT BE CALLED' },
    })
    expect(result.ok).toBe(true)
    expect(result.task_status).toBe('review')

    let row = harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get('task-content-1') as unknown as Task & { gate_owner: string }
    expect(row.status).toBe('review')
    expect(row.gate_owner).toBe('gate:content')
    expect(row.result).toContain('Proposed content-publish')

    // The durable proposal row exists under the TASK'S OWN id (the idGen trick).
    const proposalRow = harness.sqlite.prepare('SELECT * FROM department_proposals WHERE gate_id = ?').get('task-content-1') as { action: string; payload_json: string }
    expect(proposalRow).toBeDefined()
    expect(proposalRow.action).toBe('content-publish')
    const payload = JSON.parse(proposalRow.payload_json) as { executor: string; title: string; content: string; status: string }
    expect(payload).toEqual({
      executor: 'inkwell-content',
      title: 'mupot closes the loop',
      content: 'Today a content request actually writes a real draft, gated by a human.',
      status: 'draft',
    })

    // GET /approvals visibility: BASE_SELECT in src/dashboard/approvals.ts
    // selects WHERE status = 'review' — confirm this row genuinely qualifies,
    // proving the /approvals surface needs zero code changes for this to show.
    const approvalsRows = harness.sqlite.prepare(`SELECT id FROM tasks WHERE status = 'review'`).all() as { id: string }[]
    expect(approvalsRows.map((r) => r.id)).toContain('task-content-1')

    // ── Step 2: the human approves — mirrors writeVerdict's real two writes ──
    const flip = harness.sqlite.prepare(`UPDATE tasks SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'review'`)
      .run('2026-07-14T12:00:00.000Z', 'task-content-1')
    expect(Number(flip.changes)).toBe(1)
    harness.sqlite.prepare(
      `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, ?, ?)`,
    ).run('verdict-1', 'task-content-1', 'owner-1', '2026-07-14T12:00:00.000Z')

    // ── Step 3: execute — a FRESH ctx (models a different isolate/request) ──
    const module = getRegistered('growth')
    expect(module).toBeDefined()
    let fetchedUrl = ''
    let fetchedBody: unknown = null
    const fakeFetch = (async (url: string, init: RequestInit) => {
      fetchedUrl = String(url)
      fetchedBody = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ ok: true, slug: 'mupot-closes-the-loop', url: '/blog/mupot-closes-the-loop' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const executeCtx = kernelMintCtx(
      { db: harness.db, executorEnv: { inkwell: { apiUrl: 'https://inkwell-api.mumega.com', token: 'tok', tenantSlug: TENANT } } },
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )
    // Patch the module-internal fetch indirectly: inkwellContentWrite takes an
    // injectable fetchImpl, but ctx.executor.execute() always calls the real
    // global fetch. Assert against the real network boundary instead — stub
    // globalThis.fetch for the duration of this call only.
    const realFetch = globalThis.fetch
    globalThis.fetch = fakeFetch
    let outcome
    try {
      outcome = await executeCtx.executor.execute('task-content-1')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(outcome.executed).toBe(true)
    expect(outcome.adapter).toBe('inkwell-content')
    expect(outcome.artifactUrl).toBe('/blog/mupot-closes-the-loop')
    expect(fetchedUrl).toBe('https://inkwell-api.mumega.com/api/internal/content/publish')
    expect(fetchedBody).toMatchObject({ title: 'mupot closes the loop', tenant_slug: TENANT })

    // ── Step 4: the route's new "close the loop" write (mirrored exactly) ──
    const now = '2026-07-14T12:05:00.000Z'
    const closeResult = harness.sqlite.prepare(
      `UPDATE tasks SET status = 'done', result = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'`,
    ).run(`Published via ${outcome.adapter}: ${outcome.artifactUrl}`, now, now, 'task-content-1')
    expect(Number(closeResult.changes)).toBe(1)

    row = harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get('task-content-1') as unknown as Task & { gate_owner: string }
    expect(row.status).toBe('done')
    expect(row.completed_at).toBe(now)
    expect(row.result).toContain('/blog/mupot-closes-the-loop')

    // ── The receipt on the board: real observatory queries against this DB ──
    const bars = await loadSwimlaneBars(env)
    const bar = bars.find((b) => b.id === 'task-content-1')
    expect(bar).toBeDefined()
    expect(bar!.status).toBe('done')

    const recent = await loadRecentTasks(env)
    const recentRow = recent.find((t) => t.id === 'task-content-1')
    expect(recentRow).toBeDefined()
    expect(recentRow!.status).toBe('done')
  })

  it('the "flip approved → done" write is a harmless no-op for a gateId with no matching task row', () => {
    // Models seo-audit-proposal / seo-meta-fix gateIds — random UUIDs that were
    // never a task id. The route's UPDATE must not error and must not touch
    // anything (WHERE id = ? AND status = 'approved' simply matches zero rows).
    const result = harness.sqlite.prepare(
      `UPDATE tasks SET status = 'done', result = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'approved'`,
    ).run('note', 'now', 'now', 'not-a-real-task-id')
    expect(Number(result.changes)).toBe(0)
  })
})
