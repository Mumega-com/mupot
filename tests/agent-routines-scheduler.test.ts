// tests/agent-routines-scheduler.test.ts — real-schema coverage for the autonomous scheduler.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { evaluateAndDispatchDueRoutines } from '../src/routines/cron-scheduler'
import { routineOccurrenceKey } from '../src/routines/schedule'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

describe('Autonomous Agent Cron Routine Scheduler (Flight 9)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let pastIso: string

  beforeEach(() => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    pastIso = new Date(Date.now() - 1_000).toISOString()
    harness.sqlite.prepare(
      `INSERT INTO departments (id, slug, name) VALUES ('dept_gaf', 'claims', 'Claims Dept')`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO squads (id, department_id, slug, name)
       VALUES ('squad_claims', 'dept_gaf', 'claims', 'Claims Squad')`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status)
       VALUES ('agent_auditor', 'squad_claims', 'auditor', 'Auditor', 'member', 'test-model', 'active')`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO projects (id, slug, name) VALUES ('proj_gaf', 'main', 'Main Project')`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at)
       VALUES ('proj_gaf', 'squad_claims', 'write', CURRENT_TIMESTAMP)`,
    ).run()
    harness.sqlite.prepare(
      `INSERT INTO routines (
         id, tenant, project_id, name, objective, status, trigger_kind,
         cron_expression, timezone, overlap_policy, execution_mode,
         responsible_squad_id, preferred_agent_id, next_run_at,
         enabled_by, enabled_at, created_by
       ) VALUES (
         'routine_claim_audit', 'gaf', 'proj_gaf', 'Daily Warranty Claim Audit',
         'Audit all pending warranty claims and flag anomalies.', 'enabled', 'cron',
         '0 8 * * *', 'UTC', 'skip', 'propose', 'squad_claims', 'agent_auditor', ?1,
         'admin_1', CURRENT_TIMESTAMP, 'admin_1'
       )`,
    ).run(pastIso)
  })

  function env(mockBusSend = vi.fn().mockResolvedValue(undefined)): Env {
    return {
      TENANT_SLUG: 'gaf',
      BUS: { send: mockBusSend },
      DB: harness.db,
    } as unknown as Env
  }

  it('atomically creates the task/run and advances a due routine', async () => {
    const mockBusSend = vi.fn().mockResolvedValue(undefined)
    const summary = await evaluateAndDispatchDueRoutines(env(mockBusSend), Date.now())

    expect(summary).toMatchObject({ checked: 1, dispatched: 1, skipped: 0, errors: [] })
    expect(mockBusSend).toHaveBeenCalledOnce()
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'proj_gaf'`,
    ).get()?.count).toBe(1)
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = 'routine_claim_audit'`,
    ).get()?.count).toBe(1)
    expect(harness.sqlite.prepare(
      `SELECT next_run_at FROM routines WHERE id = 'routine_claim_audit'`,
    ).get()?.next_run_at).not.toBe(pastIso)
  })

  it('skips an occurrence that already has a durable run', async () => {
    const occurrenceKey = routineOccurrenceKey(
      { kind: 'cron', timezone: 'UTC', cronExpression: '0 8 * * *' },
      new Date(pastIso),
    )
    harness.sqlite.prepare(
      `INSERT INTO routine_runs (
         id, tenant, project_id, routine_id, routine_revision, policy_json,
         occurrence_key, trigger_kind, scheduled_for, status
       ) VALUES (
         'existing_run_123', 'gaf', 'proj_gaf', 'routine_claim_audit', 1, '{}',
         ?1, 'cron', ?2, 'queued'
       )`,
    ).run(occurrenceKey, pastIso)

    const summary = await evaluateAndDispatchDueRoutines(env(), Date.now())

    expect(summary).toMatchObject({ checked: 1, dispatched: 0, skipped: 1, errors: [] })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS count FROM tasks').get()?.count).toBe(0)
  })
})
