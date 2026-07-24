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
    upsertActiveAgentCapabilityGrant: vi.fn(async () => ({ result: 'created' as const })),
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
          upsertActiveAgentCapabilityGrant: async () => ({ result: 'created' }),
        },
      )
      expect(result).toEqual({ kind: 'minted', memberId: 'mem', tokenId: 'tok' })
      expect(mint).toHaveBeenCalledTimes(1)
    } finally {
      harness.close()
    }
  })

  it('confirms via upsertActiveAgentCapabilityGrant when already welded', async () => {
    const harness = makeHarness()
    const env = envFor(harness)
    try {
      const upsert = vi.fn(async () => ({ result: 'unchanged' as const }))
      const result = await commitSquadResource(
        env,
        { id: 'agent-a', squad_id: 'squad-a', slug: 'agent-a', name: 'Agent A' },
        {
          mintAgentBoundToken: async () => ({ tokenId: 'tok', memberId: 'mem' }),
          resolveActiveAgentMember: async () => 'mem-existing',
          upsertActiveAgentCapabilityGrant: upsert,
        },
      )
      expect(result).toEqual({ kind: 'confirmed', memberId: 'mem-existing', tokenId: null })
      expect(upsert).toHaveBeenCalledWith(env, expect.objectContaining({
        agentId: 'agent-a',
        expectedMemberId: 'mem-existing',
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
          upsertActiveAgentCapabilityGrant: async () => ({ result: 'created' }),
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
