// tests/helpers/migrations.ts — the ONLY sanctioned way for a test to build a schema.
//
// WHY THIS EXISTS
//
// A test that constructs its schema any other way is testing a schema production does
// not have. Two shapes of that were live in this repo on 2026-08-05:
//
//   1. HAND-WRITTEN `CREATE TABLE` in the test. This is how mupot#684 reached
//      production: twelve tests validated a query naming `member_tokens.capability`,
//      a column that does not exist. A hand-written fixture would have contained the
//      same invented column, so those tests would have stayed green forever.
//
//   2. A HAND-PICKED LIST of migration files. Subtler and worse, because it starts
//      correct and rots without anyone making a mistake. Measured across the 14 tests
//      that did this: 13 were already running against a schema production had moved
//      away from — `agents` short 15 columns (including `capabilities`), `tasks` short
//      10, `projects` short 4, `task_verdicts`/`workflow_receipts` short `project_id`.
//      Those tests execute real SQL, so they look like the strong kind of test.
//
// The rule this file encodes: the schema is the WHOLE committed migration chain, or it
// is an assumption wearing a schema's clothes. No third option, no per-test exemption —
// `scripts/check-test-schema-source.mjs` enforces it in CI (a ratchet: the baseline may
// shrink, never grow).

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

interface ExecutableSqlite {
  exec(sql: string): void
  prepare(sql: string): { all(...values: unknown[]): Record<string, unknown>[] }
}

/** Every committed migration filename, in application order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
}

/**
 * Apply EVERY migration in order, exactly as production does.
 *
 * FAIL CLOSED, deliberately. An earlier version of this loop swallowed anything matching
 * /already exists|duplicate column|no such function|module|near "PRAGMA"/. That tolerance
 * is broad enough to discard a genuinely broken migration and then build a schema that is
 * NOT production's — reproducing, one level up, the exact bug class this helper prevents.
 * On this head the full chain applies with zero errors under node:sqlite, so the tolerance
 * bought nothing and risked everything.
 *
 * If a real dialect incompatibility ever appears, allow-list the exact filename and the
 * exact expected message here. Never a pattern. (mupot#684, gate round 2.)
 */
export function applyAllMigrationsUncached(sqlite: ExecutableSqlite): void {
  const failures: string[] = []
  for (const file of migrationFiles()) {
    try {
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    } catch (error) {
      failures.push(`${file}: ${String(error)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`migrations did not apply cleanly:\n${failures.join('\n')}`)
  }
}

/**
 * Capture the finished real chain, never a handwritten or partial schema.
 * DDL-only reuse is valid only while migrations leave no application rows.
 * Fail before any application test if that invariant changes; seed support then
 * needs an explicit implementation, not a silent schema-only approximation.
 */
export function captureMigrationSnapshot(sqlite: ExecutableSqlite): string[] {
  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all()
  for (const row of tables) {
    const table = String(row.name)
    const quoted = table.replace(/"/g, '""')
    const count = Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM "${quoted}"`).all()[0]?.count)
    if (count !== 0) throw new Error(`migration snapshot cannot discard seeded rows in ${table}`)
  }
  // Preserve creation order so indexes/triggers follow the tables they reference.
  const ddl = sqlite.prepare(
    `SELECT sql FROM sqlite_master
      WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`,
  ).all().map(row => `${String(row.sql)};`)
  if (ddl.length === 0) throw new Error('migration snapshot schema is empty')
  return ddl
}

let cachedSnapshotSql: string | null = null

/** Supply the immutable snapshot built by this Vitest invocation's global setup. */
export function useMigrationSnapshot(ddl: unknown): void {
  if (!Array.isArray(ddl) || ddl.length === 0 || ddl.some(sql => typeof sql !== 'string' || !sql.trim())) {
    throw new Error('invalid migration schema snapshot')
  }
  cachedSnapshotSql = ddl.join('\n')
}

/** Build the production schema in this test's private database. */
export function applyAllMigrations(sqlite: ExecutableSqlite): void {
  if (cachedSnapshotSql === null) {
    // Outside the configured runner (or after explicit reset), still build the
    // whole real chain. Dedicated tests exercise this path independently.
    applyAllMigrationsUncached(sqlite)
    useMigrationSnapshot(captureMigrationSnapshot(sqlite))
    return
  }
  // Atomic restore, compatible with a caller's existing transaction. Failure
  // cannot leave a partially constructed schema or an open transaction behind.
  sqlite.exec('SAVEPOINT mupot_migration_snapshot')
  try {
    sqlite.exec(cachedSnapshotSql)
    sqlite.exec('RELEASE mupot_migration_snapshot')
  } catch (error) {
    sqlite.exec('ROLLBACK TO mupot_migration_snapshot; RELEASE mupot_migration_snapshot')
    throw error
  }
}

/** Test-only: force the next call to walk the real chain instead of its snapshot. */
export function resetMigrationCache(): void {
  cachedSnapshotSql = null
}
