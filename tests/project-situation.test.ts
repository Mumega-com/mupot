import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProjectSituation } from '../src/projects/situation'
import type { Env, Project, ProjectStatus } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES
      ('dept-a', 'dept-a', 'Department A'),
      ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-a', 'dept-a', 'squad-a', 'Squad A'),
      ('squad-b', 'dept-b', 'squad-b', 'Squad B');
    INSERT INTO agents (id, squad_id, slug, name) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent A'),
      ('agent-b', 'squad-b', 'agent-b', 'Agent B');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: 'pot-a' } as Env
}

function statementProbe(database: Env['DB']): {
  db: Env['DB']
  statements: Array<{ sql: string; values: unknown[] }>
} {
  const statements: Array<{ sql: string; values: unknown[] }> = []
  type Statement = ReturnType<Env['DB']['prepare']>

  const wrap = (statement: Statement, sql: string, values: unknown[] = []): Statement => ({
    bind(...nextValues: unknown[]) {
      return wrap(statement.bind(...nextValues), sql, nextValues)
    },
    async all<T>() {
      statements.push({ sql, values })
      return statement.all<T>()
    },
  }) as Statement

  return {
    db: {
      prepare(sql: string) {
        return wrap(database.prepare(sql), sql)
      },
    } as Env['DB'],
    statements,
  }
}

function insertProject(harness: SqliteD1Harness, id: string, status: ProjectStatus = 'active'): Project {
  harness.sqlite.prepare(
    'INSERT INTO projects (id, slug, name, status) VALUES (?, ?, ?, ?)',
  ).run(id, id, `Project ${id}`, status)
  harness.sqlite.prepare(`
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
    VALUES (?, 'squad-a', 'write'), (?, 'squad-b', 'write')
  `).run(id, id)
  return harness.sqlite.prepare(
    `SELECT id, slug, name, description, goal, status, parent_project_id,
            target_date, created_at, updated_at
       FROM projects WHERE id = ?`,
  ).get(id) as unknown as Project
}

function insertTask(
  harness: SqliteD1Harness,
  projectId: string,
  input: {
    id: string
    squadId?: string
    title?: string
    status: 'open' | 'in_progress' | 'blocked' | 'review' | 'done'
    updatedAt?: string
    result?: string | null
    gateOwner?: string | null
  },
): void {
  harness.sqlite.prepare(`
    INSERT INTO tasks (
      id, squad_id, title, status, assignee_agent_id, result, gate_owner,
      project_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.squadId ?? 'squad-a',
    input.title ?? input.id,
    input.status,
    input.squadId === 'squad-b' ? 'agent-b' : 'agent-a',
    input.result ?? null,
    input.gateOwner ?? null,
    projectId,
    input.updatedAt ?? '2026-07-19T01:00:00Z',
    input.updatedAt ?? '2026-07-19T01:00:00Z',
  )
}

function flightMeta(squadIds: string[], taskIds: string[]): string {
  return JSON.stringify({
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal',
    objective_id: 'objective',
    squad_ids: squadIds,
    task_ids: taskIds,
    done_when: ['Done'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  })
}

function insertFlight(
  harness: SqliteD1Harness,
  projectId: string,
  input: { id: string; squadIds: string[]; taskIds: string[]; goal?: string; meta?: string },
): void {
  harness.sqlite.prepare(`
    INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
    VALUES (?, 'pot-a', 'agent-a', ?, 'running', ?, ?, ?)
  `).run(
    input.id,
    input.goal ?? input.id,
    projectId,
    Date.parse('2026-07-19T02:00:00Z'),
    input.meta ?? flightMeta(input.squadIds, input.taskIds),
  )
}

function insertRoutine(
  harness: SqliteD1Harness,
  projectId: string,
  input: {
    id: string
    tenant?: string
    squadId?: string
    status?: 'draft' | 'enabled' | 'paused' | 'archived'
    nextRunAt?: string | null
    name?: string
  },
): void {
  const status = input.status ?? 'enabled'
  const createdAt = '2026-07-19T01:00:00.000Z'
  harness.sqlite.prepare(`
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
      timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
      budget_micro_usd, max_attempts, retry_backoff_seconds, revision, enabled_by,
      enabled_at, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Advance Project work', ?, 'cron', '* * * * *', 'America/Toronto',
      ?, 'skip', 'propose', ?, 1000, 3, 300, 1, ?, ?, 'member-a', ?, ?)
  `).run(
    input.id, input.tenant ?? 'pot-a', projectId, input.name ?? input.id, status,
    input.nextRunAt ?? null, input.squadId ?? 'squad-a',
    status === 'enabled' ? 'member-a' : null, status === 'enabled' ? createdAt : null,
    createdAt, createdAt,
  )
}

function insertRoutineRun(
  harness: SqliteD1Harness,
  projectId: string,
  input: {
    id: string
    routineId: string
    status: 'queued' | 'leased' | 'observing' | 'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
    waitingReason?: 'agent' | 'approval' | 'answer' | 'review' | 'budget' | null
    assignedAgentId?: string | null
    resultSummary?: string | null
    costMicroUsd?: number
    occurredAt?: string
  },
): void {
  const occurredAt = input.occurredAt ?? '2026-07-19T02:00:00.000Z'
  harness.sqlite.prepare(`
    INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
      trigger_kind, status, waiting_reason, assigned_agent_id, result_summary, cost_micro_usd,
      scheduled_for, started_at, finished_at, created_at, updated_at
    ) VALUES (?, 'pot-a', ?, ?, 1, '{}', ?, 'cron', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id, projectId, input.routineId, `cron:${input.id}`, input.status,
    input.waitingReason ?? null, input.assignedAgentId ?? null, input.resultSummary ?? null,
    input.costMicroUsd ?? 0, occurredAt,
    ['running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled'].includes(input.status) ? occurredAt : null,
    ['succeeded', 'failed', 'skipped', 'cancelled'].includes(input.status) ? occurredAt : null,
    occurredAt, occurredAt,
  )
}

describe('loadProjectSituation', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('derives blocker health while reviewing a pending item first', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'priority')
    insertTask(harness, project.id, {
      id: 'blocked', status: 'blocked', title: 'Restore delivery', result: 'provider_token=hidden-value',
    })
    insertTask(harness, project.id, { id: 'review', status: 'review', title: 'Review release', gateOwner: 'lead' })
    insertTask(harness, project.id, { id: 'working', status: 'in_progress', title: 'Continue rollout' })
    insertTask(harness, project.id, { id: 'open', status: 'open', title: 'Start follow-up' })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      health: 'blocked',
      summary: expect.any(String),
      blockers: [{ id: 'blocked', title: 'Restore delivery', status: 'blocked' }],
      pending_reviews: [{ id: 'review', title: 'Review release', status: 'review', gate_owner: 'lead' }],
      task_counts: { blocked: 1, review: 1, in_progress: 1, open: 1 },
      task_counts_truncated: {
        blocked: false, review: false, in_progress: false, open: false, overall: false,
      },
      active_work_count: 4,
      active_work_count_truncated: false,
      active_flight_count: 0,
      active_flight_count_truncated: false,
      blocker_details_truncated: false,
      pending_review_details_truncated: false,
      snapshot_truncated: false,
      next_action: { type: 'address_needs_you', item: { source_type: 'task', source_id: 'review', urgency: 'urgent' } },
    })
    expect(JSON.stringify(situation)).not.toContain('hidden-value')
  })

  it('derives review health when no blocker is readable', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'review-only')
    insertTask(harness, project.id, { id: 'review', status: 'review' })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.health).toBe('review')
    expect(situation.active_work_count).toBe(1)
    expect(situation.next_action).toMatchObject({ type: 'review_task', task: { id: 'review' } })
  })

  it('continues in-progress work before open work and an active flight', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'active-work')
    insertTask(harness, project.id, { id: 'open', status: 'open' })
    insertTask(harness, project.id, { id: 'working', status: 'in_progress' })
    insertFlight(harness, project.id, { id: 'flight', squadIds: ['squad-a'], taskIds: ['working'] })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      health: 'active',
      active_work_count: 2,
      active_flight_count: 1,
      next_action: { type: 'continue_task', task: { id: 'working' } },
    })
    expect(situation.latest_activity).not.toBeNull()
  })

  it('can exclude a Routine own control Task and Flight from its business Situation', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'routine-snapshot')
    insertTask(harness, project.id, { id: 'business-task', status: 'open', updatedAt: '2026-07-19T01:00:00Z' })
    insertTask(harness, project.id, { id: 'control-task', status: 'in_progress', updatedAt: '2026-07-19T03:00:00Z' })
    insertFlight(harness, project.id, { id: 'control-flight', squadIds: ['squad-a'], taskIds: ['control-task'] })

    const situation = await loadProjectSituation(envFor(harness), project, null, {
      excludeTaskIds: ['control-task'],
      excludeFlightIds: ['control-flight'],
    })

    expect(situation).toMatchObject({
      task_counts: { open: 1, in_progress: 0 },
      active_work_count: 1,
      active_flight_count: 0,
      latest_activity: { source_type: 'task', source_id: 'business-task' },
      next_action: { type: 'start_task', task: { id: 'business-task' } },
    })
  })

  it('summarizes readable Routine state and principal-neutral Needs You without exposing raw run state', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'routine-summary')
    insertRoutine(harness, project.id, { id: 'enabled', nextRunAt: '2026-07-20T13:00:00.000Z', name: 'Daily triage' })
    insertRoutine(harness, project.id, { id: 'paused', status: 'paused', name: 'Paused cleanup' })
    insertRoutineRun(harness, project.id, {
      id: 'waiting-budget', routineId: 'enabled', status: 'waiting', waitingReason: 'budget', assignedAgentId: 'agent-a',
    })
    insertRoutineRun(harness, project.id, {
      id: 'succeeded', routineId: 'enabled', status: 'succeeded', resultSummary: 'token=private-value; completed', costMicroUsd: 12345,
      occurredAt: '2026-07-19T04:00:00.000Z',
    })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      routines: {
        enabled_count: 1,
        paused_count: 1,
        next: { id: 'enabled', name: 'Daily triage', next_run_at: '2026-07-20T13:00:00.000Z', timezone: 'America/Toronto' },
        active_run: { id: 'waiting-budget', status: 'waiting', waiting_reason: 'budget', responsible_squad_id: 'squad-a' },
        latest_terminal_run: { id: 'succeeded', status: 'succeeded', cost_micro_usd: 12345, result_summary: expect.stringContaining('[redacted]') },
        truncated: false,
      },
      needs_you: {
        count: 1,
        highest_priority: { source_type: 'routine_run', source_id: 'waiting-budget', urgency: 'urgent' },
        truncated: false,
      },
      next_action: { type: 'address_needs_you', item: { source_id: 'waiting-budget' } },
    })
    expect(JSON.stringify(situation)).not.toContain('private-value')
  })

  it('uses Routine action priority after urgent attention and before Project work, then falls through to the next enabled occurrence', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'routine-priority')
    insertRoutine(harness, project.id, { id: 'routine', nextRunAt: '2026-07-20T13:00:00.000Z' })
    insertRoutineRun(harness, project.id, { id: 'waiting-agent', routineId: 'routine', status: 'waiting', waitingReason: 'agent' })
    insertTask(harness, project.id, { id: 'review', status: 'review' })
    insertTask(harness, project.id, { id: 'working', status: 'in_progress' })
    expect((await loadProjectSituation(envFor(harness), project, null)).next_action).toMatchObject({ type: 'resolve_routine_wait' })

    harness.sqlite.prepare("UPDATE routine_runs SET status = 'succeeded', waiting_reason = NULL WHERE id = 'waiting-agent'").run()
    expect((await loadProjectSituation(envFor(harness), project, null)).next_action).toMatchObject({ type: 'review_task', task: { id: 'review' } })

    harness.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 'review'").run()
    expect((await loadProjectSituation(envFor(harness), project, null)).next_action).toMatchObject({ type: 'continue_task', task: { id: 'working' } })

    harness.sqlite.prepare("UPDATE tasks SET status = 'done' WHERE id = 'working'").run()
    expect((await loadProjectSituation(envFor(harness), project, null)).next_action).toMatchObject({ type: 'run_routine', routine: { id: 'routine' } })

    insertRoutineRun(harness, project.id, { id: 'urgent-budget', routineId: 'routine', status: 'waiting', waitingReason: 'budget' })
    expect((await loadProjectSituation(envFor(harness), project, null)).next_action).toMatchObject({ type: 'address_needs_you', item: { source_id: 'urgent-budget' } })
  })

  it('keeps Routine and Needs You summaries tenant, Project, and squad scoped', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'routine-isolation')
    const otherProject = insertProject(harness, 'routine-other-project')
    insertRoutine(harness, project.id, { id: 'visible-routine', squadId: 'squad-a', nextRunAt: '2026-07-20T13:00:00.000Z' })
    insertRoutine(harness, project.id, { id: 'hidden-routine', squadId: 'squad-b', nextRunAt: '2026-07-20T12:00:00.000Z', name: 'Private routine' })
    insertRoutine(harness, otherProject.id, { id: 'other-project-routine', nextRunAt: '2026-07-20T11:00:00.000Z' })
    insertRoutine(harness, project.id, { id: 'other-tenant-routine', tenant: 'pot-b', nextRunAt: '2026-07-20T10:00:00.000Z' })
    insertRoutineRun(harness, project.id, { id: 'visible-wait', routineId: 'visible-routine', status: 'waiting', waitingReason: 'agent' })
    insertRoutineRun(harness, project.id, { id: 'hidden-wait', routineId: 'hidden-routine', status: 'waiting', waitingReason: 'budget' })

    const scoped = await loadProjectSituation(envFor(harness), project, ['squad-a'])
    expect(scoped.routines).toMatchObject({ enabled_count: 1, next: { id: 'visible-routine' }, active_run: { id: 'visible-wait' } })
    expect(scoped.needs_you).toMatchObject({ count: 1, highest_priority: { source_id: 'visible-wait' } })
    expect(JSON.stringify(scoped)).not.toContain('Private routine')
  })

  it('uses matching keyset indexes for Routine Situation ordering without source sorts', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'routine-situation-plans')
    insertRoutine(harness, project.id, { id: 'routine', nextRunAt: '2026-07-20T12:00:00.000Z' })
    insertRoutineRun(harness, project.id, {
      id: 'waiting', routineId: 'routine', status: 'waiting', waitingReason: 'budget',
    })
    insertRoutineRun(harness, project.id, {
      id: 'terminal', routineId: 'routine', status: 'succeeded', occurredAt: '2026-07-19T03:00:00.000Z',
    })
    const probe = statementProbe(harness.db)

    await loadProjectSituation({ DB: probe.db, TENANT_SLUG: 'pot-a' } as Env, project, null)

    const planFor = (fragment: string) => {
      const statement = probe.statements.find(candidate => candidate.sql.includes(fragment))
      expect(statement).toBeDefined()
      const plan = harness!.sqlite.prepare(`EXPLAIN QUERY PLAN ${statement!.sql}`).all(...statement!.values)
      return plan.map(row => String(row.detail ?? '')).join('\n')
    }
    for (const [fragment, index] of [
      ['idx_routines_project_next_occurrence', 'idx_routines_project_next_occurrence'],
      ['idx_routine_runs_project_active_keyset', 'idx_routine_runs_project_active_keyset'],
      ['idx_routine_runs_project_outcome_keyset', 'idx_routine_runs_project_outcome_keyset'],
      ['idx_routine_runs_project_needs_you_keyset', 'idx_routine_runs_project_needs_you_keyset'],
    ]) {
      const details = planFor(fragment)
      expect(details).toContain(`USING INDEX ${index}`)
      if (index === 'idx_routine_runs_project_needs_you_keyset') {
        const sourcePlan = details.slice(details.indexOf('CO-ROUTINE routine_waits'), details.indexOf('SCAN routine_waits'))
        expect(sourcePlan).not.toContain('USE TEMP B-TREE')
      } else {
        expect(details).not.toContain('USE TEMP B-TREE FOR ORDER BY')
      }
    }
  })

  it('keeps the earliest urgent Routine deadline when its source exceeds the Situation cap', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'needs-you-source-cap')
    insertRoutine(harness, project.id, { id: 'routine', nextRunAt: '2026-07-20T00:00:00.000Z' })
    for (let index = 0; index < 101; index += 1) {
      insertRoutineRun(harness, project.id, {
        id: `recent-budget-${index.toString().padStart(3, '0')}`,
        routineId: 'routine', status: 'waiting', waitingReason: 'budget',
        occurredAt: '2026-07-21T00:00:00.000Z',
      })
    }
    insertRoutineRun(harness, project.id, {
      id: 'earliest-budget', routineId: 'routine', status: 'waiting', waitingReason: 'budget',
      occurredAt: '2026-07-20T00:00:00.000Z',
    })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.needs_you.highest_priority).toMatchObject({
      source_id: 'earliest-budget', deadline_at: '2026-07-20T00:00:00.000Z', urgency: 'urgent',
    })
    expect(situation.next_action).toMatchObject({ type: 'address_needs_you', item: { source_id: 'earliest-budget' } })
  })

  it('retains the next scheduled Routine when enabled manual Routines exceed the Situation cap', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'routine-next-cap')
    for (let index = 0; index < 101; index += 1) {
      insertRoutine(harness, project.id, { id: `manual-${index.toString().padStart(3, '0')}`, nextRunAt: null })
    }
    insertRoutine(harness, project.id, {
      id: 'scheduled', name: 'Scheduled routine', nextRunAt: '2026-07-20T12:00:00.000Z',
    })

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.routines).toMatchObject({
      enabled_count: 100,
      enabled_count_truncated: true,
      next: { id: 'scheduled', next_run_at: '2026-07-20T12:00:00.000Z' },
    })
  })

  it('falls through from open work to flight monitoring', async () => {
    harness = makeHarness()
    const openProject = insertProject(harness, 'open-work')
    insertTask(harness, openProject.id, { id: 'open', status: 'open' })
    expect(await loadProjectSituation(envFor(harness), openProject, null)).toMatchObject({
      health: 'active', next_action: { type: 'start_task', task: { id: 'open' } },
    })

    const flightProject = insertProject(harness, 'flight-only')
    insertTask(harness, flightProject.id, { id: 'flight-task', status: 'done' })
    insertFlight(harness, flightProject.id, { id: 'flight', squadIds: ['squad-a'], taskIds: ['flight-task'] })
    expect(await loadProjectSituation(envFor(harness), flightProject, null)).toMatchObject({
      health: 'active', next_action: { type: 'monitor_flight', flight: { id: 'flight' } },
    })
  })

  it('ignores a malformed newest flight when deriving latest_activity for an unrestricted reader', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'canonical-activity')
    insertTask(harness, project.id, {
      id: 'canonical-task', status: 'done', updatedAt: '2026-07-19T01:00:00Z',
    })
    insertFlight(harness, project.id, {
      id: 'canonical-flight', squadIds: ['squad-a'], taskIds: ['canonical-task'],
    })
    harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
      VALUES ('malformed-newest', 'pot-a', 'agent-a', 'Malformed newest', 'running', ?, ?, ?)
    `).run(
      project.id,
      Date.parse('2026-07-19T03:00:00Z'),
      JSON.stringify({ schema: 'mupot.flight.meta/v0', squad_ids: ['squad-a'] }),
    )

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.latest_activity).toMatchObject({
      source_type: 'flight', source_id: 'canonical-flight',
    })
    expect(JSON.stringify(situation)).not.toContain('Malformed newest')
  })

  it('uses isolated health and action precedence for review, unblock, start, and lifecycle fallback', async () => {
    harness = makeHarness()

    const reviewProject = insertProject(harness, 'precedence-review')
    insertTask(harness, reviewProject.id, { id: 'review', status: 'review' })
    insertTask(harness, reviewProject.id, { id: 'review-working', status: 'in_progress' })
    expect(await loadProjectSituation(envFor(harness), reviewProject, null)).toMatchObject({
      health: 'review', next_action: { type: 'review_task', task: { id: 'review' } },
    })

    const blockedProject = insertProject(harness, 'precedence-blocked')
    insertTask(harness, blockedProject.id, { id: 'blocker', status: 'blocked' })
    insertTask(harness, blockedProject.id, { id: 'blocked-working', status: 'in_progress' })
    expect(await loadProjectSituation(envFor(harness), blockedProject, null)).toMatchObject({
      health: 'blocked', next_action: { type: 'unblock_task', task: { id: 'blocker' } },
    })

    const startProject = insertProject(harness, 'precedence-start')
    insertTask(harness, startProject.id, { id: 'start-open', status: 'open' })
    insertFlight(harness, startProject.id, {
      id: 'start-flight', squadIds: ['squad-a'], taskIds: ['start-open'],
    })
    expect(await loadProjectSituation(envFor(harness), startProject, null)).toMatchObject({
      health: 'active', next_action: { type: 'start_task', task: { id: 'start-open' } },
    })

    const pausedProject = insertProject(harness, 'precedence-paused')
    insertTask(harness, pausedProject.id, { id: 'paused-working', status: 'in_progress' })
    harness.sqlite.prepare("UPDATE projects SET status = 'paused' WHERE id = ?").run(pausedProject.id)
    const paused = { ...pausedProject, status: 'paused' as const }
    expect(await loadProjectSituation(envFor(harness), paused, null)).toMatchObject({
      health: 'paused', next_action: { type: 'continue_task', task: { id: 'paused-working' } },
    })
    harness.sqlite.prepare('DELETE FROM tasks WHERE project_id = ?').run(paused.id)
    expect(await loadProjectSituation(envFor(harness), paused, null)).toMatchObject({
      health: 'paused', next_action: { type: 'resume_project' },
    })
  })

  it.each([
    ['paused', 'paused', 'resume_project'],
    ['completed', 'completed', 'verify_completion'],
    ['archived', 'archived', 'reopen_project'],
  ] as const)('prioritizes %s lifecycle health', async (status, health, action) => {
    harness = makeHarness()
    const activeProject = insertProject(harness, `lifecycle-${status}`)
    const project = { ...activeProject, status }
    insertTask(harness, project.id, { id: `${status}-blocker`, status: 'blocked' })
    harness.sqlite.prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, project.id)

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation.health).toBe(health)
    expect(situation.next_action?.type).toBe('unblock_task')

    harness.sqlite.prepare('DELETE FROM tasks WHERE project_id = ?').run(project.id)
    expect((await loadProjectSituation(envFor(harness), project, null)).next_action?.type).toBe(action)
  })

  it('returns ready for empty projects and creates work only for an active project', async () => {
    harness = makeHarness()
    const active = insertProject(harness, 'empty-active', 'active')
    const planned = insertProject(harness, 'empty-planned', 'planned')

    expect(await loadProjectSituation(envFor(harness), active, null)).toMatchObject({
      health: 'ready',
      blockers: [],
      pending_reviews: [],
      active_work_count: 0,
      active_work_count_truncated: false,
      active_flight_count: 0,
      active_flight_count_truncated: false,
      blocker_details_truncated: false,
      pending_review_details_truncated: false,
      snapshot_truncated: false,
      latest_activity: null,
      next_action: { type: 'create_task' },
    })
    expect(await loadProjectSituation(envFor(harness), planned, null)).toMatchObject({
      health: 'ready', latest_activity: null, next_action: null,
    })
  })

  it('never derives health, counts, activity, or actions from unreadable squad rows', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'restricted')
    insertTask(harness, project.id, {
      id: 'visible-open', squadId: 'squad-a', status: 'open', updatedAt: '2026-07-19T01:00:00Z',
    })
    insertTask(harness, project.id, {
      id: 'hidden-blocker', squadId: 'squad-b', status: 'blocked', title: 'Private blocker',
      result: 'password=private-value', updatedAt: '2026-07-19T03:00:00Z',
    })
    insertTask(harness, project.id, {
      id: 'hidden-review', squadId: 'squad-b', status: 'review', title: 'Private review',
      updatedAt: '2026-07-19T04:00:00Z',
    })
    insertFlight(harness, project.id, { id: 'visible-flight', squadIds: ['squad-a'], taskIds: ['visible-open'] })
    insertFlight(harness, project.id, { id: 'hidden-flight', squadIds: ['squad-b'], taskIds: ['hidden-blocker'] })
    insertFlight(harness, project.id, {
      id: 'mixed-flight', squadIds: ['squad-a', 'squad-b'], taskIds: ['visible-open', 'hidden-blocker'],
    })
    insertFlight(harness, project.id, {
      id: 'malformed-flight', squadIds: ['squad-a'], taskIds: ['visible-open'], goal: 'Malformed private goal',
      meta: JSON.stringify({ schema: 'mupot.flight.meta/v0', squad_ids: ['squad-a'] }),
    })

    const scoped = await loadProjectSituation(envFor(harness), project, ['squad-a'])
    expect(scoped).toMatchObject({
      health: 'active',
      blockers: [],
      pending_reviews: [],
      active_work_count: 1,
      active_flight_count: 1,
      next_action: { type: 'start_task', task: { id: 'visible-open' } },
    })
    expect(JSON.stringify(scoped)).not.toMatch(/Private blocker|Private review|private-value|hidden-flight|mixed-flight|Malformed private goal/)

    const none = await loadProjectSituation(envFor(harness), project, [])
    expect(none).toMatchObject({
      health: 'ready', blockers: [], pending_reviews: [], active_work_count: 0,
      active_flight_count: 0, latest_activity: null, next_action: { type: 'create_task' },
    })
  })

  it('caps each task status and active-flight snapshot with explicit truncation truth', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'capped')
    for (const status of ['blocked', 'review', 'in_progress', 'open'] as const) {
      harness.sqlite.exec(`
        WITH RECURSIVE seq(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 100
        )
        INSERT INTO tasks (id, squad_id, title, status, project_id, created_at, updated_at)
        SELECT '${status}-' || printf('%03d', n), 'squad-a', '${status} ' || n, '${status}', '${project.id}',
               '2026-07-19T01:00:00Z', '2026-07-19T01:00:00Z'
          FROM seq;
      `)
    }
    insertTask(harness, project.id, { id: 'flight-task', status: 'done' })
    const insert = harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at, meta)
      VALUES (?, 'pot-a', 'agent-a', ?, 'running', ?, ?, ?)
    `)
    for (let index = 0; index < 101; index += 1) {
      insert.run(
        `flight-${index.toString().padStart(3, '0')}`,
        `Flight ${index}`,
        project.id,
        Date.parse('2026-07-19T02:00:00Z') + index,
        flightMeta(['squad-a'], ['flight-task']),
      )
    }

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      health: 'blocked',
      task_counts: { blocked: 100, review: 100, in_progress: 100, open: 100 },
      task_counts_truncated: {
        blocked: true, review: true, in_progress: true, open: true, overall: true,
      },
      active_work_count: 400,
      active_work_count_truncated: true,
      active_flight_count: 100,
      active_flight_count_truncated: true,
      blocker_details_truncated: true,
      pending_review_details_truncated: true,
      snapshot_truncated: true,
      next_action: { type: 'review_task', task: { id: 'review-000' } },
    })
    expect(situation.blockers).toHaveLength(20)
    expect(situation.pending_reviews).toHaveLength(20)
  })

  it('reports detail truncation at 21 rows without marking exact counts as truncated', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'detail-capped')
    for (const status of ['blocked', 'review'] as const) {
      harness.sqlite.exec(`
        WITH RECURSIVE seq(n) AS (
          VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 20
        )
        INSERT INTO tasks (id, squad_id, title, status, project_id, created_at, updated_at)
        SELECT 'detail-${status}-' || printf('%02d', n), 'squad-a', '${status} ' || n, '${status}', '${project.id}',
               '2026-07-19T01:00:00Z', '2026-07-19T01:00:00Z'
          FROM seq;
      `)
    }

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      task_counts: { blocked: 21, review: 21, in_progress: 0, open: 0 },
      task_counts_truncated: {
        blocked: false, review: false, in_progress: false, open: false, overall: false,
      },
      active_work_count: 42,
      active_work_count_truncated: false,
      blocker_details_truncated: true,
      pending_review_details_truncated: true,
      snapshot_truncated: true,
    })
    expect(situation.blockers).toHaveLength(20)
    expect(situation.pending_reviews).toHaveLength(20)
  })

  it('caps Routine and Needs You summaries with explicit active and terminal truncation truth', async () => {
    harness = makeHarness()
    const project = insertProject(harness, 'routine-capped')
    harness.sqlite.exec(`
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 100
      )
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, timezone,
        overlap_policy, execution_mode, responsible_squad_id, budget_micro_usd,
        max_attempts, retry_backoff_seconds, revision, enabled_by, enabled_at, created_by, created_at, updated_at
      )
      SELECT 'enabled-' || printf('%03d', n), 'pot-a', '${project.id}', 'Enabled ' || n, 'Advance', 'enabled', 'manual', 'UTC',
             'skip', 'propose', 'squad-a', 1000, 3, 300, 1, 'member-a', '2026-07-19T01:00:00Z', 'member-a', '2026-07-19T01:00:00Z', '2026-07-19T01:00:00Z'
        FROM seq;
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 100
      )
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, timezone,
        overlap_policy, execution_mode, responsible_squad_id, budget_micro_usd,
        max_attempts, retry_backoff_seconds, revision, created_by, created_at, updated_at
      )
      SELECT 'paused-' || printf('%03d', n), 'pot-a', '${project.id}', 'Paused ' || n, 'Advance', 'paused', 'manual', 'UTC',
             'skip', 'propose', 'squad-a', 1000, 3, 300, 1, 'member-a', '2026-07-19T01:00:00Z', '2026-07-19T01:00:00Z'
        FROM seq;
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 100
      )
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, status, waiting_reason, created_at, updated_at
      )
      SELECT 'active-' || printf('%03d', n), 'pot-a', '${project.id}', 'enabled-000', 1, '{}', 'active:' || n,
             'manual', 'waiting', 'agent', '2026-07-19T02:00:00Z', '2026-07-19T02:00:00Z'
        FROM seq;
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 100
      )
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, status, result_summary, cost_micro_usd, finished_at, created_at, updated_at
      )
      SELECT 'terminal-' || printf('%03d', n), 'pot-a', '${project.id}', 'enabled-000', 1, '{}', 'terminal:' || n,
             'manual', 'succeeded', 'completed', n, '2026-07-19T03:00:00Z', '2026-07-19T03:00:00Z', '2026-07-19T03:00:00Z'
        FROM seq;
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 100
      )
      INSERT INTO tasks (id, squad_id, title, status, gate_owner, project_id, created_at, updated_at)
      SELECT 'attention-' || printf('%03d', n), 'squad-a', 'Approval ' || n, 'review', 'gate:delivery', '${project.id}',
             '2026-07-19T04:00:00Z', '2026-07-19T04:00:00Z'
        FROM seq;
    `)

    const situation = await loadProjectSituation(envFor(harness), project, null)

    expect(situation).toMatchObject({
      routines: {
        enabled_count: 100,
        paused_count: 100,
        enabled_count_truncated: true,
        paused_count_truncated: true,
        active_run_truncated: true,
        latest_terminal_run_truncated: true,
        truncated: true,
      },
      needs_you: { count: 100, truncated: true },
    })
  })
})
