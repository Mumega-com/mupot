// tests/gen-schema-chain.test.mjs — self-tests for scripts/gen-schema-chain.mjs (mupot#1285
// Tier C slice 1). Pure-logic tests (splitter, ordering, digest, determinism) — no real
// SQLite here; tests/schema-chain.test.ts is where the split output gets proven against a
// real SQLite engine and compared to applyAllMigrations.
//
// Run: node --test tests/gen-schema-chain.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listMigrationFiles,
  splitSqlStatements,
  sha256Hex,
  buildSchemaChainEntries,
  computeChainDigest,
  generateSchemaChainModule,
} from '../scripts/gen-schema-chain.mjs'

function withMigrationsDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'gen-schema-chain-test-'))
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ── ordering ─────────────────────────────────────────────────────────────────────────

test('listMigrationFiles: lexicographic sort of *.sql only, non-.sql ignored', () => {
  withMigrationsDir(
    { '0002_b.sql': '', '0001_a.sql': '', '0010_c.sql': '', 'README.md': '', '.gitkeep': '' },
    (dir) => {
      assert.deepEqual(listMigrationFiles(dir), ['0001_a.sql', '0002_b.sql', '0010_c.sql'])
    },
  )
})

test('listMigrationFiles: matches the REAL migrations/ directory ordering rule', () => {
  // tests/helpers/migrations.ts migrationFiles() is readdirSync(...).filter(sql).sort() over
  // the real migrations/ dir. This script's copy of that rule must produce the identical
  // list against the SAME real directory — the authoritative version of this comparison
  // lives in tests/schema-chain.test.ts (which can import the .ts helper directly); this is
  // a second, independent check from the plain-Node side.
  const real = listMigrationFiles()
  assert.ok(real.length > 0, 'expected to find migrations in the real migrations/ dir')
  const sorted = [...real].sort()
  assert.deepEqual(real, sorted, 'listMigrationFiles must already be sorted')
})

// ── splitter: comments and strings ──────────────────────────────────────────────────

test('splitSqlStatements: two plain statements split on the terminating semicolon', () => {
  const sql = "CREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
  assert.match(statements[0], /CREATE TABLE a/)
  assert.match(statements[1], /CREATE TABLE b/)
})

test('splitSqlStatements: semicolon inside a string literal is not a boundary', () => {
  // Real case from migrations/0054_marketing_recommendations.sql.
  const sql = "INSERT INTO x (note) VALUES ('An owner approves; no external change is executed');\nCREATE TABLE y (id TEXT);"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2, `expected 2 statements, got ${statements.length}: ${JSON.stringify(statements)}`)
  assert.match(statements[0], /approves; no external/)
  assert.match(statements[1], /CREATE TABLE y/)
})

test('splitSqlStatements: escaped quote ($$) inside a string literal does not end it early', () => {
  const sql = "INSERT INTO x (note) VALUES ('it''s fine; still one string');\nCREATE TABLE y (id TEXT);"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
  assert.match(statements[0], /it''s fine; still one string/)
})

test('splitSqlStatements: -- line comment does not affect statement boundaries', () => {
  const sql = "-- comment; with a fake terminator\nCREATE TABLE a (id TEXT);\nCREATE TABLE b (id TEXT);"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
})

test('splitSqlStatements: /* block comment */ spanning a semicolon does not split', () => {
  const sql = "CREATE TABLE a (\n  id TEXT /* a comment; with a fake terminator */\n);\nCREATE TABLE b (id TEXT);"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
})

test('splitSqlStatements: trailing comment-only tail after the last statement is dropped', () => {
  const sql = "CREATE TABLE a (id TEXT);\n-- trailing note, no more SQL"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 1)
})

// ── splitter: CREATE TRIGGER ... BEGIN ... END ──────────────────────────────────────

test('splitSqlStatements: naive split(";") WOULD break a trigger — this splitter must not', () => {
  const sql = [
    'CREATE TRIGGER t_no_update',
    'BEFORE UPDATE ON x',
    'BEGIN',
    "  SELECT RAISE(ABORT, 'nope');",
    "  SELECT RAISE(ABORT, 'still nope');",
    'END;',
    'CREATE TABLE y (id TEXT);',
  ].join('\n')

  // Prove the naive approach really would break, so this test is meaningful.
  const naive = sql.split(';').filter((s) => s.trim().length > 0)
  assert.ok(naive.length > 2, 'naive split must fragment the trigger body (sanity check on the fixture)')

  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2, `expected trigger + table as 2 statements, got: ${JSON.stringify(statements)}`)
  assert.match(statements[0], /CREATE TRIGGER t_no_update/)
  assert.match(statements[0], /END;\s*$/)
  assert.match(statements[1], /CREATE TABLE y/)
})

test('splitSqlStatements: CASE...END nested inside a trigger BEGIN...END body survives intact', () => {
  // Real shape from migrations/0055_projects.sql: a CASE expression's own END must not be
  // mistaken for the trigger's closing END, and the internal `;` statements inside the
  // trigger body must not be mistaken for the end of the whole CREATE TRIGGER statement.
  const sql = [
    'CREATE TRIGGER t_case',
    'BEFORE UPDATE ON x',
    'BEGIN',
    "  SELECT RAISE(ABORT, 'a') WHERE json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.k') = 'v';",
    "  SELECT RAISE(ABORT, 'b') WHERE json_extract(CASE WHEN json_valid(NEW.meta) THEN NEW.meta ELSE '{}' END, '$.k2') = 'v2';",
    'END;',
    'CREATE TABLE y (id TEXT);',
  ].join('\n')

  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2, `expected trigger + table as 2 statements, got: ${JSON.stringify(statements)}`)
  assert.match(statements[0], /CREATE TRIGGER t_case/)
  assert.match(statements[0], /RAISE\(ABORT, 'b'\)/)
  assert.match(statements[0], /END;\s*$/)
  assert.match(statements[1], /CREATE TABLE y/)
})

test('splitSqlStatements: top-level CASE...END outside any trigger is not mistaken for an open block', () => {
  const sql = "SELECT CASE WHEN 1 THEN 'a' ELSE 'b' END AS x;\nCREATE TABLE y (id TEXT);"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
})

test('splitSqlStatements: multiple triggers back to back are each their own statement', () => {
  const sql = [
    'CREATE TRIGGER t1 BEFORE UPDATE ON x BEGIN',
    "  SELECT RAISE(ABORT, 'a');",
    'END;',
    'CREATE TRIGGER t2 BEFORE DELETE ON x BEGIN',
    "  SELECT RAISE(ABORT, 'b');",
    'END;',
  ].join('\n')
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
  assert.match(statements[0], /t1/)
  assert.match(statements[1], /t2/)
})

// ── real migrations directory: end-to-end sanity ────────────────────────────────────

test('buildSchemaChainEntries: every real migration file has a well-formed entry', () => {
  // A migration can legitimately produce ZERO statements — migrations/0085_identity_cleanup.sql
  // is 100% comments (a pending-approval no-op, deliberately never uncommented until a human
  // sign-off), and applyAllMigrationsUncached's `sqlite.exec(fileText)` is a harmless no-op for
  // it too. So this only pins the SHAPE of every entry, not a non-zero statement count.
  const entries = buildSchemaChainEntries()
  assert.ok(entries.length > 0)
  for (const entry of entries) {
    assert.ok(Array.isArray(entry.statements), `${entry.file} statements must be an array`)
    assert.equal(entry.sha256.length, 64, `${entry.file} sha256 should be 64 hex chars`)
  }
  const commentOnly = entries.find((e) => e.file === '0085_identity_cleanup.sql')
  assert.ok(commentOnly, 'expected the known comment-only migration to be present')
  assert.deepEqual(commentOnly.statements, [], '0085 is comment-only and must yield zero statements')
})

test('buildSchemaChainEntries: every real CREATE TRIGGER file keeps its trigger statements intact', () => {
  const entries = buildSchemaChainEntries()
  for (const entry of entries) {
    const triggerCount = (entry.statements.join('\n').match(/CREATE TRIGGER/g) ?? []).length
    if (triggerCount === 0) continue
    const triggerStatements = entry.statements.filter((s) => /CREATE TRIGGER/.test(s))
    assert.equal(
      triggerStatements.length,
      triggerCount,
      `${entry.file}: expected each CREATE TRIGGER to be its own statement`,
    )
    for (const stmt of triggerStatements) {
      assert.match(stmt, /END;\s*$/, `${entry.file}: trigger statement must end with END;`)
    }
  }
})

// ── digest and module generation ────────────────────────────────────────────────────

test('sha256Hex: stable, 64 hex chars, sensitive to content', () => {
  const a = sha256Hex('hello')
  const b = sha256Hex('hello')
  const c = sha256Hex('hello!')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.match(a, /^[0-9a-f]{64}$/)
})

test('computeChainDigest: changes when any file sha256 changes', () => {
  const entriesA = [{ file: 'a', sha256: sha256Hex('1') }, { file: 'b', sha256: sha256Hex('2') }]
  const entriesB = [{ file: 'a', sha256: sha256Hex('1') }, { file: 'b', sha256: sha256Hex('3') }]
  assert.notEqual(computeChainDigest(entriesA), computeChainDigest(entriesB))
})

test('generateSchemaChainModule: deterministic — two runs produce byte-identical output', () => {
  const a = generateSchemaChainModule()
  const b = generateSchemaChainModule()
  assert.equal(a, b)
})

test('generateSchemaChainModule: reacts to a migrations directory change (no stale caching)', () => {
  withMigrationsDir({ '0001_a.sql': 'CREATE TABLE a (id TEXT);' }, (dir) => {
    const before = generateSchemaChainModule(dir)
    writeFileSync(join(dir, '0002_b.sql'), 'CREATE TABLE b (id TEXT);', 'utf8')
    const after = generateSchemaChainModule(dir)
    assert.notEqual(before, after)
    assert.match(after, /0002_b\.sql/)
  })
})
