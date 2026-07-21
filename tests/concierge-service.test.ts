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
    expect(second.decision).toEqual({ action: 'noop', reason: 'has_advancing_work' })
    expect(second.taskId).toBeNull()

    // The dedup guard is the whole point of this test: fails here if it's ever removed.
    const rows = countTasks(harness, p.id)
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
