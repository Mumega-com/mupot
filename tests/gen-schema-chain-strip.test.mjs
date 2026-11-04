// tests/gen-schema-chain-strip.test.mjs — proof that stripping SQL comments out of the baked
// schema chain (scripts/gen-schema-chain.mjs stripSqlComments) changes NOTHING a database can
// observe. Plain node:test + node:sqlite, run by CI's schema-chain-fresh job.
//
// Three layers:
//   1. stripSqlComments unit cases (comment kinds, every literal zone, doubled-quote escapes).
//   2. Equivalence over EVERY committed migration: a fresh SQLite built from the original
//      file text vs one built from the split+stripped statements, compared after each file on
//      sqlite_master (type/name/tbl_name/normalised sql), PRAGMA table_info of every table,
//      and every table's rows (so a seed INSERT string cannot be silently edited).
//   3. The same equivalence over a synthetic fixture whose literals contain `--`, `/*`, `*/`,
//      `;`, doubled quotes, in strings, "identifiers", `identifiers`, [identifiers], a CHECK
//      and a trigger body — plus mutants of the stripper that strip INSIDE literals, which
//      the harness MUST reject. (No committed migration has `--` in a literal today, so the
//      real corpus alone could not catch such a mutant; the fixture can.)

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_MIGRATIONS_DIR,
  listMigrationFiles,
  splitSqlStatements,
  stripSqlComments,
} from '../scripts/gen-schema-chain.mjs'
import { normaliseSqlForComparison } from '../scripts/sql-compare.mjs'

// Independent normaliser (deliberately NOT stripSqlComments): scripts/sql-compare.mjs,
// SQLite-whitespace-only, shared with tests/schema-chain.test.ts.
const normaliseSql = normaliseSqlForComparison

function snapshot(db) {
  const master = db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
    .all()
  const objects = master.map((r) => ({ type: r.type, name: r.name, tbl_name: r.tbl_name, sql: normaliseSql(r.sql) }))
  const tableInfo = {}
  const rows = {}
  for (const r of master) {
    if (r.type !== 'table') continue
    const q = `"${String(r.name).replace(/"/g, '""')}"`
    tableInfo[r.name] = db.prepare(`PRAGMA table_info(${q})`).all().map((c) => ({ ...c }))
    try {
      rows[r.name] = db.prepare(`SELECT * FROM ${q}`).all().map((row) => ({ ...row }))
    } catch {
      rows[r.name] = 'unreadable (virtual table)'
    }
  }
  return JSON.stringify({ objects, tableInfo, rows })
}

/** Applies each file to two fresh databases (original text vs split+stripped statements) and
 *  returns the list of files after which the observable state differs (or a stripped
 *  statement fails to apply). Empty list = equivalent. */
function compareChains(files, strip) {
  const original = new DatabaseSync(':memory:')
  const stripped = new DatabaseSync(':memory:')
  const differences = []
  try {
    for (const { file, text } of files) {
      original.exec(text)
      let applyError = null
      try {
        for (const stmt of splitSqlStatements(text, file).map((s) => strip(s, file)).filter((s) => s.length > 0)) {
          stripped.exec(stmt)
        }
      } catch (error) {
        applyError = String(error)
      }
      if (applyError !== null) {
        differences.push(`${file}: stripped statements failed: ${applyError}`)
        break
      }
      if (snapshot(original) !== snapshot(stripped)) differences.push(`${file}: schema/data differs`)
    }
  } finally {
    original.close()
    stripped.close()
  }
  return differences
}

// ── 1. unit cases ────────────────────────────────────────────────────────────────────────

test('stripSqlComments removes -- and block comments outside literals', () => {
  assert.equal(stripSqlComments('-- header\nCREATE TABLE t (\n  a INT, -- trailing\n  /* gone */ b INT\n);'),
    'CREATE TABLE t (\n  a INT,\n   b INT\n);')
  assert.equal(stripSqlComments('SELECT 1 -- no newline at EOF'), 'SELECT 1')
  assert.equal(stripSqlComments('SELECT a/**/FROM t'), 'SELECT a FROM t')
  assert.equal(stripSqlComments('/* only a comment */'), '')
})

test('stripSqlComments never edits inside any literal zone (byte for byte)', () => {
  const literals = [
    "'a -- b'",
    "'a /* b */ c'",
    "'it''s -- still a string'",
    "'x'';-- y'",
    '"col -- name"',
    '"say ""-- hi"" /* x */"',
    '`tick -- name`',
    '`a``b -- c`',
    '[br -- ket]',
    '[br /* x */ ket]',
    "'multi\n-- line string\n'",
  ]
  for (const lit of literals) {
    const sql = `SELECT ${lit} FROM t -- drop me`
    assert.equal(stripSqlComments(sql), `SELECT ${lit} FROM t`, lit)
  }
})

test('stripSqlComments fails closed on unterminated constructs', () => {
  assert.throws(() => stripSqlComments('SELECT /* open'), /unterminated/)
  assert.throws(() => stripSqlComments("SELECT 'open"), /unterminated/)
  assert.throws(() => stripSqlComments('SELECT [open'), /unterminated/)
})

// ── 2. every committed migration ────────────────────────────────────────────────────────

test('stripped chain is schema- and data-equivalent to the original for EVERY migration', () => {
  const files = listMigrationFiles().map((file) => ({
    file,
    text: readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), 'utf8'),
  }))
  assert.ok(files.length > 100, `expected the full chain, got ${files.length} files`)
  assert.deepEqual(compareChains(files, stripSqlComments), [])
})

// ── 3. synthetic fixture + mutants ──────────────────────────────────────────────────────

const FIXTURE = [
  {
    file: 'fx_0001.sql',
    text: [
      '-- header comment with \'quote and "dq',
      'CREATE TABLE fx (',
      '  id INTEGER PRIMARY KEY, -- trailing',
      "  note TEXT NOT NULL DEFAULT 'a -- b /* c */ d;', /* inline */",
      "  kind TEXT CHECK (kind IN ('x--y', 'it''s /* ok */', 'z')),",
      '  "we--ird" INTEGER,',
      '  `tick /* t */` INTEGER,',
      '  [br -- ket] INTEGER',
      ');',
      "INSERT INTO fx (note, kind) VALUES ('seed -- one', 'x--y');",
      "INSERT INTO fx (note, kind) VALUES ('seed /* two */', 'z'); -- tail",
      '/* block */',
      'CREATE TABLE fx_log (msg TEXT);',
      'CREATE VIEW fx_v AS SELECT/**/id/**/AS/**/k FROM fx;',
      // F1: NBSP is an identifier char in SQLite, not whitespace: `a`, comment, `<NBSP>m` stay
      // two tokens (column a, type "<NBSP>m INT"). JS \s would fuse them into `a<NBSP>m`.
      'CREATE TABLE fx_nb (a/**/\u00a0m INT);',
      // F3 (M10): `/*/` does not close the comment — the closer needs its own `*/`.
      'CREATE VIEW fx_c AS SELECT 1 /*/ still inside */ AS c;',
      // F3 (M11): a comment between two `-` must leave a space, else `1--1` becomes a comment.
      'CREATE VIEW fx_m AS SELECT 1-/**/-1 AS v;',
      'CREATE TRIGGER fx_guard BEFORE DELETE ON fx',
      'BEGIN',
      "  -- comment in trigger body with 'quote",
      "  INSERT INTO fx_log (msg) VALUES ('deleted -- row /* x */');",
      "  SELECT CASE WHEN old.kind = 'z' THEN RAISE(ABORT, 'no -- delete') ELSE 1 END;",
      'END;',
    ].join('\n'),
  },
]

test('fixture: real stripper is equivalent', () => {
  assert.deepEqual(compareChains(FIXTURE, stripSqlComments), [])
})

// Mutants: a stripper that does NOT protect one literal zone (or one escape rule), built
// from a parametrised reference stripper. The harness must flag every one; a mutant that
// survives means the equivalence test cannot see that class of regression.
function makeStripper({ single = true, double = true, backtick = true, bracket = true }) {
  const quotes = [single && "'", double && '"', backtick && '`'].filter(Boolean)
  return (sql) => {
    let out = ''
    let i = 0
    while (i < sql.length) {
      const ch = sql[i]
      if (ch === '-' && sql[i + 1] === '-') {
        const nl = sql.indexOf('\n', i)
        i = nl === -1 ? sql.length : nl
        continue
      }
      if (ch === '/' && sql[i + 1] === '*') {
        i = sql.indexOf('*/', i + 2) + 2
        out += ' '
        continue
      }
      if (quotes.includes(ch)) {
        let j = i + 1
        while (j < sql.length) {
          if (sql[j] === ch && sql[j + 1] === ch) { j += 2; continue }
          if (sql[j] === ch) break
          j += 1
        }
        out += sql.slice(i, j + 1)
        i = j + 1
        continue
      }
      if (bracket && ch === '[') {
        const j = sql.indexOf(']', i)
        out += sql.slice(i, j + 1)
        i = j + 1
        continue
      }
      out += ch
      i += 1
    }
    return out.trim()
  }
}
const MUTANTS = {
  'strips everywhere, ignoring all literals': (sql) =>
    sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ' ').trim(),
  'does not protect single-quoted strings': makeStripper({ single: false }),
  'does not protect double-quoted identifiers': makeStripper({ double: false }),
  'does not protect backtick identifiers': makeStripper({ backtick: false }),
  'does not protect bracket identifiers': makeStripper({ bracket: false }),
  // NOT listed: "no doubled-quote escape". Treating '' as close+reopen is an EQUIVALENT
  // mutant: the two quotes toggle the zone off and on again with nothing between them, so the
  // protected text is identical. (Verified: it survives the harness because it changes nothing.)
}

// Control: the reference stripper with every protection on must itself pass, so a mutant
// failing is down to the missing protection and not the harness.
test('control: fully protected reference stripper is equivalent on the fixture', () => {
  assert.deepEqual(compareChains(FIXTURE, makeStripper({})), [])
})

for (const [name, mutant] of Object.entries(MUTANTS)) {
  test(`mutant rejected: stripper that ${name}`, () => {
    const differences = compareChains(FIXTURE, mutant)
    assert.notDeepEqual(differences, [], `mutant "${name}" survived the equivalence harness`)
  })
}

// F1/F3 mutants of the REAL stripper's tricky rules, as reference strippers.
const MUTANTS_2 = {
  'uses JS \\s (fuses a/**/<NBSP>m)': (sql) =>
    makeStripper({})(sql.replace(/\/\*\*\/\u00a0/g, '\u00a0')),
  'closes block comment at /*/': (sql) => sql.replace(/\/\*\/[\s\S]*?\*\//g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' '),
  'inserts no space for a comment': (sql) => makeStripper({})(sql).replace(/- -/g, '--'),
}
for (const [name, mutant] of Object.entries(MUTANTS_2)) {
  test(`mutant rejected: stripper that ${name}`, () => {
    assert.notDeepEqual(compareChains(FIXTURE, mutant), [], `mutant "${name}" survived`)
  })
}
