// tests/schema-chain.test.ts — real-SQLite proof that the generated schema chain
// (src/pots/schema-chain.generated.ts) and applySchemaChain (src/pots/schema-chain.ts)
// reproduce the exact same schema applyAllMigrations does, and that applySchemaChain's
// idempotency / fail-closed / batching behavior is correct (mupot#1285 Tier C slice 1).
//
// Schema built via applyAllMigrations per tests/helpers/migrations.ts — the sanctioned
// source (scripts/check-test-schema-source.mjs enforces this repo-wide). This file itself
// builds a SECOND, independent schema by replaying SCHEMA_CHAIN's pre-split statements
// through applySchemaChain, then diffs the two — that comparison IS the point of the file,
// not a violation of the single-schema-source rule (there is no hand-written CREATE TABLE
// or hand-picked migration list here).

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { applyAllMigrations, migrationFiles, resetMigrationCache } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { listMigrationFiles as generatorListMigrationFiles } from '../scripts/gen-schema-chain.mjs'
import { SCHEMA_CHAIN, SCHEMA_CHAIN_DIGEST, type SchemaChainFile } from '../src/pots/schema-chain.generated'
import {
  applySchemaChain,
  batchStatements,
  recordedKey,
  SCHEMA_CHAIN_BATCH_MAX_BYTES,
  SCHEMA_CHAIN_BATCH_MAX_STATEMENTS,
} from '../src/pots/schema-chain'

afterEach(() => {
  resetMigrationCache()
})

// ── helpers ──────────────────────────────────────────────────────────────────────────

function schemaObjects(harness: SqliteD1Harness): string {
  return JSON.stringify(
    harness.sqlite
      .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
      .all(),
  )
}

function execViaSqlite(harness: SqliteD1Harness): (sql: string) => Promise<void> {
  return async (sql: string) => {
    harness.sqlite.exec(sql)
  }
}

/** What pot_schema_applied actually holds right now, in the `alreadyApplied` shape applySchemaChain expects. */
function recordedSetFromDb(harness: SqliteD1Harness): Set<string> {
  const rows = harness.sqlite
    .prepare(`SELECT file, sha256 FROM pot_schema_applied`)
    .all() as Array<{ file: string; sha256: string }>
  return new Set(rows.map((row) => recordedKey(row.file, row.sha256)))
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ── ordering: three independent sources must agree ─────────────────────────────────

describe('migration ordering — the generator must match the sanctioned test helper', () => {
  it('scripts/gen-schema-chain.mjs listMigrationFiles() === tests/helpers/migrations.ts migrationFiles()', () => {
    const fromHelper = migrationFiles()
    const fromGenerator = generatorListMigrationFiles()
    expect(fromHelper.length).toBeGreaterThan(50)
    expect(fromGenerator).toEqual(fromHelper)
  })

  it('the COMMITTED SCHEMA_CHAIN file order matches migrationFiles() too', () => {
    expect(SCHEMA_CHAIN.map((entry) => entry.file)).toEqual(migrationFiles())
  })
})

// ── the split, proven against real SQLite ───────────────────────────────────────────

describe('applySchemaChain — full chain equals the applyAllMigrations reference schema', () => {
  it('applying every SCHEMA_CHAIN file (split statements) reproduces the reference schema exactly', async () => {
    const reference = createSqliteD1()
    applyAllMigrations(reference.sqlite as unknown as Parameters<typeof applyAllMigrations>[0])

    const built = createSqliteD1()
    const result = await applySchemaChain(execViaSqlite(built))

    expect(result.failed).toBeUndefined()
    expect(result.applied.length).toBe(SCHEMA_CHAIN.length)
    expect(result.skipped).toEqual([])

    // pot_schema_applied is bookkeeping this module owns — exclude it from the schema
    // comparison, since the reference database (built via applyAllMigrations alone) never
    // creates that table.
    const builtObjects = JSON.parse(schemaObjects(built)) as Array<{ name: string }>
    const filtered = builtObjects.filter((o) => o.name !== 'pot_schema_applied')
    expect(JSON.stringify(filtered)).toBe(schemaObjects(reference))

    reference.close()
    built.close()
  })

  it('SCHEMA_CHAIN_DIGEST is the sha256 of the per-file sha256 chain, in order', () => {
    const expected = sha256Hex(SCHEMA_CHAIN.map((entry) => entry.sha256).join('\n'))
    expect(SCHEMA_CHAIN_DIGEST).toBe(expected)
  })
})

describe('applySchemaChain — idempotency', () => {
  it('a second run against the same database skips every file (all in `skipped`, none re-applied)', async () => {
    const db = createSqliteD1()
    const exec = execViaSqlite(db)

    const first = await applySchemaChain(exec)
    expect(first.failed).toBeUndefined()
    expect(first.applied.length).toBe(SCHEMA_CHAIN.length)

    const alreadyApplied = recordedSetFromDb(db)
    expect(alreadyApplied.size).toBe(SCHEMA_CHAIN.length)

    const second = await applySchemaChain(exec, { alreadyApplied })
    expect(second.failed).toBeUndefined()
    expect(second.applied).toEqual([])
    expect(second.skipped.length).toBe(SCHEMA_CHAIN.length)

    db.close()
  })
})

describe('applySchemaChain — fails closed on a tampered recorded sha256', () => {
  it('stops at the mismatched file; nothing after it is applied; earlier files are untouched', async () => {
    const db = createSqliteD1()
    const exec = execViaSqlite(db)

    // Build a chain whose 3rd file has been "tampered" — the sha256 we tell applySchemaChain
    // was recorded does not match what's actually in SCHEMA_CHAIN for that file.
    const chain = SCHEMA_CHAIN.slice(0, 6)
    const tamperedFile = chain[2]
    const alreadyApplied = new Set<string>([
      recordedKey(chain[0].file, chain[0].sha256),
      recordedKey(chain[1].file, chain[1].sha256),
      recordedKey(tamperedFile.file, 'deadbeef'.repeat(8)), // 64 hex chars, deliberately wrong
    ])

    const result = await applySchemaChain(exec, { alreadyApplied, chain })

    expect(result.failed).toBeDefined()
    expect(result.failed?.file).toBe(tamperedFile.file)
    expect(result.failed?.statementIndex).toBe(-1)
    expect(result.failed?.error).toMatch(/sha256/)

    // The two files before the tampered one were legitimately recorded — they're reported
    // as skipped, not re-applied.
    expect(result.skipped).toEqual([chain[0].file, chain[1].file])
    // Nothing at or after the tampered file was applied.
    expect(result.applied).toEqual([])

    // Ground truth from the actual database: none of the tables the LATER files (index 3-5)
    // would have created exist, because the loop returned before reaching them.
    const laterFile = chain[5]
    const createdTableNames = laterFile.statements
      .map((s) => /CREATE TABLE(?: IF NOT EXISTS)? ["']?(\w+)["']?/i.exec(s)?.[1])
      .filter((name): name is string => Boolean(name))
    for (const table of createdTableNames) {
      const row = db.sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
        .all(table)
      expect(row.length).toBe(0)
    }

    db.close()
  })
})

describe('applySchemaChain — fails closed on a statement that throws mid-file', () => {
  it('names the failing file + exact statement index; later files are NOT applied', async () => {
    const db = createSqliteD1()
    const realExec = execViaSqlite(db)

    // The 4th file in a 6-file slice has its 2nd statement swapped for something guaranteed
    // to throw against real SQLite. Statement indices before it should have already run;
    // nothing from this file or any later file should.
    const chain: SchemaChainFile[] = SCHEMA_CHAIN.slice(0, 6).map((entry, i) => {
      if (i !== 3) return entry
      if (entry.statements.length < 2) throw new Error('fixture assumption violated: need >= 2 statements')
      return {
        ...entry,
        statements: [entry.statements[0], 'THIS IS NOT VALID SQL AT ALL (~!', ...entry.statements.slice(2)],
      }
    })
    const brokenFile = chain[3]

    const result = await applySchemaChain(realExec, { chain })

    expect(result.failed).toBeDefined()
    expect(result.failed?.file).toBe(brokenFile.file)
    expect(result.failed?.statementIndex).toBe(1)
    expect(result.applied).toEqual(chain.slice(0, 3).map((e) => e.file))
    expect(result.skipped).toEqual([])

    // The broken file's FIRST statement did execute (it came before the failing one) — but
    // the file overall must not appear in `applied`, and no LATER file's objects exist.
    const laterFile = chain[5]
    const createdTableNames = laterFile.statements
      .map((s) => /CREATE TABLE(?: IF NOT EXISTS)? ["']?(\w+)["']?/i.exec(s)?.[1])
      .filter((name): name is string => Boolean(name))
    for (const table of createdTableNames) {
      const row = db.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).all(table)
      expect(row.length).toBe(0)
    }

    db.close()
  })
})

describe('applySchemaChain — trigger-bearing migrations survive the split', () => {
  it('migrations/0008_gate_grants.sql triggers exist in sqlite_master after split-apply', async () => {
    const db = createSqliteD1()
    // 0008's triggers fire on task_verdicts, a table an EARLIER migration creates — apply the
    // chain prefix up to and including 0008, not the file in isolation.
    const index = SCHEMA_CHAIN.findIndex((e) => e.file === '0008_gate_grants.sql')
    expect(index).toBeGreaterThanOrEqual(0)
    const chain = SCHEMA_CHAIN.slice(0, index + 1)

    const result = await applySchemaChain(execViaSqlite(db), { chain })
    expect(result.failed).toBeUndefined()
    expect(result.applied.length).toBe(chain.length)

    const triggers = db.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
      .all()
      .map((r) => String((r as { name: string }).name))
    expect(triggers).toContain('task_verdicts_no_update')
    expect(triggers).toContain('task_verdicts_no_delete')

    db.close()
  })

  it('migrations/0055_projects.sql (CASE nested inside trigger BEGIN...END) survives the split', async () => {
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN.find((e) => e.file === '0055_projects.sql')
    expect(entry).toBeDefined()

    // 0055 depends on tables created by earlier migrations (projects, flights, tasks, ...),
    // so apply the prefix of the chain up to and including it, not the file in isolation.
    const index = SCHEMA_CHAIN.findIndex((e) => e.file === '0055_projects.sql')
    const chain = SCHEMA_CHAIN.slice(0, index + 1)
    const result = await applySchemaChain(execViaSqlite(db), { chain })
    expect(result.failed).toBeUndefined()
    expect(result.applied.length).toBe(chain.length)

    const triggers = db.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name`)
      .all()
      .map((r) => String((r as { name: string }).name))
    expect(triggers).toContain('validate_projects_parent_update')
    expect(triggers).toContain('validate_flights_project_id_update')

    db.close()
  })
})

// ── batching: a standalone, unwired-in-this-slice utility, unit tested on its own ──────

describe('batchStatements', () => {
  it('never splits a single statement across two batches, even when it exceeds maxBytes alone', () => {
    const huge = 'X'.repeat(SCHEMA_CHAIN_BATCH_MAX_BYTES * 2)
    const batches = batchStatements([huge], SCHEMA_CHAIN_BATCH_MAX_BYTES, SCHEMA_CHAIN_BATCH_MAX_STATEMENTS)
    expect(batches).toEqual([[huge]])
  })

  it('respects the byte cap: a batch never exceeds maxBytes unless it holds exactly one statement', () => {
    const maxBytes = 100
    const statements = Array.from({ length: 10 }, (_, i) => `STMT_${i}_`.padEnd(30, 'x'))
    const batches = batchStatements(statements, maxBytes, 1000)
    for (const batch of batches) {
      const bytes = batch.reduce((sum, s) => sum + new TextEncoder().encode(s).length, 0)
      if (batch.length > 1) expect(bytes).toBeLessThanOrEqual(maxBytes)
    }
    // every statement present exactly once, in order
    expect(batches.flat()).toEqual(statements)
  })

  it('respects the statement-count cap', () => {
    const statements = Array.from({ length: 25 }, (_, i) => `S${i};`)
    const batches = batchStatements(statements, 1_000_000, 10)
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(10)
    expect(batches.flat()).toEqual(statements)
  })

  it('empty input yields no batches', () => {
    expect(batchStatements([])).toEqual([])
  })

  it('the real SCHEMA_CHAIN, batched, never splits a statement and respects both caps', () => {
    for (const entry of SCHEMA_CHAIN) {
      const batches = batchStatements(entry.statements)
      expect(batches.flat()).toEqual(entry.statements)
      for (const batch of batches) {
        expect(batch.length).toBeLessThanOrEqual(SCHEMA_CHAIN_BATCH_MAX_STATEMENTS)
        const bytes = batch.reduce((sum, s) => sum + new TextEncoder().encode(s).length, 0)
        if (batch.length > 1) expect(bytes).toBeLessThanOrEqual(SCHEMA_CHAIN_BATCH_MAX_BYTES)
      }
    }
  })
})

describe('applySchemaChain — pot_schema_applied bookkeeping table', () => {
  it('is created and records file + sha256 + applied_at for every applied file', async () => {
    const db = createSqliteD1()
    const fixedNow = () => '2026-09-04T00:00:00.000Z'
    const chain = SCHEMA_CHAIN.slice(0, 3)
    const result = await applySchemaChain(execViaSqlite(db), { chain, now: fixedNow })
    expect(result.failed).toBeUndefined()

    const rows = db.sqlite
      .prepare(`SELECT file, sha256, applied_at FROM pot_schema_applied ORDER BY file`)
      .all() as Array<{ file: string; sha256: string; applied_at: string }>
    expect(rows.map((r) => r.file).sort()).toEqual(chain.map((e) => e.file).sort())
    for (const row of rows) {
      const entry = chain.find((e) => e.file === row.file)
      expect(row.sha256).toBe(entry?.sha256)
      expect(row.applied_at).toBe('2026-09-04T00:00:00.000Z')
    }

    db.close()
  })
})
