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

/**
 * D1 accepts numbered placeholders (?1, ?2). Node's node:sqlite only accepts
 * anonymous `?`. Rewrite numbered params and remap bind values by index.
 */
function normalizeD1Bindings(sql: string, values: readonly unknown[]): {
  readonly sql: string
  readonly values: readonly unknown[]
} {
  const paramNumbers: number[] = []
  const rewritten = sql.replace(/\?(\d+)/g, (_match, digits: string) => {
    paramNumbers.push(Number(digits))
    return '?'
  })
  if (paramNumbers.length === 0) return { sql, values }
  const remapped: unknown[] = []
  for (let index = 0; index < paramNumbers.length; index += 1) {
    remapped.push(values[paramNumbers[index] - 1])
  }
  return { sql: rewritten, values: remapped }
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

  private prepared() {
    const normalized = normalizeD1Bindings(this.sql, this.values)
    return {
      statement: this.database.prepare(normalized.sql),
      values: normalized.values,
    }
  }

  async first<T = SqliteRow>(columnName?: string): Promise<T | null> {
    const { statement, values } = this.prepared()
    const row = statement.get(...values)
    if (!row) return null
    return (columnName === undefined ? row : row[columnName]) as T
  }

  async all<T = SqliteRow>(): Promise<D1Result<T>> {
    return this.executeAll<T>()
  }

  async run<T = SqliteRow>(): Promise<D1Result<T>> {
    const { statement, values } = this.prepared()
    const info = statement.run(...values)
    return result([], Number(info.changes)) as D1Result<T>
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const { statement, values } = this.prepared()
    const rows = statement.all(...values)
    return rows.map((row) => Object.values(row) as T)
  }

  executeAll<T = SqliteRow>(): D1Result<T> {
    const { statement, values } = this.prepared()
    const rows = statement.all(...values) as T[]
    const changesRow = this.database.prepare('SELECT changes() AS changes').get()
    return result(rows, Number(changesRow?.changes ?? 0))
  }
}

export interface SqliteD1Harness {
  db: D1Database
  sqlite: RawSqliteDatabase
  close(): void
}


// ── #919 strict-batch SQL inspection ──────────────────────────────────────────
// Deliberately crude. These only need to be good enough to name the tables a statement
// touches; a false POSITIVE is a loud failure a human reads, and a false NEGATIVE just
// leaves us where we already are. Precision here is not worth a SQL parser.

const IDENT = '[`"\\[]?([A-Za-z_][A-Za-z0-9_]*)[`"\\]]?'

/** Tables a statement writes. */
export function tablesWritten(sql: string): string[] {
  const out: string[] = []
  const patterns = [
    new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${IDENT}`, 'gi'),
    new RegExp(`\\bUPDATE\\s+${IDENT}`, 'gi'),
    new RegExp(`\\bDELETE\\s+FROM\\s+${IDENT}`, 'gi'),
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(sql)) !== null) out.push(m[1].toLowerCase())
  }
  return out
}

/** Tables a statement reads — FROM/JOIN anywhere, including subqueries and INSERT...SELECT. */
export function tablesRead(sql: string): string[] {
  const out: string[] = []
  // Strip the leading write-target so `UPDATE x SET ...` does not count x as a read.
  const body = sql
    .replace(new RegExp(`^\\s*UPDATE\\s+${IDENT}`, 'i'), ' ')
    .replace(new RegExp(`^\\s*INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${IDENT}\\s*\\([^)]*\\)`, 'i'), ' ')
    .replace(new RegExp(`^\\s*INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${IDENT}`, 'i'), ' ')
    .replace(new RegExp(`^\\s*DELETE\\s+FROM\\s+${IDENT}`, 'i'), ' ')
  for (const re of [
    new RegExp(`\\bFROM\\s+${IDENT}`, 'gi'),
    new RegExp(`\\bJOIN\\s+${IDENT}`, 'gi'),
  ]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      const name = m[1].toLowerCase()
      if (name !== 'json_each' && name !== 'json_tree') out.push(name)
    }
  }
  return out
}

export function createSqliteD1(): SqliteD1Harness {
  const sqlite = new DatabaseSync(':memory:') as RawSqliteDatabase
  sqlite.exec('PRAGMA foreign_keys = ON')

  const db = {
    prepare(sql: string) {
      return new SqliteD1Statement(sqlite, sql) as unknown as D1PreparedStatement
    },
    async batch<T = SqliteRow>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      // STRICT MODE (#919) — OPT-IN, DEFAULT OFF.
      //
      // This harness runs batch() as BEGIN IMMEDIATE + sequential execute + COMMIT, and
      // real SQLite reads its own writes inside a transaction. Production D1 does not:
      // a statement in a batch sees the PRE-BATCH snapshot. So the harness is MORE
      // transactional than the platform it stands for, and it certified mupot#916 as
      // correct for the entire life of the feature — 24 of 46 batch sites carry the same
      // defect and every one of them passes CI green.
      //
      // Strict mode detects the hazard rather than emulating the snapshot: if a statement
      // READS a table an earlier statement in the same batch WROTE, that is the defect,
      // and emulating it would only produce a confusing zero-row result where a named
      // error is clearer. Detection is also deterministic, which emulation would not be.
      //
      // Default is off so this ships without changing any existing test's state. Turning
      // it on is Phase C and is deliberately NOT left to drift — see docs/ops.
      if (process.env.CRG_D1_STRICT_BATCH === '1') {
        const written = new Set<string>()
        statements.forEach((statement, index) => {
          const sql = (statement as unknown as { sql?: string }).sql ?? ''
          for (const table of tablesRead(sql)) {
            if (written.has(table)) {
              throw new Error(
                `D1 batch read-after-write (#919): statement ${index} reads "${table}", ` +
                `which an earlier statement in this batch wrote. On production D1 that ` +
                `read sees the pre-batch snapshot and matches zero rows.\n  SQL: ${sql.slice(0, 200)}`,
              )
            }
          }
          for (const table of tablesWritten(sql)) written.add(table)
        })
      }
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
