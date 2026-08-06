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
 * The DDL of the finished chain, captured once per process.
 *
 * Replaying 77 migrations costs ~405ms; replaying the resulting DDL costs ~59ms, and a
 * per-test `makeDb()` pays that on every single test. The speedup is only sound because
 * the finished chain leaves ZERO rows behind — every INSERT in the chain is inside a
 * temp-table-and-rename rebuild whose result is dropped. That is a property of today's
 * migrations, not a law, so `tests/helpers-migrations.test.ts` pins all three legs:
 * identical `sqlite_master`, identical per-column `table_info`, and zero surviving rows.
 * If a migration ever seeds data, that test goes red before this cache can silently
 * hand tests a schema-only database.
 */
let cachedDdl: string[] | null = null

function captureDdl(sqlite: ExecutableSqlite): string[] {
  // rowid order preserves creation order, so triggers/indexes replay after their tables.
  // `sqlite_%` names are SQLite's own (e.g. sqlite_sequence) and are re-created implicitly;
  // replaying them raises "object name reserved for internal use".
  return sqlite
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY rowid`,
    )
    .all()
    .map((row) => `${String(row.sql)};`)
}

/** Build the production schema. Use this — nothing else. */
export function applyAllMigrations(sqlite: ExecutableSqlite): void {
  if (cachedDdl === null) {
    applyAllMigrationsUncached(sqlite)
    cachedDdl = captureDdl(sqlite)
    return
  }
  for (const statement of cachedDdl) sqlite.exec(statement)
}

/** Test-only: force the next `applyAllMigrations` to walk the real chain again. */
export function resetMigrationCache(): void {
  cachedDdl = null
}
