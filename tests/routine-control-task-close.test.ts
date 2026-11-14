// 11e2a810 — close the control board task on every routine end state (close-only).
// Auto-pause after unclaimed runs is deferred (mupot#2424).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskCounterSource } from '../src/agents/kpi-sources'
import { cancelRoutineRun, submitRoutineProposal } from '../src/routines/actions'
import {
  closeRoutineControlTask,
  controlTaskOutcome,
} from '../src/routines/control-task'
import { dispatchRoutineRun } from '../src/routines/dispatch'
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
      status: 'done', result: 'failed: execution_failed', assignee_agent_id: null,
    })
  })

  it('closes as cancelled: operator on confirmed cancel, and failed: cancellation_unconfirmed otherwise', async () => {
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
    expect(row(fixture.harness, "SELECT status, result FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'done', result: 'cancelled: operator',
    })

    const unconfirmed = await makeReadyRoutineFixture('execute_internal')
    harness = unconfirmed.harness
    await expect(cancelRoutineRun(unconfirmed.env, administrator, 'run-1')).resolves.toMatchObject({
      ok: true, outcome: 'unconfirmed',
    })
    expect(row(unconfirmed.harness, "SELECT status, result FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'done', result: 'failed: cancellation_unconfirmed',
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
    )).resolves.toBe(false)
    expect(row(harness, "SELECT status, gate_owner, result, assignee_agent_id FROM tasks WHERE id = 'human-gated'")).toEqual({
      status: 'review', gate_owner: 'gate:hadi', result: null, assignee_agent_id: 'agent-1',
    })
  })

  it('clears only gate:routines when closing, and is idempotent on a second close', async () => {
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
      status: 'done', result: 'failed: operator_cancel', gate_owner: null, assignee_agent_id: null,
    })
    await expect(closeRoutineControlTask(
      env, { task_id: 'routine-gated', project_id: 'project-1' }, controlTaskOutcome('succeeded'),
    )).resolves.toBe(true)
    // Second close is a no-op: does not overwrite a non-empty result.
    expect(row(harness, "SELECT status, result FROM tasks WHERE id = 'routine-gated'")).toEqual({
      status: 'done', result: 'failed: operator_cancel',
    })
  })

  it('closes a control task on lease recovery and does not credit the agent KPI done count', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
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
        'lease-task', 'squad-1', 'project-1', 'Routine: lease', '', 'Done', 'in_progress',
        'agent-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
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
        'scheduler-1', '2026-07-19T15:00:00.000Z', 1, 'lease-task',
        '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    const recovered = await recoverExpiredRoutineLeases(env, NOW)
    expect(recovered).toBe(1)
    expect(row(harness, "SELECT status, result_summary, task_id FROM routine_runs WHERE id = 'run-lease'")).toEqual({
      status: 'failed', result_summary: 'retry_exhausted', task_id: 'lease-task',
    })
    expect(row(harness, "SELECT status, result, assignee_agent_id FROM tasks WHERE id = 'lease-task'")).toEqual({
      status: 'done', result: 'failed: lease_expired', assignee_agent_id: null,
    })
    const agent = row(harness, "SELECT id, kpi_target FROM agents WHERE id = 'agent-1'") as unknown as Agent
    const kpi = await taskCounterSource(env, agent)
    expect(kpi).toMatchObject({ ok: true, count: 0, source: 'task_counter' })
  })

  it('closes the control task as unclaimed when attempts are exhausted while keeping the specific run cause', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
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
        'unclaimed-task', 'squad-1', 'project-1', 'Routine: unclaimed', '', 'Done', 'open',
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
        'scheduler-1', '2026-07-19T16:05:00.000Z', 1, 'unclaimed-task',
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
      status: 'waiting', waiting_reason: 'agent', result_summary: 'agent_offline', task_id: 'unclaimed-task',
    })
    expect(row(harness, "SELECT status, result FROM tasks WHERE id = 'unclaimed-task'")).toEqual({
      status: 'done', result: 'unclaimed: agent_offline',
    })
  })
})
