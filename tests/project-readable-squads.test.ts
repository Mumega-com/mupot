import { afterEach, describe, expect, it } from 'vitest'
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { resolveReadableSquadIds } from '../src/projects/readable-squads'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

type QueryCall = { sql: string; values: unknown[] }

function probedDb(database: D1Database, calls: QueryCall[]): D1Database {
  return {
    prepare(sql: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => ({
        bind(...values: unknown[]) {
          calls.push({ sql, values })
          return wrap(statement.bind(...values))
        },
        all<T>() {
          return statement.all<T>()
        },
      }) as D1PreparedStatement
      return wrap(database.prepare(sql))
    },
  } as D1Database
}

describe('resolveReadableSquadIds', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('collects complete naturally deduplicated scope through bounded keyset pages', async () => {
    harness = createSqliteD1()
    harness.sqlite.exec(`
      CREATE TABLE squads (id TEXT PRIMARY KEY, department_id TEXT NOT NULL);
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 1200
      )
      INSERT INTO squads (id, department_id)
      SELECT 'squad-' || printf('%04d', n), 'dept' FROM seq;
    `)
    const calls: QueryCall[] = []
    const env = { DB: probedDb(harness.db, calls) } as Env

    const ids = await resolveReadableSquadIds(env, ['squad-1200'], ['dept'])

    expect(ids).toHaveLength(1201)
    expect(new Set(ids).size).toBe(1201)
    expect(ids.at(-1)).toBe('squad-1200')
    expect(calls).toHaveLength(3)
    expect(calls.every((call) => /id > \?3/.test(call.sql) && /ORDER BY id\s+LIMIT \?4/.test(call.sql))).toBe(true)
    expect(calls.map((call) => call.values[2])).toEqual(['', 'squad-0499', 'squad-0999'])
    expect(calls.every((call) => call.values[3] === 500)).toBe(true)
  })

  it('terminates after one empty bounded page', async () => {
    harness = createSqliteD1()
    harness.sqlite.exec('CREATE TABLE squads (id TEXT PRIMARY KEY, department_id TEXT NOT NULL)')
    const calls: QueryCall[] = []
    const env = { DB: probedDb(harness.db, calls) } as Env

    await expect(resolveReadableSquadIds(env, [], [])).resolves.toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.values[3]).toBe(500)
  })
})
