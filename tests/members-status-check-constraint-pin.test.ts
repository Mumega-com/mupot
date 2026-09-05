// #1330 WARN pin — flipping all seven `status = 'active'` predicates to
// `status != 'suspended'` across the codebase survives 68/68 tests today, and
// is benign ONLY because migrations/0002_members.sql's CHECK constraint
// currently allows exactly two values: ('active','suspended'). The day a
// third status is added (e.g. 'pending', 'deactivated'), every one of those
// `!= 'suspended'` predicates silently becomes a lockout-turned-open-door and
// nothing goes red — because no test exercises the constraint itself. This
// pins the CHECK constraint directly: if it is ever loosened to add a status,
// this test goes red first, forcing a deliberate audit of every
// `status = 'active'` / `status != 'suspended'` predicate before the schema
// change ships.
import { afterEach, describe, expect, it } from 'vitest'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

describe('members.status CHECK constraint is pinned to exactly (active, suspended)', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness.close())

  it('rejects any third status value at the database layer', () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    expect(() =>
      harness.sqlite.exec(
        `INSERT INTO members (id, tenant, email, display_name, status, created_at)
         VALUES ('m-pending', 'tenant-a', 'pending@example.test', 'Pending', 'pending', datetime('now'))`,
      ),
    ).toThrow(/CHECK constraint failed/i)
  })

  it('accepts both currently-defined statuses', () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    expect(() =>
      harness.sqlite.exec(
        `INSERT INTO members (id, tenant, email, display_name, status, created_at)
         VALUES ('m-active', 'tenant-a', 'active@example.test', 'Active', 'active', datetime('now')),
                ('m-suspended', 'tenant-a', 'susp@example.test', 'Suspended', 'suspended', datetime('now'))`,
      ),
    ).not.toThrow()
  })
})
