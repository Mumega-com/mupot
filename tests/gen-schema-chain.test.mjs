// tests/gen-schema-chain.test.mjs — self-tests for scripts/gen-schema-chain.mjs (mupot#1285
// Tier C slice 1). Pure-logic tests (splitter, ordering, digest, determinism) — no real
// SQLite here; tests/schema-chain.test.ts is where the split output gets proven against a
// real SQLite engine and compared to applyAllMigrations.
//
// Run: node --test tests/gen-schema-chain.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listMigrationFiles,
  splitSqlStatements,
  sha256Hex,
  buildSchemaChainEntries,
  computeChainDigest,
  generateSchemaChainModule,
  SCHEMA_CHAIN_SPLITTER_VERSION,
  DEFAULT_MIGRATIONS_DIR,
} from '../scripts/gen-schema-chain.mjs'
import { DatabaseSync } from 'node:sqlite'

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

// ── splitter: bracket / backtick identifiers (F2 gate fix) ─────────────────────────

test('splitSqlStatements: [bracket-quoted] identifier does not open a false BEGIN/CASE block', () => {
  const sql = "CREATE TABLE t ([begin] TEXT, [end] TEXT, [case] TEXT);\nCREATE TABLE y (id TEXT);"
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2, `expected 2 statements, got ${statements.length}: ${JSON.stringify(statements)}`)
  assert.match(statements[0], /\[begin\]/)
})

test('splitSqlStatements: `backtick-quoted` identifier does not open a false BEGIN/CASE block', () => {
  const sql = 'CREATE TABLE t (`begin` TEXT, `end` TEXT);\nCREATE TABLE y (id TEXT);'
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2, `expected 2 statements, got ${statements.length}: ${JSON.stringify(statements)}`)
  assert.match(statements[0], /`begin`/)
})

test('splitSqlStatements: doubled `` inside a backtick identifier is an escaped backtick, not a close', () => {
  const sql = 'CREATE TABLE t (`a``b` TEXT);\nCREATE TABLE y (id TEXT);'
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
  assert.match(statements[0], /`a``b`/)
})

test('splitSqlStatements: [ ] with no closing bracket runs to end of string, not an infinite loop', () => {
  const sql = 'CREATE TABLE t ([unterminated TEXT);'
  // Must terminate at all (the point of this test) and must not throw for an unrelated reason.
  const statements = splitSqlStatements(sql)
  assert.ok(Array.isArray(statements))
})

// ── splitter: hard fail on an unterminated block (F2 gate fix) — permanent regressions ──
//
// M12 and M13 are the two mutation-style fixture regressions named in the gate verdict on
// PR #1300: constructs that swallowed a whole file into one "statement" and survived every
// check that existed before this fix.

test('M12 — BEGIN TRANSACTION; ... COMMIT; never closes the block counter: hard fail, not a silent 1-statement swallow', () => {
  const sql = 'BEGIN TRANSACTION;\nCREATE TABLE a (id TEXT);\nCOMMIT;\nCREATE TABLE b (id TEXT);'
  assert.throws(
    () => splitSqlStatements(sql, 'M12_fixture.sql'),
    /unterminated BEGIN\/CASE block/,
    'BEGIN TRANSACTION (closed by COMMIT, not END) must hard-fail rather than swallow the rest of the file',
  )
  // The file label must be named in the error, not just "some file somewhere failed".
  try {
    splitSqlStatements(sql, 'M12_fixture.sql')
    assert.fail('expected a throw')
  } catch (error) {
    assert.match(error.message, /M12_fixture\.sql/)
  }
})

test('M13 — CREATE TABLE t([begin] TEXT); is NOT mistaken for a BEGIN keyword (regression, not just the unit test above)', () => {
  const sql = 'CREATE TABLE t([begin] TEXT);\nCREATE TABLE y (id TEXT);'
  // Before the bracket branch existed, "begin" inside the brackets matched the keyword scan,
  // opened a block nothing ever closes, and the file was silently swallowed into one
  // statement — which this splitter now instead treats correctly, needing no END at all.
  const statements = splitSqlStatements(sql, 'M13_fixture.sql')
  assert.equal(statements.length, 2, `expected 2 statements (bracket identifier is not a keyword), got: ${JSON.stringify(statements)}`)
})

test('splitSqlStatements: an unterminated trigger BEGIN with no END hard-fails, naming the file', () => {
  const sql = 'CREATE TRIGGER t BEFORE UPDATE ON x BEGIN\n  SELECT 1;\n'
  assert.throws(() => splitSqlStatements(sql, 'unterminated_trigger.sql'), /unterminated BEGIN\/CASE block/)
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

// ── CORPUS INVARIANT (F2c gate fix): every emitted statement is exactly ONE statement ──

test('CORPUS INVARIANT: every statement emitted for every real migration file is exactly ONE SQL statement, per node:sqlite as an independent oracle', () => {
  // Oracle choice, and why this one: node:sqlite's DatabaseSync.prepare(sql) does NOT throw
  // or reject when handed more than one statement — verified empirically against this Node
  // version — it silently prepares only the FIRST statement and ignores the rest. That
  // silent truncation is exactly what makes `.sourceSQL` usable here: it is the exact
  // substring SQLite's OWN tokenizer consumed as one statement (always trimmed of trailing
  // whitespace — verified separately). If what this splitter emitted as "one statement"
  // actually glues a second real statement onto the first, sourceSQL comes back SHORTER than
  // the text we handed it — a signal that comes from SQLite's tokenizer, not from re-running
  // our own splitter against itself (which would just relocate the blind spot, not close it —
  // see the PR #1300 gate verdict, which named this exact trap).
  //
  // Every statement is also exec()'d in real chain order as it's checked, not merely
  // prepared, so later CREATE TRIGGER / INSERT statements see the schema and data their own
  // dependencies need — the same order applySchemaChain itself runs them in.
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const entries = buildSchemaChainEntries()
  let checked = 0
  for (const entry of entries) {
    for (const stmt of entry.statements) {
      const prepared = db.prepare(stmt)
      const expected = stmt.trim()
      const actual = prepared.sourceSQL.trim()
      assert.equal(
        actual,
        expected,
        `${entry.file}: emitted "statement" is not exactly one SQL statement per node:sqlite's ` +
          `own tokenizer — sourceSQL covers only ${actual.length} of ${expected.length} chars. ` +
          `First 200 chars emitted: ${JSON.stringify(expected.slice(0, 200))}`,
      )
      prepared.run()
      checked += 1
    }
  }
  // Not just "every file produced a well-formed shape" (buildSchemaChainEntries' own test
  // above already covers that) — this pins that a meaningful number of REAL statements were
  // actually walked through the oracle, so the assertion above cannot pass vacuously on an
  // empty or near-empty corpus.
  assert.ok(checked > 900, `expected roughly 955 real statements checked across the corpus, got ${checked}`)
  db.close()
})

test('CORPUS INVARIANT sanity check: a deliberately-broken splitter (return [sql]) IS caught by the oracle above', () => {
  // Proves the invariant test is not vacuous — the exact mutation named in the gate verdict
  // (`return [sql]`, i.e. no splitting at all) must fail this oracle for at least one real
  // migration file that contains more than one statement.
  const entries = buildSchemaChainEntries()
  const multiStatementFile = entries.find((e) => e.statements.length > 1)
  assert.ok(multiStatementFile, 'expected at least one real migration with more than one statement')
  const wholeFileText = readFileSync(join(DEFAULT_MIGRATIONS_DIR, multiStatementFile.file), 'utf8')
  const db = new DatabaseSync(':memory:')
  const prepared = db.prepare(wholeFileText)
  assert.notEqual(
    prepared.sourceSQL.trim(),
    wholeFileText.trim(),
    `return [sql] mutation: ${multiStatementFile.file} has ${multiStatementFile.statements.length} real ` +
      'statements, so treating the whole file as one statement must be caught by the oracle',
  )
  db.close()
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

// ── splitter version (gate fix: sha256 seals migration TEXT, never the splitter) ───────

test('SCHEMA_CHAIN_SPLITTER_VERSION: is a positive integer', () => {
  assert.ok(Number.isInteger(SCHEMA_CHAIN_SPLITTER_VERSION))
  assert.ok(SCHEMA_CHAIN_SPLITTER_VERSION > 0)
})

test('computeChainDigest: changes when ONLY the splitter version changes, file sha256s held fixed', () => {
  // This is the exact gate finding: "the sha256 seals the migration text but not the
  // splitter that produced the statements — fixing the splitter would make every
  // already-provisioned pot skip every file". Mixing the splitter version into the digest
  // formula means a splitter-only change is visible at the aggregate level too, not just in
  // the per-file bookkeeping key (src/pots/schema-chain.ts recordedKey).
  const entries = [{ file: 'a', sha256: sha256Hex('1') }, { file: 'b', sha256: sha256Hex('2') }]
  const digestV1 = computeChainDigest(entries, 1)
  const digestV2 = computeChainDigest(entries, 2)
  assert.notEqual(digestV1, digestV2, 'digest must change when only the splitter version differs')
})

test('generateSchemaChainModule: emits SCHEMA_CHAIN_SPLITTER_VERSION as a real export', () => {
  const source = generateSchemaChainModule()
  assert.match(source, /export const SCHEMA_CHAIN_SPLITTER_VERSION: number = \d+/)
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
