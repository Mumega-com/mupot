// tests/seo-meta-fix-loop-sqlite.test.ts — mupot Flight 2 slice 1.
//
// Proves the seo-meta-fix work-type end to end against REAL SQLite (not a
// hand-rolled JS reimplementation of the SQL — see
// feedback_uuid_slug_bridge_and_real_sql_tests: test the real SQL, not a mock
// that could silently diverge from it). Mirrors
// tests/content-proposal-loop-sqlite.test.ts's pattern (Flight 1's proven rail)
// for the seo-meta-fix work-type:
//
//   1. proposeSeoMetaFix (departments/collectors/seo-meta-fix.ts) proposes a
//      gated seo-meta-fix action for an EXISTING slug — a real INSERT INTO
//      department_proposals row, readable back across a fresh ctx/isolate.
//   2. Simulating the real verdict route's write (mirrors src/tasks/service.ts
//      writeVerdict) inserts an approved task_verdicts row.
//   3. ctx.executor.execute(gateId) — a FRESH ctx (models a different Worker
//      isolate / different request, same D1, same shape the dashboard's
//      POST /admin/departments/:dept/execute/:gateId route mints) — finds the
//      durable proposal + the approved verdict and dispatches to the SAME
//      inkwell-content adapter (inkwellContentWrite) Flight 1 proved for
//      content-publish. No kernel.ts change was needed for this — see the
//      design note in departments/collectors/seo-meta-fix.ts.
//   4. The real HTTP write body sent to Inkwell's internal publish endpoint
//      carries slug + overwrite:true (the STATED intent — this record documents
//      an update to an existing item, never a create) and server-forced draft.
//      ⚠ overwrite:true is advisory/inert server-side: the internal publish
//      endpoint (workers/inkwell-api/src/routes/internal-content.ts →
//      lib/tenant-content.ts putContent()) never reads the overwrite field — it
//      performs an UNCONDITIONAL full replace of (tenant, slug) on every write it
//      accepts. The real, enforced contract is: this is a full-body replace of
//      whatever slug is targeted, with no create-vs-update branch and no partial
//      update, regardless of the overwrite flag's value. Do not read the
//      assertion below as proof of a write-time protection — there isn't one.

import { beforeEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { kernelMintCtx } from '../src/departments/kernel'
import { getRegistered } from '../src/departments/registry'
import '../src/departments/modules/growth'
import { proposeSeoMetaFix } from '../src/departments/collectors/seo-meta-fix'

const TENANT = 'viamar-test'

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  // Minimal schema slice: only the tables the propose→approve→execute path
  // actually touches (department_proposals, task_verdicts) — same column shapes
  // as tests/content-proposal-loop-sqlite.test.ts's full schema.
  sqlite.exec(`
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

describe('seo-meta-fix loop — real SQLite, propose → approve → execute → real write', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
  })

  it('closes the entire loop end to end, writing a full-body-replace update to the target slug', async () => {
    // ── Step 1: proposeSeoMetaFix records intent (real INSERT) ────────────────
    const { gateId } = await proposeSeoMetaFix(
      { db: harness.db },
      TENANT,
      {
        slug: 'mupot-closes-the-loop',
        title: 'mupot closes the loop (AEO-optimised title)',
        content: 'Today a content request actually writes a real draft, gated by a human.',
        description: 'Updated meta description for answer-engine optimisation.',
        tags: ['geo', 'aeo'],
      },
      { idGen: () => 'meta-fix-gate-1' },
    )
    expect(gateId).toBe('meta-fix-gate-1')

    const proposalRow = harness.sqlite
      .prepare('SELECT * FROM department_proposals WHERE gate_id = ?')
      .get(gateId) as { action: string; payload_json: string; tenant_id: string; department_key: string }
    expect(proposalRow).toBeDefined()
    expect(proposalRow.action).toBe('seo-meta-fix')
    expect(proposalRow.tenant_id).toBe(TENANT)
    expect(proposalRow.department_key).toBe('growth')
    const payload = JSON.parse(proposalRow.payload_json) as {
      executor: string
      slug: string
      title: string
      content: string
      overwrite: boolean
      status: string
    }
    expect(payload).toMatchObject({
      executor: 'inkwell-content',
      slug: 'mupot-closes-the-loop',
      title: 'mupot closes the loop (AEO-optimised title)',
      overwrite: true,
      status: 'draft',
    })

    // ── Step 2: the human approves — mirrors writeVerdict's real INSERT ───────
    harness.sqlite
      .prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, ?, ?)`,
      )
      .run('verdict-1', gateId, 'owner-1', '2026-07-14T12:00:00.000Z')

    // ── Step 3: execute — a FRESH ctx (models a different isolate/request), ──
    // same shape src/dashboard/index.ts's execute route mints: executorEnv
    // resolved from the pot's configured connector, routed through the
    // service-binding fetcher (INKWELL_SVC / cfg.fetcher) — Flight 1's 522 fix.
    const module = getRegistered('growth')
    expect(module).toBeDefined()

    let fetchedUrl = ''
    let fetchedBody: Record<string, unknown> | null = null
    let boundCalls = 0
    const boundFetch = (async (url: string, init: RequestInit) => {
      boundCalls++
      fetchedUrl = String(url)
      fetchedBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(
        JSON.stringify({ ok: true, slug: 'mupot-closes-the-loop', url: '/blog/mupot-closes-the-loop' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const fetcher = { fetch: boundFetch } as unknown as Fetcher

    const executeCtx = kernelMintCtx(
      {
        db: harness.db,
        executorEnv: {
          inkwell: { apiUrl: 'https://inkwell-api.mumega.com', token: 'tok', tenantSlug: TENANT, fetcher },
        },
      },
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )

    const outcome = await executeCtx.executor.execute(gateId)

    expect(outcome.executed).toBe(true)
    expect(outcome.adapter).toBe('inkwell-content')
    expect(outcome.artifactUrl).toBe('/blog/mupot-closes-the-loop')

    // The write went through the service-binding fetcher (never global fetch) —
    // the same same-zone-522 avoidance Flight 1 wired for content-publish.
    expect(boundCalls).toBe(1)
    expect(fetchedUrl).toBe('https://inkwell-api.mumega.com/api/internal/content/publish')
    expect(fetchedBody).toMatchObject({
      title: 'mupot closes the loop (AEO-optimised title)',
      slug: 'mupot-closes-the-loop',
      // overwrite:true is the STATED intent this producer always sends — but it
      // is advisory/inert server-side (see file header). The TRUE, enforced
      // contract at the sink is: every write to this endpoint is an
      // unconditional full replace of (tenant, slug), whether overwrite is true,
      // false, or absent. This assertion documents what the wire body contains,
      // not a write-time safety guarantee.
      overwrite: true,
      status: 'draft', // server-forced-draft regardless of caller intent
      tenant_slug: TENANT,
    })
  })

  it('fails closed — no approval yet → not_approved, no fetch attempted', async () => {
    const { gateId } = await proposeSeoMetaFix(
      { db: harness.db },
      TENANT,
      { slug: 'unapproved-slug', title: 't', content: 'c' },
      { idGen: () => 'meta-fix-gate-2' },
    )
    const module = getRegistered('growth')
    let fetchCalled = false
    const fetcher = {
      fetch: (async () => {
        fetchCalled = true
        throw new Error('should never be called')
      }) as unknown as typeof fetch,
    } as unknown as Fetcher
    const executeCtx = kernelMintCtx(
      {
        db: harness.db,
        executorEnv: { inkwell: { apiUrl: 'https://inkwell-api.mumega.com', token: 'tok', tenantSlug: TENANT, fetcher } },
      },
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )
    await expect(executeCtx.executor.execute(gateId)).rejects.toThrow(/not_approved/)
    expect(fetchCalled).toBe(false)
  })

  it('fails closed — no inkwell connector configured for this pot → executor_not_wired, no fetch', async () => {
    const { gateId } = await proposeSeoMetaFix(
      { db: harness.db },
      TENANT,
      { slug: 'unwired-slug', title: 't', content: 'c' },
      { idGen: () => 'meta-fix-gate-3' },
    )
    harness.sqlite
      .prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, ?, ?)`,
      )
      .run('verdict-3', gateId, 'owner-1', '2026-07-14T12:00:00.000Z')
    const module = getRegistered('growth')
    // No executorEnv at all — models every pot that hasn't connected an 'inkwell'
    // connector yet (Hadi-go still pending). No global fetch stub either — a real
    // network attempt here would fail the test, proving nothing was attempted.
    const executeCtx = kernelMintCtx(
      { db: harness.db },
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )
    const outcome = await executeCtx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('executor_not_wired')
    expect(outcome.adapter).toBe('inkwell-content')
  })
})
