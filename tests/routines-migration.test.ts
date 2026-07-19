import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const ROUTINES_MIGRATION = '0061_project_routines.sql'

function applyPriorMigrations(sqlite: { exec(sql: string): void }): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name < ROUTINES_MIGRATION).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function applyRoutineMigration(sqlite: { exec(sql: string): void }): void {
  applyPriorMigrations(sqlite)
  sqlite.exec(readFileSync(join(MIGRATIONS_DIR, ROUTINES_MIGRATION), 'utf8'))
}

function seedOwnership(sqlite: { exec(sql: string): void }): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'delivery', 'Delivery');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core');
    INSERT INTO agents (id, squad_id, slug, name) VALUES ('agent-1', 'squad-1', 'worker', 'Worker');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-a', 'project-a', 'Project A', 'active'),
      ('project-b', 'project-b', 'Project B', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level)
    VALUES ('project-a', 'squad-1', 'write'), ('project-b', 'squad-1', 'write');
  `)
}

function insertRoutine(sqlite: { exec(sql: string): void }): void {
  sqlite.exec(`
    INSERT INTO routines (
      id, tenant, project_id, name, objective, status, trigger_kind,
      cron_expression, timezone, overlap_policy, execution_mode, responsible_squad_id,
      preferred_agent_id, budget_micro_usd, max_attempts,
      retry_backoff_seconds, max_occurrences, revision, enabled_by, enabled_at, created_by
    ) VALUES (
      'routine-1', 'tenant-a', 'project-a', 'Daily progress', 'Move the project forward',
      'enabled', 'cron', '0 9 * * *', 'America/Toronto', 'skip', 'propose', 'squad-1',
      'agent-1', 500000, 3, 300, 30, 1, 'member-owner',
      '2026-07-19T13:00:00.000Z', 'member-owner'
    );
  `)
}

describe('0061_project_routines migration', () => {
  it('adds the complete durable routine control-plane schema and indexes', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyRoutineMigration(sqlite)

      const columns = (table: string) => sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map(row => row.name)
      expect(columns('routines')).toEqual(expect.arrayContaining([
        'id', 'tenant', 'project_id', 'name', 'objective', 'status', 'trigger_kind',
        'run_once_at', 'cron_expression', 'timezone', 'next_run_at', 'overlap_policy',
        'execution_mode', 'responsible_squad_id', 'preferred_agent_id', 'budget_micro_usd',
        'max_attempts', 'retry_backoff_seconds', 'max_occurrences', 'stop_at', 'revision',
        'enabled_by', 'enabled_at', 'created_by', 'created_at', 'updated_at',
      ]))
      expect(columns('routine_runs')).toEqual(expect.arrayContaining([
        'id', 'tenant', 'project_id', 'routine_id', 'routine_revision', 'policy_json',
        'occurrence_key', 'trigger_kind', 'scheduled_for', 'status', 'waiting_reason',
        'lease_owner', 'lease_expires_at', 'attempt', 'retry_at', 'assigned_agent_id',
        'task_id', 'flight_id', 'situation_digest', 'proposal_json', 'result_summary',
        'cost_micro_usd', 'started_at', 'finished_at', 'created_at', 'updated_at',
      ]))
      expect(columns('routine_run_events')).toContain('correlation_id')
      expect(columns('routine_run_actions')).toContain('action_key')
      expect(columns('routine_run_refs')).toContain('relation')

      const indexNames = (table: string) => sqlite.prepare(`SELECT name FROM pragma_index_list(?)`).all(table).map(row => row.name)
      expect(indexNames('routines')).toEqual(expect.arrayContaining([
        'idx_routines_due', 'idx_routines_project_status',
      ]))
      expect(indexNames('routine_runs')).toEqual(expect.arrayContaining([
        'idx_routine_runs_lease_recovery', 'idx_routine_runs_project_history',
        'idx_routine_runs_needs_you', 'idx_routine_runs_retry',
      ]))
    } finally {
      close()
    }
  })

  it('enforces ownership, policy shape, occurrence idempotency, and immutable run snapshots', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyRoutineMigration(sqlite)
      seedOwnership(sqlite)
      insertRoutine(sqlite)

      expect(() => sqlite.exec(`UPDATE routines SET tenant = 'tenant-b' WHERE id = 'routine-1'`))
        .toThrow(/routine ownership immutable/)
      expect(() => sqlite.exec(`UPDATE routines SET project_id = 'project-b' WHERE id = 'routine-1'`))
        .toThrow(/routine ownership immutable/)

      expect(() => sqlite.exec(`
        INSERT INTO routine_runs (
          id, tenant, project_id, routine_id, routine_revision, policy_json,
          occurrence_key, trigger_kind, status
        ) VALUES (
          'wrong-project', 'tenant-a', 'project-b', 'routine-1', 1, '{}',
          'manual:wrong', 'manual', 'queued'
        )
      `)).toThrow(/routine run project mismatch/)

      sqlite.exec(`
        INSERT INTO routine_runs (
          id, tenant, project_id, routine_id, routine_revision, policy_json,
          occurrence_key, trigger_kind, status
        ) VALUES (
          'run-1', 'tenant-a', 'project-a', 'routine-1', 1,
          '{"execution_mode":"propose","budget_micro_usd":500000}',
          'cron:2026-07-20T09:00:00[America/Toronto]', 'cron', 'queued'
        )
      `)
      expect(() => sqlite.exec(`
        INSERT INTO routine_runs (
          id, tenant, project_id, routine_id, routine_revision, policy_json,
          occurrence_key, trigger_kind, status
        ) VALUES (
          'run-duplicate', 'tenant-a', 'project-a', 'routine-1', 1, '{}',
          'cron:2026-07-20T09:00:00[America/Toronto]', 'cron', 'queued'
        )
      `)).toThrow(/UNIQUE/)
      expect(() => sqlite.exec(`UPDATE routine_runs SET policy_json = '{}' WHERE id = 'run-1'`))
        .toThrow(/routine run ownership immutable/)
      expect(() => sqlite.exec(`UPDATE routine_runs SET project_id = 'project-b' WHERE id = 'run-1'`))
        .toThrow(/routine run ownership immutable/)
      expect(() => sqlite.exec(`UPDATE routine_runs SET status = 'running', waiting_reason = 'agent' WHERE id = 'run-1'`))
        .toThrow(/CHECK constraint/)
    } finally {
      close()
    }
  })

  it('keeps events append-only and deduplicates actions and references', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyRoutineMigration(sqlite)
      seedOwnership(sqlite)
      insertRoutine(sqlite)
      sqlite.exec(`
        INSERT INTO routine_runs (
          id, tenant, project_id, routine_id, routine_revision, policy_json,
          occurrence_key, trigger_kind, status
        ) VALUES ('run-1', 'tenant-a', 'project-a', 'routine-1', 1, '{}', 'manual:key-1', 'manual', 'queued');
        INSERT INTO routine_run_events (
          id, tenant, project_id, run_id, kind, actor_type, actor_id, metadata_json, correlation_id
        ) VALUES ('event-1', 'tenant-a', 'project-a', 'run-1', 'created', 'member', 'member-owner', '{}', 'corr-1');
        INSERT INTO routine_run_actions (
          id, tenant, project_id, run_id, action_key, kind, input_json, status
        ) VALUES ('action-1', 'tenant-a', 'project-a', 'run-1', 'next-step', 'create_task', '{}', 'pending');
        INSERT INTO routine_run_refs (
          id, tenant, project_id, run_id, ref_type, ref_id, relation
        ) VALUES ('ref-1', 'tenant-a', 'project-a', 'run-1', 'task', 'task-1', 'created');
      `)

      expect(() => sqlite.exec(`UPDATE routine_run_events SET kind = 'failed' WHERE id = 'event-1'`))
        .toThrow(/routine events are append-only/)
      expect(() => sqlite.exec(`DELETE FROM routine_run_events WHERE id = 'event-1'`))
        .toThrow(/routine events are append-only/)
      expect(() => sqlite.exec(`
        INSERT INTO routine_run_actions (id, tenant, project_id, run_id, action_key, kind, input_json, status)
        VALUES ('action-2', 'tenant-a', 'project-a', 'run-1', 'next-step', 'no_action', '{}', 'pending')
      `)).toThrow(/UNIQUE/)
      expect(() => sqlite.exec(`
        INSERT INTO routine_run_refs (id, tenant, project_id, run_id, ref_type, ref_id, relation)
        VALUES ('ref-2', 'tenant-a', 'project-a', 'run-1', 'task', 'task-1', 'created')
      `)).toThrow(/UNIQUE/)
    } finally {
      close()
    }
  })
})
