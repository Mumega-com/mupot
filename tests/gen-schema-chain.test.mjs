// tests/gen-schema-chain.test.mjs — self-tests for scripts/gen-schema-chain.mjs (mupot#1285
// Tier C slice 1). Pure-logic tests (splitter, ordering, digest, determinism) — no real
// SQLite here; tests/schema-chain.test.ts is where the split output gets proven against a
// real SQLite engine and compared to applyAllMigrations.
//
// Run: node --test tests/gen-schema-chain.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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
  extractCreatedObjects,
  splitterSourceText,
  assertSplitterVersionMatchesSource,
  SPLITTER_SOURCE_SHA256_BY_VERSION,
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

test('splitSqlStatements: `backtick-quoted` identifier does not open a false BEGIN/CASE block (UNBALANCED fixture — pins the branch itself, gate M14)', () => {
  // Gate finding on PR #1300, round 3: the ORIGINAL version of this test paired `begin` with
  // `end` in the same statement. Deleting the entire backtick branch left 29/29 vitest and
  // 30/30 node green anyway, because with the branch gone, the bare words BEGIN and END
  // inside the backticks are scanned as the real keywords — blockDepth goes 0 -> 1 (BEGIN) ->
  // 0 (END) -> back to zero by COINCIDENCE, and the file still "looks" correctly split. A
  // fixture that can pass whether or not the branch exists proves nothing about the branch.
  //
  // This fixture uses `begin` ALONE, with NO matching `end` anywhere in the file. With the
  // backtick branch present, `` `begin` `` is consumed whole as an opaque identifier and never
  // reaches the keyword scan — blockDepth stays 0, the file splits into 2 statements cleanly.
  // With the branch removed, the bare word BEGIN inside the backticks IS scanned as the
  // keyword, opens a block nothing in the file ever closes, and generation now hard-fails
  // with "unterminated BEGIN/CASE block" instead of returning 2 statements — an assertion
  // that can actually tell the branch was removed.
  const sql = 'CREATE TABLE t (`begin` TEXT);\nCREATE TABLE y (id TEXT);'
  const statements = splitSqlStatements(sql, 'unbalanced_backtick.sql')
  assert.equal(statements.length, 2, `expected 2 statements, got ${statements.length}: ${JSON.stringify(statements)}`)
  assert.match(statements[0], /`begin`/)
})

test('splitSqlStatements: doubled `` inside a backtick identifier is an escaped backtick, not a close', () => {
  const sql = 'CREATE TABLE t (`a``b` TEXT);\nCREATE TABLE y (id TEXT);'
  const statements = splitSqlStatements(sql)
  assert.equal(statements.length, 2)
  assert.match(statements[0], /`a``b`/)
})

test('splitSqlStatements: [ ] with no closing bracket hard-fails at end of file (C4 gate fix) — was a vacuous assertion, gate note on gen-schema-chain.test.mjs:194', () => {
  // The ORIGINAL version of this test only asserted `Array.isArray(statements)` — true for
  // ANY return value the function could produce, so it could not fail for the reason it
  // existed (an infinite loop would hang the test runner, not fail this assertion; a wrong
  // split would still be an array). Before the C4 fix, an unterminated bracket silently
  // consumed to end of string as one "statement" and returned normally — also `Array.isArray`
  // true, so the vacuous assertion passed on BOTH the wrong-but-terminating behavior and any
  // future correct behavior equally, telling a reader nothing. Now it must hard-fail, and this
  // pins the exact error and that the fileLabel is named in it.
  const sql = 'CREATE TABLE t ([unterminated TEXT);'
  assert.throws(
    () => splitSqlStatements(sql, 'unterminated_bracket.sql'),
    /unterminated \[bracket identifier\]/,
  )
  try {
    splitSqlStatements(sql, 'unterminated_bracket.sql')
    assert.fail('expected a throw')
  } catch (error) {
    assert.match(error.message, /unterminated_bracket\.sql/)
  }
})

// ── splitter: hard fail on an unterminated block (F2 gate fix) — permanent regressions ──
//
// M12 and M13 are the two mutation-style fixture regressions named in the gate verdict on
// PR #1300: constructs that swallowed a whole file into one "statement" and survived every
// check that existed before this fix.

test('M12 — BEGIN TRANSACTION; ... COMMIT; is classified and hard-failed as transaction-control BEGIN (C4 gate fix, round 3)', () => {
  // Round 2 caught this by letting the generic "unterminated BEGIN/CASE block" check fire at
  // EOF (COMMIT never decrements the counter BEGIN incremented). Round 3's gate finding was
  // that the SAME construct closed by END instead of COMMIT — `BEGIN; ... END;` — swallows the
  // whole file SILENTLY, because END decrements the counter back to zero by coincidence (see
  // the two tests below). The fix classifies transaction-control BEGIN immediately, at the
  // BEGIN itself, before it ever reaches the block-depth counter — so this fixture now throws
  // a different, more specific message than round 2's, not the generic end-of-file one.
  const sql = 'BEGIN TRANSACTION;\nCREATE TABLE a (id TEXT);\nCOMMIT;\nCREATE TABLE b (id TEXT);'
  assert.throws(
    () => splitSqlStatements(sql, 'M12_fixture.sql'),
    /transaction-control BEGIN/,
    'BEGIN TRANSACTION must hard-fail as transaction-control BEGIN, not swallow or silently mis-split',
  )
  // The file label must be named in the error, not just "some file somewhere failed".
  try {
    splitSqlStatements(sql, 'M12_fixture.sql')
    assert.fail('expected a throw')
  } catch (error) {
    assert.match(error.message, /M12_fixture\.sql/)
  }
})

test('C4 — bare BEGIN; ... COMMIT; (no TRANSACTION keyword) is also classified as transaction-control BEGIN', () => {
  const sql = 'BEGIN;\nCREATE TABLE a (id TEXT);\nCOMMIT;\nCREATE TABLE b (id TEXT);'
  assert.throws(() => splitSqlStatements(sql, 'bare_begin.sql'), /transaction-control BEGIN/)
})

test('C4 — BEGIN DEFERRED / IMMEDIATE / EXCLUSIVE (with or without TRANSACTION) are all classified as transaction-control BEGIN', () => {
  for (const variant of ['BEGIN DEFERRED;', 'BEGIN IMMEDIATE;', 'BEGIN EXCLUSIVE;', 'BEGIN DEFERRED TRANSACTION;']) {
    const sql = `${variant}\nCREATE TABLE a (id TEXT);\nCOMMIT;`
    assert.throws(
      () => splitSqlStatements(sql, 'variant.sql'),
      /transaction-control BEGIN/,
      `expected ${JSON.stringify(variant)} to hard-fail as transaction-control BEGIN`,
    )
  }
})

test('C4 — BEGIN; ... END; (END as a SQLite synonym for COMMIT) hard-fails instead of SILENTLY swallowing the whole file', () => {
  // THE gap round 3's gate found: a naive fix for M12 (hard-fail whenever the BEGIN/CASE
  // counter never returns to zero) does NOT catch this shape, because END decrements the
  // counter back to zero — coincidentally, since SQLite treats END as a synonym for COMMIT
  // for transaction control, not because this is a trigger body. Before this fix, the whole
  // file between BEGIN and END collapsed into ONE "statement" and no check anywhere caught it.
  const sql = 'BEGIN;\nCREATE TABLE a (id TEXT);\nEND;\nCREATE TABLE b (id TEXT);'
  assert.throws(() => splitSqlStatements(sql, 'begin_end_txn.sql'), /transaction-control BEGIN/)
})

test('C4 — BEGIN TRANSACTION; ... END TRANSACTION; also hard-fails instead of swallowing the file (gate verdict\'s exact second example)', () => {
  const sql = 'BEGIN TRANSACTION;\nCREATE TABLE a (id TEXT);\nEND TRANSACTION;\nCREATE TABLE b (id TEXT);'
  assert.throws(() => splitSqlStatements(sql, 'begin_end_txn2.sql'), /transaction-control BEGIN/)
})

test('P2 (round 4) — BEGIN /* comment */; ... END; is STILL classified as transaction-control BEGIN, not silently swallowed', () => {
  // Round 3's C4 fix classified the word immediately after BEGIN by skipping WHITESPACE only
  // (skipWhitespace) to find it. The gate proved that gap: a comment wedged between BEGIN and
  // its next real token defeated the classifier — it read into the comment's own text rather
  // than past it, missed the `;` that should have triggered "bare BEGIN;" classification, fell
  // through to the safe default (treat as trigger-opening), and the whole file collapsed into
  // one statement exactly like the pre-C4 defect. Fixed: skipWhitespace now skips `--` and
  // `/* */` comments too. This is the direct reproduction — before the fix this did NOT throw.
  const sql = 'BEGIN /* c */;\nCREATE TABLE a (id TEXT);\nEND;\nCREATE TABLE b (id TEXT);'
  assert.throws(() => splitSqlStatements(sql, 'begin_comment_txn.sql'), /transaction-control BEGIN/)
})

test('P2 (round 4) — BEGIN -- line comment\\n TRANSACTION; ... END; is also classified as transaction-control BEGIN', () => {
  const sql = 'BEGIN -- starts a transaction\nTRANSACTION;\nCREATE TABLE a (id TEXT);\nEND;'
  assert.throws(() => splitSqlStatements(sql, 'begin_linecomment_txn.sql'), /transaction-control BEGIN/)
})

test('C4 — a trigger-opening BEGIN (immediately followed by a non-transaction word) is UNAFFECTED — still tracked and closed by its own END', () => {
  const sql = [
    'CREATE TRIGGER t BEFORE UPDATE ON x BEGIN',
    "  SELECT RAISE(ABORT, 'nope');",
    'END;',
    'CREATE TABLE y (id TEXT);',
  ].join('\n')
  const statements = splitSqlStatements(sql, 'trigger_unaffected.sql')
  assert.equal(statements.length, 2)
  assert.match(statements[0], /CREATE TRIGGER t/)
})

// ── splitter: every literal zone must close before EOF (C4 gate fix) ───────────────────

test('C4 — unterminated /* block comment */ at end of file hard-fails, naming the file', () => {
  const sql = 'CREATE TABLE a (id TEXT);\n/* this comment never closes'
  assert.throws(
    () => splitSqlStatements(sql, 'unterminated_comment.sql'),
    /unterminated \/\* block comment \*\//,
  )
  try {
    splitSqlStatements(sql, 'unterminated_comment.sql')
    assert.fail('expected a throw')
  } catch (error) {
    assert.match(error.message, /unterminated_comment\.sql/)
  }
})

test('C4 — unterminated \'string literal\' at end of file hard-fails instead of swallowing the rest of the file', () => {
  const sql = "CREATE TABLE a (id TEXT);\nINSERT INTO a VALUES ('never closed"
  assert.throws(() => splitSqlStatements(sql, 'unterminated_string.sql'), /unterminated 'string literal'/)
})

test('C4 — unterminated "double-quoted identifier" at end of file hard-fails', () => {
  const sql = 'CREATE TABLE a (id TEXT);\nSELECT "never closed FROM a;'
  assert.throws(() => splitSqlStatements(sql, 'unterminated_dquote.sql'), /unterminated "double-quoted identifier"/)
})

test('C4 — unterminated `backtick identifier` at end of file hard-fails', () => {
  const sql = 'CREATE TABLE a (id TEXT);\nSELECT `never closed FROM a;'
  assert.throws(() => splitSqlStatements(sql, 'unterminated_backtick.sql'), /unterminated `backtick-quoted identifier`/)
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

// ── extractCreatedObjects (K1 gate fix) ─────────────────────────────────────────────

test('extractCreatedObjects: CREATE TABLE / INDEX / UNIQUE INDEX / TRIGGER / VIEW are all detected', () => {
  const statements = [
    'CREATE TABLE foo (id TEXT);',
    'CREATE TABLE IF NOT EXISTS bar (id TEXT);',
    'CREATE INDEX idx_foo ON foo(id);',
    'CREATE UNIQUE INDEX uidx_foo ON foo(id);',
    'CREATE TRIGGER trg_foo BEFORE UPDATE ON foo BEGIN SELECT 1; END;',
    'CREATE VIEW v_foo AS SELECT * FROM foo;',
    'CREATE VIRTUAL TABLE vt_foo USING fts5(id);',
  ]
  const objects = extractCreatedObjects(statements)
  assert.deepEqual(objects, [
    { type: 'table', name: 'foo' },
    { type: 'table', name: 'bar' },
    { type: 'index', name: 'idx_foo' },
    { type: 'index', name: 'uidx_foo' },
    { type: 'trigger', name: 'trg_foo' },
    { type: 'view', name: 'v_foo' },
    { type: 'table', name: 'vt_foo' },
  ])
})

test('extractCreatedObjects: a statement whose text is LED by a comment (very common in this repo) is still detected — regression for a bug caught during this fix, not shipped', () => {
  // The first version of this extractor matched `^\s*CREATE` directly and silently missed
  // every statement that opens with a descriptive header comment before the keyword — which
  // is migrations/0001_init.sql's FIRST statement (the `departments` table) and dozens of
  // others across the real corpus. Caught by cross-checking against the real migrations
  // directory before this diff shipped, not by any assertion that was ever red in CI.
  const statements = ["-- a header comment about this table\n-- spanning two lines\nCREATE TABLE t (id TEXT);"]
  const objects = extractCreatedObjects(statements)
  assert.deepEqual(objects, [{ type: 'table', name: 't' }])
})

test('extractCreatedObjects: a statement led by a /* block comment */ before the keyword is also detected', () => {
  const statements = ['/* block comment */\nCREATE TABLE t (id TEXT);']
  assert.deepEqual(extractCreatedObjects(statements), [{ type: 'table', name: 't' }])
})

test('extractCreatedObjects: quoted object names ("...", `...`, [...]) are unwrapped to the bare name', () => {
  const statements = [
    'CREATE TABLE "t1" (id TEXT);',
    'CREATE TABLE `t2` (id TEXT);',
    'CREATE TABLE [t3] (id TEXT);',
  ]
  assert.deepEqual(extractCreatedObjects(statements), [
    { type: 'table', name: 't1' },
    { type: 'table', name: 't2' },
    { type: 'table', name: 't3' },
  ])
})

test('extractCreatedObjects: ALTER TABLE / DROP / plain DML create nothing and are skipped', () => {
  const statements = [
    'ALTER TABLE t ADD COLUMN x TEXT;',
    'DROP TABLE IF EXISTS t;',
    "INSERT INTO t (id) VALUES ('a');",
    "UPDATE t SET id = 'b';",
  ]
  assert.deepEqual(extractCreatedObjects(statements), [])
})

test('extractCreatedObjects: case-insensitive CREATE keyword (real migrations use both cases)', () => {
  assert.deepEqual(extractCreatedObjects(['create table t (id text);']), [{ type: 'table', name: 't' }])
})

test('buildSchemaChainEntries: every real migration file with a CREATE statement has a non-empty objects list (spot-check against a known comment-led file)', () => {
  // 0001_init.sql's FIRST statement is comment-led (see the regression test above) — this
  // pins that the real corpus, not just a synthetic fixture, is covered.
  const entries = buildSchemaChainEntries()
  const init = entries.find((e) => e.file === '0001_init.sql')
  assert.ok(init, 'expected 0001_init.sql to be present')
  const names = init.objects.map((o) => o.name)
  assert.ok(names.includes('departments'), `expected 'departments' among ${JSON.stringify(names)}`)
})

// ── splitter version <-> source hash tie (C6 gate fix — CI enforcement of the bump rule) ──

test('assertSplitterVersionMatchesSource: passes against the committed splitSqlStatements source', () => {
  assert.doesNotThrow(() => assertSplitterVersionMatchesSource())
})

test('assertSplitterVersionMatchesSource: throws when the recorded hash for the current version does not match the current source (simulates an edit with no bump)', () => {
  const original = SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION]
  try {
    SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION] = 'deadbeef'.repeat(8)
    assert.throws(() => assertSplitterVersionMatchesSource(), /was not bumped/)
  } finally {
    SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION] = original
  }
  // Restored — must pass again.
  assert.doesNotThrow(() => assertSplitterVersionMatchesSource())
})

test('assertSplitterVersionMatchesSource: throws when the current version has no recorded hash entry at all', () => {
  const original = SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION]
  try {
    delete SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION]
    assert.throws(() => assertSplitterVersionMatchesSource(), /has no entry/)
  } finally {
    SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION] = original
  }
})

test('splitterSourceText: is stable across calls and non-empty', () => {
  const a = splitterSourceText()
  const b = splitterSourceText()
  assert.equal(a, b)
  assert.ok(a.length > 100)
  assert.match(a, /function splitSqlStatements/)
})

test('P2 (round 4) — the splitter-version/source hash covers the FULL CALL GRAPH: mutating a helper splitSqlStatements calls (isBlankStatement), not just its own body, invalidates the pinned hash', () => {
  // The gate's finding, reproduced directly and mechanically rather than just documented:
  // round 3's SPLITTER SOURCE HASH REGION wrapped splitSqlStatements' own text, but
  // isBlankStatement — called from splitSqlStatements' final line — was defined just OUTSIDE
  // the region. Editing isBlankStatement's BEHAVIOR (not splitSqlStatements' own body) changed
  // the real corpus' total statement count (955 -> 958 in the gate's report) while
  // SCHEMA_CHAIN_SPLITTER_VERSION, SCHEMA_CHAIN_DIGEST, and every per-file sha256 stayed
  // identical — the exact silent-skip shape SPLITTER_SOURCE_SHA256_BY_VERSION exists to catch,
  // for a function one line outside the fence meant to catch it.
  //
  // This builds a REAL, RUNNABLE copy of the generator with isBlankStatement's body mutated,
  // and confirms assertSplitterVersionMatchesSource (called from generateSchemaChainModule,
  // which both `npm run gen:schema-chain` and the CI freshness guard invoke) now refuses to
  // run against it — proving the hashed region covers the call graph, not just one function's
  // own text. Before the round-4 fix (moving the END marker past isBlankStatement's
  // definition), this test's mutated copy did NOT throw.
  const realPath = new URL('../scripts/gen-schema-chain.mjs', import.meta.url)
  const realSource = readFileSync(realPath, 'utf8')
  const needle = 'return stripped.length === 0\n}'
  assert.ok(
    realSource.includes(needle),
    'fixture assumption violated: isBlankStatement\'s body text not found to mutate — did its source change shape?',
  )
  const mutated = realSource.replace(needle, 'return stripped.length === 0 && stripped !== "MUTATED_BY_TEST"\n}')
  assert.notEqual(mutated, realSource)

  const dir = mkdtempSync(join(tmpdir(), 'splitter-call-graph-test-'))
  try {
    const mutatedGeneratorPath = join(dir, 'gen-schema-chain.mjs')
    writeFileSync(mutatedGeneratorPath, mutated, 'utf8')
    const runnerPath = join(dir, 'runner.mjs')
    const runnerSrc =
      `import { assertSplitterVersionMatchesSource } from ${JSON.stringify(mutatedGeneratorPath)}\n` +
      `try {\n` +
      `  assertSplitterVersionMatchesSource()\n` +
      `  console.log('NO_THROW')\n` +
      `} catch (e) {\n` +
      `  console.log('THREW: ' + e.message)\n` +
      `}\n`
    writeFileSync(runnerPath, runnerSrc, 'utf8')
    const output = execFileSync(process.execPath, [runnerPath], { encoding: 'utf8' })
    assert.match(
      output,
      /THREW:/,
      'mutating isBlankStatement (a helper splitSqlStatements calls) must invalidate the pinned ' +
        'splitter source hash — it did not, meaning the hashed region misses part of the call graph',
    )
    assert.match(output, /source changed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generateSchemaChainModule: throws (refuses to generate) when the splitter version/source tie is broken', () => {
  const original = SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION]
  try {
    SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION] = 'deadbeef'.repeat(8)
    assert.throws(() => generateSchemaChainModule(), /was not|has no entry/)
  } finally {
    SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION] = original
  }
})
