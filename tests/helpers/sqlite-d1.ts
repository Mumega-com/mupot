// @ts-expect-error Node 22 provides node:sqlite; the Worker project intentionally has no Node runtime dependency.
import { DatabaseSync } from 'node:sqlite'
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types'

type SqliteRow = Record<string, unknown>

interface RawSqliteDatabase {
  close(): void
  exec(sql: string): void
  prepare(sql: string): {
    all(...values: unknown[]): SqliteRow[]
    get(...values: unknown[]): SqliteRow | undefined
    run(...values: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  }
}

function result<T>(rows: T[], changes: number): D1Result<T> {
  return {
    success: true,
    results: rows,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: rows.length,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  }
}

class SqliteD1Statement {
  constructor(
    private readonly database: RawSqliteDatabase,
    readonly sql: string,
    readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(this.database, this.sql, values) as unknown as D1PreparedStatement
  }

  async first<T = SqliteRow>(columnName?: string): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values)
    if (!row) return null
    return (columnName === undefined ? row : row[columnName]) as T
  }

  async all<T = SqliteRow>(): Promise<D1Result<T>> {
    return this.executeAll<T>()
  }

  async run<T = SqliteRow>(): Promise<D1Result<T>> {
    const info = this.database.prepare(this.sql).run(...this.values)
    return result([], Number(info.changes)) as D1Result<T>
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.database.prepare(this.sql).all(...this.values)
    return rows.map((row) => Object.values(row) as T)
  }

  executeAll<T = SqliteRow>(): D1Result<T> {
    const rows = this.database.prepare(this.sql).all(...this.values) as T[]
    const changesRow = this.database.prepare('SELECT changes() AS changes').get()
    return result(rows, Number(changesRow?.changes ?? 0))
  }
}

export interface SqliteD1Harness {
  db: D1Database
  sqlite: RawSqliteDatabase
  close(): void
}

export function createSqliteD1(): SqliteD1Harness {
  const sqlite = new DatabaseSync(':memory:') as RawSqliteDatabase
  sqlite.exec('PRAGMA foreign_keys = ON')

  const db = {
    prepare(sql: string) {
      return new SqliteD1Statement(sqlite, sql) as unknown as D1PreparedStatement
    },
    async batch<T = SqliteRow>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const outcomes = statements.map((statement) => (
          (statement as unknown as SqliteD1Statement).executeAll<T>()
        ))
        sqlite.exec('COMMIT')
        return outcomes
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
  } as unknown as D1Database

  return { db, sqlite, close: () => sqlite.close() }
}
