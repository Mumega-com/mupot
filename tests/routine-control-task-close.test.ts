// 11e2a810 — close the control board task on DEAD routine end states (close-only).
// Final scope cut (PR #2425): no review→rejected walk; keep assignee; attempt-keyed
// close only; unconfirmed cancel stays blocked; KPI counts every done task except failed:/cancelled:/unclaimed: results.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskCounterSource } from '../src/agents/kpi-sources'
import { loadAgentStats } from '../src/dashboard/observatory'
import { cancelRoutineRun, submitRoutineProposal } from '../src/routines/actions'
import {
  closeRoutineControlTask,
  controlTaskOutcome,
} from '../src/routines/control-task'
import { dispatchRoutineRun } from '../src/routines/dispatch'
import { routineControlId } from '../src/routines/identity'
import { recoverExpiredRoutineLeases } from '../src/routines/scheduler'
import type { RoutinePrincipal } from '../src/routines/access'
import type { Agent, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { makeReadyRoutineFixture } from './helpers/routine-actions'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const NOW = new Date('2026-07-19T16:00:00.000Z')

function applyMigrations(harness: SqliteD1Harness): void {
  applyAllMigrations(harness.sqlite)
}

function row(harness: SqliteD1Harness, sql: string, ...binds: unknown[]): Record<string, unknown> | undefined {
  return harness.sqlite.prepare(sql).get(...binds) as Record<string, unknown> | undefined
}

describe('routine control task close (11e2a810, close-only)', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('closes the control task as done with succeeded on a successful end', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    const result = await submitRoutineProposal(fixture.env, fixture.principal, fixture.proposal({
      key: 'none-ok', kind: 'no_action', input: { reason: 'Nothing to do.' },
    }))
    expect(result).toMatchObject({ ok: true, status: 'succeeded' })
    expect(row(fixture.harness, "SELECT status, result, gate_owner, assignee_agent_id FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'done', result: 'succeeded', gate_owner: null, assignee_agent_id: 'agent-1',
    })
  })

  it('closes the control task as done with failed outcome on execution failure', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    fixture.harness.sqlite.prepare("UPDATE routine_runs SET attempt = 3 WHERE id = 'run-1'").run()
    const db = fixture.env.DB
    const failingEnv = {
      ...fixture.env,
      DB: {
        prepare(sql: string) {
          if (/INSERT INTO flights/.test(sql)) {
            return {
              bind() { return this },
              async run() { throw new Error('simulated flight execution failure') },
            }
          }
          return db.prepare(sql)
        },
        batch: db.batch.bind(db),
      },
    } as unknown as Env

    const result = await submitRoutineProposal(failingEnv, fixture.principal, fixture.proposal({
      key: 'flight-throws', kind: 'dispatch_flight',
      input: { goal: 'Throw during dispatch', task_ids: ['control-task'], artifact_refs: [], budget_micro_usd: 1000 },
    }))
    expect(result).toEqual({ ok: false, error: 'action_failed' })
    expect(row(fixture.harness, "SELECT status, result, assignee_agent_id FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'done', result: 'failed: execution_failed', assignee_agent_id: 'agent-1',
    })
  })

  it('closes as cancelled: operator on confirmed cancel; unconfirmed stays blocked (main)', async () => {
    const fixture = await makeReadyRoutineFixture('execute_internal')
    harness = fixture.harness
    fixture.harness.sqlite.exec(`
      UPDATE flights SET status = 'failed', gate_reason = 'already_stopped', ended_at = 1752940900000
       WHERE id = 'control-flight';
    `)
    const administrator: RoutinePrincipal = {
      ...fixture.principal, actor_type: 'member', actor_id: 'owner-1', workspace_admin: true,
      project_read: { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] },
    }
    await expect(cancelRoutineRun(fixture.env, administrator, 'run-1')).resolves.toMatchObject({
      ok: true, outcome: 'confirmed',
    })
    expect(row(fixture.harness, "SELECT status, result, assignee_agent_id FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'done', result: 'cancelled: operator', assignee_agent_id: 'agent-1',
    })

    const unconfirmed = await makeReadyRoutineFixture('execute_internal')
    harness = unconfirmed.harness
    await expect(cancelRoutineRun(unconfirmed.env, administrator, 'run-1')).resolves.toMatchObject({
      ok: true, outcome: 'unconfirmed',
    })
    // Main: blocked, not closed — external work may still be running.
    expect(row(unconfirmed.harness, "SELECT status, result FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'blocked', result: null,
    })
  })

  it('leaves a human-gated review task alone (gate:hadi) and only records the run outcome', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, gate_owner,
        assignee_agent_id, created_at, updated_at
      ) VALUES (
        'human-gated', 'squad-1', 'project-1', 'Routine: human gate', '', 'Done', 'review',
        'gate:hadi', 'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    await expect(closeRoutineControlTask(
      env,
      { task_id: 'human-gated', project_id: 'project-1' },
      controlTaskOutcome('failed', 'lease_expired'),
    )).resolves.toBe(true)
    expect(row(harness, "SELECT status, gate_owner, result, assignee_agent_id FROM tasks WHERE id = 'human-gated'")).toEqual({
      status: 'review', gate_owner: 'gate:hadi', result: null, assignee_agent_id: 'agent-1',
    })
  })

  it('leaves a gate:routines review task alone (no review→rejected→done walk)', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, gate_owner,
        assignee_agent_id, created_at, updated_at
      ) VALUES (
        'routine-gated', 'squad-1', 'project-1', 'Routine: gated', '', 'Done', 'review',
        'gate:routines', 'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    const outcome = controlTaskOutcome('failed', 'operator_cancel')
    await expect(closeRoutineControlTask(
      env, { task_id: 'routine-gated', project_id: 'project-1' }, outcome,
    )).resolves.toBe(true)
    expect(row(harness, "SELECT status, result, gate_owner, assignee_agent_id FROM tasks WHERE id = 'routine-gated'")).toEqual({
      status: 'review', result: null, gate_owner: 'gate:routines', assignee_agent_id: 'agent-1',
    })
  })

  it('is idempotent on a second close of an already-done task', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, result,
        assignee_agent_id, created_at, updated_at, completed_at
      ) VALUES (
        'already-done', 'squad-1', 'project-1', 'Routine: done', '', 'Done', 'done',
        'failed: first', 'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    await expect(closeRoutineControlTask(
      env, { task_id: 'already-done', project_id: 'project-1' }, controlTaskOutcome('succeeded'),
    )).resolves.toBe(true)
    expect(row(harness, "SELECT status, result FROM tasks WHERE id = 'already-done'")).toEqual({
      status: 'done', result: 'failed: first',
    })
  })

  it('closes a control task on lease recovery; failed keeps assignee; KPI done=0 task_count=1', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    const taskId = await routineControlId('task', 'run-lease:1')
    const recent = new Date().toISOString()
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status, kpi_target)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active', '10 tasks');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        '${taskId}', 'squad-1', 'project-1', 'Routine: lease', '', 'Done', 'in_progress',
        'agent-1', '${recent}', '${recent}'
      );
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
        timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
        preferred_agent_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
        revision, enabled_by, enabled_at, created_by, created_at, updated_at
      ) VALUES (
        'routine-1', 'tenant-a', 'project-1', 'Lease check', 'Advance', 'enabled', 'cron', '* * * * *',
        'UTC', '2026-07-19T16:00:00.000Z', 'skip', 'propose', 'squad-1',
        'agent-1', 100000, 1, 30, 1, 'owner-1', '${NOW.toISOString()}',
        'owner-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, lease_owner, lease_expires_at, attempt,
        task_id, created_at, updated_at
      ) VALUES (
        'run-lease', 'tenant-a', 'project-1', 'routine-1', 1,
        '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":"agent-1","budget_micro_usd":100000,"max_attempts":1,"retry_backoff_seconds":30}',
        'cron:2026-07-19T16:00:00[UTC]', 'cron', '${NOW.toISOString()}', 'observing',
        'scheduler-1', '2026-07-19T15:00:00.000Z', 1, '${taskId}',
        '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    const recovered = await recoverExpiredRoutineLeases(env, NOW)
    expect(recovered).toBe(1)
    expect(row(harness, "SELECT status, result_summary, task_id FROM routine_runs WHERE id = 'run-lease'")).toEqual({
      status: 'failed', result_summary: 'retry_exhausted', task_id: taskId,
    })
    expect(row(harness, 'SELECT status, result, assignee_agent_id FROM tasks WHERE id = ?', taskId)).toEqual({
      status: 'done', result: 'failed: lease_expired', assignee_agent_id: 'agent-1',
    })
    const agent = row(harness, "SELECT id, kpi_target FROM agents WHERE id = 'agent-1'") as unknown as Agent
    const kpi = await taskCounterSource(env, agent)
    expect(kpi).toMatchObject({ ok: true, count: 0, source: 'task_counter' })
    const stats = await loadAgentStats(env)
    expect(stats.get('agent-1')).toMatchObject({ task_count: 1, done_count: 0 })
  })

  it('counts a succeeded close in KPI done_count while keeping assignee', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    const recent = new Date().toISOString()
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status, kpi_target)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active', '10 tasks');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        'ok-task', 'squad-1', 'project-1', 'Routine: ok', '', 'Done', 'in_progress',
        'agent-1', '${recent}', '${recent}'
      );
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    await expect(closeRoutineControlTask(
      env, { task_id: 'ok-task', project_id: 'project-1' }, controlTaskOutcome('succeeded'),
    )).resolves.toBe(true)
    expect(row(harness, "SELECT status, result, assignee_agent_id FROM tasks WHERE id = 'ok-task'")).toEqual({
      status: 'done', result: 'succeeded', assignee_agent_id: 'agent-1',
    })
    const agent = row(harness, "SELECT id, kpi_target FROM agents WHERE id = 'agent-1'") as unknown as Agent
    const kpi = await taskCounterSource(env, agent)
    expect(kpi).toMatchObject({ ok: true, count: 1, source: 'task_counter' })
    const stats = await loadAgentStats(env)
    expect(stats.get('agent-1')).toMatchObject({ task_count: 1, done_count: 1 })
  })

  it('credits every ordinary done task and excludes only failed:/cancelled:/unclaimed: closes (KPI source, observatory)', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    const recent = new Date().toISOString()
    const doneTask = (id: string, result: string | null): string => `
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, result, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        '${id}', 'squad-1', 'project-1', 'T ${id}', '', 'Done', 'done', ${result === null ? 'NULL' : `'${result}'`},
        'agent-1', '${recent}', '${recent}'
      );`
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status, kpi_target)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active', '10 tasks');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      ${doneTask('t-free', 'Merged PR #123 and deployed')}
      ${doneTask('t-null', null)}
      ${doneTask('t-ok', 'succeeded')}
      ${doneTask('t-failed', 'failed: lease_expired')}
      ${doneTask('t-cancelled', 'cancelled: operator')}
      ${doneTask('t-unclaimed', 'unclaimed: agent_offline')}
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    const agent = row(harness, "SELECT id, kpi_target FROM agents WHERE id = 'agent-1'") as unknown as Agent
    const kpi = await taskCounterSource(env, agent)
    expect(kpi).toMatchObject({ ok: true, count: 3, source: 'task_counter' })
    const stats = await loadAgentStats(env)
    expect(stats.get('agent-1')).toMatchObject({ task_count: 6, done_count: 3 })
  })

  it.todo('loop.ts counter uses the shared failure predicate: needs a real-schema write path, see #2427')

  it('closes the control task as unclaimed when attempts are exhausted while keeping the specific run cause', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    const taskId = await routineControlId('task', 'run-u1:1')
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-1', 'agent-1', 'squad-1', 'member');
      INSERT INTO members (id, display_name, status, tenant)
        VALUES ('member-1', 'Worker', 'active', 'tenant-a');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-1', 'member-1', '${NOW.toISOString()}');
      INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
        VALUES ('token-1', 'member-1', 'hash-1', 'worker', 'workspace', '${NOW.toISOString()}', NULL, 'agent-1', 'tenant-a');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-1', 'member-1', 'squad', 'squad-1', 'member');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        '${taskId}', 'squad-1', 'project-1', 'Routine: unclaimed', '', 'Done', 'open',
        'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
        timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
        preferred_agent_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
        revision, enabled_by, enabled_at, created_by, created_at, updated_at
      ) VALUES (
        'routine-1', 'tenant-a', 'project-1', 'Pickup', 'Advance', 'enabled', 'cron', '* * * * *',
        'UTC', '2026-07-19T16:00:00.000Z', 'skip', 'propose', 'squad-1',
        'agent-1', 100000, 1, 30, 1, 'owner-1', '${NOW.toISOString()}',
        'owner-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, lease_owner, lease_expires_at, attempt,
        task_id, created_at, updated_at
      ) VALUES (
        'run-u1', 'tenant-a', 'project-1', 'routine-1', 1,
        '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":"agent-1","budget_micro_usd":100000,"max_attempts":1,"retry_backoff_seconds":30}',
        'cron:2026-07-19T16:00:00[UTC]', 'cron', '${NOW.toISOString()}', 'leased',
        'scheduler-1', '2026-07-19T16:05:00.000Z', 1, '${taskId}',
        '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = {
      DB: harness.db, TENANT_SLUG: 'tenant-a', PUBLIC_ORIGIN: 'https://mupot.example',
      BUS: { send: vi.fn(async () => undefined) },
    } as unknown as Env

    const result = await dispatchRoutineRun(env, 'run-u1', NOW)
    expect(result).toEqual({ ok: true, status: 'waiting', reason: 'agent', run_id: 'run-u1' })
    expect(row(harness, "SELECT status, waiting_reason, result_summary, task_id FROM routine_runs WHERE id = 'run-u1'")).toEqual({
      status: 'waiting', waiting_reason: 'agent', result_summary: 'agent_offline', task_id: taskId,
    })
    expect(row(harness, 'SELECT status, result, assignee_agent_id FROM tasks WHERE id = ?', taskId)).toEqual({
      status: 'done', result: 'unclaimed: agent_offline', assignee_agent_id: 'agent-1',
    })
  })

  it('does not close a pause-release orphan when a later attempt fails before minting', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    const orphanId = await routineControlId('task', 'run-pause:1')
    const attempt2Id = await routineControlId('task', 'run-pause:2')
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO memberships (id, agent_id, squad_id, capability)
        VALUES ('membership-1', 'agent-1', 'squad-1', 'member');
      INSERT INTO members (id, display_name, status, tenant)
        VALUES ('member-1', 'Worker', 'active', 'tenant-a');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('tenant-a', 'agent-1', 'member-1', '${NOW.toISOString()}');
      INSERT INTO member_tokens
        (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
        VALUES ('token-1', 'member-1', 'hash-1', 'worker', 'workspace', '${NOW.toISOString()}', NULL, 'agent-1', 'tenant-a');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-1', 'member-1', 'squad', 'squad-1', 'member');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      -- Attempt-1 pause orphan stays blocked; run.task_id still points at it.
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, result, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        '${orphanId}', 'squad-1', 'project-1', 'Routine: paused orphan', '', 'Done', 'blocked',
        'execution_paused: routine dispatch refused by an execution pause; task released',
        NULL, '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
        timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
        preferred_agent_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
        revision, enabled_by, enabled_at, created_by, created_at, updated_at
      ) VALUES (
        'routine-1', 'tenant-a', 'project-1', 'Pause retry', 'Advance', 'enabled', 'cron', '* * * * *',
        'UTC', '2026-07-19T16:00:00.000Z', 'skip', 'propose', 'squad-1',
        'agent-1', 100000, 3, 30, 1, 'owner-1', '${NOW.toISOString()}',
        'owner-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, lease_owner, lease_expires_at, attempt,
        task_id, created_at, updated_at
      ) VALUES (
        'run-pause', 'tenant-a', 'project-1', 'routine-1', 1,
        '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":"agent-1","budget_micro_usd":100000,"max_attempts":3,"retry_backoff_seconds":30}',
        'cron:2026-07-19T16:00:00[UTC]', 'cron', '${NOW.toISOString()}', 'leased',
        'scheduler-1', '2026-07-19T16:05:00.000Z', 2, '${orphanId}',
        '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = {
      DB: harness.db, TENANT_SLUG: 'tenant-a', PUBLIC_ORIGIN: 'https://mupot.example',
      BUS: { send: vi.fn(async () => undefined) },
    } as unknown as Env

    // Agent offline on attempt 2 before a new task is minted → must NOT close the orphan.
    const result = await dispatchRoutineRun(env, 'run-pause', NOW)
    expect(result).toMatchObject({ ok: true, status: 'retry_scheduled', run_id: 'run-pause' })
    expect(row(harness, 'SELECT status, result FROM tasks WHERE id = ?', orphanId)).toEqual({
      status: 'blocked',
      result: 'execution_paused: routine dispatch refused by an execution pause; task released',
    })
    expect(row(harness, 'SELECT id FROM tasks WHERE id = ?', attempt2Id)).toBeUndefined()
  })

  it('refuses to close an archived open task (archive guard on result write / persist)', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO members (id, display_name, status, tenant)
        VALUES ('owner-1', 'Owner', 'active', 'tenant-a');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        'archived-open', 'squad-1', 'project-1', 'Routine: archived', '', 'Done', 'in_progress',
        'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
        VALUES ('archived-open', '${NOW.toISOString()}', 'test', 'owner-1', 'in_progress');
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    await expect(closeRoutineControlTask(
      env, { task_id: 'archived-open', project_id: 'project-1' }, controlTaskOutcome('failed', 'lease_expired'),
    )).resolves.toBe(true)
    expect(row(harness, "SELECT status, result FROM tasks WHERE id = 'archived-open'")).toEqual({
      status: 'in_progress', result: null,
    })
  })

  it('close after transition: a failing recovery batch leaves the task open', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    const taskId = await routineControlId('task', 'run-race:1')
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        '${taskId}', 'squad-1', 'project-1', 'Routine: race', '', 'Done', 'in_progress',
        'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO routines (
        id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
        timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
        preferred_agent_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
        revision, enabled_by, enabled_at, created_by, created_at, updated_at
      ) VALUES (
        'routine-1', 'tenant-a', 'project-1', 'Race', 'Advance', 'enabled', 'cron', '* * * * *',
        'UTC', '2026-07-19T16:00:00.000Z', 'skip', 'propose', 'squad-1',
        'agent-1', 100000, 1, 30, 1, 'owner-1', '${NOW.toISOString()}',
        'owner-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, lease_owner, lease_expires_at, attempt,
        task_id, created_at, updated_at
      ) VALUES (
        'run-race', 'tenant-a', 'project-1', 'routine-1', 1,
        '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":"agent-1","budget_micro_usd":100000,"max_attempts":1,"retry_backoff_seconds":30}',
        'cron:2026-07-19T16:00:00[UTC]', 'cron', '${NOW.toISOString()}', 'observing',
        'scheduler-1', '2026-07-19T15:00:00.000Z', 1, '${taskId}',
        '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const realDb = harness.db
    let batchCalls = 0
    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: {
        prepare: realDb.prepare.bind(realDb),
        async batch(stmts: unknown[]) {
          batchCalls++
          // First recovery batch: pretend zero changes (raced observe→running).
          if (batchCalls === 1) {
            return stmts.map(() => ({ meta: { changes: 0 } }))
          }
          return realDb.batch(stmts as Parameters<typeof realDb.batch>[0])
        },
      },
    } as unknown as Env
    const recovered = await recoverExpiredRoutineLeases(env, NOW)
    expect(recovered).toBe(0)
    expect(row(harness, 'SELECT status, result FROM tasks WHERE id = ?', taskId)).toEqual({
      status: 'in_progress', result: null,
    })
    expect(row(harness, "SELECT status FROM routine_runs WHERE id = 'run-race'")).toEqual({
      status: 'observing',
    })
  })

  it('updated_at fence: a concurrent human edit blocks the close write', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        'fenced', 'squad-1', 'project-1', 'Routine: fenced', '', 'Done', 'in_progress',
        'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const realDb = harness.db
    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: {
        prepare(sql: string) {
          const stmt = realDb.prepare(sql)
          if (/UPDATE tasks\s+SET title/.test(sql) || (/UPDATE tasks/.test(sql) && /updated_at = \?/.test(sql) && /status = \?/.test(sql))) {
            return {
              bind(...args: unknown[]) {
                // Human edits the row between read and write.
                harness!.sqlite.prepare(
                  "UPDATE tasks SET title = 'human-edited', updated_at = ? WHERE id = 'fenced'",
                ).run(new Date(NOW.getTime() + 1000).toISOString())
                return stmt.bind(...args)
              },
              run: stmt.run.bind(stmt),
              first: stmt.first.bind(stmt),
              all: stmt.all.bind(stmt),
            }
          }
          return stmt
        },
        batch: realDb.batch.bind(realDb),
      },
    } as unknown as Env
    await closeRoutineControlTask(
      env, { task_id: 'fenced', project_id: 'project-1' }, controlTaskOutcome('failed', 'lease_expired'),
    )
    const t = row(harness, "SELECT status, title, result FROM tasks WHERE id = 'fenced'")
    // Either still in_progress (fence refused) or done only if the raced reload succeeded —
    // never a silent overwrite of the human title without a fresh fence.
    expect(t?.title === 'human-edited' || t?.status === 'done').toBe(true)
    if (t?.status !== 'done') {
      expect(t).toMatchObject({ status: 'in_progress', title: 'human-edited', result: null })
    }
  })

  it('project check: close refuses a task owned by another project', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES
        ('project-1', 'project-1', 'P', 'active'),
        ('project-2', 'project-2', 'Q', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write'), ('project-2', 'squad-1', 'write');
      INSERT INTO tasks (
        id, squad_id, project_id, title, body, done_when, status, assignee_agent_id,
        created_at, updated_at
      ) VALUES (
        'other-proj', 'squad-1', 'project-2', 'Routine: other', '', 'Done', 'in_progress',
        'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    await expect(closeRoutineControlTask(
      env, { task_id: 'other-proj', project_id: 'project-1' }, controlTaskOutcome('failed', 'x'),
    )).resolves.toBe(false)
    expect(row(harness, "SELECT status FROM tasks WHERE id = 'other-proj'")).toEqual({ status: 'in_progress' })
  })
})
