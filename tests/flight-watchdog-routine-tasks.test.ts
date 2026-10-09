// Routine control work has two durable parts: its flight and its task.  A watchdog
// failure must not leave the latter claiming that the routine is still executing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reapStalledFlight } from '../src/flight/watchdog'
import { routineControlId } from '../src/routines/identity'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'digid'
const T0 = 1_000_000
const STALLED_NOW = T0 + 70 * 60_000
const NOW_ISO = new Date(STALLED_NOW).toISOString()
const WATCHDOG = { actor: { kind: 'system' as const, id: 'mupot-watchdog' } }

let h: SqliteD1Harness
let env: Env

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad', 'dept', 'squad', 'Squad');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent', 'squad', 'agent', 'Agent', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project', 'project', 'Project', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project', 'squad', 'write');
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, cron_expression, timezone,
      overlap_policy, execution_mode, responsible_squad_id, budget_micro_usd, max_attempts,
      retry_backoff_seconds, revision, enabled_by, enabled_at, created_by, created_at, updated_at
    ) VALUES (
      'routine', '${TENANT}', 'project', 'Routine', 'Observe', 'enabled', 'cron', '* * * * *', 'UTC',
      'skip', 'propose', 'squad', 100, 3, 300, 1, 'system', '${NOW_ISO}', 'system', '${NOW_ISO}', '${NOW_ISO}'
    );
  `)
})

afterEach(() => h.close())

async function seedRoutineAttempt(input: {
  runId?: string
  attempt?: number
  taskId?: string
  taskStatus?: string
  runStatus?: string
  flightId?: string
  taskProject?: string
  flightProject?: string
} = {}): Promise<{ runId: string; attempt: number; taskId: string; flightId: string }> {
  const runId = input.runId ?? 'run'
  const attempt = input.attempt ?? 1
  const taskId = input.taskId ?? await routineControlId('task', `${runId}:${attempt}`)
  const flightId = input.flightId ?? 'flight'
  const taskProject = input.taskProject ?? 'project'
  const flightProject = input.flightProject ?? 'project'
  h.sqlite.prepare(
    `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
     VALUES (?, 'squad', ?, 'Routine control', 'body', 'proposal accepted', ?, 'agent', ?, ?)`,
  ).run(taskId, taskProject, input.taskStatus ?? 'in_progress', NOW_ISO, NOW_ISO)
  h.sqlite.prepare(
    `INSERT INTO flights (
      id, tenant, agent, dispatched_by_agent_id, project_id, goal, status, trigger_source,
      gate_verdict, gate_reason, score, budget_micro_usd, cost_micro_usd, created_at, started_at, meta
    ) VALUES (?, ?, 'agent', 'dispatcher', ?, 'Routine', 'running', 'schedule',
      'go', '', 1, 100, 0, ?, ?, ?)`,
  ).run(
    flightId, TENANT, flightProject, T0, T0,
    JSON.stringify({
      schema: 'mupot.flight.meta/v1', goal_id: 'routine', objective_id: runId,
      squad_ids: ['squad'], task_ids: [taskId], done_when: ['proposal accepted'],
      artifact_refs: [], receipt_refs: [], confidentiality: 'internal', publication_target: 'none',
      parent_flight_id: null, routine_run_id: runId, routine_revision: 1,
    }),
  )
  h.sqlite.prepare(
    `INSERT INTO routine_runs (
      id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key, trigger_kind,
      status, attempt, assigned_agent_id, task_id, flight_id, created_at, updated_at
    ) VALUES (?, ?, 'project', 'routine', 1, ?, ?, 'cron', ?, ?, 'agent', ?, ?, ?, ?)`,
  ).run(
    runId, TENANT, JSON.stringify({ responsible_squad_id: 'squad' }), `manual:${runId}`,
    input.runStatus ?? 'running', attempt, taskId, flightId, NOW_ISO, NOW_ISO,
  )
  return { runId, attempt, taskId, flightId }
}

function task(id: string): Record<string, unknown> {
  return h.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>
}

describe('reapStalledFlight routine-control task reconciliation', () => {
  it('blocks the exact live routine control task with flight-correlated failure evidence', async () => {
    const { runId, taskId, flightId } = await seedRoutineAttempt()
    h.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
       VALUES ('unrelated', 'squad', 'project', 'Other', 'body', 'done', 'in_progress', 'agent', ?, ?)`,
    ).run(NOW_ISO, NOW_ISO)

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(taskId)).toMatchObject({ status: 'blocked' })
    expect(String(task(taskId).result)).toContain('watchdog_reap: executor timed out')
    expect(String(task(taskId).result)).toContain(flightId)
    expect(task('unrelated')).toMatchObject({ status: 'in_progress' })
    expect(h.sqlite.prepare('SELECT status, result_summary FROM routine_runs WHERE id = ?').get(runId))
      .toMatchObject({ status: 'failed', result_summary: 'watchdog_reap: executor timed out' })
    expect(h.sqlite.prepare(
      `SELECT principal_kind, principal_id, flight_id, task_id, evidence_json
         FROM mutation_audit_entries WHERE task_id = ?`,
    ).get(taskId)).toMatchObject({
      principal_kind: 'system', principal_id: 'mupot-watchdog', flight_id: flightId, task_id: taskId,
    })
  })

  it.each(['open', 'blocked', 'review', 'approved', 'rejected', 'done'])(
    'leaves a %s control task untouched',
    async (taskStatus) => {
      const { taskId, flightId } = await seedRoutineAttempt({ taskStatus })

      const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

      expect(result.transitioned).toBe(true)
      expect(task(taskId)).toMatchObject({ status: taskStatus, result: null })
      expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
    },
  )

  it('does not block a previous-attempt task if a run points to it after retry', async () => {
    const oldTaskId = await routineControlId('task', 'run:1')
    const { flightId } = await seedRoutineAttempt({ attempt: 2, taskId: oldTaskId })

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(oldTaskId)).toMatchObject({ status: 'in_progress', result: null })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(oldTaskId)).toHaveLength(0)
  })

  it('preserves a task that already has result or active runtime custody', async () => {
    const { taskId, flightId } = await seedRoutineAttempt()
    h.sqlite.prepare(
      `UPDATE tasks SET result = 'executor result pending reconciliation', execution_claim_expires_at = ? WHERE id = ?`,
    ).run('2026-10-09T01:00:00.000Z', taskId)

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(taskId)).toMatchObject({
      status: 'in_progress', result: 'executor result pending reconciliation',
      execution_claim_expires_at: '2026-10-09T01:00:00.000Z',
    })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
  })

  it('preserves a task with an execution receipt pointer', async () => {
    const { taskId, flightId } = await seedRoutineAttempt()
    h.sqlite.prepare("UPDATE tasks SET execution_receipt_id = 'prior-dispatch' WHERE id = ?").run(taskId)

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(taskId)).toMatchObject({ status: 'in_progress', execution_receipt_id: 'prior-dispatch' })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
  })

  it.each([
    ['squad reassignment', (taskId: string) => {
      h.sqlite.exec(`
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-2', 'dept', 'squad-2', 'Squad 2');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project', 'squad-2', 'write');
      `)
      h.sqlite.prepare("UPDATE tasks SET squad_id = 'squad-2' WHERE id = ?").run(taskId)
    }],
    ['assignee reassignment', (taskId: string) => {
      h.sqlite.prepare('UPDATE tasks SET assignee_agent_id = NULL WHERE id = ?').run(taskId)
    }],
  ])('preserves a control task after %s', async (_name, mutate) => {
    const { taskId, flightId } = await seedRoutineAttempt()
    mutate(taskId)

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(taskId)).toMatchObject({ status: 'in_progress', result: null })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
  })

  it('preserves a task whose project differs from its routine run', async () => {
    h.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status) VALUES ('project-2', 'project-2', 'Project 2', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-2', 'squad', 'write');
    `)
    const { taskId, flightId } = await seedRoutineAttempt({ taskProject: 'project-2', flightProject: 'project-2' })

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(taskId)).toMatchObject({ status: 'in_progress', result: null, project_id: 'project-2' })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
  })

  it('preserves an archived routine task', async () => {
    const { taskId, flightId } = await seedRoutineAttempt()
    h.sqlite.exec(`INSERT INTO members (id, tenant, email, display_name, status)
      VALUES ('archiver', '${TENANT}', 'archiver@example.test', 'Archiver', 'active')`)
    h.sqlite.prepare(
      `INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
       VALUES (?, ?, 'operator archived task', 'archiver', 'in_progress', ?)`,
    ).run(taskId, NOW_ISO, NOW_ISO)

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(taskId)).toMatchObject({ status: 'in_progress', result: null })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
  })

  it('does not touch the task when the run transition loses a race', async () => {
    const { runId, taskId, flightId } = await seedRoutineAttempt()
    const prepare = env.DB.prepare.bind(env.DB)
    let raced = false
    env.DB.prepare = ((sql: string) => {
      if (!raced && sql.includes('UPDATE routine_runs') && sql.includes("SET status = 'failed'")) {
        raced = true
        h.sqlite.prepare(
          "UPDATE routine_runs SET status = 'failed', result_summary = 'other winner', finished_at = ?, updated_at = ? WHERE id = ?",
        ).run(NOW_ISO, NOW_ISO, runId)
      }
      return prepare(sql)
    }) as typeof env.DB.prepare

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result.transitioned).toBe(true)
    expect(task(taskId)).toMatchObject({ status: 'in_progress', result: null })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
  })

  it('does not touch the task when the guarded flight transition loses a race', async () => {
    const { taskId, flightId } = await seedRoutineAttempt()
    const prepare = env.DB.prepare.bind(env.DB)
    let raced = false
    env.DB.prepare = ((sql: string) => {
      if (!raced && sql.includes('UPDATE flights') && sql.includes('RETURNING id, status')) {
        raced = true
        h.sqlite.prepare("UPDATE flights SET status = 'failed', gate_reason = 'earlier winner', ended_at = ? WHERE id = ?").run(STALLED_NOW, flightId)
      }
      return prepare(sql)
    }) as typeof env.DB.prepare

    const result = await reapStalledFlight(env, flightId, WATCHDOG, 'executor timed out', STALLED_NOW)

    expect(result).toMatchObject({ transitioned: false, error: 'transition_race_or_already_terminal' })
    expect(task(taskId)).toMatchObject({ status: 'in_progress', result: null })
    expect(h.sqlite.prepare('SELECT * FROM mutation_audit_entries WHERE task_id = ?').all(taskId)).toHaveLength(0)
  })
})
