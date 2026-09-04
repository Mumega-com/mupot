#!/usr/bin/env node
// scripts/gen-schema-chain.mjs — generates src/pots/schema-chain.generated.ts from
// migrations/*.sql, so the schema chain becomes a runtime artifact a Worker can apply to a
// freshly created D1 over the Cloudflare REST API (mupot#1285 Tier C slice 1).
//
// WHY GENERATE INSTEAD OF READING migrations/*.sql AT RUNTIME
//
// A Cloudflare Worker has no filesystem access to the repo's migrations/ directory at
// request time. The chain has to be baked into the deployed bundle as data, which means a
// build-time step that can drift from the real migrations unless CI catches it —
// scripts/check-schema-chain-fresh.mjs is that catch (wired as its own CI job).
//
// ORDERING — MUST MATCH tests/helpers/migrations.ts
//
// tests/helpers/migrations.ts `migrationFiles()` is production's own definition of
// "application order": readdirSync(MIGRATIONS_DIR), filtered to *.sql, then
// lexicographically sorted. `listMigrationFiles` below is a deliberate COPY of that exact
// rule rather than an import, because this script runs as plain Node ESM with no TypeScript
// loader and tests/helpers/migrations.ts is a .ts module. tests/schema-chain.test.ts asserts
// the two orderings are byte-for-byte identical on every run (importing the real
// `migrationFiles` from tests/helpers/migrations.ts and this file's `listMigrationFiles`),
// so any future drift between the two copies of the rule goes red immediately instead of
// silently producing two different answers to "what order is the schema."
//
// DUPLICATE NUMERIC PREFIXES ARE SAFE HERE, DELIBERATELY NOT RE-CHECKED
//
// migrations/ has three numeric prefixes that each name two files today (0068, 0069, 0127 —
// verified via `ls migrations/*.sql | sed -E 's/^([0-9]+)_.*/\1/' | sort | uniq -c`).
// scripts/check-migration-numbering.mjs already documents this exact fact and deliberately
// does not fail on it ("Existing duplicates on main ... pre-existing debt is not this PR's to
// fix") — its only two accepted deviations. `.sort()` above sorts the FULL FILENAME string,
// not the parsed numeric prefix, so "0068_agent_profile.sql" < "0068_project_cycle_boundary.sql"
// is a stable, total, lexicographic order regardless of the duplicate prefix — every reader
// of this rule (this script, tests/helpers/migrations.ts, D1's own `wrangler d1 migrations
// apply`, which also applies alphabetically) computes the identical order from the identical
// input, so position is well-defined even though the number alone is not unique. Adding a
// SEPARATE duplicate-prefix guard here would just re-litigate a question
// check-migration-numbering.mjs already answered for the one thing that actually matters
// (newly ADDED files clearing the target head) — see that file's `duplicate_number_within_pr`
// check for the case that's real.

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MIGRATIONS_DIR = join(ROOT, 'migrations')
const DEFAULT_OUTPUT_FILE = join(ROOT, 'src', 'pots', 'schema-chain.generated.ts')

/** Every committed migration filename, in application order. Mirrors
 *  tests/helpers/migrations.ts migrationFiles() exactly — see file header. */
export function listMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------------------
// SQL statement splitter
// ---------------------------------------------------------------------------------------
//
// A naive `sql.split(';')` breaks `CREATE TRIGGER ... BEGIN ... END;` bodies: SQLite
// trigger bodies contain their OWN semicolon-terminated statements before the final `;`
// that closes the trigger (grep `CREATE TRIGGER` in migrations/ — 45 files use them). It
// also breaks on `;` that appears inside a string literal (real example in this repo:
// migrations/0054_marketing_recommendations.sql has
// `'An owner approves or rejects the recommendation; no external change is executed'`) or
// inside a `--`/`/* */` comment.
//
// The state machine below tracks, left to right over the raw file text:
//   - single-quoted string literals ('...'), with '' as the escaped-quote sequence
//   - double-quoted identifiers ("..."), with "" as the escaped-quote sequence (SQLite
//     supports these; unused for identifiers in this repo today but they DO appear inside
//     `--` comments — those are already skipped whole-line by the comment branch, so this
//     branch only matters for real double-quoted identifiers, not comment prose)
//   - `--` line comments and `/* */` block comments
//   - a LIFO block-depth counter that increments on the keyword BEGIN or CASE and
//     decrements on END, so a top-level `;` only ends a statement when the counter is back
//     to zero.
//
// CASE and BEGIN share one counter deliberately, not two. migrations/0055_projects.sql has
// triggers whose BEGIN...END bodies contain `CASE WHEN json_valid(...) THEN ... ELSE ...
// END` expressions — tracking BEGIN/END alone would close the trigger's statement at the
// first CASE's END (wrong: that END belongs to CASE, not the trigger), and tracking CASE/END
// alone would never open for a bare trigger BEGIN. Since CASE and BEGIN are both closed by
// the same keyword and SQL never interleaves them incorrectly (a CASE always closes with its
// own END before the enclosing BEGIN's END can), a single LIFO stack over both is correct:
// push on BEGIN or CASE, pop on END, and a `;` at depth 0 is a real statement boundary.
//
// TWO MORE LITERAL ZONES, ADDED AFTER A GATE FINDING (2026-09-04): `[bracket]` identifiers
// and `` `backtick` `` identifiers are both SQLite-legal quoting for identifiers, borrowed
// from MS SQL Server and MySQL respectively. Before this fix, neither had a branch here, so
// `CREATE TABLE t([begin] TEXT);` fed straight into the keyword-scanning branch below, which
// matched the word "begin" inside the brackets as the keyword BEGIN and opened a block that
// nothing in the file ever closes — silently swallowing the rest of the file into one
// "statement". Both branches below run BEFORE the keyword-scanning branch, so their contents
// (including any word that looks like BEGIN/CASE/END) are consumed as an opaque literal and
// never reach the keyword scan, the same way the string-literal and comment branches already
// protect their own contents.
//
// WHAT THIS SPLITTER DOES NOT HANDLE, ON PURPOSE: standalone `BEGIN;` / `BEGIN TRANSACTION;`
// (SQLite's transaction-control statement, unrelated to a trigger body) is not distinguished
// from a trigger-opening BEGIN — both increment blockDepth here, and only a trigger's BEGIN is
// ever closed by a matching END. A file that uses transaction-control BEGIN therefore leaves
// blockDepth stuck above zero at end of file, which the check below turns into a hard
// generator failure rather than a silently wrong split. No migration in this repo uses
// transaction-control BEGIN today (`wrangler d1 migrations apply` already wraps each file in
// its own transaction — see migrations/0049_agent_status_inactive.sql's header — so a
// migration author has no reason to write one), and the hard failure is the correct outcome
// if one ever is: fail loud at generation time, not silently mis-split at runtime.
export function splitSqlStatements(sql, fileLabel) {
  const statements = []
  let current = ''
  let i = 0
  let blockDepth = 0
  const n = sql.length
  const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch)

  function wordAt(pos) {
    if (pos > 0 && isWordChar(sql[pos - 1])) return null
    let j = pos
    while (j < n && isWordChar(sql[j])) j += 1
    if (j === pos) return null
    return { word: sql.slice(pos, j).toUpperCase(), end: j }
  }

  while (i < n) {
    const ch = sql[i]

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const stop = nl === -1 ? n : nl + 1
      current += sql.slice(i, stop)
      i = stop
      continue
    }
    // /* block comment */
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      const stop = close === -1 ? n : close + 2
      current += sql.slice(i, stop)
      i = stop
      continue
    }
    // 'single-quoted string'
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j += 1; break }
        j += 1
      }
      current += sql.slice(i, j)
      i = j
      continue
    }
    // "double-quoted identifier"
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue }
        if (sql[j] === '"') { j += 1; break }
        j += 1
      }
      current += sql.slice(i, j)
      i = j
      continue
    }
    // `backtick-quoted identifier` (MySQL-style, SQLite accepts it too)
    if (ch === '`') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '`' && sql[j + 1] === '`') { j += 2; continue }
        if (sql[j] === '`') { j += 1; break }
        j += 1
      }
      current += sql.slice(i, j)
      i = j
      continue
    }
    // [bracket-quoted identifier] (MS SQL Server-style, SQLite accepts it too). SQLite's own
    // tokenizer does not support an escaped `]` inside a bracket identifier — the first `]`
    // always closes it — so this branch matches that exactly rather than inventing an escape
    // convention SQLite itself does not honor.
    if (ch === '[') {
      let j = i + 1
      while (j < n && sql[j] !== ']') j += 1
      if (j < n) j += 1 // include the closing bracket
      current += sql.slice(i, j)
      i = j
      continue
    }
    // keyword-based block tracking (BEGIN / CASE open, END closes whichever is innermost)
    if (/[A-Za-z]/.test(ch)) {
      const w = wordAt(i)
      if (w) {
        if (w.word === 'BEGIN' || w.word === 'CASE') blockDepth += 1
        else if (w.word === 'END' && blockDepth > 0) blockDepth -= 1
        current += sql.slice(i, w.end)
        i = w.end
        continue
      }
    }
    // statement terminator, only at top level
    if (ch === ';' && blockDepth === 0) {
      current += ch
      statements.push(current)
      current = ''
      i += 1
      continue
    }
    current += ch
    i += 1
  }
  if (current.trim().length > 0) statements.push(current)

  // HARD FAIL, not a warning — a gate finding on this PR (2026-09-04) proved that swallowing
  // the rest of a file into one "statement" because a block never closed is invisible to
  // every other check in this repo: the equality test builds both schemas through
  // node:sqlite's exec(), which runs multi-statement text happily, so split granularity was
  // never actually observed. `blockDepth !== 0` here means the file contained more BEGIN/CASE
  // opens than END closes as far as this splitter's rules understand them (see the
  // WHAT-THIS-SPLITTER-DOES-NOT-HANDLE note above for the one known unsupported construct,
  // transaction-control BEGIN). Refusing to generate is the correct outcome: a migration this
  // splitter cannot account for must be looked at by a person, not silently mis-split into
  // one giant statement that then gets exec()'d as if it were one CREATE TABLE.
  if (blockDepth !== 0) {
    throw new Error(
      `splitSqlStatements: unterminated BEGIN/CASE block (depth=${blockDepth}) at end of file` +
        (fileLabel ? ` in ${fileLabel}` : '') +
        ' — this splitter only understands BEGIN as a CREATE TRIGGER body opener, closed by a' +
        ' matching END; transaction-control BEGIN (bare `BEGIN;` / `BEGIN TRANSACTION;`, closed' +
        ' by COMMIT rather than END) and any other unmatched BEGIN/CASE are not supported and' +
        ' must be rewritten, or this splitter must be extended to recognize the construct.',
    )
  }

  // Drop fragments that are pure whitespace/comments (e.g. a trailing comment block after
  // the file's last `;`) — they are not statements and node:sqlite's exec() would choke on
  // an empty-after-comment-stripped chunk being sent as its own "statement".
  return statements.filter((stmt) => !isBlankStatement(stmt))
}

function isBlankStatement(stmt) {
  const stripped = stmt
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
  return stripped.length === 0
}

// ---------------------------------------------------------------------------------------
// Module generation
// ---------------------------------------------------------------------------------------

// Bumped whenever splitSqlStatements' SPLITTING RULES change (not when migrations/*.sql
// changes — that's what each entry's own sha256 already covers). Gate finding (2026-09-04):
// the per-file sha256 seals the migration TEXT, never the splitter that turned that text
// into statements. Fix a splitter bug — say, the bracket/backtick branches added alongside
// this constant — and every already-provisioned pot's bookkeeping still shows the old sha256
// for unchanged files, so a naive "sha256 matches, skip" would silently go on believing the
// OLD (buggy) split was what actually ran, forever. src/pots/schema-chain.ts folds this into
// each bookkeeping row's key precisely so a splitter-version bump becomes a visible,
// fail-closed content-mismatch on next apply against an already-provisioned pot, never a
// silent skip.
export const SCHEMA_CHAIN_SPLITTER_VERSION = 1

export function buildSchemaChainEntries(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  return listMigrationFiles(migrationsDir).map((file) => {
    const text = readFileSync(join(migrationsDir, file), 'utf8')
    return {
      file,
      sha256: sha256Hex(text),
      statements: splitSqlStatements(text, file),
    }
  })
}

/** sha256 over the splitter version plus the concatenation of every file's own sha256
 *  (newline-joined), in chain order — mixing in the splitter version means a splitter fix
 *  changes the digest even when not one migration file's text changed. */
export function computeChainDigest(entries, splitterVersion = SCHEMA_CHAIN_SPLITTER_VERSION) {
  return sha256Hex([String(splitterVersion), ...entries.map((entry) => entry.sha256)].join('\n'))
}

function renderStatementsArray(statements) {
  if (statements.length === 0) return '[]'
  const lines = ['[']
  for (const stmt of statements) {
    lines.push(`      ${JSON.stringify(stmt)},`)
  }
  lines.push('    ]')
  return lines.join('\n')
}

/** Pure: builds the exact source text of src/pots/schema-chain.generated.ts. No filesystem
 *  writes here — scripts/check-schema-chain-fresh.mjs calls this and compares against disk
 *  without mutating anything, and the CLI entrypoint below is the only writer. */
export function generateSchemaChainModule(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const entries = buildSchemaChainEntries(migrationsDir)
  const digest = computeChainDigest(entries)

  const lines = []
  lines.push('// src/pots/schema-chain.generated.ts — AUTO-GENERATED. DO NOT EDIT BY HAND.')
  lines.push('//')
  lines.push('// Produced by scripts/gen-schema-chain.mjs from migrations/*.sql, in the exact order')
  lines.push('// tests/helpers/migrations.ts applyAllMigrations uses (readdirSync + .sql filter, sorted).')
  lines.push('// Regenerate: npm run gen:schema-chain')
  lines.push('// CI verifies this file is fresh: scripts/check-schema-chain-fresh.mjs — a migration')
  lines.push('// added without regenerating fails that guard.')
  lines.push('')
  lines.push('export interface SchemaChainFile {')
  lines.push('  readonly file: string')
  lines.push('  readonly sha256: string')
  lines.push('  readonly statements: readonly string[]')
  lines.push('}')
  lines.push('')
  lines.push('export const SCHEMA_CHAIN: readonly SchemaChainFile[] = [')
  for (const entry of entries) {
    lines.push('  {')
    lines.push(`    file: ${JSON.stringify(entry.file)},`)
    lines.push(`    sha256: ${JSON.stringify(entry.sha256)},`)
    lines.push(`    statements: ${renderStatementsArray(entry.statements)},`)
    lines.push('  },')
  }
  lines.push(']')
  lines.push('')
  lines.push('// Bump history and rationale: scripts/gen-schema-chain.mjs, next to this constant.')
  lines.push(`export const SCHEMA_CHAIN_SPLITTER_VERSION: number = ${JSON.stringify(SCHEMA_CHAIN_SPLITTER_VERSION)}`)
  lines.push('')
  lines.push(`export const SCHEMA_CHAIN_DIGEST: string = ${JSON.stringify(digest)}`)
  lines.push('')
  return lines.join('\n')
}

export function writeSchemaChainModule(migrationsDir = DEFAULT_MIGRATIONS_DIR, outputFile = DEFAULT_OUTPUT_FILE) {
  const source = generateSchemaChainModule(migrationsDir)
  writeFileSync(outputFile, source, 'utf8')
  return source
}

export { DEFAULT_MIGRATIONS_DIR, DEFAULT_OUTPUT_FILE }

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const source = writeSchemaChainModule()
  const fileCount = (source.match(/^\s{2}\{$/gm) ?? []).length
  console.log(`Wrote ${DEFAULT_OUTPUT_FILE} (${fileCount} migration files).`)
}
