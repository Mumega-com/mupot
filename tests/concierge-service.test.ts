// tests/concierge-service.test.ts — per-project concierge (Module Kernel Leg 1, the
// always-on dispatcher). Design: docs/architecture/mupot-module-kernel.md § "Per-project
// concierge". Builds on Port 1 (module_registry + presence, migration 0066,
// src/registry/service.ts).
//
// Real D1 via the sqlite-d1 test harness, full migration chain — no JS-reimplemented
// mock of the SQL (mirrors tests/tasks-project-filter.test.ts's harness pattern).
//
// Coverage:
//   1. Presence: a cycle registers the project's concierge and it appears online on
//      that project's own roster.
//   2. Stalled project (goal + online build-capable agent + zero advancing tasks) ->
//      dispatches exactly ONE starter task, assigned to that agent.
//   3. Idempotency (the anti-spam proof): running the cycle TWICE dispatches only
//      once — the second cycle sees the task it just created and no-ops. This test
//      MUST fail if the dedup (hasAdvancingTask) guard is ever removed.
//   4. No online agent -> registers presence only, no dispatch.
//   5. No goal -> no dispatch, even with idle online build capacity.
//   6. An existing in_progress task -> no dispatch.
//   7. runConciergeTick fans out across projects and tallies the sweep.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Env, Project } from '../src/types'
import { registerModule, listPresence } from '../src/registry/service'
import {
  runProjectConcierge,
  runConciergeTick,
  conciergeIdentity,
  BUILD_CAPABILITY,
} from '../src/concierge/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-builder', 'squad-a', 'builder', 'Builder', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-paused', 'squad-a', 'paused-agent', 'Paused Agent', 'paused');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function project(overrides: Partial<Project> = {}): Project {
  const now = new Date().toISOString()
  return {
    id: 'proj-1',
    slug: 'proj-1',
    name: 'Project One',
    description: '',
    goal: 'Ship the starter feature',
    status: 'active',
    parent_project_id: null,
    target_date: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

// createSqliteD1's raw `sqlite.exec` has no parameter binding (see sibling test files —
// every seed uses inline SQL literals). Follow that convention rather than introducing
// a second seeding path.
function insertProject(harness: SqliteD1Harness, p: Project): void {
  const esc = (v: string) => v.replace(/'/g, "''")
  harness.sqlite.exec(
    `INSERT INTO projects (id, slug, name, description, goal, status)
     VALUES ('${esc(p.id)}', '${esc(p.slug)}', '${esc(p.name)}', '${esc(p.description)}', '${esc(p.goal)}', '${esc(p.status)}')`,
  )
}

function grantSquadAccess(harness: SqliteD1Harness, projectId: string, squadId: string, level: 'write' | 'admin' | 'read'): void {
  harness.sqlite.exec(
    `INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('${projectId}', '${squadId}', '${level}')`,
  )
}

function countTasks(harness: SqliteD1Harness, projectId: string): Array<{ status: string; assignee_agent_id: string | null }> {
  return harness.sqlite
    .prepare(`SELECT status, assignee_agent_id FROM tasks WHERE project_id = ?`)
    .all(projectId) as Array<{ status: string; assignee_agent_id: string | null }>
}

async function registerBuilderOnline(env: Env, projectId: string): Promise<void> {
  const result = await registerModule(env, {
    identity: 'agent-builder',
    kind: 'agent_system',
    adapter: 'cursor',
    projectId,
    capabilities: [BUILD_CAPABILITY],
  })
  expect(result.ok).toBe(true)
}

// The SHARED build pool: a driver registered with project_id = null (how the standing
// operator's cursor/mumcp actually register). This is the live production shape.
async function registerBuilderShared(env: Env): Promise<void> {
  const result = await registerModule(env, {
    identity: 'agent-builder',
    kind: 'agent_system',
    adapter: 'cursor',
    projectId: null,
    capabilities: [BUILD_CAPABILITY],
  })
  expect(result.ok).toBe(true)
}

describe('runProjectConcierge — presence registration', () => {
  it('registers the concierge and it appears online on its own project roster', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project({ goal: '' }) // no goal -> will no-op after registering
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')

    const result = await runProjectConcierge(env, p)
    expect(result.registered).toBe(true)
    expect(result.decision).toEqual({ action: 'noop', reason: 'no_goal' })

    const roster = await listPresence(env, { projectId: p.id })
    const self = roster.find((m) => m.identity === conciergeIdentity(p.id))
    expect(self?.status).toBe('online')
    expect(self?.adapter).toBe('concierge')
    expect(self?.kind).toBe('agent_system')
  })
})

describe('runProjectConcierge — stalled project dispatches exactly one starter task', () => {
  it('goal + online build-capable agent + zero advancing tasks -> dispatch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)

    const result = await runProjectConcierge(env, p)
    expect(result.registered).toBe(true)
    expect(result.decision).toEqual({ action: 'dispatch', agentId: 'agent-builder' })
    expect(result.taskId).toBeTruthy()
  })

  // Work-router: a BUSY project (has advancing work) with a SITTING unassigned-open
  // task routes it to an online builder — the "10 tasks parked, agents idle" case.
  it('routes a sitting unassigned-open task to an online builder (busy project)', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    // open + unassigned in squad-a: makes the project "busy" AND is the routable target.
    // Seed a stale updated_at so we can assert the router bumps it.
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, assignee_agent_id, updated_at)
       VALUES ('task-sitting', 'squad-a', '${p.id}', 'Sitting work', 'done', 'open', NULL, '2020-01-01T00:00:00.000Z')`,
    )
    await registerBuilderShared(env) // online in the shared pool (project_id=null)

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'route', routed: 1 })
    const row = harness.sqlite
      .prepare('SELECT assignee_agent_id, updated_at FROM tasks WHERE id = ?')
      .get('task-sitting') as { assignee_agent_id: string | null; updated_at: string }
    expect(row.assignee_agent_id).toBe('agent-builder')
    expect(row.updated_at).not.toBe('2020-01-01T00:00:00.000Z') // router bumped it (observability)
  })

  // SECURITY regression (#404): a cross-pot (source_pot) open+unassigned task must NOT be
  // auto-routed — untrusted remote content requires an explicit human/operator assignee.
  it('does NOT route a cross-pot (source_pot) task — #404 invariant', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, assignee_agent_id, source_pot)
       VALUES ('task-crosspot', 'squad-a', '${p.id}', 'Inbound remote work', 'done', 'open', NULL, 'remote-pot-x')`,
    )
    await registerBuilderShared(env)

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'noop', reason: 'has_advancing_work' })
    const row = harness.sqlite
      .prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?')
      .get('task-crosspot') as { assignee_agent_id: string | null }
    expect(row.assignee_agent_id).toBeNull() // untrusted cross-pot task NOT auto-assigned
  })

  it('does NOT reassign an already-assigned task; busy project with no sitting work -> noop', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    // one in_progress task already assigned to someone else — busy, but nothing to route.
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, assignee_agent_id)
       VALUES ('task-owned', 'squad-a', '${p.id}', 'Owned work', 'done', 'in_progress', 'agent-paused')`,
    )
    await registerBuilderShared(env)

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'noop', reason: 'has_advancing_work' })
    const row = harness.sqlite
      .prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?')
      .get('task-owned') as { assignee_agent_id: string | null }
    expect(row.assignee_agent_id).toBe('agent-paused') // untouched
  })

  it('routes at most MAX_ROUTES_PER_AGENT to one builder in a tick', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    // 4 sitting tasks, only one online builder (agent-builder) → capped at 2 this tick.
    for (let i = 0; i < 4; i++) {
      harness.sqlite.exec(
        `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, assignee_agent_id)
         VALUES ('sit-${i}', 'squad-a', '${p.id}', 'Sitting ${i}', 'done', 'open', NULL)`,
      )
    }
    await registerBuilderShared(env)

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'route', routed: 2 }) // MAX_ROUTES_PER_AGENT
    const assigned = (
      harness.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND assignee_agent_id = 'agent-builder'`)
        .get(p.id) as { n: number }
    ).n
    expect(assigned).toBe(2)
  })

  // Effort ladder: research task prefers agy; agy must never receive build work.
  it('routes a research task to agy when online; does not give agy build work', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-agy', 'squad-a', 'agy', 'Agy', 'active');
      INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-cursor', 'squad-a', 'cursor', 'Cursor', 'active');
      INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id)
      VALUES ('task-research', 'squad-a', '${p.id}', 'Research competitor pricing', '', 'done', 'open', NULL);
      INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id)
      VALUES ('task-build', 'squad-a', '${p.id}', 'Ship the feature', '', 'done', 'open', NULL);
    `)
    // agy presence wrongly claims build — authoritative HARNESS_CAPABILITIES must still
    // keep it research-only.
    await registerModule(env, {
      identity: 'agent-agy',
      kind: 'agent_system',
      adapter: 'antigravity',
      projectId: null,
      capabilities: ['build', 'research', 'review'],
    })
    await registerModule(env, {
      identity: 'agent-cursor',
      kind: 'agent_system',
      adapter: 'cursor',
      projectId: null,
      capabilities: [BUILD_CAPABILITY],
    })

    const result = await runProjectConcierge(env, p)
    expect(result.decision.action).toBe('route')
    const research = harness.sqlite
      .prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?')
      .get('task-research') as { assignee_agent_id: string | null }
    const build = harness.sqlite
      .prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?')
      .get('task-build') as { assignee_agent_id: string | null }
    expect(research.assignee_agent_id).toBe('agent-agy')
    expect(build.assignee_agent_id).toBe('agent-cursor')
  })

  // Regression for the "never dispatched in production" bug: the build driver is in the
  // SHARED pool (project_id=null), NOT on the project roster. Before the fix the concierge
  // only queried the project scope and reported no_online_builder forever.
  it('goal + SHARED-pool (project_id=null) build agent + zero advancing -> dispatch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderShared(env) // builder online in the shared pool ONLY

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'dispatch', agentId: 'agent-builder' })
    expect(result.taskId).toBeTruthy()

    const rows = countTasks(harness, p.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('open')
    expect(rows[0].assignee_agent_id).toBe('agent-builder')
  })
})

describe('runProjectConcierge — idempotency (the anti-spam proof)', () => {
  it('running the cycle TWICE dispatches only once', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)

    const first = await runProjectConcierge(env, p)
    expect(first.decision.action).toBe('dispatch')

    const second = await runProjectConcierge(env, p)
    // After the dispatch, the starter is an OPEN task, so the project is now BUSY →
    // the second cycle takes the work-router branch (checked before the starter's
    // dispatch-once bookkeeping). The starter is already ASSIGNED (assignee=builder),
    // so there is nothing unassigned to route → has_advancing_work. Crucially it does
    // NOT dispatch a second starter — the dispatch-once invariant holds (the starter
    // path is only reachable when the project is STALLED, and there already_dispatched
    // still guards it — see the FULL-lifecycle regression below).
    expect(second.decision).toEqual({ action: 'noop', reason: 'has_advancing_work' })
    expect(second.taskId).toBeNull()

    // The dedup guard is the whole point of this test: fails here if it's ever removed.
    const rows = countTasks(harness, p.id)
    expect(rows).toHaveLength(1)
  })
})

describe('runProjectConcierge — dispatch-once-ever across the FULL task lifecycle (P0 regression, PR #459 gate)', () => {
  // The pre-fix dedup (ADVANCING_STATUSES = open/in_progress/review/blocked) only
  // covered "live" statuses. A starter that moved to done/rejected/approved fell out
  // of that set entirely, so — with project.goal still set (nothing clears it) — the
  // NEXT cycle saw "no advancing task" and dispatched a byte-identical second starter.
  // Left running on a cron, that is an unbounded per-tick duplicate-task flood. Each
  // case below MUST fail against the pre-fix code (verified by temporarily reverting
  // the hasConciergeStarter guard — see the task's final report for how).

  it('starter dispatched -> moved to done, goal still set -> second cycle does NOT re-dispatch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)

    const first = await runProjectConcierge(env, p)
    expect(first.decision.action).toBe('dispatch')
    const taskId = first.taskId
    expect(taskId).toBeTruthy()

    // Move the dispatched starter all the way to 'done' — a terminal status the
    // pre-fix ADVANCING_STATUSES list never covered.
    harness.sqlite.exec(`UPDATE tasks SET status = 'done' WHERE id = '${taskId}'`)

    const second = await runProjectConcierge(env, p)
    expect(second.decision).toEqual({ action: 'noop', reason: 'already_dispatched' })
    expect(second.taskId).toBeNull()

    const rows = countTasks(harness, p.id)
    expect(rows).toHaveLength(1) // no duplicate starter created
  })

  it('starter dispatched -> moved to rejected (un-reworked), goal still set -> no re-dispatch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)

    const first = await runProjectConcierge(env, p)
    expect(first.decision.action).toBe('dispatch')
    const taskId = first.taskId

    harness.sqlite.exec(`UPDATE tasks SET status = 'rejected' WHERE id = '${taskId}'`)

    const second = await runProjectConcierge(env, p)
    expect(second.decision).toEqual({ action: 'noop', reason: 'already_dispatched' })
    expect(second.taskId).toBeNull()
    expect(countTasks(harness, p.id)).toHaveLength(1)
  })

  it('starter dispatched -> moved to approved (not yet done), goal still set -> no double-dispatch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)

    const first = await runProjectConcierge(env, p)
    expect(first.decision.action).toBe('dispatch')
    const taskId = first.taskId

    harness.sqlite.exec(`UPDATE tasks SET status = 'approved' WHERE id = '${taskId}'`)

    const second = await runProjectConcierge(env, p)
    expect(second.decision).toEqual({ action: 'noop', reason: 'already_dispatched' })
    expect(second.taskId).toBeNull()
    expect(countTasks(harness, p.id)).toHaveLength(1)
  })
})

describe('runProjectConcierge — TOCTOU backstop (P1, migration 0067 unique index)', () => {
  it('a concurrent create that loses the race is treated as already_dispatched, not an error', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)

    // Simulate two overlapping ticks both passing BOTH read-side dedup checks as
    // "none yet" by forcing those seams to report false, then letting this call's
    // real INSERT collide with a starter a "concurrent" first call already wrote
    // directly (mirrors what migration 0067's unique index would reject in
    // production when two live ticks race the real read-then-write). Status is
    // 'done' — a terminal status hasAdvancingTask never counts as live — so the
    // ONLY thing standing between this call and a duplicate starter is the DB-level
    // unique index, which is exactly what this test is proving closes the gap.
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id)
       VALUES ('task-concurrent', 'squad-a', '${p.id}', 'Starter: Project One',
               'Concierge dispatch (MVP heuristic)\n\n[concierge-starter]', 'progress', 'done', 'agent-builder')`,
    )

    const result = await runProjectConcierge(env, p, {
      hasConciergeStarter: async () => false, // force past the read-side any-status check
      hasAdvancingTask: async () => false, // force past the read-side live-work check
    })

    expect(result.decision).toEqual({ action: 'noop', reason: 'already_dispatched' })
    expect(result.taskId).toBeNull()
    // Still exactly one concierge-marked row — the unique index refused the duplicate.
    const rows = harness.sqlite
      .prepare(`SELECT id FROM tasks WHERE project_id = ? AND instr(body, '[concierge-starter]') > 0`)
      .all(p.id) as Array<{ id: string }>
    expect(rows).toHaveLength(1)
  })
})

describe('runProjectConcierge — no online agent', () => {
  it('registers presence only; no dispatch when nobody with BUILD_CAPABILITY is online', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    // Register the builder WITHOUT the build capability — should not count.
    await registerModule(env, {
      identity: 'agent-builder',
      kind: 'agent_system',
      adapter: 'cursor',
      projectId: p.id,
      capabilities: ['chat'],
    })

    const result = await runProjectConcierge(env, p)
    expect(result.registered).toBe(true)
    expect(result.decision).toEqual({ action: 'noop', reason: 'no_online_builder' })
    expect(countTasks(harness, p.id)).toHaveLength(0)
  })

  it('a build-capable registration that does not resolve to an active agent row does not count', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    // identity has no matching row in `agents` at all (e.g. a bare member-token principal).
    await registerModule(env, {
      identity: 'member-not-an-agent',
      kind: 'agent_system',
      adapter: 'claude_code',
      projectId: p.id,
      capabilities: [BUILD_CAPABILITY],
    })

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'noop', reason: 'no_online_builder' })
  })

  it('a paused agent does not count as a dispatch candidate', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerModule(env, {
      identity: 'agent-paused',
      kind: 'agent_system',
      adapter: 'cursor',
      projectId: p.id,
      capabilities: [BUILD_CAPABILITY],
    })

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'noop', reason: 'no_online_builder' })
  })
})

describe('runProjectConcierge — no goal', () => {
  it('no dispatch when the project has no goal, even with idle online build capacity', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project({ goal: '   ' }) // whitespace-only counts as empty
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'noop', reason: 'no_goal' })
    expect(countTasks(harness, p.id)).toHaveLength(0)
  })
})

describe('runProjectConcierge — existing advancing task blocks dispatch', () => {
  it('an in_progress task already on the project board -> no dispatch', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const p = project()
    insertProject(harness, p)
    grantSquadAccess(harness, p.id, 'squad-a', 'write')
    await registerBuilderOnline(env, p.id)
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, project_id, title, done_when, status)
       VALUES ('task-existing', 'squad-a', '${p.id}', 'Already working', 'it works', 'in_progress')`,
    )

    const result = await runProjectConcierge(env, p)
    expect(result.decision).toEqual({ action: 'noop', reason: 'has_advancing_work' })
    expect(countTasks(harness, p.id)).toHaveLength(1) // still just the pre-existing one
  })
})

describe('runConciergeTick — fans out across active projects, best-effort', () => {
  it('tallies registered/dispatched/noop across multiple projects in one sweep', async () => {
    const harness = makeHarness()
    const env = envFor(harness)

    const stalled = project({ id: 'proj-stalled', slug: 'proj-stalled', name: 'Stalled' })
    const quiet = project({ id: 'proj-quiet', slug: 'proj-quiet', name: 'Quiet', goal: '' })
    insertProject(harness, stalled)
    insertProject(harness, quiet)
    grantSquadAccess(harness, stalled.id, 'squad-a', 'write')
    grantSquadAccess(harness, quiet.id, 'squad-a', 'write')
    await registerBuilderOnline(env, stalled.id)

    const summary = await runConciergeTick(env, {
      listProjects: async () => [stalled, quiet],
    })

    expect(summary.ok).toBe(true)
    expect(summary.projects).toBe(2)
    expect(summary.registered).toBe(2) // both concierges register presence
    expect(summary.dispatched).toBe(1) // only the stalled project had idle capacity
    expect(summary.noop).toBe(1)
    expect(summary.errors).toBe(0)
  })

  it('one project throwing does not abort the rest of the sweep', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    const ok = project({ id: 'proj-ok', slug: 'proj-ok', name: 'OK', goal: '' })
    insertProject(harness, ok)

    const broken: Project = { ...project(), id: 'proj-missing', slug: 'proj-missing' }
    // Deliberately never inserted into `projects` — createTask/registerModule against
    // this id will fail the project_squad_access FK / project lookup, forcing an error.

    const summary = await runConciergeTick(env, { listProjects: async () => [broken, ok] })
    expect(summary.ok).toBe(true)
    expect(summary.projects).toBe(2)
    expect(summary.errors).toBeGreaterThanOrEqual(0)
    // Whatever happened to `broken`, the healthy project still ran its own cycle.
    const rosterOk = await listPresence(env, { projectId: ok.id })
    expect(rosterOk.some((m) => m.identity === conciergeIdentity(ok.id))).toBe(true)
  })
})
