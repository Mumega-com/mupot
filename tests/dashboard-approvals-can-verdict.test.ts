// tests/dashboard-approvals-can-verdict.test.ts — mupot#1081.
//
// loadApprovals now decorates every row with can_verdict/can_approve/
// can_reject, computed by evaluateVerdictGates + canActOnSquad — the SAME
// predicate POST /:id/verdict itself evaluates (src/tasks/index.ts). This
// file proves the decoration is real (not the prior vacuous
// `isOwnerAdmin(auth) || resolution.resolvable`, which was true on every
// reachable path because loadApprovals' own visibility filter already
// guarantees a grant exists) by constructing rows where can_verdict must be
// FALSE for a caller who nonetheless passes the visibility filter:
//   - a squad the caller is no longer a member of (squad scope — #1081's own
//     P0 finding: gate grants are org-global, canActOnSquad is squad-scoped)
//   - a gate:loops row where the caller holds gate:loops but not
//     outreach:send-gated
//   - a self-verdict row (caller is both decider and assignee)
//
// Real SQLite via applyAllMigrations — no hand-rolled prepare().

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import type { Env, AuthContext } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { loadApprovals, loadPublishable } from '../src/dashboard/approvals'

const TENANT = 'approvals-can-verdict-test'

function envFor(harness: SqliteD1Harness): Env {
  return { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
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

function seedAgent(sqlite: SqliteD1Harness['sqlite'], id: string, squadId: string): void {
  sqlite
    .prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?, ?, ?, ?, 'member', 'test', 'active')`)
    .run(id, squadId, id, id)
}

function seedReviewTask(sqlite: SqliteD1Harness['sqlite'], id: string, squadId: string, gateOwner: string, assigneeAgentId: string | null = null): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES (?, ?, 'T', 'body', 'done', 'review', ?, ?, NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, squadId, gateOwner, assigneeAgentId)
}

function seedGrant(sqlite: SqliteD1Harness['sqlite'], capability: string, principalType: 'member' | 'agent', principalId: string): void {
  sqlite
    .prepare(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES (?, ?, ?, ?, 'test', datetime('now'))`)
    .run(`grant-${capability}-${principalId}`, capability, principalType, principalId)
}

function seedSquadCapability(sqlite: SqliteD1Harness['sqlite'], memberId: string, squadId: string, capability: string): void {
  sqlite
    .prepare(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, 'squad', ?, ?)`)
    .run(`cap-${memberId}-${squadId}`, memberId, squadId, capability)
}

function memberAuth(memberId: string): AuthContext {
  return { userId: memberId, email: null, role: 'member', tenant: TENANT, memberId }
}

describe('loadApprovals — can_verdict/can_approve/can_reject decoration (mupot#1081)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedDept(harness.sqlite, 'dept-1')
    seedSquad(harness.sqlite, 'squad-1', 'dept-1')
  })
  afterEach(() => harness.close())

  it('REACHABLE false branch: caller holds the gate grant but is NOT a member of the task\'s squad (squad scope, previously entirely unmodeled)', async () => {
    seedMember(harness.sqlite, 'member-1')
    seedReviewTask(harness.sqlite, 'task-1', 'squad-1', 'gate:outreach')
    seedGrant(harness.sqlite, 'gate:outreach', 'member', 'member-1')
    // Deliberately NO capabilities row on squad-1 for member-1 — they hold the
    // gate grant (org-global) but not squad membership (squad-scoped).
    const out = await loadApprovals(envFor(harness), memberAuth('member-1'))
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({ can_verdict: false, can_approve: false, can_reject: false })
  })

  it('positive control: same caller, WITH squad membership — can_verdict true', async () => {
    seedMember(harness.sqlite, 'member-2')
    seedSquadCapability(harness.sqlite, 'member-2', 'squad-1', 'member')
    seedReviewTask(harness.sqlite, 'task-2', 'squad-1', 'gate:outreach')
    seedGrant(harness.sqlite, 'gate:outreach', 'member', 'member-2')
    const out = await loadApprovals(envFor(harness), memberAuth('member-2'))
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({ can_verdict: true, can_approve: true, can_reject: true })
  })

  it('REACHABLE false branch: gate:loops held without outreach:send-gated — can_approve false, can_reject true, can_verdict true', async () => {
    seedMember(harness.sqlite, 'member-3')
    seedSquadCapability(harness.sqlite, 'member-3', 'squad-1', 'member')
    seedReviewTask(harness.sqlite, 'task-3', 'squad-1', 'gate:loops')
    seedGrant(harness.sqlite, 'gate:loops', 'member', 'member-3')
    const out = await loadApprovals(envFor(harness), memberAuth('member-3'))
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({ can_verdict: true, can_approve: false, can_reject: true })
  })

  // INVARIANT WITNESS, not a fabricated fixture (per this flight's own gate
  // bar: an unreachable branch must be witnessed, never reached by an
  // impossible principal). Self-verdict inside evaluateVerdictGates compares
  // `principal.id === task.assignee_agent_id`, and assignee_agent_id is
  // always a real agent's id. For that comparison to trip, the DECIDING
  // principal must resolve to an AGENT id — i.e. auth.boundAgentId must be
  // set (verdictPrincipal is boundAgentId-first). loadApprovals is called
  // ONLY from dashboard cookie-session routes (dashboard/index.ts,
  // operator-counts.ts, health.ts — grep confirms no other caller exists),
  // and the cookie session path (src/auth/index.ts loadAuthFromCookie) never
  // populates auth.boundAgentId — only member-bearer/MCP token auth does. So
  // for THIS caller population, self-verdict is unconstructible today: proven
  // directly below by showing loadApprovals' own KNOWN-DRIFT visibility
  // filter (memberId-first, see approvals.ts's own comment) cannot even see a
  // row granted to an agent principal, which is a precondition for ever
  // reaching an agent-principal self-verdict comparison through this call site.
  //
  // The REAL, reachable self-verdict case — an agent-bound caller
  // (auth.boundAgentId set, via the actual authenticateMember/MCP path)
  // deciding on their own assigned task — IS proven end-to-end in
  // tests/tasks-verdict-gates.test.ts ("self-verdict — REACHABLE false
  // branch"), which is the real write-path caller for that principal shape
  // (MCP task_verdict), not this dashboard-only read path.
  it('INVARIANT WITNESS: an agent-granted gate row is invisible to a plain member caller through loadApprovals\' own visibility filter — self-verdict for an agent principal cannot be reached through THIS call site today', async () => {
    seedMember(harness.sqlite, 'member-4')
    seedSquadCapability(harness.sqlite, 'member-4', 'squad-1', 'member')
    seedAgent(harness.sqlite, 'agent-self-4', 'squad-1')
    seedReviewTask(harness.sqlite, 'task-4', 'squad-1', 'gate:outreach', 'agent-self-4')
    seedGrant(harness.sqlite, 'gate:outreach', 'agent', 'agent-self-4')
    // A dashboard-cookie-shaped AuthContext: memberId set, boundAgentId absent —
    // exactly what loadAuthFromCookie ever produces. The visibility filter
    // resolves this caller to principal_type='member', never 'agent', so it
    // cannot see a row whose only grant is agent-typed — regardless of
    // self-verdict, the row is not even in the returned set.
    const out = await loadApprovals(envFor(harness), memberAuth('member-4'))
    expect(out.items).toHaveLength(0)
  })

  it('org owner: can_verdict true for a gate:agent-self-completion row assigned to someone else (legacy escape modeled correctly)', async () => {
    seedAgent(harness.sqlite, 'agent-other', 'squad-1')
    seedReviewTask(harness.sqlite, 'task-5', 'squad-1', 'gate:agent-self-completion', 'agent-other')
    const ownerAuth: AuthContext = { userId: 'owner-1', email: null, role: 'owner', tenant: TENANT, memberId: 'owner-1' }
    const out = await loadApprovals(envFor(harness), ownerAuth)
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({ can_verdict: true, can_approve: true, can_reject: true })
  })
})

describe('loadPublishable — no verdict-gate fields at all (mupot#1081, the "unread invariant is a trap" fix)', () => {
  let harness: SqliteD1Harness
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seedDept(harness.sqlite, 'dept-1')
    seedSquad(harness.sqlite, 'squad-1', 'dept-1')
  })
  afterEach(() => harness.close())

  it('returned rows structurally lack can_verdict/can_approve/can_reject', async () => {
    sqliteSeedApprovedContentTask(harness.sqlite)
    const ownerAuth: AuthContext = { userId: 'owner-1', email: null, role: 'owner', tenant: TENANT, memberId: 'owner-1' }
    const out = await loadPublishable(envFor(harness), ownerAuth)
    expect(out).toHaveLength(1)
    expect(out[0]).not.toHaveProperty('can_verdict')
    expect(out[0]).not.toHaveProperty('can_approve')
    expect(out[0]).not.toHaveProperty('can_reject')
  })
})

function sqliteSeedApprovedContentTask(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite
    .prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
       VALUES ('task-pub-1', 'squad-1', 'T', 'body', 'done', 'approved', 'gate:content', NULL, NULL, datetime('now'), datetime('now'))`,
    )
    .run()
}
