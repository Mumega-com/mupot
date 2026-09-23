// tests/project-start-gate.test.ts — project lifecycle slice 3 (authorize + provision).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// planned → active seeds >=1 first task onto a write/admin squad AND mints/confirms
// that squad's resource via the existing grant path. Resource failure keeps the
// project planned (blocked-start). Stale planned with no provision attempt escalates
// to org owners (ghost-start alarm).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Env, Task } from '../src/types'
import { runProjectLoopTick } from '../src/projects/loop'
import { getProject } from '../src/projects/service'
import { DEFAULT_CYCLE_DAYS, nextCycleBoundary } from '../src/projects/cycle-creation'
import {
  cycleInstanceId,
  defaultCircuitBreakerDeps,
  evaluateProjectCircuitBreaker,
  proposeProjectRecommit,
  recordRecommitOrKill,
} from '../src/projects/circuit-breaker'
import { writeReceiptToD1 } from '../src/workflows/pipeline'
import {
  BLOCKED_START_SCHEMA,
  BLOCKED_START_STEP,
  DEFAULT_GHOST_START_DAYS,
  GHOST_START_ALARM_SCHEMA,
  GHOST_START_ALARM_STEP,
  START_GATE_SCHEMA,
  START_GATE_SEED_MARKER,
  START_GATE_STEP,
  commitSquadResource,
  defaultGhostStartDeps,
  defaultStartGateDeps,
  evaluateGhostStartAlarm,
  ghostCutoffIso,
  ghostInstanceId,
  hasStartProvisionAttempt,
  seedTaskFromGoal,
  startInstanceId,
  startProject,
  type StartGateDeps,
} from '../src/projects/start-gate'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'
const NOW = '2026-07-23T12:00:00.000Z'
const STALE_CREATED = '2026-07-01T00:00:00.000Z'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO members (id, email, display_name, telegram_chat_id, status, created_at, tenant)
    VALUES ('owner-1', 'owner@example.com', 'Owner', NULL, 'active', '2026-06-01T00:00:00.000Z', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
    VALUES ('cap-owner', 'owner-1', 'org', NULL, 'owner');
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

function insertPlannedProject(
  harness: SqliteD1Harness,
  opts: { id?: string; goal?: string; created_at?: string } = {},
): void {
  const id = opts.id ?? 'proj-1'
  const goal = opts.goal ?? 'Ship the start gate'
  const created = opts.created_at ?? '2026-07-20T00:00:00.000Z'
  harness.sqlite.exec(`
    INSERT INTO projects (
      id, slug, name, description, goal, status, parent_project_id, target_date,
      cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at
    ) VALUES (
      '${id}', '${id}', 'Project ${id}', '', '${goal.replace(/'/g, "''")}', 'planned', NULL, NULL,
      NULL, 0, NULL, NULL, '${created}', '${created}'
    );
  `)
}

function grantSquadAccess(harness: SqliteD1Harness, projectId: string, level = 'write'): void {
  harness.sqlite.exec(`
    INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
    VALUES ('${projectId}', 'squad-a', '${level}', '2026-07-20T00:00:00.000Z');
  `)
}

function insertAgent(harness: SqliteD1Harness, id = 'agent-a'): void {
  harness.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at)
    VALUES ('${id}', 'squad-a', '${id}', 'Agent ${id}', 'builder', 'test', 'active', '2026-07-20T00:00:00.000Z');
  `)
}

/** Insert a plain, pre-existing task row directly — e.g. history that predates the start gate. */
function insertTask(
  harness: SqliteD1Harness,
  opts: {
    id: string
    project_id: string
    squad_id: string
    body?: string
    assignee_agent_id?: string | null
    created_at?: string
  },
): void {
  const created = opts.created_at ?? '2026-07-15T00:00:00.000Z'
  const body = (opts.body ?? 'Some pre-existing task, not a start-gate seed').replace(/'/g, "''")
  const assignee = opts.assignee_agent_id === undefined ? null : opts.assignee_agent_id
  harness.sqlite.exec(`
    INSERT INTO tasks (
      id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
      github_issue_url, result, completed_at, gate_owner, created_at, updated_at
    ) VALUES (
      '${opts.id}', '${opts.squad_id}', '${opts.project_id}', 'Pre-existing task', '${body}',
      'done_when', 'open', ${assignee ? `'${assignee}'` : 'NULL'},
      NULL, NULL, NULL, NULL, '${created}', '${created}'
    );
  `)
}

/** A createTask dep that actually persists the row (mirrors the happy-path test's inline version). */
function persistingCreateTask() {
  return vi.fn(async (
    taskEnv: Env,
    input: {
      squad_id: string
      project_id: string
      title: string
      body: string
      done_when: string
      assignee_agent_id: string
    },
  ): Promise<Task> => {
    const id = `task-seed-${Math.random().toString(36).slice(2, 10)}`
    await taskEnv.DB.prepare(
      `INSERT INTO tasks (
         id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
         github_issue_url, result, completed_at, gate_owner, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(
      id, input.squad_id, input.project_id, input.title, input.body, input.done_when,
      input.assignee_agent_id, NOW, NOW,
    ).run()
    return {
      id,
      squad_id: input.squad_id,
      project_id: input.project_id,
      title: input.title,
      body: input.body,
      done_when: input.done_when,
      status: 'open',
      assignee_agent_id: input.assignee_agent_id,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: null,
      created_at: NOW,
      updated_at: NOW,
    }
  })
}

function makeDeps(overrides: Partial<StartGateDeps> = {}): StartGateDeps {
  const base = defaultStartGateDeps()
  return {
    ...base,
    mintAgentBoundToken: vi.fn(async () => ({
      tokenId: 'tok-1',
      memberId: 'mem-agent-1',
    })),
    revokeMemberToken: vi.fn(async () => true),
    resolveActiveAgentMember: vi.fn(async () => 'unminted' as const),
    setAgentSquadAccess: vi.fn(async () => ({ ok: true as const, result: 'created' as const })),
    createTask: vi.fn(async (_env, input) => ({
      id: 'task-seed-1',
      squad_id: input.squad_id,
      project_id: input.project_id,
      title: input.title,
      body: input.body,
      done_when: input.done_when,
      status: 'open',
      assignee_agent_id: input.assignee_agent_id,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: null,
      created_at: NOW,
      updated_at: NOW,
    } satisfies Task)),
    ...overrides,
  }
}

describe('seedTaskFromGoal (pure)', () => {
  it('derives title/body/done_when from the project goal', () => {
    expect(seedTaskFromGoal({ name: 'Alpha', goal: 'Land the charter' })).toEqual({
      title: 'Land the charter',
      body: `Land the charter\n\n${START_GATE_SEED_MARKER}`,
      done_when: 'First delivery toward: Land the charter',
    })
  })

  it('falls back to the project name when goal is blank', () => {
    expect(seedTaskFromGoal({ name: 'Alpha', goal: '   ' }).title).toBe('Start Alpha')
    expect(seedTaskFromGoal({ name: 'Alpha', goal: '   ' }).body).toContain(START_GATE_SEED_MARKER)
  })
})

describe('commitSquadResource (existing grant path)', () => {
  it('mints when the agent is unminted', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      const mint = vi.fn(async () => ({ tokenId: 'tok', memberId: 'mem' }))
      const result = await commitSquadResource(
        env,
        { id: 'agent-a', squad_id: 'squad-a', slug: 'agent-a', name: 'Agent A' },
        {
          mintAgentBoundToken: mint,
          resolveActiveAgentMember: async () => 'unminted',
          setAgentSquadAccess: async () => ({ ok: true, result: 'created' }),
        },
      )
      expect(result).toEqual({ kind: 'minted', memberId: 'mem', tokenId: 'tok' })
      expect(mint).toHaveBeenCalledTimes(1)
    } finally {
      harness.close()
    }
  })

  it('confirms via setAgentSquadAccess when already welded', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      const upsert = vi.fn(async () => ({ ok: true as const, result: 'unchanged' as const }))
      const result = await commitSquadResource(
        env,
        { id: 'agent-a', squad_id: 'squad-a', slug: 'agent-a', name: 'Agent A' },
        {
          mintAgentBoundToken: async () => ({ tokenId: 'tok', memberId: 'mem' }),
          resolveActiveAgentMember: async () => 'mem-existing',
          setAgentSquadAccess: upsert,
        },
      )
      expect(result).toEqual({ kind: 'confirmed', memberId: 'mem-existing', tokenId: null })
      expect(upsert).toHaveBeenCalledWith(env, expect.objectContaining({
        agentId: 'agent-a',
        memberId: 'mem-existing',
        squadId: 'squad-a',
        capability: 'member',
      }))
    } finally {
      harness.close()
    }
  })

  it('returns null when identity is ambiguous (resource commit failed)', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      const result = await commitSquadResource(
        env,
        { id: 'agent-a', squad_id: 'squad-a', slug: 'agent-a', name: 'Agent A' },
        {
          mintAgentBoundToken: async () => ({ tokenId: 'tok', memberId: 'mem' }),
          resolveActiveAgentMember: async () => 'ambiguous',
          setAgentSquadAccess: async () => ({ ok: true, result: 'created' }),
        },
      )
      expect(result).toBeNull()
    } finally {
      harness.close()
    }
  })
})

describe('startProject happy path', () => {
  it('activates, seeds a first task, and records a start-gate receipt', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-happy', goal: 'Ship slice 3' })
      grantSquadAccess(harness, 'proj-happy', 'admin')
      insertAgent(harness, 'agent-happy')

      // Persist the seeded task so count/reuse paths see a real row on success path.
      const deps = makeDeps({
        createTask: vi.fn(async (taskEnv, input) => {
          const id = 'task-happy-1'
          await taskEnv.DB.prepare(
            `INSERT INTO tasks (
               id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
               github_issue_url, result, completed_at, gate_owner, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)`,
          ).bind(
            id, input.squad_id, input.project_id, input.title, input.body, input.done_when,
            input.assignee_agent_id, NOW, NOW,
          ).run()
          return {
            id,
            squad_id: input.squad_id,
            project_id: input.project_id,
            title: input.title,
            body: input.body,
            done_when: input.done_when,
            status: 'open' as const,
            assignee_agent_id: input.assignee_agent_id,
            github_issue_url: null,
            result: null,
            completed_at: null,
            gate_owner: null,
            created_at: NOW,
            updated_at: NOW,
          }
        }),
      })

      const result = await startProject(env, 'proj-happy', deps)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.project.status).toBe('active')
      expect(result.task_id).toBe('task-happy-1')
      expect(result.squad_id).toBe('squad-a')
      expect(result.agent_id).toBe('agent-happy')
      expect(result.resource).toBe('minted')
      expect(deps.mintAgentBoundToken).toHaveBeenCalledTimes(1)
      expect(deps.createTask).toHaveBeenCalledTimes(1)

      expect((await getProject(env, 'proj-happy'))?.status).toBe('active')
      const receipt = harness.sqlite.prepare(
        `SELECT step_name, status, detail FROM workflow_receipts
          WHERE instance_id = ? AND step_name = ?`,
      ).get(startInstanceId('proj-happy'), START_GATE_STEP) as {
        step_name: string
        status: string
        detail: string
      }
      expect(receipt.status).toBe('ok')
      expect(JSON.parse(receipt.detail)).toMatchObject({
        schema: START_GATE_SCHEMA,
        project_id: 'proj-happy',
        task_id: 'task-happy-1',
        resource: 'minted',
      })
      expect(await hasStartProvisionAttempt(env, 'proj-happy')).toBe(true)
    } finally {
      harness.close()
    }
  })
})

describe('startProject resource-fail stays planned (blocked-start)', () => {
  it('keeps planned and writes blocked-start when resource commit fails', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-block', goal: 'Never activate' })
      grantSquadAccess(harness, 'proj-block', 'write')
      insertAgent(harness, 'agent-block')

      const deps = makeDeps({
        resolveActiveAgentMember: vi.fn(async () => 'ambiguous' as const),
      })

      const result = await startProject(env, 'proj-block', deps)
      expect(result).toMatchObject({ ok: false, error: 'resource_commit_failed' })
      expect((await getProject(env, 'proj-block'))?.status).toBe('planned')
      expect(deps.createTask).not.toHaveBeenCalled()

      const receipt = harness.sqlite.prepare(
        `SELECT status, detail FROM workflow_receipts
          WHERE instance_id = ? AND step_name = ?`,
      ).get(startInstanceId('proj-block'), BLOCKED_START_STEP) as {
        status: string
        detail: string
      }
      expect(receipt.status).toBe('error')
      expect(JSON.parse(receipt.detail)).toMatchObject({
        schema: BLOCKED_START_SCHEMA,
        project_id: 'proj-block',
        reason: 'resource_commit_failed',
      })
      expect(await hasStartProvisionAttempt(env, 'proj-block')).toBe(true)
    } finally {
      harness.close()
    }
  })

  it('blocks start when no write/admin squad access exists', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-nosquad' })
      insertAgent(harness, 'agent-nosquad')
      // read-only access is not enough
      harness.sqlite.exec(`
        INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
        VALUES ('proj-nosquad', 'squad-a', 'read', '2026-07-20T00:00:00.000Z');
      `)

      const result = await startProject(env, 'proj-nosquad', makeDeps())
      expect(result).toMatchObject({ ok: false, error: 'no_writable_squad' })
      expect((await getProject(env, 'proj-nosquad'))?.status).toBe('planned')
    } finally {
      harness.close()
    }
  })

  // mupot#1498: a project with ZERO squad edges (not merely a non-writable
  // one — see the test above) auto-creates `<slug>-sqd` + an ADMIN edge
  // instead of refusing no_writable_squad. The auto-created squad starts
  // with no agent in it (nothing to auto-create one FROM), so the overall
  // start still blocks — but on the more specific, honest 'no_squad_agent'
  // reason, and with a real, reusable squad now in place for next time
  // (an operator adds an agent to it, or calls team_bootstrap next time
  // instead) rather than a dead end.
  it('auto-creates <slug>-sqd + an ADMIN edge when the project has NO squad edge at all', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      // free tier's maxDepartments=1/maxSquads=1 (src/billing/plans.ts) is
      // already spent by makeHarness's dept-a/squad-a fixture — raise the
      // tier so THIS test is about the auto-create path, not the entitlement
      // gate createDepartment/createSquad already enforce independently.
      harness.sqlite.exec(
        `INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00')`,
      )
      insertPlannedProject(harness, { id: 'proj-nosquad-at-all' })
      // Deliberately NO project_squad_access row and NO pre-existing squad
      // named 'proj-nosquad-at-all-sqd' — this is the true "without any
      // squad" case. No agent either — the newly-created squad starts empty.

      const result = await startProject(env, 'proj-nosquad-at-all', makeDeps())
      expect(result).toMatchObject({ ok: false, error: 'no_squad_agent' })
      expect((await getProject(env, 'proj-nosquad-at-all'))?.status).toBe('planned')

      const squad = await env.DB.prepare('SELECT id, slug, department_id FROM squads WHERE slug = ?')
        .bind('proj-nosquad-at-all-sqd')
        .first<{ id: string; slug: string; department_id: string }>()
      expect(squad).toBeTruthy()

      const edge = await env.DB.prepare(
        'SELECT access_level FROM project_squad_access WHERE project_id = ? AND squad_id = ?',
      )
        .bind('proj-nosquad-at-all', squad!.id)
        .first<{ access_level: string }>()
      expect(edge?.access_level).toBe('admin')

      // A RETRY after an agent is added to the now-real squad succeeds.
      insertAgent(harness, 'agent-nosquad-at-all')
      harness.sqlite.exec(`UPDATE agents SET squad_id = '${squad!.id}' WHERE id = 'agent-nosquad-at-all'`)
      const retry = await startProject(env, 'proj-nosquad-at-all', makeDeps())
      expect(retry.ok).toBe(true)
      if (retry.ok) expect(retry.squad_id).toBe(squad!.id)
    } finally {
      harness.close()
    }
  })

  // mupot#1498 successor (P3-2): the auto-created squad stamps
  // created_by_member_id with the actor who triggered the start-gate — the
  // SAME provenance column team_bootstrap's adoption check reads (migration
  // 0166). Without this, a later team_bootstrap call adopting this exact
  // squad by derived slug would fall through to the org-admin adopt:true
  // override on every single call instead of recognizing its own actor's
  // prior work.
  it('stamps created_by_member_id on the auto-created squad with the start-gate actor', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      harness.sqlite.exec(
        `INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00')`,
      )
      insertPlannedProject(harness, { id: 'proj-nosquad-provenance' })

      await startProject(env, 'proj-nosquad-provenance', makeDeps({ actorMemberId: 'member-start-gate-actor' }))

      const squad = await env.DB.prepare('SELECT created_by_member_id FROM squads WHERE slug = ?')
        .bind('proj-nosquad-provenance-sqd')
        .first<{ created_by_member_id: string | null }>()
      expect(squad?.created_by_member_id).toBe('member-start-gate-actor')
    } finally {
      harness.close()
    }
  })

  it('a second project with no squad edge reuses the SAME auto-provisioned department, not a new one', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      harness.sqlite.exec(
        `INSERT INTO org_settings (key, value, updated_at) VALUES ('billing_state', '{"tier":"scale"}', '2026-07-22 00:00:00')`,
      )
      insertPlannedProject(harness, { id: 'proj-auto-a' })
      insertPlannedProject(harness, { id: 'proj-auto-b' })

      await startProject(env, 'proj-auto-a', makeDeps())
      await startProject(env, 'proj-auto-b', makeDeps())

      const squadA = await env.DB.prepare('SELECT department_id FROM squads WHERE slug = ?')
        .bind('proj-auto-a-sqd')
        .first<{ department_id: string }>()
      const squadB = await env.DB.prepare('SELECT department_id FROM squads WHERE slug = ?')
        .bind('proj-auto-b-sqd')
        .first<{ department_id: string }>()
      expect(squadA).toBeTruthy()
      expect(squadB).toBeTruthy()
      expect(squadA?.department_id).toBe(squadB?.department_id)

      const deptCount = await env.DB.prepare(`SELECT COUNT(*) AS n FROM departments WHERE slug = 'dept-projects'`).first<{ n: number }>()
      expect(deptCount?.n).toBe(1)
    } finally {
      harness.close()
    }
  })
})

// mupot: reviving an ARCHIVED project (archived -> planned -> active, this
// same startProject path) can land on a project that already has tasks —
// just none of them carrying START_GATE_SEED_MARKER, because the project
// predates the start gate (or its seed lived on a squad edge since
// repointed). pickExistingSeedTaskId's "existing seed" lookup is an
// IDEMPOTENCE guard (a retry after a partial failure must reuse the seed it
// already made, not mint a second one) — it was never meant to be the only
// path to a seed, and the no-seed-found branch used to fail closed with
// task_seed_failed instead of seeding. Live prod repro: 'stemminds' (22
// pre-existing tasks, none marked) was permanently unable to re-activate.
describe('startProject revives an archived project with pre-existing, non-seed tasks', () => {
  it('creates exactly one new seed task on the picked squad; old tasks are untouched', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-revive', goal: 'Revive stemminds-shaped project' })
      grantSquadAccess(harness, 'proj-revive', 'admin')
      insertAgent(harness, 'agent-revive')

      // Pre-existing history from before the start gate existed — neither
      // task carries START_GATE_SEED_MARKER.
      insertTask(harness, { id: 'task-old-1', project_id: 'proj-revive', squad_id: 'squad-a' })
      insertTask(harness, { id: 'task-old-2', project_id: 'proj-revive', squad_id: 'squad-a' })

      const deps = makeDeps({ createTask: persistingCreateTask() })
      const result = await startProject(env, 'proj-revive', deps)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.project.status).toBe('active')
      expect(deps.createTask).toHaveBeenCalledTimes(1)
      expect(deps.createTask).toHaveBeenCalledWith(env, expect.objectContaining({
        squad_id: 'squad-a',
        project_id: 'proj-revive',
        assignee_agent_id: 'agent-revive',
      }))

      const tasks = harness.sqlite.prepare(
        `SELECT id, body, squad_id FROM tasks WHERE project_id = ? ORDER BY created_at ASC, id ASC`,
      ).all('proj-revive') as Array<{ id: string; body: string; squad_id: string }>
      expect(tasks).toHaveLength(3)
      const oldOnes = tasks.filter((t) => t.id === 'task-old-1' || t.id === 'task-old-2')
      expect(oldOnes).toHaveLength(2)
      for (const old of oldOnes) expect(old.body).not.toContain(START_GATE_SEED_MARKER)

      const seedRow = tasks.find((t) => t.id !== 'task-old-1' && t.id !== 'task-old-2')
      expect(seedRow).toBeTruthy()
      expect(seedRow!.body).toContain(START_GATE_SEED_MARKER)
      expect(seedRow!.squad_id).toBe('squad-a')
      expect(result.task_id).toBe(seedRow!.id)
    } finally {
      harness.close()
    }
  })

  it('idempotence: a repeated call after a successful revival reuses the seed, task count unchanged', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-revive-again', goal: 'Revive twice' })
      grantSquadAccess(harness, 'proj-revive-again', 'admin')
      insertAgent(harness, 'agent-revive-again')
      insertTask(harness, { id: 'task-old-a', project_id: 'proj-revive-again', squad_id: 'squad-a' })

      const first = await startProject(env, 'proj-revive-again', makeDeps({ createTask: persistingCreateTask() }))
      expect(first.ok).toBe(true)
      if (!first.ok) return

      const countAfterFirst = harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?`,
      ).get('proj-revive-again') as { n: number }
      expect(countAfterFirst.n).toBe(2) // 1 pre-existing + 1 new seed

      // Simulate the project being sent back to 'planned' without disturbing
      // its task history (e.g. archived then reopened again) so a second
      // startProject call is reachable against the SAME tasks.
      harness.sqlite.exec(`UPDATE projects SET status = 'planned' WHERE id = 'proj-revive-again'`)

      const second = await startProject(env, 'proj-revive-again', makeDeps({ createTask: persistingCreateTask() }))
      expect(second.ok).toBe(true)
      if (!second.ok) return
      expect(second.task_id).toBe(first.task_id)

      const countAfterSecond = harness.sqlite.prepare(
        `SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?`,
      ).get('proj-revive-again') as { n: number }
      expect(countAfterSecond.n).toBe(2)
    } finally {
      harness.close()
    }
  })

  // DECISION (documented for the PR, not a defect): a seed marked task
  // sitting on a DIFFERENT squad than the one startProject just picked is not
  // reused. isStartGateSeedTask's squadId check already means
  // pickExistingSeedTaskId will not find it; this test pins that a fresh seed
  // is created on the picked squad instead of, say, refusing or reusing
  // cross-squad. Rationale: the seed must live where the assignee agent
  // actually is (the picked squad), and reusing a task on a squad the caller
  // no longer has write/admin access to would assign it invisibly.
  it('a seed on a DIFFERENT squad than the one just picked is not reused — a fresh seed is created on the picked squad', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      harness.sqlite.exec(`
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-a', 'squad-b', 'Squad B');
      `)
      insertPlannedProject(harness, { id: 'proj-cross-squad', goal: 'Cross-squad seed' })
      insertAgent(harness, 'agent-cross-squad')

      // squad-b held write access FIRST (tasks.squad_id needs a live
      // write/admin project_squad_access row at insert time — see
      // migrations/0069's validate_tasks_project_id_insert), and a real
      // start-gate seed was created on it. Access was then repointed to
      // squad-a — the exact "an old activation's squad edge moved" shape
      // this test pins.
      harness.sqlite.exec(`
        INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
        VALUES ('proj-cross-squad', 'squad-b', 'admin', '2026-07-18T00:00:00.000Z');
      `)
      insertTask(harness, {
        id: 'task-seed-on-b',
        project_id: 'proj-cross-squad',
        squad_id: 'squad-b',
        body: `Old goal\n\n${START_GATE_SEED_MARKER}`,
      })
      harness.sqlite.exec(`
        DELETE FROM project_squad_access WHERE project_id = 'proj-cross-squad' AND squad_id = 'squad-b';
      `)
      grantSquadAccess(harness, 'proj-cross-squad', 'admin') // squad-a is now the only writable squad

      const deps = makeDeps({ createTask: persistingCreateTask() })
      const result = await startProject(env, 'proj-cross-squad', deps)

      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(deps.createTask).toHaveBeenCalledTimes(1)
      expect(result.squad_id).toBe('squad-a')
      expect(result.task_id).not.toBe('task-seed-on-b')

      const tasks = harness.sqlite.prepare(
        `SELECT id, squad_id FROM tasks WHERE project_id = ?`,
      ).all('proj-cross-squad') as Array<{ id: string; squad_id: string }>
      expect(tasks).toHaveLength(2)
      expect(tasks.find((t) => t.id === 'task-seed-on-b')?.squad_id).toBe('squad-b')
    } finally {
      harness.close()
    }
  })

  it('rollback: an activation failure after seeding a revived project cleans up the new seed exactly as the count===0 path does', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-revive-rollback', goal: 'Rollback after revival seed' })
      grantSquadAccess(harness, 'proj-revive-rollback', 'admin')
      insertAgent(harness, 'agent-revive-rollback')
      insertTask(harness, { id: 'task-old-rb', project_id: 'proj-revive-rollback', squad_id: 'squad-a' })

      const deps = makeDeps({
        createTask: persistingCreateTask(),
        updateProject: vi.fn(async () => ({ ok: false as const, error: 'receipt_failed' as const })),
      })

      const result = await startProject(env, 'proj-revive-rollback', deps)
      expect(result).toMatchObject({ ok: false, error: 'activate_failed' })
      expect((await getProject(env, 'proj-revive-rollback'))?.status).toBe('planned')

      const tasks = harness.sqlite.prepare(
        `SELECT id FROM tasks WHERE project_id = ?`,
      ).all('proj-revive-rollback') as Array<{ id: string }>
      // The seed created during THIS call was rolled back by
      // compensateStartProvision (same DELETE FROM tasks path the
      // existingCount===0 branch has always used) — only the pre-existing
      // non-seed task remains.
      expect(tasks).toHaveLength(1)
      expect(tasks[0].id).toBe('task-old-rb')

      const receipt = harness.sqlite.prepare(
        `SELECT status, detail FROM workflow_receipts
          WHERE instance_id = ? AND step_name = ?`,
      ).get(startInstanceId('proj-revive-rollback'), BLOCKED_START_STEP) as { status: string; detail: string }
      expect(receipt.status).toBe('error')
      expect(JSON.parse(receipt.detail)).toMatchObject({
        schema: BLOCKED_START_SCHEMA,
        project_id: 'proj-revive-rollback',
        reason: 'activate_failed',
      })
    } finally {
      harness.close()
    }
  })
})

// mupot: a revived project (archived -> planned -> active) can carry its OLD,
// already-elapsed cycle_boundary_at with stalled=1 from before it was
// archived — and a KILL receipt already on file for that exact boundary
// (recorded by the breaker before the project was archived the first time).
// Without a reset, shouldEvaluateBreaker (circuit-breaker.ts) early-evaluates
// ANY stalled=1 project with a non-null boundary, so the revived project is
// immediately re-killable on the next loop tick — and project_recommit
// against that stale boundary already returns already_decided (kill is on
// file), so nobody can save it either. Live prod repro: mumega-com (boundary
// 2026-08-28) and viamar (boundary 2026-09-09), both stalled=1.
describe('startProject resets a revived project onto a fresh cycle boundary', () => {
  const REVIVE_NOW = '2026-09-15T00:00:00.000Z'
  const STALE_BOUNDARY = '2026-08-28T00:00:00.000Z' // in the past relative to REVIVE_NOW, with a KILL receipt on file

  it('clears the stale elapsed boundary + stalled=1; the breaker does not re-kill and recommit succeeds on the new boundary', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-revive-boundary', goal: 'Revive with a stale boundary' })
      grantSquadAccess(harness, 'proj-revive-boundary', 'admin')
      insertAgent(harness, 'agent-revive-boundary')

      // Simulate the project's state from BEFORE it was archived: a stale,
      // already-elapsed boundary, stalled=1, and a receipted KILL decision on
      // that exact boundary (exactly what the breaker leaves behind).
      harness.sqlite.exec(`
        UPDATE projects SET cycle_boundary_at = '${STALE_BOUNDARY}', stalled = 1
         WHERE id = 'proj-revive-boundary'
      `)
      await recordRecommitOrKill(
        env,
        {
          projectId: 'proj-revive-boundary',
          boundaryAt: STALE_BOUNDARY,
          decision: 'kill',
          principal: 'system:project-loop',
          reason: 'cycle_boundary_no_recommit',
        },
        writeReceiptToD1,
      )

      const deps = makeDeps({ nowIso: () => REVIVE_NOW })
      const result = await startProject(env, 'proj-revive-boundary', deps)
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const row = harness.sqlite.prepare(
        `SELECT cycle_boundary_at, stalled, status FROM projects WHERE id = ?`,
      ).get('proj-revive-boundary') as { cycle_boundary_at: string | null; stalled: number; status: string }
      expect(row.status).toBe('active')
      expect(row.stalled).toBe(0)
      expect(row.cycle_boundary_at).not.toBeNull()
      expect(Date.parse(row.cycle_boundary_at!)).toBeGreaterThan(Date.parse(REVIVE_NOW))
      // Exact value: the pure now+interval calc, matching what production uses.
      expect(row.cycle_boundary_at).toBe(nextCycleBoundary(REVIVE_NOW, null, DEFAULT_CYCLE_DAYS))
      expect(result.project.cycle_boundary_at).toBe(row.cycle_boundary_at)
      expect(result.project.stalled).toBe(0)

      // The breaker, ticking right now, must NOT re-kill: boundary is in the
      // future and stalled is cleared.
      const outcome = await evaluateProjectCircuitBreaker(
        env,
        { id: 'proj-revive-boundary', status: 'active', cycle_boundary_at: row.cycle_boundary_at, stalled: 0 },
        REVIVE_NOW,
        defaultCircuitBreakerDeps(),
      )
      expect(outcome).toBe('skipped')

      // The OLD kill receipt (on the stale boundary) still exists and is
      // untouched — recommit only ever reads the CURRENT boundary's receipt.
      const oldKillStillOnFile = await env.DB.prepare(
        `SELECT 1 FROM workflow_receipts WHERE instance_id = ? AND step_name = 'recommit_or_kill'`,
      ).bind(cycleInstanceId('proj-revive-boundary', STALE_BOUNDARY)).first()
      expect(oldKillStillOnFile).toBeTruthy()

      // project_recommit on the NEW boundary succeeds — it is no longer
      // shadowed by the old already_decided kill.
      const recommit = await proposeProjectRecommit(
        env,
        'proj-revive-boundary',
        'external-reviewer',
        'still worth doing',
        writeReceiptToD1,
      )
      expect(recommit).toMatchObject({ ok: true })
    } finally {
      harness.close()
    }
  })
})

describe('ghost-start alarm', () => {
  it('escalates stale planned projects with no provision attempt to org owners', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-ghost', created_at: STALE_CREATED })
      // No squad access / no start attempt → pure ghost.

      const outcome = await evaluateGhostStartAlarm(
        env,
        { id: 'proj-ghost', status: 'planned', created_at: STALE_CREATED },
        NOW,
        defaultGhostStartDeps(),
      )
      expect(outcome).toBe('alarmed')

      const receipt = harness.sqlite.prepare(
        `SELECT detail FROM workflow_receipts
          WHERE instance_id = ? AND step_name = ?`,
      ).get(ghostInstanceId('proj-ghost'), GHOST_START_ALARM_STEP) as { detail: string }
      expect(JSON.parse(receipt.detail)).toMatchObject({
        schema: GHOST_START_ALARM_SCHEMA,
        project_id: 'proj-ghost',
        owner_member_ids: ['owner-1'],
        reason: 'stale_planned_no_provision_attempt',
      })

      // Idempotent — second evaluation does not duplicate.
      const again = await evaluateGhostStartAlarm(
        env,
        { id: 'proj-ghost', status: 'planned', created_at: STALE_CREATED },
        NOW,
        defaultGhostStartDeps(),
      )
      expect(again).toBe('already_alarmed')
    } finally {
      harness.close()
    }
  })

  it('skips ghost alarm when a provision attempt (blocked-start) already exists', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-tried', created_at: STALE_CREATED })
      grantSquadAccess(harness, 'proj-tried')
      // No agent → start fails with blocked-start (a real provision attempt).
      const blocked = await startProject(env, 'proj-tried', makeDeps())
      expect(blocked).toMatchObject({ ok: false, error: 'no_squad_agent' })

      const outcome = await evaluateGhostStartAlarm(
        env,
        { id: 'proj-tried', status: 'planned', created_at: STALE_CREATED },
        NOW,
        defaultGhostStartDeps(),
      )
      expect(outcome).toBe('skipped')
      const ghost = harness.sqlite.prepare(
        `SELECT 1 AS ok FROM workflow_receipts
          WHERE instance_id = ? AND step_name = ?`,
      ).get(ghostInstanceId('proj-tried'), GHOST_START_ALARM_STEP)
      expect(ghost).toBeUndefined()
    } finally {
      harness.close()
    }
  })

  it('runProjectLoopTick raises ghost_alarmed for stale planned ghosts', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      insertPlannedProject(harness, { id: 'proj-loop-ghost', created_at: STALE_CREATED })
      const tick = await runProjectLoopTick(env, {
        nowIso: () => NOW,
        ghostDeps: {
          ...defaultGhostStartDeps(),
          ghostThresholdDays: DEFAULT_GHOST_START_DAYS,
        },
      })
      expect(tick.ok).toBe(true)
      expect(tick.ghost_alarmed).toBe(1)
      expect(Date.parse(STALE_CREATED)).toBeLessThan(Date.parse(ghostCutoffIso(NOW, DEFAULT_GHOST_START_DAYS)))
    } finally {
      harness.close()
    }
  })
})
