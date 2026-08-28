// tests/agent-routines-scheduler.test.ts — Unit tests for Autonomous Agent Cron Routine Scheduler (Flight 9).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { evaluateAndDispatchDueRoutines } from '../src/routines/cron-scheduler'
import { routineOccurrenceKey } from '../src/routines/schedule'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

describe('Autonomous Agent Cron Routine Scheduler (Flight 9)', () => {
  let harness: ReturnType<typeof createSqliteD1>

  beforeEach(() => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  it('evaluates due routines and dispatches autonomous tasks and runs', async () => {
    const mockBusSend = vi.fn().mockResolvedValue(undefined)

    // Seed department, squad, agent, project, routine into SQLite
    await harness.db.prepare(
      `INSERT INTO departments (id, slug, name, created_at) VALUES ('dept_gaf', 'claims', 'Claims Dept', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad_claims', 'dept_gaf', 'claims', 'Claims Squad', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES ('agent_auditor', 'squad_claims', 'auditor', 'Auditor', 'member', 'claude-3-7-sonnet', 'active', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO projects (id, slug, name, created_at) VALUES ('proj_gaf', 'main', 'Main Project', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at) VALUES ('proj_gaf', 'squad_claims', 'write', CURRENT_TIMESTAMP)`,
    ).run()

    const pastIso = new Date(Date.now() - 1000).toISOString()
    await harness.db.prepare(
      `INSERT INTO routines (id, tenant, project_id, name, objective, status, trigger_kind, cron_expression, timezone, overlap_policy, execution_mode, responsible_squad_id, preferred_agent_id, next_run_at, enabled_by, enabled_at, created_by, created_at, updated_at)
       VALUES ('routine_claim_audit', 'gaf', 'proj_gaf', 'Daily Warranty Claim Audit', 'Audit all pending warranty claims in Supabase and flag anomalies.', 'enabled', 'cron', '0 8 * * *', 'UTC', 'skip', 'propose', 'squad_claims', 'agent_auditor', ?1, 'admin_1', CURRENT_TIMESTAMP, 'admin_1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(pastIso).run()

    const env: Env = {
      TENANT_SLUG: 'gaf',
      BUS: { send: mockBusSend },
      DB: harness.db,
    } as unknown as Env

    const summary = await evaluateAndDispatchDueRoutines(env, Date.now())

    expect(summary.checked).toBe(1)
    expect(summary.dispatched).toBe(1)
    expect(summary.skipped).toBe(0)
    expect(summary.errors.length).toBe(0)
    expect(mockBusSend).toHaveBeenCalledTimes(1)
  })

  it('skips duplicate runs if occurrence key already exists', async () => {
    const mockBusSend = vi.fn().mockResolvedValue(undefined)

    // Seed department, squad, agent, project, routine into SQLite
    await harness.db.prepare(
      `INSERT INTO departments (id, slug, name, created_at) VALUES ('dept_gaf', 'claims', 'Claims Dept', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad_claims', 'dept_gaf', 'claims', 'Claims Squad', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES ('agent_auditor', 'squad_claims', 'auditor', 'Auditor', 'member', 'claude-3-7-sonnet', 'active', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO projects (id, slug, name, created_at) VALUES ('proj_gaf', 'main', 'Main Project', CURRENT_TIMESTAMP)`,
    ).run()
    await harness.db.prepare(
      `INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at) VALUES ('proj_gaf', 'squad_claims', 'write', CURRENT_TIMESTAMP)`,
    ).run()

    const pastIso = new Date(Date.now() - 1000).toISOString()
    await harness.db.prepare(
      `INSERT INTO routines (id, tenant, project_id, name, objective, status, trigger_kind, cron_expression, timezone, overlap_policy, execution_mode, responsible_squad_id, preferred_agent_id, next_run_at, enabled_by, enabled_at, created_by, created_at, updated_at)
       VALUES ('routine_claim_audit', 'gaf', 'proj_gaf', 'Daily Warranty Claim Audit', 'Audit claims', 'enabled', 'cron', '0 8 * * *', 'UTC', 'skip', 'propose', 'squad_claims', 'agent_auditor', ?1, 'admin_1', CURRENT_TIMESTAMP, 'admin_1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(pastIso).run()

    // Insert an active run with occurrence key
    const scheduledDate = new Date(pastIso)
    const scheduleObj = { kind: 'cron' as const, timezone: 'UTC', cronExpression: '0 8 * * *' }
    const occurrenceKey = routineOccurrenceKey(scheduleObj, scheduledDate)

    await harness.db.prepare(
      `INSERT INTO routine_runs (id, tenant, project_id, routine_id, routine_revision, policy_json, status, trigger_kind, occurrence_key, scheduled_for, created_at)
       VALUES ('existing_run_123', 'gaf', 'proj_gaf', 'routine_claim_audit', 1, '{}', 'queued', 'cron', ?1, ?2, CURRENT_TIMESTAMP)`,
    ).bind(occurrenceKey, pastIso).run()

    const env: Env = {
      TENANT_SLUG: 'gaf',
      BUS: { send: mockBusSend },
      DB: harness.db,
    } as unknown as Env

    const summary = await evaluateAndDispatchDueRoutines(env, Date.now())

    expect(summary.checked).toBe(1)
    expect(summary.dispatched).toBe(0)
    expect(summary.skipped).toBe(1)
  })
})
