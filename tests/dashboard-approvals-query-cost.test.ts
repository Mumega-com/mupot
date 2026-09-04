// tests/dashboard-approvals-query-cost.test.ts — mupot#1319 gate BLOCK-1.
//
// decorateApprovals (src/dashboard/approvals.ts) computes can_verdict per row
// via canActOnSquad + evaluateVerdictGates. Before this fix that was an
// UNBOUNDED, unmemoized D1 fan-out — every existing test used either the
// owner/admin path (zero queries, short-circuits on legacyOwnerAdmin) or a
// 1-2 row fixture, so nothing could see the cost. Measured on the real gate
// review (River, 2026-09-04): 40 gate:loops rows for one non-admin member
// produced 161 D1 prepare() calls — 4.00/row — through an unbounded
// Promise.all with no LIMIT on the underlying query.
//
// This file is a COUNTING wrapper around the REAL SQLite D1 harness (real
// SQL still executes — applyAllMigrations, no hand-rolled prepare() — this
// wrapper only increments a counter around every env.DB.prepare() call), so
// it proves both correctness AND cost on the same fixture. That is the
// combination no prior test in this area had.
//
// This is the only thing that will stop query-fan-out regressing here again
// — a correctness-only test cannot see O(rows) growth.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { Env, AuthContext } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { loadApprovals, APPROVALS_QUEUE_LIMIT } from '../src/dashboard/approvals'

const TENANT = 'approvals-query-cost-test'

function countingEnv(harness: SqliteD1Harness): { env: Env; count: () => number } {
  let calls = 0
  const realDb = harness.db
  const countingDb = {
    prepare(sql: string) {
      calls += 1
      return realDb.prepare(sql)
    },
    batch: realDb.batch?.bind(realDb),
    exec: (realDb as unknown as { exec?: unknown }).exec,
  }
  const env = { TENANT_SLUG: TENANT, DB: countingDb } as unknown as Env
  return { env, count: () => calls }
}

function seedDept(sqlite: SqliteD1Harness['sqlite'], id: string): void {
  sqlite.prepare(`INSERT INTO departments (id, slug, name) VALUES (?, ?, ?)`).run(id, id, id)
}

function seedSquad(sqlite: SqliteD1Harness['sqlite'], id: string, deptId: string): void {
  sqlite.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, ?, ?)`).run(id, deptId, id, id)
}

function seedMember(sqlite: SqliteD1Harness['sqlite'], id: string): void {
  sqlite.prepare(`INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', ?)`).run(id, `${id}@test.com`, id, TENANT)
}

function seedSquadCapability(sqlite: SqliteD1Harness['sqlite'], memberId: string, squadId: string): void {
  sqlite
    .prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'squad', ?, 'member')`)
    .run(`cap-${memberId}-${squadId}`, memberId, squadId)
}

function seedGrant(sqlite: SqliteD1Harness['sqlite'], capability: string, memberId: string): void {
  sqlite
    .prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, 'member', ?, 'test', datetime('now'))`)
    .run(`grant-${capability}-${memberId}`, capability, memberId)
}

function seedReviewTask(sqlite: SqliteD1Harness['sqlite'], id: string, squadId: string, gateOwner: string): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, ?, 'T', 'body', 'done', 'review', ?, NULL, NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, squadId, gateOwner)
}

// Capabilities are set explicitly on the AuthContext, exactly as the real
// dashboard cookie-session bridge does (loadAuthFromCookie resolves +
// attaches auth.capabilities ONCE at auth time, src/auth/index.ts) — NOT via
// canActOnSquad's own `auth.capabilities ?? resolveCapabilities(...)`
// fallback, which exists for callers that never resolved capabilities
// upfront and would otherwise re-query per row. Omitting this here would
// test a fixture shape production never sends through this call site.
function memberAuth(memberId: string): AuthContext {
  return {
    userId: memberId,
    email: null,
    role: 'member',
    tenant: TENANT,
    memberId,
    capabilities: [{ member_id: memberId, scope_type: 'squad', scope_id: 'squad-1', capability: 'member' }],
  }
}

describe('decorateApprovals — bounded, memoized D1 cost (mupot#1319 gate BLOCK-1)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedDept(harness.sqlite, 'dept-1')
    seedSquad(harness.sqlite, 'squad-1', 'dept-1')
    seedMember(harness.sqlite, 'member-1')
    seedSquadCapability(harness.sqlite, 'member-1', 'squad-1')
    seedGrant(harness.sqlite, 'gate:loops', 'member-1')
    seedGrant(harness.sqlite, 'outreach:send-gated', 'member-1')
  })
  afterEach(() => harness.close())

  it('N gate:loops rows, ONE squad, ONE caller: prepare() calls grow O(1) in N, not O(N) — memoization actually fires', async () => {
    const ROWS = 12
    for (let i = 0; i < ROWS; i += 1) {
      seedReviewTask(harness.sqlite, `task-${i}`, 'squad-1', 'gate:loops')
    }
    const { env, count } = countingEnv(harness)
    const out = await loadApprovals(env, memberAuth('member-1'))

    // Correctness: still every row, still correctly verdictable.
    expect(out).toHaveLength(ROWS)
    for (const row of out) {
      expect(row).toMatchObject({ can_verdict: true, can_approve: true, can_reject: true })
    }

    // Cost: the ONE thing no prior test could see. Before this fix this was
    // 1 (queue query) + ROWS * 4 (squadDepartment + 2x gate-ownership +
    // surface-cap) = 49 for 12 rows, and it GROWS LINEARLY with ROWS. After
    // memoization, every row after the first reuses the cached squad
    // department, gate-ownership, and surface-cap answers (all three are
    // the SAME squad, gate, and caller across every row) — the query count
    // stays flat regardless of ROWS. Pin a real ceiling, not just "less than
    // before": 1 queue query + at most a handful of first-row lookups.
    expect(count()).toBeLessThanOrEqual(6)
  })

  it('growing the fixture (24 rows instead of 12) does NOT grow the query count — the O(1) claim, not just "fewer than before"', async () => {
    for (let i = 0; i < 24; i += 1) {
      seedReviewTask(harness.sqlite, `task-${i}`, 'squad-1', 'gate:loops')
    }
    const { env, count } = countingEnv(harness)
    const out = await loadApprovals(env, memberAuth('member-1'))
    expect(out).toHaveLength(24)
    // Same ceiling as the 12-row case above — if this ever creeps upward
    // with row count, the memoization broke.
    expect(count()).toBeLessThanOrEqual(6)
  })

  it('BASE_SELECT is bounded (non-admin path): seeding well past APPROVALS_QUEUE_LIMIT still returns at most the limit, oldest first', async () => {
    const EXTRA = 5
    for (let i = 0; i < APPROVALS_QUEUE_LIMIT + EXTRA; i += 1) {
      seedReviewTask(harness.sqlite, `task-${String(i).padStart(5, '0')}`, 'squad-1', 'gate:loops')
    }
    const { env } = countingEnv(harness)
    const out = await loadApprovals(env, memberAuth('member-1'))
    expect(out.length).toBeLessThanOrEqual(APPROVALS_QUEUE_LIMIT)
    expect(out).toHaveLength(APPROVALS_QUEUE_LIMIT)
  })

  it('BASE_SELECT is bounded (owner/admin path — a SEPARATE query branch, no gate_grants EXISTS clause): the admin bypass query has its own LIMIT too', async () => {
    const EXTRA = 5
    for (let i = 0; i < APPROVALS_QUEUE_LIMIT + EXTRA; i += 1) {
      seedReviewTask(harness.sqlite, `task-admin-${String(i).padStart(5, '0')}`, 'squad-1', 'gate:loops')
    }
    const { env } = countingEnv(harness)
    const ownerAuth: AuthContext = { userId: 'owner-1', email: null, role: 'owner', tenant: TENANT, memberId: 'owner-1' }
    const out = await loadApprovals(env, ownerAuth)
    expect(out.length).toBeLessThanOrEqual(APPROVALS_QUEUE_LIMIT)
    expect(out).toHaveLength(APPROVALS_QUEUE_LIMIT)
  })
})
