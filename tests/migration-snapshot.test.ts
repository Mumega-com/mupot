import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Node 22 provides node:sqlite; the Worker project has no Node runtime dependency.
import { DatabaseSync } from 'node:sqlite'
import {
  applyAllMigrations,
  applyAllMigrationsUncached,
  captureMigrationSnapshot,
  resetMigrationCache,
  useMigrationSnapshot,
} from './helpers/migrations'

const databases: InstanceType<typeof DatabaseSync>[] = []
function fresh() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  databases.push(db)
  return db
}
afterEach(() => {
  resetMigrationCache()
  for (const db of databases.splice(0)) db.close()
})

describe('shared migration snapshot', () => {
  it('the configured worker snapshot equals an independently replayed full chain', () => {
    const target = fresh()
    const executed: string[] = []
    applyAllMigrations({
      exec(sql: string) { executed.push(sql); target.exec(sql) },
      prepare: target.prepare.bind(target),
    })
    // This is the initially injected snapshot, before any reset or local capture.
    expect(executed.join('\n')).not.toMatch(/ALTER TABLE/i)
    const chain = fresh()
    applyAllMigrationsUncached(chain)
    const schema = (db: typeof target) => db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all()
    expect(schema(target)).toEqual(schema(chain))
    expect(schema(target).length).toBeGreaterThan(0)
  })
  it('restores isolated fixtures from the real chain without replaying ALTER migrations', () => {
    const chain = fresh()
    applyAllMigrationsUncached(chain)
    const snapshot = captureMigrationSnapshot(chain)
    useMigrationSnapshot(snapshot)
    const first = fresh()
    const second = fresh()
    const executed: string[] = []
    const observed = {
      exec(sql: string) { executed.push(sql); first.exec(sql) },
      prepare: first.prepare.bind(first),
    }
    applyAllMigrations(observed)
    applyAllMigrations(second)
    expect(executed.join('\n')).not.toMatch(/ALTER TABLE/i)
    const schema = (db: typeof first) => db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all()
    expect(schema(first)).toEqual(schema(chain))
    expect(schema(second)).toEqual(schema(chain))
    first.exec("INSERT INTO members (id,email,display_name) VALUES ('snapshot-member','snapshot@example.test','Snapshot')")
    expect(second.prepare('SELECT COUNT(*) AS count FROM members').get().count).toBe(0)
    expect(first.prepare('PRAGMA foreign_keys').get().foreign_keys).toBe(1)
  })

  it('rejects seeded rows instead of silently dropping them from the schema snapshot', () => {
    const chain = fresh()
    applyAllMigrationsUncached(chain)
    chain.exec("INSERT INTO members (id,email,display_name) VALUES ('seed','seed@example.test','Seed')")
    expect(() => captureMigrationSnapshot(chain)).toThrow(/seed.*members|members.*seed/i)
  })

  it('rolls back a broken restore instead of leaving a partial fixture schema', () => {
    const chain = fresh()
    applyAllMigrationsUncached(chain)
    useMigrationSnapshot([...captureMigrationSnapshot(chain), 'THIS IS INVALID SQL;'])
    const target = fresh()
    expect(() => applyAllMigrations(target)).toThrow()
    expect(target.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all()).toEqual([])
    // No transaction should remain open after failure.
    target.exec('BEGIN; ROLLBACK;')
  })
})
