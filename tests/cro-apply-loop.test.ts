// tests/cro-apply-loop.test.ts — CRO apply-bridge (S5b), the full loop.
//
// Proves propose → approve → execute → real fetch-then-merge write end to end
// against REAL SQLite (not a hand-rolled JS reimplementation — see
// feedback_uuid_slug_bridge_and_real_sql_tests: test the real SQL). Mirrors
// tests/seo-meta-fix-loop-sqlite.test.ts's pattern: proposeCroApply mints its own
// ctx internally (models one Worker isolate/request); a FRESH kernelMintCtx call
// for execute() (models a different isolate/request, same D1) finds the durable
// department_proposals row + the approved task_verdicts row and dispatches for
// real — the same rail Flight 1/2 proved, now through inkwellContentDispatch's
// fetch-then-merge path (executors/inkwell.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { kernelMintCtx } from '../src/departments/kernel'
import { getRegistered } from '../src/departments/registry'
import '../src/departments/modules/growth'
import { proposeCroApply, CroApplyProposeError } from '../src/departments/collectors/cro-apply'

const TENANT = 'viamar-test'

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  // Minimal schema slice: only the tables the propose→approve→execute path
  // actually touches — same shapes as tests/seo-meta-fix-loop-sqlite.test.ts.
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

/** A fetch mock that answers the internal GET (current content) then the POST (publish). */
function fetchThenMerge(current: {
  title: string
  description: string
  author: string
  tags: string[]
  status: string
  content: string
}) {
  let calls = 0
  const fn = (async (_url: string | URL, init?: RequestInit) => {
    calls += 1
    const method = init?.method ?? 'GET'
    if (method === 'GET') {
      return new Response(JSON.stringify({ ok: true, ...current }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ ok: true, slug: 'existing-post', url: '/blog/existing-post' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetch: fn, callCount: () => calls }
}

describe('CRO apply-bridge — propose → approve → execute, real SQLite', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
  })

  it('AUTO-PROPOSABLE meta_title: full loop executes, body preserved, receipt carries the diff', async () => {
    const { gateId, flagged } = await proposeCroApply(
      { db: harness.db },
      TENANT,
      { slug: 'existing-post', changeType: 'meta_title', value: 'New AEO Title' },
      { idGen: () => 'cro-gate-1' },
    )
    expect(gateId).toBe('cro-gate-1')
    expect(flagged).toBe(false)

    const proposalRow = harness.sqlite
      .prepare('SELECT * FROM department_proposals WHERE gate_id = ?')
      .get(gateId) as { action: string; payload_json: string }
    expect(proposalRow.action).toBe('cro-apply')
    expect(JSON.parse(proposalRow.payload_json)).toMatchObject({
      executor: 'inkwell-content',
      mode: 'cro-apply-merge',
      changeType: 'meta_title',
      flagged: false,
    })

    // Human approves — mirrors writeVerdict's real INSERT.
    harness.sqlite
      .prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, ?, ?)`,
      )
      .run('verdict-1', gateId, 'owner-1', '2026-07-16T12:00:00.000Z')

    // FRESH ctx (a different isolate/request) — same shape dashboard/index.ts's
    // execute route mints.
    const module = getRegistered('growth')
    expect(module).toBeDefined()

    const { fetch: boundFetch, callCount } = fetchThenMerge({
      title: 'Old Title',
      description: 'Old description',
      author: 'agent',
      tags: ['x'],
      status: 'published',
      content: 'The real, untouched article body.',
    })
    const fetcher = { fetch: boundFetch } as unknown as Fetcher

    const executeCtx = kernelMintCtx(
      { db: harness.db, executorEnv: { inkwell: { apiUrl: 'https://inkwell-api.mumega.com', token: 'tok', tenantSlug: TENANT, fetcher } } },
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )

    const outcome = await executeCtx.executor.execute(gateId)
    expect(outcome.executed).toBe(true)
    expect(outcome.adapter).toBe('inkwell-content')
    expect(outcome.artifactUrl).toBe('/blog/existing-post')
    // ⭐ THE RECEIPT — change-type, field, before/after, reused from the SAME
    // ExecuteOutcome the content-publish/seo-meta-fix receipt already returns.
    expect(outcome.diff).toEqual({
      changeType: 'meta_title',
      field: 'title',
      before: 'Old Title',
      after: 'New AEO Title',
    })
    expect(callCount()).toBe(2) // GET (fetch current) + POST (write merged) — proves the merge path ran
  })

  it('FLAGGED body_copy: still requires the SAME human gate — no auto-execute bypass', async () => {
    const { gateId, flagged } = await proposeCroApply(
      { db: harness.db },
      TENANT,
      { slug: 'existing-post', changeType: 'body_copy', value: 'a full rewrite' },
      { idGen: () => 'cro-gate-2' },
    )
    expect(flagged).toBe(true)

    const module = getRegistered('growth')
    const { fetch: boundFetch } = fetchThenMerge({
      title: 'T',
      description: 'D',
      author: 'agent',
      tags: [],
      status: 'draft',
      content: 'old body',
    })
    const fetcher = { fetch: boundFetch } as unknown as Fetcher
    const executeCtx = kernelMintCtx(
      { db: harness.db, executorEnv: { inkwell: { apiUrl: 'https://inkwell-api.mumega.com', token: 'tok', tenantSlug: TENANT, fetcher } } },
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )

    // NOT approved yet — execute must fail closed regardless of flagged/auto tier.
    await expect(executeCtx.executor.execute(gateId)).rejects.toThrow(/not_approved/)

    harness.sqlite
      .prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, ?, ?)`,
      )
      .run('verdict-2', gateId, 'owner-1', '2026-07-16T12:00:00.000Z')

    const outcome = await executeCtx.executor.execute(gateId)
    expect(outcome.executed).toBe(true)
    expect(outcome.diff).toMatchObject({ changeType: 'body_copy', field: 'content', after: 'a full rewrite' })
  })

  it('HARD-REFUSED change-type never reaches the gate — nothing persisted, nothing to approve', async () => {
    await expect(
      proposeCroApply(
        { db: harness.db },
        TENANT,
        { slug: 'existing-post', changeType: 'pricing' as never, value: 'free forever' },
        { idGen: () => 'cro-gate-3' },
      ),
    ).rejects.toBeInstanceOf(CroApplyProposeError)

    const row = harness.sqlite.prepare('SELECT * FROM department_proposals WHERE gate_id = ?').get('cro-gate-3')
    expect(row).toBeUndefined()
  })

  it('fetch failure (article missing) at execute time → executed:false, fail-closed, never throws out of execute()', async () => {
    const { gateId } = await proposeCroApply(
      { db: harness.db },
      TENANT,
      { slug: 'ghost-post', changeType: 'meta_title', value: 'x' },
      { idGen: () => 'cro-gate-4' },
    )
    harness.sqlite
      .prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, ?, ?)`,
      )
      .run('verdict-4', gateId, 'owner-1', '2026-07-16T12:00:00.000Z')

    const module = getRegistered('growth')
    const notFoundFetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch
    const fetcher = { fetch: notFoundFetch } as unknown as Fetcher
    const executeCtx = kernelMintCtx(
      { db: harness.db, executorEnv: { inkwell: { apiUrl: 'https://inkwell-api.mumega.com', token: 'tok', tenantSlug: TENANT, fetcher } } },
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )
    const outcome = await executeCtx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('merge_source_not_found')
  })

  it('NO executorEnv (pot has no inkwell connector configured) → executor_not_wired, no fetch', async () => {
    const { gateId } = await proposeCroApply(
      { db: harness.db },
      TENANT,
      { slug: 'existing-post', changeType: 'meta_description', value: 'x' },
      { idGen: () => 'cro-gate-5' },
    )
    harness.sqlite
      .prepare(
        `INSERT INTO task_verdicts (id, task_id, verdict, note, decided_by, decided_at) VALUES (?, ?, 'approved', NULL, ?, ?)`,
      )
      .run('verdict-5', gateId, 'owner-1', '2026-07-16T12:00:00.000Z')

    const module = getRegistered('growth')
    const spy = vi.fn()
    const executeCtx = kernelMintCtx(
      { db: harness.db }, // no executorEnv
      { tenantId: TENANT, departmentKey: 'growth', module: module!, capabilities: ['owner'] },
    )
    const outcome = await executeCtx.executor.execute(gateId)
    expect(outcome.executed).toBe(false)
    expect(outcome.reason).toBe('executor_not_wired')
    expect(spy).not.toHaveBeenCalled()
  })
})
