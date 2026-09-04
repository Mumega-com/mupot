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
export function splitSqlStatements(sql) {
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

export function buildSchemaChainEntries(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  return listMigrationFiles(migrationsDir).map((file) => {
    const text = readFileSync(join(migrationsDir, file), 'utf8')
    return {
      file,
      sha256: sha256Hex(text),
      statements: splitSqlStatements(text),
    }
  })
}

/** sha256 over the concatenation of every file's own sha256 (newline-joined), in chain order. */
export function computeChainDigest(entries) {
  return sha256Hex(entries.map((entry) => entry.sha256).join('\n'))
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
