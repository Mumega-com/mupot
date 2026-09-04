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
//
// GATE HISTORY (2026-09-04, PR #1300): the `describe` blocks under "F1 —", "F3 —", "F4/F5 —"
// below are the adversarial gate's repro cases, each proven to fail before the corresponding
// fix in src/pots/schema-chain.ts and passing after. See that file's header for the fixes.

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { applyAllMigrations, migrationFiles, resetMigrationCache } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { listMigrationFiles as generatorListMigrationFiles } from '../scripts/gen-schema-chain.mjs'
import {
  SCHEMA_CHAIN,
  SCHEMA_CHAIN_DIGEST,
  SCHEMA_CHAIN_SPLITTER_VERSION,
  type SchemaChainFile,
} from '../src/pots/schema-chain.generated'
import {
  applySchemaChain,
  batchStatements,
  escapeSqlLiteral,
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

type PotSchemaAppliedRow = {
  file: string
  sha256: string
  splitter_version: number
  status: 'started' | 'applied'
  started_at: string
  applied_at: string | null
}

function potSchemaAppliedRows(harness: SqliteD1Harness): PotSchemaAppliedRow[] {
  return harness.sqlite
    .prepare(`SELECT file, sha256, splitter_version, status, started_at, applied_at FROM pot_schema_applied ORDER BY file`)
    .all() as PotSchemaAppliedRow[]
}

/** What pot_schema_applied actually holds right now, in the `alreadyApplied` shape applySchemaChain expects. */
function recordedSetFromDb(harness: SqliteD1Harness): Set<string> {
  return new Set(
    potSchemaAppliedRows(harness).map((row) => recordedKey(row.file, row.sha256, row.splitter_version, row.status)),
  )
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

    // pot_schema_applied and pot_schema_chain_meta are bookkeeping this module owns —
    // exclude them from the schema comparison, since the reference database (built via
    // applyAllMigrations alone) never creates either table.
    const builtObjects = JSON.parse(schemaObjects(built)) as Array<{ name: string }>
    const filtered = builtObjects.filter(
      (o) => o.name !== 'pot_schema_applied' && o.name !== 'pot_schema_chain_meta',
    )
    expect(JSON.stringify(filtered)).toBe(schemaObjects(reference))

    reference.close()
    built.close()
  })

  it('SCHEMA_CHAIN_DIGEST is the sha256 of the splitter version plus the per-file sha256 chain, in order', () => {
    const expected = sha256Hex(
      [String(SCHEMA_CHAIN_SPLITTER_VERSION), ...SCHEMA_CHAIN.map((entry) => entry.sha256)].join('\n'),
    )
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
      recordedKey(chain[0].file, chain[0].sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'applied'),
      recordedKey(chain[1].file, chain[1].sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'applied'),
      recordedKey(tamperedFile.file, 'deadbeef'.repeat(8), SCHEMA_CHAIN_SPLITTER_VERSION, 'applied'), // 64 hex chars, deliberately wrong
    ])

    const result = await applySchemaChain(exec, { alreadyApplied, chain })

    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('content-mismatch')
    expect(result.failed?.file).toBe(tamperedFile.file)
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

  it('fails closed on a splitter-version mismatch, distinct message from a sha256 mismatch', async () => {
    const db = createSqliteD1()
    const exec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 2)
    // Correct sha256, but recorded under a DIFFERENT splitter version than what would run now.
    const alreadyApplied = new Set<string>([
      recordedKey(chain[0].file, chain[0].sha256, SCHEMA_CHAIN_SPLITTER_VERSION + 999, 'applied'),
    ])

    const result = await applySchemaChain(exec, { alreadyApplied, chain })

    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('content-mismatch')
    expect(result.failed?.file).toBe(chain[0].file)
    expect(result.failed?.error).toMatch(/splitter_version/)
    expect(result.applied).toEqual([])

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
    expect(result.failed?.kind).toBe('statement-error')
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
  it('is created and records file + sha256 + splitter_version + status=applied + applied_at for every applied file', async () => {
    const db = createSqliteD1()
    const fixedNow = () => '2026-09-04T00:00:00.000Z'
    const chain = SCHEMA_CHAIN.slice(0, 3)
    const result = await applySchemaChain(execViaSqlite(db), { chain, now: fixedNow })
    expect(result.failed).toBeUndefined()

    const rows = potSchemaAppliedRows(db)
    expect(rows.map((r) => r.file).sort()).toEqual(chain.map((e) => e.file).sort())
    for (const row of rows) {
      const entry = chain.find((e) => e.file === row.file)
      expect(row.sha256).toBe(entry?.sha256)
      expect(row.splitter_version).toBe(SCHEMA_CHAIN_SPLITTER_VERSION)
      expect(row.status).toBe('applied')
      expect(row.applied_at).toBe('2026-09-04T00:00:00.000Z')
    }

    db.close()
  })

  it('`applied` exactly matches the rows actually recorded as status=applied in the database (F4/F5 gate note)', async () => {
    // Direct fix for: "moving `applied.push` above the record write survives 15/15 — nothing
    // ties `applied` to the rows actually written." This test ties them together explicitly.
    const db = createSqliteD1()
    const chain = SCHEMA_CHAIN.slice(0, 5)
    const result = await applySchemaChain(execViaSqlite(db), { chain })
    expect(result.failed).toBeUndefined()

    const appliedInDb = potSchemaAppliedRows(db)
      .filter((r) => r.status === 'applied')
      .map((r) => r.file)
      .sort()
    expect(result.applied.slice().sort()).toEqual(appliedInDb)
    expect(result.applied.length).toBe(chain.length)

    db.close()
  })
})

// ── F1 — mid-file crash leaves a 'started' row; the NEXT run must fail-closed, not replay ──

describe('applySchemaChain — F1: partial-application (crash-then-replay) fails closed instead of bricking', () => {
  it('reproduces the gate scenario: run 1 crashes mid-file, run 2 (fed the real DB state) refuses to replay', async () => {
    const db = createSqliteD1()
    const exec = execViaSqlite(db)

    // Build a 6-file chain whose 4th file's 2nd statement is guaranteed to throw — mirrors
    // the gate's "fail at statement 2 of 0084_subagent_token_telemetry.sql" repro exactly,
    // with a synthetic broken statement standing in for "a network drop mid-file".
    const chain: SchemaChainFile[] = SCHEMA_CHAIN.slice(0, 6).map((entry, i) => {
      if (i !== 3) return entry
      if (entry.statements.length < 2) throw new Error('fixture assumption violated: need >= 2 statements')
      return {
        ...entry,
        statements: [entry.statements[0], 'NOT VALID SQL AT ALL (~!', ...entry.statements.slice(2)],
      }
    })
    const crashedFile = chain[3]

    // Run 1: crashes on crashedFile's statement index 1.
    const run1 = await applySchemaChain(exec, { chain })
    expect(run1.failed?.kind).toBe('statement-error')
    expect(run1.failed?.file).toBe(crashedFile.file)

    // Ground truth: crashedFile is recorded 'started', never 'applied' — this is the F1 marker.
    const row = potSchemaAppliedRows(db).find((r) => r.file === crashedFile.file)
    expect(row).toBeDefined()
    expect(row?.status).toBe('started')
    expect(row?.applied_at).toBeNull()

    // Run 2: the SAME broken chain (nothing fixed the SQL — this models an operator retrying
    // blind), fed the REAL current DB state via recordedSetFromDb (exactly what a correct
    // caller would read before retrying). Before the fix, applySchemaChain would see nothing
    // recorded for crashedFile (the caller never got a chance to see the crash before the
    // process died) and replay from statement 0 — which the gate proved dies on "table
    // already exists" instead of the original, more useful error. After the fix, the
    // recorded 'started' row itself is what run 2 sees, and it refuses outright.
    const alreadyApplied = recordedSetFromDb(db)
    const run2 = await applySchemaChain(exec, { chain, alreadyApplied })

    expect(run2.failed).toBeDefined()
    expect(run2.failed?.kind).toBe('partial-application')
    expect(run2.failed?.file).toBe(crashedFile.file)
    expect(run2.failed?.error).toMatch(/unknown partial state/)
    expect(run2.failed?.error).toMatch(/recreated/)
    // Specifically NOT the "table already exists" shape the gate proved run 2/run 3 produced
    // before this fix — that string must not appear as the reported reason any more.
    expect(run2.failed?.error).not.toMatch(/already exists/)

    db.close()
  })

  it('a `started` row blocks that file even when its recorded sha256 and splitter_version both still match', async () => {
    // Guards against a narrower, "helpful-looking" bug: only checking 'started' when the
    // sha/version DON'T match. A `started` row must be a hard stop unconditionally, because
    // matching sha/version says nothing about whether the file's statements actually finished.
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN[0]
    const alreadyApplied = new Set<string>([
      recordedKey(entry.file, entry.sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'started'),
    ])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], alreadyApplied })
    expect(result.failed?.kind).toBe('partial-application')
    expect(result.applied).toEqual([])
    db.close()
  })
})

// ── F3 — the result must not certify an empty/lied-about database as healthy ───────────

describe('applySchemaChain — F3: ground-truth verification against the real database', () => {
  it('reproduces the gate scenario: alreadyApplied claims files are applied against a VIRGIN database — must fail, not report success', async () => {
    const db = createSqliteD1()
    const chain = SCHEMA_CHAIN.slice(0, 5)
    // The caller claims all 5 are already applied. The database has never seen any of them.
    const lyingAlreadyApplied = new Set<string>(
      chain.map((entry) => recordedKey(entry.file, entry.sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'applied')),
    )

    const result = await applySchemaChain(execViaSqlite(db), { chain, alreadyApplied: lyingAlreadyApplied })

    // Before the fix: { applied: [], skipped: [5 files] }, failed undefined — a clean-looking
    // success that is actually reporting nothing happened against an empty database.
    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('ground-truth-mismatch')
    expect(result.failed?.error).toMatch(/applied row/)

    db.close()
  })

  it('an empty chain is an error, not a success-shaped no-op', async () => {
    const db = createSqliteD1()
    await expect(applySchemaChain(execViaSqlite(db), { chain: [] })).rejects.toThrow(/chain is empty/)
    db.close()
  })

  it('a genuinely fresh, fully-applied chain passes ground truth and records the digest in pot_schema_chain_meta', async () => {
    const db = createSqliteD1()
    const chain = SCHEMA_CHAIN.slice(0, 4)
    const result = await applySchemaChain(execViaSqlite(db), { chain })
    expect(result.failed).toBeUndefined()

    const metaRow = db.sqlite
      .prepare(`SELECT value FROM pot_schema_chain_meta WHERE key = 'digest'`)
      .get() as { value: string } | undefined
    expect(metaRow?.value).toBe(SCHEMA_CHAIN_DIGEST)

    // The ground-truth scratch table/trigger must not leak into the final schema.
    const leaked = db.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE name LIKE '__pot_schema_chain_ground_truth%'`)
      .all()
    expect(leaked).toEqual([])

    db.close()
  })

  it('a correctly-recorded skip-everything run still passes ground truth (not a false positive)', async () => {
    const db = createSqliteD1()
    const exec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 4)

    const first = await applySchemaChain(exec, { chain })
    expect(first.failed).toBeUndefined()

    const alreadyApplied = recordedSetFromDb(db)
    const second = await applySchemaChain(exec, { chain, alreadyApplied })
    expect(second.failed).toBeUndefined()
    expect(second.skipped.length).toBe(chain.length)

    db.close()
  })
})

// ── F4/F5 — unguarded exec() calls, and a plain (non-upsert) bookkeeping INSERT ────────

describe('applySchemaChain — F4/F5: exec() failures around bookkeeping are caught, not thrown raw', () => {
  it('a throw on the bootstrap CREATE TABLE (pot_schema_applied) returns a clean failed result, not an unhandled throw', async () => {
    const exec = async (sql: string) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS pot_schema_applied')) {
        throw new Error('simulated D1 outage on bootstrap')
      }
    }
    const result = await applySchemaChain(exec, { chain: [SCHEMA_CHAIN[0]] })
    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('statement-error')
    expect(result.failed?.error).toMatch(/simulated D1 outage/)
    expect(result.applied).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('a throw on the ground-truth verification step returns a clean failed result with the real applied/skipped so far', async () => {
    const db = createSqliteD1()
    const realExec = execViaSqlite(db)
    let sawGroundTruthInsert = false
    const exec = async (sql: string) => {
      if (sql.includes('INSERT INTO __pot_schema_chain_ground_truth')) {
        sawGroundTruthInsert = true
        throw new Error('simulated network drop on the final verification round trip')
      }
      await realExec(sql)
    }
    const chain = SCHEMA_CHAIN.slice(0, 3)
    const result = await applySchemaChain(exec, { chain })

    expect(sawGroundTruthInsert).toBe(true)
    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('ground-truth-mismatch')
    // Every file genuinely ran — this is exactly the F4 case: a throw here must NOT lose
    // `applied`, which is what the pre-fix unguarded exec() call did.
    expect(result.applied).toEqual(chain.map((e) => e.file))

    db.close()
  })

  it('re-applying a file the database already has (a stale/forgotten `alreadyApplied`) does not throw UNIQUE constraint failed', async () => {
    // F5 repro: the bookkeeping write used to be a plain INSERT. A caller that forgot (or
    // never learned) that a file was already recorded would have that INSERT throw
    // `UNIQUE constraint failed: pot_schema_applied.file` — an unrelated bookkeeping crash
    // masking whatever the real statement outcome was.
    const db = createSqliteD1()
    const exec = execViaSqlite(db)
    const idempotentEntry: SchemaChainFile = {
      file: 'synthetic_idempotent_for_f5.sql',
      sha256: 'a'.repeat(64),
      statements: ['CREATE TABLE IF NOT EXISTS synth_f5_table (id TEXT);'],
    }

    const run1 = await applySchemaChain(exec, { chain: [idempotentEntry] })
    expect(run1.failed).toBeUndefined()
    expect(run1.applied).toEqual([idempotentEntry.file])

    // Run 2: alreadyApplied is empty again, as if the caller never persisted/read run 1's
    // outcome. The bookkeeping row for this file already exists with status='applied'.
    const run2 = await applySchemaChain(exec, { chain: [idempotentEntry] })
    expect(run2.failed).toBeUndefined()
    expect(run2.applied).toEqual([idempotentEntry.file])

    db.close()
  })
})

// ── escapeSqlLiteral — direct + injection-shaped integration proof ─────────────────────

describe('escapeSqlLiteral', () => {
  it('doubles every single quote (SQL string-literal escaping)', () => {
    expect(escapeSqlLiteral(`it's fine`)).toBe(`it''s fine`)
    expect(escapeSqlLiteral(`no quotes here`)).toBe(`no quotes here`)
    expect(escapeSqlLiteral(`'''`)).toBe(`''''''`)
  })

  it('the identity function is NOT a passing substitute — gate note: escapeSqlLiteral -> identity survived 15/15 before this test existed', async () => {
    // A direct, mechanical proof rather than trusting the unit test above alone: run a value
    // that WOULD break out of the SQL string literal and corrupt the table through the real
    // interpolation path (`now`, which schema-chain.ts embeds via escapeSqlLiteral into the
    // bookkeeping INSERT/UPDATE), and confirm the database survives with the exact literal
    // value on record — proof the escaping is live on the path that matters, not just in
    // isolation.
    const db = createSqliteD1()
    const maliciousNow = () => `2026-01-01T00:00:00Z'); DROP TABLE pot_schema_applied; --`
    const entry = SCHEMA_CHAIN[0]
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], now: maliciousNow })

    expect(result.failed).toBeUndefined()
    // If escaping were the identity function, this raw value breaks out of the '...' literal
    // and the crafted suffix runs as its own statement — DROPPING pot_schema_applied. The
    // table surviving, with the row present and its applied_at holding the exact literal
    // string (not truncated, not executed), is the proof escaping is live.
    const rows = potSchemaAppliedRows(db)
    expect(rows.length).toBe(1)
    expect(rows[0].applied_at).toBe(maliciousNow())

    db.close()
  })
})
