// tests/routine-run-actions-kind-migration.test.ts — Athena round-2 condition
// 2 on PR #1488 (FP-01 Slice 2, mupot#1443): migrations/0158 rebuilds
// routine_run_actions (SQLite has no ALTER COLUMN) to widen its `kind` CHECK
// to admit 'project_access'. Proves the rebuild is ROW-PRESERVING: every
// pre-existing row, for every pre-existing kind, survives with byte-identical
// column values, and the table's indexes/triggers are recreated identically.
//
// Pure migration-behaviour test — imports no src/, builds its schema by
// walking the real committed migration files up to (not including) 0158, the
// exact pattern tests/projects-migration.test.ts already uses for the same
// class of table-rebuild proof (there: 0055_projects.sql). Exempt from
// scripts/check-test-schema-source.mjs by its own documented carve-out
// ("a migration-behaviour test, which must construct a historical state, and
// imports no src/").
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TARGET_MIGRATION = '0158_routine_run_actions_project_access_kind.sql'

function applyPriorMigrations(sqlite: { exec(sql: string): void }): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name < TARGET_MIGRATION).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

interface SchemaObjectRow {
  type: string
  name: string
  sql: string | null
}

function routineRunActionsSchemaObjects(sqlite: { prepare(sql: string): { all(...values: unknown[]): Record<string, unknown>[] } }): SchemaObjectRow[] {
  return sqlite.prepare(
    `SELECT type, name, sql FROM sqlite_master
      WHERE tbl_name = 'routine_run_actions' AND type IN ('index', 'trigger')
      ORDER BY type, name`,
  ).all() as unknown as SchemaObjectRow[]
}

const PRE_EXISTING_KINDS = ['create_task', 'dispatch_flight', 'request_review', 'ask_human', 'no_action'] as const

describe('migrations/0158_routine_run_actions_project_access_kind (table-rebuild)', () => {
  it('preserves every pre-existing row byte-for-byte and recreates indexes/triggers identically', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)

      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad', 'Squad');
        INSERT INTO projects (id, slug, name, status) VALUES ('project-1', 'project-1', 'Project One', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-1', 'squad-1', 'write');
        INSERT INTO routines (
          id, tenant, project_id, name, objective, status, trigger_kind, timezone,
          overlap_policy, execution_mode, responsible_squad_id, budget_micro_usd,
          created_by, created_at, updated_at
        ) VALUES (
          'routine-1', 'tenant-a', 'project-1', 'Routine', 'Objective', 'draft', 'manual', 'UTC',
          'skip', 'propose', 'squad-1', 100000, 'owner-1', '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'
        );
        INSERT INTO routine_runs (
          id, tenant, project_id, routine_id, routine_revision, policy_json, occurrence_key,
          trigger_kind, status, attempt, created_at, updated_at
        ) VALUES (
          'run-1', 'tenant-a', 'project-1', 'routine-1', 1, '{}', 'manual:1',
          'manual', 'running', 1, '2026-07-19T16:00:00.000Z', '2026-07-19T16:00:00.000Z'
        );
      `)

      // One row per pre-existing kind, each with a distinct, fully-populated
      // column set (including nullable columns left NULL vs. set) so a
      // column-dropping or column-reordering rebuild bug would be visible in
      // the post-migration comparison, not just the row count.
      const insertAction = sqlite.prepare(
        `INSERT INTO routine_run_actions (
          id, tenant, project_id, run_id, action_key, kind, input_json,
          validation_status, gate_status, status, source_type, source_id,
          receipt_id, result_json, created_at, updated_at
        ) VALUES (?, 'tenant-a', 'project-1', 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      const seeded = [
        {
          id: 'action-create-task', key: 'k-create-task', kind: 'create_task',
          input: '{"title":"T","description":"D"}', validation: 'accepted', gate: 'not_required',
          status: 'succeeded', sourceType: 'task', sourceId: 'task-1', receiptId: 'receipt-1',
          result: '{"task_id":"task-1"}', createdAt: '2026-07-19T16:01:00.000Z', updatedAt: '2026-07-19T16:02:00.000Z',
        },
        {
          id: 'action-dispatch-flight', key: 'k-dispatch-flight', kind: 'dispatch_flight',
          input: '{"goal":"G","task_ids":["task-1"],"artifact_refs":[],"budget_micro_usd":1}',
          validation: 'accepted', gate: 'not_required', status: 'running', sourceType: 'flight', sourceId: 'flight-1',
          receiptId: null, result: null, createdAt: '2026-07-19T16:03:00.000Z', updatedAt: '2026-07-19T16:03:00.000Z',
        },
        {
          id: 'action-request-review', key: 'k-request-review', kind: 'request_review',
          input: '{"source_type":"task","source_id":"task-1","summary":"S"}',
          validation: 'accepted', gate: 'pending', status: 'waiting', sourceType: 'task', sourceId: 'control-task',
          receiptId: 'wait-receipt-1', result: null, createdAt: '2026-07-19T16:04:00.000Z', updatedAt: '2026-07-19T16:04:00.000Z',
        },
        {
          id: 'action-ask-human', key: 'k-ask-human', kind: 'ask_human',
          input: '{"question":"Q?","references":[]}',
          validation: 'accepted', gate: 'not_required', status: 'waiting', sourceType: 'question', sourceId: 'action-ask-human',
          receiptId: 'wait-receipt-2', result: null, createdAt: '2026-07-19T16:05:00.000Z', updatedAt: '2026-07-19T16:05:00.000Z',
        },
        {
          id: 'action-no-action', key: 'k-no-action', kind: 'no_action',
          input: '{"reason":"nothing to do"}',
          validation: 'accepted', gate: 'not_required', status: 'succeeded', sourceType: null, sourceId: null,
          receiptId: 'action-no-action', result: '{"no_action":true,"reason":"nothing to do"}',
          createdAt: '2026-07-19T16:06:00.000Z', updatedAt: '2026-07-19T16:07:00.000Z',
        },
      ] as const
      for (const row of seeded) {
        insertAction.all(
          row.id, row.key, row.kind, row.input, row.validation, row.gate, row.status,
          row.sourceType, row.sourceId, row.receiptId, row.result, row.createdAt, row.updatedAt,
        )
      }

      // Every pre-existing kind actually accepted by the ORIGINAL (pre-0158) CHECK —
      // proves the fixture itself is honest before asserting anything about the migration.
      expect(PRE_EXISTING_KINDS.every((k) => seeded.some((row) => row.kind === k))).toBe(true)

      const before = sqlite.prepare(
        `SELECT id, tenant, project_id, run_id, action_key, kind, input_json,
                validation_status, gate_status, status, source_type, source_id,
                receipt_id, result_json, created_at, updated_at
           FROM routine_run_actions ORDER BY id`,
      ).all()
      expect(before).toHaveLength(5)
      const schemaBefore = routineRunActionsSchemaObjects(sqlite)
      // The two named indexes + two triggers from migrations/0073, PLUS
      // SQLite's own auto-indexes for the PRIMARY KEY and UNIQUE(run_id,
      // action_key) constraints (sqlite_autoindex_routine_run_actions_1/2) —
      // asserted present here (not just in the before/after equality below)
      // so a rebuild that silently dropped the PK or the UNIQUE constraint
      // would already fail on THIS list, not only on the row-level checks.
      expect(schemaBefore.map((o) => o.name)).toEqual(expect.arrayContaining([
        'idx_routine_run_actions_projection_keyset', 'idx_routine_run_actions_run',
        'routine_action_ownership_immutable', 'validate_routine_action_insert',
        'sqlite_autoindex_routine_run_actions_1', 'sqlite_autoindex_routine_run_actions_2',
      ]))
      expect(schemaBefore).toHaveLength(6)

      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, TARGET_MIGRATION), 'utf8'))

      // ROW-PRESERVING: identical rows, identical column values, same order.
      const after = sqlite.prepare(
        `SELECT id, tenant, project_id, run_id, action_key, kind, input_json,
                validation_status, gate_status, status, source_type, source_id,
                receipt_id, result_json, created_at, updated_at
           FROM routine_run_actions ORDER BY id`,
      ).all()
      expect(after).toEqual(before)

      // Indexes/triggers recreated identically (same names AND same defining SQL —
      // a rebuild that silently dropped a WHERE clause or a column list would
      // still pass a name-only comparison).
      const schemaAfter = routineRunActionsSchemaObjects(sqlite)
      expect(schemaAfter).toEqual(schemaBefore)

      // The widened CHECK: every OLD kind still passes it post-migration...
      for (const kind of PRE_EXISTING_KINDS) {
        expect(() => sqlite.exec(
          `INSERT INTO routine_run_actions (id, tenant, project_id, run_id, action_key, kind, input_json)
           VALUES ('probe-${kind}', 'tenant-a', 'project-1', 'run-1', 'probe-key-${kind}', '${kind}', '{}')`,
        )).not.toThrow()
      }
      // ...and the NEW kind this migration exists to admit now also passes.
      expect(() => sqlite.exec(
        `INSERT INTO routine_run_actions (id, tenant, project_id, run_id, action_key, kind, input_json)
         VALUES ('probe-project-access', 'tenant-a', 'project-1', 'run-1', 'probe-key-project-access', 'project_access', '{}')`,
      )).not.toThrow()
      // A genuinely unknown kind is still rejected — the widening was exact, not a drop of the CHECK entirely.
      expect(() => sqlite.exec(
        `INSERT INTO routine_run_actions (id, tenant, project_id, run_id, action_key, kind, input_json)
         VALUES ('probe-bogus', 'tenant-a', 'project-1', 'run-1', 'probe-key-bogus', 'not_a_real_kind', '{}')`,
      )).toThrow()

      // Immutability trigger still fires post-rebuild (proves it's not just
      // present in sqlite_master but actually live).
      expect(() => sqlite.exec(
        `UPDATE routine_run_actions SET kind = 'no_action' WHERE id = 'action-create-task'`,
      )).toThrow(/routine action ownership immutable/)
    } finally {
      close()
    }
  })
})
