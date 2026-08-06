// tests/helpers-migrations.test.ts — the helper that every other test's schema depends on.
//
// applyAllMigrations() replays a cached DDL snapshot instead of the 77-file chain (~59ms
// vs ~405ms, paid per test). That is only sound if the snapshot is INDISTINGUISHABLE from
// the chain. "Indistinguishable" is a claim, and an unverified claim in the one helper
// every schema flows through is the highest-leverage place in this repo to be wrong.
//
// So all three legs of the claim are pinned below, each able to fail on its own:
//   1. identical sqlite_master (tables, indexes, triggers, views — and their exact SQL)
//   2. identical per-column table_info (type, notnull, default, pk)
//   3. zero surviving rows — the assumption the whole cache rests on
//
// Leg 3 is the fragile one. Nine migrations contain INSERT statements; today every one of
// them lands in a temp table that a later rename discards, so nothing survives. The day a
// migration seeds a real row, the cache would hand every test a schema-only database and
// nothing else in the suite would notice. This test notices.

import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Node 22 provides node:sqlite; the Worker project has no Node runtime dependency.
import { DatabaseSync } from 'node:sqlite'
import {
  applyAllMigrations,
  applyAllMigrationsUncached,
  migrationFiles,
  resetMigrationCache,
} from './helpers/migrations'

interface Sqlite {
  exec(sql: string): void
  prepare(sql: string): { all(...values: unknown[]): Record<string, unknown>[] }
  close(): void
}

function freshDb(): Sqlite {
  const db = new DatabaseSync(':memory:') as Sqlite
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

function schemaObjects(db: Sqlite): string {
  return JSON.stringify(
    db
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all(),
  )
}

function columnShape(db: Sqlite): string {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((row) => String(row.name))
  return tables
    .map((table) => {
      const cols = db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((c) => `${String(c.name)}/${String(c.type)}/${String(c.notnull)}/${String(c.dflt_value)}/${String(c.pk)}`)
      return `${table}:${cols.join(',')}`
    })
    .join('|')
}

afterEach(() => {
  resetMigrationCache()
})

describe('applyAllMigrations — the cached snapshot equals the real chain', () => {
  it('there is a migration chain to apply at all', () => {
    // A guard against the silent-empty-database failure: if migrationFiles() ever returns
    // [], applyAllMigrations succeeds, builds nothing, and every schema test below would
    // compare two empty databases and pass.
    expect(migrationFiles().length).toBeGreaterThan(50)
  })

  it('produces byte-identical sqlite_master to the uncached chain', () => {
    const chain = freshDb()
    applyAllMigrationsUncached(chain)

    resetMigrationCache()
    const warm = freshDb()
    applyAllMigrations(warm) // cold: walks the chain, captures the snapshot
    const cached = freshDb()
    applyAllMigrations(cached) // warm: replays the snapshot

    expect(schemaObjects(cached)).toBe(schemaObjects(chain))
    expect(schemaObjects(warm)).toBe(schemaObjects(chain))

    chain.close()
    warm.close()
    cached.close()
  })

  it('produces identical column types, nullability, defaults and primary keys', () => {
    const chain = freshDb()
    applyAllMigrationsUncached(chain)

    resetMigrationCache()
    const warmUp = freshDb()
    applyAllMigrations(warmUp)
    const cached = freshDb()
    applyAllMigrations(cached)

    expect(columnShape(cached)).toBe(columnShape(chain))

    chain.close()
    warmUp.close()
    cached.close()
  })

  it('the finished chain leaves ZERO rows — the assumption the cache rests on', () => {
    const chain = freshDb()
    applyAllMigrationsUncached(chain)
    const tables = chain
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((row) => String(row.name))
    const seeded = tables
      .map((table) => ({ table, count: Number(chain.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).all()[0]?.c ?? 0) }))
      .filter((entry) => entry.count > 0)

    // If this fails, a migration now seeds data and the DDL snapshot would silently drop
    // it. Fix by teaching applyAllMigrations to replay the rows too — NOT by relaxing this.
    expect(seeded, `migrations now seed rows: ${JSON.stringify(seeded)}`).toEqual([])
    chain.close()
  })

  it('carries the real schema, not an empty one — member_tokens has no `capability` (mupot#684)', () => {
    const db = freshDb()
    applyAllMigrations(db)
    const cols = db
      .prepare('PRAGMA table_info(member_tokens)')
      .all()
      .map((c) => String(c.name))
    expect(cols.length).toBeGreaterThan(0)
    expect(cols).not.toContain('capability')
    expect(cols).toContain('agent_id')
    db.close()
  })
})

describe('applyAllMigrations — fail closed', () => {
  it('surfaces a broken migration instead of building a partial schema', () => {
    const exploding = {
      exec(sql: string) {
        if (sql.includes('CREATE TABLE')) throw new Error('simulated dialect failure')
      },
      prepare() {
        return { all: () => [] }
      },
    }
    expect(() => applyAllMigrationsUncached(exploding)).toThrow(/migrations did not apply cleanly/)
  })
})
