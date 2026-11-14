// 11e2a810 — control tasks close on every end; pause after N unclaimed runs.
//
// These assertions go red if close-on-end or pause-after-unclaimed is dropped.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { invokeTool } from '../src/mcp'
import { cancelRoutineRun, submitRoutineProposal } from '../src/routines/actions'
import {
  UNCLAIMED_PAUSE_THRESHOLD,
  closeRoutineControlTask,
  controlTaskOutcome,
  maybePauseAfterUnclaimedRuns,
} from '../src/routines/control-task'
import { dispatchRoutineRun } from '../src/routines/dispatch'
import { runRoutineScheduler } from '../src/routines/scheduler'
import type { RoutinePrincipal } from '../src/routines/access'
import type { AuthContext, CapabilityGrant, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { makeReadyRoutineFixture } from './helpers/routine-actions'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const NOW = new Date('2026-07-19T16:00:00.000Z')

function applyMigrations(harness: SqliteD1Harness): void {
  applyAllMigrations(harness.sqlite)
}

function sessions() {
  const entries = new Map<string, string>()
  return {
    get: async <T>(key: string, type?: 'json') => {
      const value = entries.get(key) ?? null
      return type === 'json' && value ? JSON.parse(value) as T : value as T | null
    },
    put: async (key: string, value: string) => { entries.set(key, value) },
    delete: async (key: string) => { entries.delete(key) },
  }
}

function grant(capability: CapabilityGrant['capability'], scope_id: string | null = 'squad-1'): CapabilityGrant {
  return { member_id: 'owner-1', capability, scope_id, scope_type: scope_id ? 'squad' : 'org' }
}

function adminAuth(): AuthContext {
  return {
    userId: 'owner-1', memberId: 'owner-1', email: null, role: 'member', tenant: 'tenant-a',
    channel: 'workspace', boundAgentId: null,
    capabilities: [grant('admin', null)],
  }
}

function row(harness: SqliteD1Harness, sql: string, ...binds: unknown[]): Record<string, unknown> | undefined {
  return harness.sqlite.prepare(sql).get(...binds)
}

function seedUnclaimedWorld(harness: SqliteD1Harness): void {
  applyMigrations(harness)
  // Eligible agent exists, but no live fleet runtime — every dispatch ends unclaimed.
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name, status)
      VALUES ('agent-1', 'squad-1', 'agent-1', 'Agent One', 'active');
    INSERT INTO memberships (id, agent_id, squad_id, capability)
      VALUES ('membership-1', 'agent-1', 'squad-1', 'member');
    INSERT INTO members (id, display_name, status, tenant)
      VALUES ('owner-1', 'Owner', 'active', 'tenant-a'),
             ('member-1', 'Worker', 'active', 'tenant-a');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('tenant-a', 'agent-1', 'member-1', '${NOW.toISOString()}');
    INSERT INTO member_tokens
      (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant)
      VALUES ('token-1', 'member-1', 'hash-1', 'worker', 'workspace', '${NOW.toISOString()}', NULL, 'agent-1', 'tenant-a');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-owner', 'owner-1', 'org', NULL, 'admin'),
      ('cap-worker', 'member-1', 'squad', 'squad-1', 'member');
    INSERT INTO projects (id, slug, name, goal, status)
      VALUES ('project-1', 'project-1', 'Project One', 'Ship', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-1', 'squad-1', 'write');
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind, cron_expression,
      timezone, next_run_at, overlap_policy, execution_mode, responsible_squad_id,
      preferred_agent_id, budget_micro_usd, max_attempts, retry_backoff_seconds,
      revision, enabled_by, enabled_at, created_by, created_at, updated_at
    ) VALUES (
      'routine-1', 'tenant-a', 'project-1', 'Pickup check',
      'Advance work when a worker is live', 'enabled', 'cron', '* * * * *',
      'UTC', '2026-07-19T16:00:00.000Z', 'skip', 'propose', 'squad-1',
      'agent-1', 100000, 1, 30, 1, 'owner-1', '${NOW.toISOString()}',
      'owner-1', '${NOW.toISOString()}', '${NOW.toISOString()}'
    );
  `)
}

describe('routine control task close + unclaimed pause (11e2a810)', () => {
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
    expect(row(fixture.harness, "SELECT status, result, gate_owner FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'done', result: 'succeeded', gate_owner: null,
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
    expect(row(fixture.harness, "SELECT status, result FROM tasks WHERE id = 'control-task'")).toEqual({
      status: 'done', result: 'failed: execution_failed',
    })
  })

  it('closes the control task as done with cancelled outcome on operator cancel', async () => {
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
      status: 'done', result: 'cancelled: Routine cancelled by operator.',
    })
  })

  it('closes a control task as done with skipped outcome without leaving board clutter', async () => {
    harness = createSqliteD1()
    applyMigrations(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'P', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-1', 'squad-1', 'write');
      INSERT INTO tasks (id, squad_id, project_id, title, body, done_when, status, created_at, updated_at)
        VALUES ('skip-task', 'squad-1', 'project-1', 'Routine: leftover', '', 'Done', 'in_progress',
                '${NOW.toISOString()}', '${NOW.toISOString()}');
    `)
    const env = { DB: harness.db, TENANT_SLUG: 'tenant-a' } as unknown as Env
    await expect(closeRoutineControlTask(
      env,
      { task_id: 'skip-task', project_id: 'project-1' },
      controlTaskOutcome('skipped', 'routine_policy_changed'),
    )).resolves.toBe(true)
    expect(row(harness, "SELECT status, result, gate_owner FROM tasks WHERE id = 'skip-task'")).toEqual({
      status: 'done', result: 'skipped: routine_policy_changed', gate_owner: null,
    })
  })

  it('ends an unclaimed run as skipped and never leaves an open control task', async () => {
    harness = createSqliteD1()
    seedUnclaimedWorld(harness)
    // leased run, no live fleet → unclaimed
    harness.sqlite.exec(`
      INSERT INTO routine_runs (
        id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
        trigger_kind, scheduled_for, status, lease_owner, lease_expires_at, attempt,
        created_at, updated_at
      ) VALUES (
        'run-u1', 'tenant-a', 'project-1', 'routine-1', 1,
        '{"execution_mode":"propose","overlap_policy":"skip","responsible_squad_id":"squad-1","preferred_agent_id":"agent-1","budget_micro_usd":100000,"max_attempts":1,"retry_backoff_seconds":30}',
        'cron:2026-07-19T16:00:00[UTC]', 'cron', '${NOW.toISOString()}', 'leased',
        'scheduler-1', '2026-07-19T16:05:00.000Z', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
    `)
    const env = {
      DB: harness.db, TENANT_SLUG: 'tenant-a', PUBLIC_ORIGIN: 'https://mupot.example',
      BUS: { send: vi.fn(async () => undefined) },
    } as unknown as Env

    const result = await dispatchRoutineRun(env, 'run-u1', NOW)
    expect(result).toEqual({ ok: true, status: 'skipped', reason: 'unclaimed', run_id: 'run-u1' })
    expect(row(harness, "SELECT status, result_summary FROM routine_runs WHERE id = 'run-u1'")).toEqual({
      status: 'skipped', result_summary: 'unclaimed',
    })
    expect(row(harness, "SELECT COUNT(*) AS count FROM tasks WHERE status IN ('open','in_progress','blocked','review')")).toEqual({
      count: 0,
    })
  })

  it('pauses after three unclaimed runs with at most one open needs-you notice, and closes it on enable', async () => {
    harness = createSqliteD1()
    seedUnclaimedWorld(harness)
    const env = {
      DB: harness.db,
      TENANT_SLUG: 'tenant-a',
      PUBLIC_ORIGIN: 'https://mupot.example',
      SESSIONS: sessions(),
      BUS: { send: vi.fn(async () => undefined) },
    } as unknown as Env

    for (let index = 0; index < UNCLAIMED_PAUSE_THRESHOLD; index++) {
      const scheduled = new Date(NOW.getTime() + index * 60_000)
      harness.sqlite.prepare(
        `UPDATE routines SET next_run_at = ?, status = 'enabled' WHERE id = 'routine-1'`,
      ).run(scheduled.toISOString())
      await runRoutineScheduler(env, scheduled, `worker-${index}`, async (runId) => {
        const result = await dispatchRoutineRun(env, runId, scheduled)
        if (!result.ok) throw new Error(result.error)
      })
    }

    expect(row(harness, "SELECT status FROM routines WHERE id = 'routine-1'")).toEqual({ status: 'paused' })
    expect(row(harness, `
      SELECT COUNT(*) AS count FROM routine_runs
       WHERE routine_id = 'routine-1' AND status = 'skipped' AND result_summary = 'unclaimed'
    `)).toEqual({ count: UNCLAIMED_PAUSE_THRESHOLD })
    expect(row(harness, `
      SELECT COUNT(*) AS count FROM tasks
       WHERE project_id = 'project-1' AND status IN ('open','in_progress','review')
    `)).toEqual({ count: 0 })
    const openNotices = row(harness, `
      SELECT COUNT(*) AS count FROM tasks
       WHERE project_id = 'project-1' AND status = 'blocked' AND gate_owner = 'gate:routines'
         AND assignee_agent_id IS NULL AND title LIKE 'Routine paused:%'
    `)
    expect(openNotices).toEqual({ count: 1 })

    // Idempotent: another pause tick must not open a second notice.
    await maybePauseAfterUnclaimedRuns(env, 'routine-1')
    expect(row(harness, `
      SELECT COUNT(*) AS count FROM tasks
       WHERE project_id = 'project-1' AND status = 'blocked' AND gate_owner = 'gate:routines'
         AND assignee_agent_id IS NULL AND title LIKE 'Routine paused:%'
    `)).toEqual({ count: 1 })

    const enabled = await invokeTool(
      adminAuth(),
      env,
      'routine_enable',
      { routine_id: 'routine-1' },
      'https://pot.test',
    )
    expect(enabled).toMatchObject({ ok: true })
    expect(row(harness, "SELECT status FROM routines WHERE id = 'routine-1'")).toEqual({ status: 'enabled' })
    expect(row(harness, `
      SELECT COUNT(*) AS count FROM tasks
       WHERE project_id = 'project-1' AND status = 'blocked' AND title LIKE 'Routine paused:%'
    `)).toEqual({ count: 0 })
    expect(row(harness, `
      SELECT status, result FROM tasks
       WHERE project_id = 'project-1' AND title LIKE 'Routine paused:%'
    `)).toEqual({ status: 'done', result: 'routine_resumed' })
  })
})
