// tests/tasks-verdict-route-e2e.test.ts — mupot#1080/#1081.
//
// Real SQLite (applyAllMigrations — the full committed migration chain, never
// a hand-rolled `prepare()`; scripts/check-test-schema-source.mjs enforces
// this) and the REAL POST /:id/verdict route (tasksApp.fetch) — not just the
// evaluateVerdictGates predicate function in isolation (that unit-level
// coverage lives in tests/tasks-verdict-gates.test.ts). This file closes the
// loop from "the predicate is correct" to "the actual wire endpoint honors
// it," and replaces tests/surface-caps.test.ts's old structural
// (source-text-grepping) assertion of the same gate — see that file's
// comment for why a string match cannot prove this.
//
// requireAuth is mocked to inject a real, hand-constructed AuthContext
// (the same pattern tests/org-kind-boundary.test.ts uses) — this test is
// about the ROUTE's wiring of evaluateVerdictGates, not about auth-context
// construction, which tests/tasks-verdict-gates.test.ts already proves
// end-to-end via the real authenticateMember/MCP path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { D1PreparedStatement, D1Result } from '@cloudflare/workers-types'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

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

const { tasksApp } = await import('../src/tasks')

const TENANT = 'verdict-route-e2e'

function envFor(harness: SqliteD1Harness): Env {
  return { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
}

function seedBase(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.prepare(`INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-1', 'Dept One')`).run()
  sqlite
    .prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad-1', 'Squad One')`)
    .run()
  sqlite.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-1', 'm1@test.com', 'M1', 'active', ?)`).run(TENANT)
}

function seedReviewTask(
  sqlite: SqliteD1Harness['sqlite'],
  id: string,
  gateOwner: string,
  assigneeAgentId: string | null = null,
): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, 'squad-1', 'T', 'body', 'done', 'review', ?, ?, NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, gateOwner, assigneeAgentId)
}

function seedGrant(sqlite: SqliteD1Harness['sqlite'], capability: string, principalType: 'member' | 'agent', principalId: string): void {
  sqlite
    .prepare(
      `INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
       VALUES (?, ?, ?, ?, 'test-granter', datetime('now'))`,
    )
    .run(`grant-${capability}-${principalId}`, capability, principalType, principalId)
}

async function postVerdict(id: string, body: Record<string, unknown>, env: Env) {
  return tasksApp.fetch(
    new Request(`https://pot.test/${id}/verdict`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  )
}

describe('POST /:id/verdict — gate:loops surface cap, real route + real D1 (mupot#1080/#1081)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
    authState.current = {
      userId: 'member-1', email: null, role: 'member', tenant: TENANT, memberId: 'member-1',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    }
  })
  afterEach(() => {
    harness.close()
    authState.current = null
  })

  it('holds gate:loops but NOT outreach:send-gated: 403 forbidden need outreach:send-gated on approve', async () => {
    seedReviewTask(harness.sqlite, 'task-1', 'gate:loops')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-1')
    const res = await postVerdict('task-1', { verdict: 'approved' }, envFor(harness))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string; need: string }
    expect(body).toMatchObject({ error: 'forbidden', need: 'outreach:send-gated' })
  })

  it('holds gate:loops but NOT outreach:send-gated: reject is NOT gated, succeeds', async () => {
    seedReviewTask(harness.sqlite, 'task-2', 'gate:loops')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-1')
    const res = await postVerdict('task-2', { verdict: 'rejected', note: 'no' }, envFor(harness))
    expect(res.status).toBe(201)
  })

  it('holds BOTH gate:loops and outreach:send-gated: approve succeeds', async () => {
    seedReviewTask(harness.sqlite, 'task-3', 'gate:loops')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-1')
    seedGrant(harness.sqlite, 'outreach:send-gated', 'member', 'member-1')
    const res = await postVerdict('task-3', { verdict: 'approved' }, envFor(harness))
    expect(res.status).toBe(201)
  })

  it('no gate_owner grant at all: 403 forbidden need gate:loops (base RBAC still fires first)', async () => {
    seedReviewTask(harness.sqlite, 'task-4', 'gate:loops')
    const res = await postVerdict('task-4', { verdict: 'approved' }, envFor(harness))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string; need: string }
    expect(body).toMatchObject({ error: 'forbidden', need: 'gate:loops' })
  })
})

describe('POST /:id/verdict — gate:agent-self-completion, real route + real D1 (mupot#1080/#1081)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
  })
  afterEach(() => {
    harness.close()
    authState.current = null
  })

  it('a MEMBER holding a manually-granted gate:agent-self-completion capability is still 403 — the grant is NOT authority for this gate (BLOCK-1)', async () => {
    harness.sqlite
      .prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-other', 'squad-1', 'agent-other', 'Agent Other', 'member', 'test', 'active')`)
      .run()
    seedReviewTask(harness.sqlite, 'task-5', 'gate:agent-self-completion', 'agent-other')
    seedGrant(harness.sqlite, 'gate:agent-self-completion', 'member', 'member-1')
    authState.current = {
      userId: 'member-1', email: null, role: 'member', tenant: TENANT, memberId: 'member-1',
      capabilities: [{ member_id: 'member-1', scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
    }
    const res = await postVerdict('task-5', { verdict: 'approved' }, envFor(harness))
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string; need: string }
    expect(body).toMatchObject({ error: 'forbidden', need: 'assignee_or_org_admin' })
  })

  it('org owner passes gate:agent-self-completion for an unrelated assignee (legacy escape)', async () => {
    harness.sqlite
      .prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-other', 'squad-1', 'agent-other', 'Agent Other', 'member', 'test', 'active')`)
      .run()
    seedReviewTask(harness.sqlite, 'task-6', 'gate:agent-self-completion', 'agent-other')
    authState.current = { userId: 'owner-1', email: null, role: 'owner', tenant: TENANT, memberId: 'owner-1' }
    const res = await postVerdict('task-6', { verdict: 'approved' }, envFor(harness))
    expect(res.status).toBe(201)
  })
})

// ── mupot#1425 round 4 (kasra-review round-3 BLOCK): "a lost-race repro on
// the plain HTTP path with 0 verdict rows." This is the SAME K5 conditional-
// UPDATE guard the unit-level tests in tests/tasks-gate.test.ts exercise
// against a hand-mocked DB, but driven here through the REAL wire route
// (tasksApp.fetch → writeVerdict → env.DB.batch) against real SQLite —
// closing the gap between "the predicate is correct in isolation" and "the
// actual endpoint refuses to leave a verdict row for the race loser." ─────
describe('POST /:id/verdict — K5 lost race, real route + real D1, 0 verdict rows for the loser (mupot#1425 round 4)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedBase(harness.sqlite)
    // Org owner: passes RBAC unconditionally (see the legacy-escape test
    // above) so the only thing left to fail is the K5 guard itself.
    authState.current = { userId: 'owner-1', email: null, role: 'owner', tenant: TENANT, memberId: 'owner-1' }
  })
  afterEach(() => {
    harness.close()
    authState.current = null
  })

  it('a concurrent verdict flips task status between the RBAC check and the write — 409 verdict_conflict, 0 task_verdicts rows for the loser', async () => {
    seedReviewTask(harness.sqlite, 'task-race-http', 'gate:agent-self-completion')

    const realBatch = harness.db.batch.bind(harness.db)
    // Wraps the ONE seam writeVerdict uses to commit anything (env.DB.batch)
    // to flip the task's status the instant before the batch actually runs —
    // simulating a genuine concurrent verdict winning the race, the same
    // interleaving kasra-review drove directly against the production
    // statement (round 3 BLOCK, P0-1).
    const raceEnv: Env = {
      ...envFor(harness),
      DB: {
        ...harness.db,
        batch: (statements: D1PreparedStatement[]): Promise<D1Result[]> => {
          harness.sqlite.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run('task-race-http')
          return realBatch(statements)
        },
      } as unknown as Env['DB'],
    }

    const res = await postVerdict('task-race-http', { verdict: 'approved' }, raceEnv)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('verdict_conflict')

    const count = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM task_verdicts').get() as { n: number }
    expect(count.n).toBe(0) // the race LOSER's INSERT landed nothing over the real wire route (this asserts the
    // task-status EXISTS guard, not the nonce specifically — the nonce-collision proof lives in
    // tests/tasks-gate.test.ts's frozen-clock "P0-2 (frozen clock)" test)
  })
})
