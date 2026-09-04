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
  assertSafeInteger,
  batchStatements,
  escapeSqlLiteral,
  recordedKey,
  selectGroundTruthProbes,
  POT_SCHEMA_APPLIED_TABLE_SQL,
  POT_SCHEMA_CHAIN_META_TABLE_SQL,
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

  it('a `started` row WITH a genuine trace in the database blocks that file even when its recorded sha256 and splitter_version both still match', async () => {
    // Guards against a narrower, "helpful-looking" bug: only checking 'started' when the
    // sha/version DON'T match. Matching sha/version says nothing about whether the file's
    // statements actually finished.
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN[0]
    await execViaSqlite(db)(entry.statements[0])
    const alreadyApplied = new Set<string>([
      recordedKey(entry.file, entry.sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'started'),
    ])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], alreadyApplied })
    expect(result.failed?.kind).toBe('partial-application')
    expect(result.applied).toEqual([])
    db.close()
  })

  it('ROUND 4 gate fix — a `started` row for a file WITH statements is unconditionally hard-blocked, even on a VIRGIN database where nothing of the file ran', async () => {
    // Round 3's K2 fix tried to distinguish "nothing ran" from "genuine partial state" by
    // probing the real database for a trace of the file's own created objects
    // (fileHasTraceInDatabase, since deleted) — a virgin database with a 'started' row used to
    // be RETRIED here, not blocked. The gate proved that unsafe: 29 of the 134 committed
    // migrations run an ALTER/UPDATE/INSERT before their first CREATE, so a crash in that
    // window leaves the database dirty (non-idempotent DML already ran) with NO object trace
    // — exactly what the K2 check read as "safe to retry," reproducing the original F1 brick
    // one door over. This test is the direct regression guard for that: a virgin database
    // (nothing has run, no manufactured trace) with a 'started' row for a file that HAS
    // statements must be hard-blocked, full stop — proving fileHasTraceInDatabase-style
    // database-probing is gone, not just renamed.
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

  it('the reviewer\'s LITERAL example: a comment-only, zero-statement migration marked \'started\' must not be condemned over a no-op', async () => {
    // The ONE exception that survives round 4: a file with ZERO statements cannot possibly
    // have run anything, so this needs no database query at all — see the 'started' branch in
    // applySchemaChain.
    const db = createSqliteD1()
    const commentOnly = SCHEMA_CHAIN.find((e) => e.file === '0085_identity_cleanup.sql')
    expect(commentOnly).toBeDefined()
    if (!commentOnly) throw new Error('unreachable')
    expect(commentOnly.statements).toEqual([]) // sanity: this really is the zero-statement file
    const alreadyApplied = new Set<string>([
      recordedKey(commentOnly.file, commentOnly.sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'started'),
    ])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [commentOnly], alreadyApplied })
    expect(result.failed).toBeUndefined()
    expect(result.applied).toEqual([commentOnly.file])
    db.close()
  })

  it('a `started` row for a file with statements but NO detectable created objects (pure DML/ALTER) is hard-blocked too — same rule, no special case any more', async () => {
    const db = createSqliteD1()
    const dmlOnlyEntry: SchemaChainFile = {
      file: 'synthetic_dml_only.sql',
      sha256: 'b'.repeat(64),
      statements: ["INSERT INTO nonexistent (id) VALUES ('x');"],
      objects: [],
    }
    const alreadyApplied = new Set<string>([
      recordedKey(dmlOnlyEntry.file, dmlOnlyEntry.sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'started'),
    ])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [dmlOnlyEntry], alreadyApplied })
    expect(result.failed?.kind).toBe('partial-application')
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

  it('the digest RAISE clause is load-bearing: an exec() that silently no-ops the pot_schema_chain_meta write (reports success without persisting it) is caught, not treated as success', async () => {
    // Direct mutation-guard for the digest clause in verifyGroundTruth's raiseClauses: deleting
    // that clause entirely survives every other test in this file (nothing else in the suite
    // observes it, since recordDigestSql unconditionally overwrites the digest to the correct
    // value immediately before verifyGroundTruth runs on every normal path — see the C6 doc
    // note on what this clause can and cannot detect). The one thing it CAN catch is an exec()
    // that reports success on the digest INSERT without actually persisting it — simulated
    // here directly, rather than asserted only in prose.
    const db = createSqliteD1()
    const realExec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 4)
    const exec = async (sql: string) => {
      if (sql.startsWith('INSERT INTO pot_schema_chain_meta')) {
        return // silently no-op — the exact failure mode the digest clause exists to catch
      }
      await realExec(sql)
    }
    const result = await applySchemaChain(exec, { chain })
    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('ground-truth-mismatch')
    expect(result.failed?.error).toMatch(/digest does not match/)
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

// ── K1 — ground truth must check REAL schema objects, not just this module's own bookkeeping ──

describe('applySchemaChain — K1 (round 3): verifyGroundTruth is not a tautology over pot_schema_applied/pot_schema_chain_meta', () => {
  it('reproduces the exact gate scenario: HONESTLY-populated pot_schema_applied (real rows, correct sha256s, matching digest) but ZERO real schema objects exist — must fail, not report success', async () => {
    // The F3 fix (round 2) only checked pot_schema_applied's ROW COUNT and pot_schema_chain_
    // meta's digest — both tables THIS MODULE owns. The gate proved that is a tautology: seed
    // those two tables "honestly" (real rows, not just a caller's in-memory claim) with
    // correct counts and a correct digest, and the check passes even though not one real
    // CREATE TABLE from the actual migrations ever ran. This test does exactly that — writes
    // directly to pot_schema_applied/pot_schema_chain_meta via `exec`, bypassing
    // applySchemaChain's own statement loop entirely — then calls applySchemaChain with an
    // `alreadyApplied` that matches those honest rows, so every file is skipped and the ONLY
    // thing under test is whether ground truth can be fooled by consistent-but-fake
    // bookkeeping.
    const db = createSqliteD1()
    const exec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 4)

    await exec(POT_SCHEMA_APPLIED_TABLE_SQL)
    await exec(POT_SCHEMA_CHAIN_META_TABLE_SQL)
    const alreadyApplied = new Set<string>()
    for (const entry of chain) {
      await exec(
        `INSERT INTO pot_schema_applied (file, sha256, splitter_version, status, started_at, applied_at) ` +
          `VALUES ('${entry.file}', '${entry.sha256}', ${SCHEMA_CHAIN_SPLITTER_VERSION}, 'applied', ` +
          `'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');`,
      )
      alreadyApplied.add(recordedKey(entry.file, entry.sha256, SCHEMA_CHAIN_SPLITTER_VERSION, 'applied'))
    }
    const expectedDigest = sha256Hex(
      [String(SCHEMA_CHAIN_SPLITTER_VERSION), ...chain.map((e) => e.sha256)].join('\n'),
    )
    await exec(`INSERT INTO pot_schema_chain_meta (key, value) VALUES ('digest', '${expectedDigest}');`)

    // Sanity: the OLD bookkeeping-only facts genuinely do match here — this is not a case the
    // count/digest checks alone would have caught either way.
    const countRow = db.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM pot_schema_applied WHERE status = 'applied'`)
      .get() as { n: number }
    expect(countRow.n).toBe(chain.length)

    const result = await applySchemaChain(exec, { chain, alreadyApplied })

    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('ground-truth-mismatch')
    expect(result.failed?.error).toMatch(/no (table|index|trigger|view) named/)

    db.close()
  })

  it('C6: a stale `applied` row for a file no longer in the current chain (a renamed/squashed migration) does not permanently fail ground truth for an otherwise healthy pot', async () => {
    // Gate note: "an applied row for a migration since renamed or squashed permanently fails
    // the count, which is unscoped to the chain." Before the C6 fix, the count query counted
    // EVERY 'applied' row in pot_schema_applied regardless of whether its file is still part
    // of the chain being verified — so a stray leftover row from a rename/squash inflated the
    // count above chain.length forever, failing ground truth on an otherwise perfectly
    // healthy, fully up-to-date pot.
    const db = createSqliteD1()
    const exec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 4)

    const first = await applySchemaChain(exec, { chain })
    expect(first.failed).toBeUndefined()

    await exec(
      `INSERT INTO pot_schema_applied (file, sha256, splitter_version, status, started_at, applied_at) ` +
        `VALUES ('old_removed_migration.sql', '${'a'.repeat(64)}', ${SCHEMA_CHAIN_SPLITTER_VERSION}, ` +
        `'applied', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');`,
    )

    const alreadyApplied = recordedSetFromDb(db)
    const second = await applySchemaChain(exec, { chain, alreadyApplied })
    expect(second.failed).toBeUndefined()

    db.close()
  })

  it('the real SCHEMA_CHAIN chosen probes survive to the end of the full chain (0042\'s tasks_new rename-away is correctly skipped as a probe candidate)', async () => {
    // Regression for a real bug caught while building this fix: the FIRST version of
    // selectGroundTruthProbes picked entry.objects[0] blindly. migrations/0042_task_status_
    // gate_values.sql creates `tasks_new`, then (same file) DROPs `tasks` and RENAMEs
    // `tasks_new` TO `tasks` — so `tasks_new` never exists under that name once the chain
    // finishes, and probing for it after a full, genuinely correct apply would fail on a
    // HEALTHY database. This runs the full real chain and confirms ground truth passes.
    const db = createSqliteD1()
    const result = await applySchemaChain(execViaSqlite(db), { chain: SCHEMA_CHAIN })
    expect(result.failed).toBeUndefined()
    db.close()
  })
})

// ── ROUND 4 — the K1 fix itself was a 5-of-115 sample; probing must cover EVERY file ────

describe('applySchemaChain — ROUND 4: selectGroundTruthProbes probes every object-creating file, not a sample', () => {
  it('the real SCHEMA_CHAIN yields a non-empty probe list, and one probe per object-creating, surviving-object file — never a fixed-size sample', () => {
    // Direct assertion for the gate note: "assert that the real SCHEMA_CHAIN yields a
    // non-empty probe list, so an empty list can never silently restore the tautology." Also
    // proves the count scales with the CORPUS, not a constant like the old `fractions.length`
    // (5) — if a future regression reintroduced any fixed-size sample, this would go red the
    // moment the corpus has more than that many probeable files, which it already does.
    const probes = selectGroundTruthProbes(SCHEMA_CHAIN)
    expect(probes.length).toBeGreaterThan(5)

    const withSurvivingObject = SCHEMA_CHAIN.filter((entry) => entry.objects.length > 0).length
    // Not every object-creating file necessarily contributes a probe (all of its objects could
    // be dropped/renamed away later — see objectSurvivesRestOfChain) so this is an upper bound,
    // not exact equality, but it must be in the same ballpark as "every file," not "5".
    expect(probes.length).toBeGreaterThan(withSurvivingObject * 0.9)
    expect(probes.length).toBeLessThanOrEqual(withSurvivingObject)

    // Every probed file must be distinct (one probe per file, not per object).
    expect(new Set(probes.map((p) => p.file)).size).toBe(probes.length)
  })

  it('wiping an arbitrary mid-chain file — deliberately one the OLD 5-point 0/25/50/75/100% sample would never have picked — is caught', async () => {
    // Round 3's sample walked `fractions = [0, 0.25, 0.5, 0.75, 1]` over the object-creating
    // files, by POSITION in that sub-list. The gate proved dropping any of the other ~110
    // files' objects passed clean. This test picks one such file (a real one, not a synthetic
    // fixture) by computing what the OLD algorithm would have selected and choosing a
    // different index, applies the REAL full chain, wipes only that file's surviving object,
    // and confirms ground truth now fails and names it — the direct proof that probing covers
    // every file, not five.
    const withObjects = SCHEMA_CHAIN.map((entry, index) => ({ entry, index })).filter(
      ({ entry }) => entry.objects.length > 0,
    )
    expect(withObjects.length).toBeGreaterThan(20) // sanity: corpus is large enough for this to mean something

    const legacyFractions = [0, 0.25, 0.5, 0.75, 1]
    const legacyIndices = new Set(
      legacyFractions.map((f) => Math.min(withObjects.length - 1, Math.floor(f * (withObjects.length - 1)))),
    )
    const targetPos = withObjects.findIndex((_, i) => !legacyIndices.has(i))
    expect(targetPos).toBeGreaterThanOrEqual(0) // sanity: such a position exists
    const target = withObjects[targetPos]

    const db = createSqliteD1()
    const exec = execViaSqlite(db)
    const first = await applySchemaChain(exec, { chain: SCHEMA_CHAIN })
    expect(first.failed).toBeUndefined()

    // Find one real object this file created that survived to the end of the chain (i.e. it
    // is actually present in the final schema) and drop it directly — simulating a
    // splitter/apply bug that silently lost exactly this one migration deep in the corpus.
    const survivingObject = target.entry.objects.find((obj) =>
      db.sqlite.prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`).get(obj.type, obj.name),
    )
    expect(survivingObject).toBeDefined()
    if (!survivingObject) throw new Error('unreachable')
    db.sqlite.exec(`DROP ${survivingObject.type.toUpperCase()} ${survivingObject.name};`)

    const alreadyApplied = recordedSetFromDb(db)
    const second = await applySchemaChain(exec, { chain: SCHEMA_CHAIN, alreadyApplied })
    expect(second.failed).toBeDefined()
    expect(second.failed?.kind).toBe('ground-truth-mismatch')
    expect(second.failed?.error).toContain(target.entry.file)

    db.close()
  })
})

// ── C7 — verifyGroundTruth's cleanup must not replace the original diagnostic ──────────

describe('applySchemaChain — C7 (round 3): a cleanup failure inside verifyGroundTruth does not clobber the real error', () => {
  it('when the ground-truth INSERT fails AND the cleanup DROP calls also fail, the reported error is the ORIGINAL ground-truth failure, not the cleanup failure', async () => {
    const db = createSqliteD1()
    const realExec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 4)
    let sawGroundTruthInsert = false
    const exec = async (sql: string) => {
      if (sql.includes('INSERT INTO __pot_schema_chain_ground_truth')) {
        sawGroundTruthInsert = true
        throw new Error('ORIGINAL: real ground-truth mismatch')
      }
      if (sawGroundTruthInsert && sql.startsWith('DROP')) {
        // Simulate the cleanup calls ALSO failing (e.g. the same dropped connection that
        // caused the ground-truth check to fail in the first place).
        throw new Error('SECONDARY: cleanup DROP failed too')
      }
      await realExec(sql)
    }

    const result = await applySchemaChain(exec, { chain })

    expect(sawGroundTruthInsert).toBe(true)
    expect(result.failed).toBeDefined()
    expect(result.failed?.kind).toBe('ground-truth-mismatch')
    // The C7 fix: the ORIGINAL error must be what's reported, not the cleanup's.
    expect(result.failed?.error).toMatch(/ORIGINAL: real ground-truth mismatch/)
    expect(result.failed?.error).not.toMatch(/SECONDARY/)

    db.close()
  })
})

// ── C5 — recordedEntryFor fails CLOSED on a malformed bookkeeping entry, not open ──────

describe('applySchemaChain — C5 (round 3): a malformed alreadyApplied entry is a hard failure, never silently "not recorded"', () => {
  // NUL (\u0000) is the REAL field separator recordedKey uses (see RECORDED_KEY_SEP in
  // src/pots/schema-chain.ts) — a plain space would not even match the file's prefix check
  // and would just look like "not recorded" without ever reaching the malformed-entry logic
  // these tests exist to exercise. Every fixture below builds on that real separator.
  //
  // ROUND 4 gate fix: these used to assert applySchemaChain REJECTS (throws) on a malformed
  // entry — that was itself a bug this round closes (recordedEntryFor's throw was unwrapped
  // inside the file loop, discarding applied/skipped for files that already succeeded). It now
  // resolves with a typed `failed.kind === 'malformed-bookkeeping'` result instead, like every
  // other failure path in this module. See the 'preserves applied/skipped' test below.
  const SEP = '\u0000'

  it('an entry with the wrong number of fields after the file prefix is a malformed-bookkeeping failure, rather than being treated as unrecorded and replayed', async () => {
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN[0]
    const malformed = new Set<string>([`${entry.file}${SEP}onlyonefield`])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], alreadyApplied: malformed })
    expect(result.failed?.kind).toBe('malformed-bookkeeping')
    expect(result.failed?.error).toMatch(/malformed bookkeeping entry/)
    db.close()
  })

  it('an entry with an unknown status is a malformed-bookkeeping failure, rather than being silently skipped', async () => {
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN[0]
    const malformed = new Set<string>([`${entry.file}${SEP}${entry.sha256}${SEP}${SCHEMA_CHAIN_SPLITTER_VERSION}${SEP}bogus_status`])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], alreadyApplied: malformed })
    expect(result.failed?.kind).toBe('malformed-bookkeeping')
    expect(result.failed?.error).toMatch(/unknown status/)
    db.close()
  })

  it('the empty-string-is-zero trap: an entry with an EMPTY splitter-version field is a malformed-bookkeeping failure, not a silent parse as version 0', async () => {
    // Number('') === 0, and Number.isInteger(0) === true — a truncated/corrupted key (e.g.
    // from a double separator) with an empty splitter-version field used to misparse as "a
    // real version 0" rather than being caught as malformed. This is the gate's named trap.
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN[0]
    const malformed = new Set<string>([`${entry.file}${SEP}${entry.sha256}${SEP}${SEP}applied`])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], alreadyApplied: malformed })
    expect(result.failed?.kind).toBe('malformed-bookkeeping')
    expect(result.failed?.error).toMatch(/not a non-negative integer literal/)
    db.close()
  })

  it('an entry with a non-digit (e.g. negative or decimal) splitter-version field is a malformed-bookkeeping failure', async () => {
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN[0]
    const malformed = new Set<string>([`${entry.file}${SEP}${entry.sha256}${SEP}-1${SEP}applied`])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], alreadyApplied: malformed })
    expect(result.failed?.kind).toBe('malformed-bookkeeping')
    expect(result.failed?.error).toMatch(/not a non-negative integer literal/)
    db.close()
  })

  it('an entry with an empty sha256 field is a malformed-bookkeeping failure', async () => {
    const db = createSqliteD1()
    const entry = SCHEMA_CHAIN[0]
    const malformed = new Set<string>([`${entry.file}${SEP}${SEP}1${SEP}applied`])
    const result = await applySchemaChain(execViaSqlite(db), { chain: [entry], alreadyApplied: malformed })
    expect(result.failed?.kind).toBe('malformed-bookkeeping')
    expect(result.failed?.error).toMatch(/empty sha256/)
    db.close()
  })

  it('ROUND 4 regression: preserves applied/skipped — a malformed entry hit partway through a multi-file chain does not lose the files that already succeeded (the F4 class, one door over)', async () => {
    // Before this round, recordedEntryFor's throw was unwrapped inside the file loop and
    // propagated straight out of applySchemaChain as a rejected promise — discarding
    // `applied`/`skipped` even though earlier files in the SAME run had genuinely succeeded.
    const db = createSqliteD1()
    const exec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 3)
    const malformed = new Set<string>([`${chain[2].file}${SEP}onlyonefield`])
    const result = await applySchemaChain(exec, { chain, alreadyApplied: malformed })
    expect(result.failed?.kind).toBe('malformed-bookkeeping')
    expect(result.failed?.file).toBe(chain[2].file)
    // The first two files genuinely ran (nothing claims them as already applied) and must be
    // visible in `applied`, not silently discarded by the third file's malformed entry.
    expect(result.applied).toEqual([chain[0].file, chain[1].file])
    db.close()
  })

  it('a malformed entry for a DIFFERENT (unrelated) file does not affect lookup or application of the real chain files', async () => {
    // The malformed-entry check only inspects entries whose prefix matches the file being
    // looked up — a garbage entry for some OTHER file must not affect this one. Both real
    // chain files apply FRESH here (nothing claims them as already applied), so a clean
    // success (including ground truth, which now checks real objects) proves the garbage
    // entry for an unrelated file was ignored rather than tripping anything.
    const db = createSqliteD1()
    const chain = SCHEMA_CHAIN.slice(0, 2)
    const garbageForAnotherFile = `totally_unrelated_file.sql${SEP}garbage`
    const alreadyApplied = new Set<string>([garbageForAnotherFile])
    const result = await applySchemaChain(execViaSqlite(db), { chain, alreadyApplied })
    expect(result.failed).toBeUndefined()
    expect(result.skipped).toEqual([])
    expect(result.applied).toEqual([chain[0].file, chain[1].file])
    db.close()
  })
})


// ── M15 — assertSafeInteger's guard must be directly, not just incidentally, verified ──

describe('assertSafeInteger', () => {
  it('accepts a non-negative integer and returns it unchanged', () => {
    expect(assertSafeInteger(0, 'x')).toBe(0)
    expect(assertSafeInteger(42, 'x')).toBe(42)
  })

  it('rejects a negative number', () => {
    expect(() => assertSafeInteger(-1, 'x')).toThrow(/non-negative integer/)
  })

  it('rejects a non-integer (float)', () => {
    expect(() => assertSafeInteger(1.5, 'x')).toThrow(/non-negative integer/)
  })

  it('rejects NaN and Infinity', () => {
    expect(() => assertSafeInteger(Number.NaN, 'x')).toThrow(/non-negative integer/)
    expect(() => assertSafeInteger(Number.POSITIVE_INFINITY, 'x')).toThrow(/non-negative integer/)
  })

  it('live on the path that matters: an invalid splitterVersion override is rejected through the public applySchemaChain API, not just in isolation', async () => {
    const db = createSqliteD1()
    const result = await applySchemaChain(execViaSqlite(db), { chain: [SCHEMA_CHAIN[0]], splitterVersion: -1 })
    expect(result.failed).toBeDefined()
    expect(result.failed?.error).toMatch(/non-negative integer/)
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
      objects: [{ type: 'table', name: 'synth_f5_table' }],
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

  it('a file never lands in `applied` when the write that marks it applied itself fails (guards the applied.push ordering)', async () => {
    // Gate note: "moving `applied.push` above the record write survives 15/15 — nothing ties
    // `applied` to the rows actually written." This test forces exactly that write to fail
    // and asserts `applied` reflects reality — it can only pass if `applied.push` runs AFTER
    // the write that marks the file 'applied' succeeds, not before.
    const db = createSqliteD1()
    const realExec = execViaSqlite(db)
    const chain = SCHEMA_CHAIN.slice(0, 2)
    const targetFile = chain[1].file
    const exec = async (sql: string) => {
      if (sql.startsWith('UPDATE pot_schema_applied SET status') && sql.includes(`WHERE file = '${targetFile}'`)) {
        throw new Error('simulated failure writing the applied marker')
      }
      await realExec(sql)
    }

    const result = await applySchemaChain(exec, { chain })

    expect(result.failed).toBeDefined()
    expect(result.failed?.file).toBe(targetFile)
    // The file whose applied-write failed must NOT be in `applied` — its statements ran, but
    // the bookkeeping never confirmed it, so callers must not be told it is done.
    expect(result.applied).not.toContain(targetFile)
    expect(result.applied).toEqual([chain[0].file])

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
