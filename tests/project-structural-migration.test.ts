import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations')
const PENDING_PRODUCTION_MIGRATIONS = [
  '0068_project_cycle_boundary.sql',
  '0069_project_structural_completion.sql',
  '0071_agent_connections.sql',
  '0073_project_routines.sql',
  '0074_routine_cancellation_events.sql',
] as const

function applyProductionBaseline(sqlite: { exec(sql: string): void }): void {
  const deferred = new Set<string>(PENDING_PRODUCTION_MIGRATIONS)
  for (const file of readdirSync(MIGRATIONS_DIR).filter(name => name.endsWith('.sql')).sort()) {
    if (file > '0070_harness_role_capabilities.sql') continue
    if (deferred.has(file)) continue
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

function applyPendingProductionMigrations(sqlite: { exec(sql: string): void }): void {
  sqlite.exec('PRAGMA foreign_keys = ON; BEGIN')
  try {
    for (const file of PENDING_PRODUCTION_MIGRATIONS) {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    sqlite.exec('COMMIT')
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

describe('v0.25 production migration path', () => {
  it('preserves project-attributed append-only evidence through the project table rebuild', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyProductionBaseline(sqlite)
      sqlite.exec(`
        INSERT INTO departments (id, slug, name)
        VALUES ('dept', 'delivery', 'Delivery');
        INSERT INTO squads (id, department_id, slug, name)
        VALUES ('squad', 'dept', 'core', 'Core');

        INSERT INTO projects (id, slug, name, status)
        VALUES ('project-root', 'root', 'Root', 'active');
        INSERT INTO projects (id, slug, name, status, parent_project_id)
        VALUES ('project-child', 'child', 'Child', 'active', 'project-root');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES
          ('project-root', 'squad', 'admin'),
          ('project-child', 'squad', 'write');

        INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
        VALUES ('task', 'squad', 'Task', 'Done', 'open', 'project-child');
        INSERT INTO flights (id, tenant, agent, goal, status, project_id, meta)
        VALUES ('flight', 'mumega', 'agent', 'Goal', 'landed', 'project-child', '{}');

        INSERT INTO module_registry (
          id, tenant, kind, adapter, project_id, identity, status, capabilities,
          last_heartbeat, registered_at
        )
        VALUES (
          'module', 'mumega', 'agent_system', 'test', 'project-child', 'agent:test',
          'online', '[]', '2026-07-27T00:00:00Z', '2026-07-27T00:00:00Z'
        );
        INSERT INTO module_registry (
          id, tenant, kind, adapter, project_id, identity, status, capabilities,
          last_heartbeat, registered_at
        )
        VALUES (
          'module-unscoped', 'mumega', 'agent_system', 'test', NULL, 'agent:test',
          'online', '[]', '2026-07-27T00:00:00Z', '2026-07-27T00:00:00Z'
        );
        INSERT INTO task_verdicts (
          id, task_id, verdict, decided_by, decided_at, project_id
        )
        VALUES (
          'verdict', 'task', 'approved', 'owner', '2026-07-27T00:00:00Z',
          'project-child'
        );
        INSERT INTO workflow_receipts (
          id, instance_id, task_id, step_name, status, created_at, project_id
        )
        VALUES (
          'workflow', 'instance', 'task', 'review', 'completed',
          '2026-07-27T00:00:00Z', 'project-child'
        );
        INSERT INTO task_dispatch_receipts (
          id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at,
          project_id
        )
        VALUES (
          'dispatch', 'mumega', 'task', 'squad', 'agent', 'member', 'owner',
          '2026-07-27T00:00:00Z', 'project-child'
        );
        INSERT INTO flight_event_outbox (
          id, tenant, flight_id, event_type, actor_kind, actor_id, payload, created_at,
          project_id
        )
        VALUES (
          'outbox', 'mumega', 'flight', 'flight.landed', 'member', 'owner', '{}',
          '2026-07-27T00:00:00Z', 'project-child'
        );
      `)

      applyPendingProductionMigrations(sqlite)

      expect(sqlite.prepare(`
        SELECT id, parent_project_id, cycle_boundary_at, stalled,
               stall_threshold_days, completion_proposed_by
        FROM projects
        ORDER BY id
      `).all()).toEqual([
        {
          id: 'project-child',
          parent_project_id: 'project-root',
          cycle_boundary_at: null,
          stalled: 0,
          stall_threshold_days: null,
          completion_proposed_by: null,
        },
        {
          id: 'project-root',
          parent_project_id: null,
          cycle_boundary_at: null,
          stalled: 0,
          stall_threshold_days: null,
          completion_proposed_by: null,
        },
      ])
      expect(sqlite.prepare(`
        SELECT project_id, squad_id, access_level
        FROM project_squad_access
        ORDER BY project_id
      `).all()).toEqual([
        { project_id: 'project-child', squad_id: 'squad', access_level: 'write' },
        { project_id: 'project-root', squad_id: 'squad', access_level: 'admin' },
      ])
      expect(sqlite.prepare(`
        SELECT id, project_id
        FROM module_registry
        WHERE identity = 'agent:test'
        ORDER BY id
      `).all()).toEqual([
        { id: 'module', project_id: 'project-child' },
        { id: 'module-unscoped', project_id: null },
      ])

      for (const table of [
        'task_verdicts',
        'workflow_receipts',
        'task_dispatch_receipts',
        'flight_event_outbox',
      ]) {
        expect(sqlite.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(
          table === 'task_verdicts' ? 'verdict'
            : table === 'workflow_receipts' ? 'workflow'
              : table === 'task_dispatch_receipts' ? 'dispatch'
                : 'outbox',
        )).toEqual({ project_id: 'project-child' })
      }

      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
      expect(sqlite.prepare(`PRAGMA foreign_key_list('projects')`).all()).toEqual([
        expect.objectContaining({
          table: 'projects',
          from: 'parent_project_id',
          to: 'id',
          on_delete: 'RESTRICT',
        }),
      ])
      expect(() => sqlite.exec(`DELETE FROM projects WHERE id = 'project-root'`))
        .toThrow(/FOREIGN KEY constraint failed/)
      expect(sqlite.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
      expect(sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name LIKE '%_backup_0069'
      `).get()).toEqual({ count: 0 })

      expect(() => sqlite.exec(`
        UPDATE task_verdicts SET note = 'mutated' WHERE id = 'verdict'
      `)).toThrow(/verdicts are append-only/)
      expect(() => sqlite.exec(`
        UPDATE workflow_receipts SET project_id = NULL WHERE id = 'workflow'
      `)).toThrow(/workflow receipt project (immutable|mismatch)/)
      expect(() => sqlite.exec(`
        UPDATE task_dispatch_receipts SET project_id = NULL WHERE id = 'dispatch'
      `)).toThrow(/dispatch receipt project (immutable|mismatch)/)
      expect(() => sqlite.exec(`
        UPDATE flight_event_outbox SET project_id = NULL WHERE id = 'outbox'
      `)).toThrow(/flight event project (immutable|mismatch)/)
    } finally {
      close()
    }
  })
})
