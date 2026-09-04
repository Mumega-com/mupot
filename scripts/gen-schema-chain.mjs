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
//   - `[bracket]` and `` `backtick` `` quoted identifiers (SQL Server- and MySQL-style
//     respectively; SQLite accepts both)
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
// EVERY LITERAL ZONE MUST CLOSE BEFORE END OF FILE (C4 gate fix, 2026-09-04): a quoted
// string, a quoted/bracketed identifier, or a block comment left open at EOF used to be
// consumed silently to the end of the file as "still inside the zone" — the same swallow the
// BEGIN/CASE depth check exists to prevent, just for a different kind of zone. Every branch
// below now hard-fails instead. This did not change output for any committed migration —
// every real file's quotes, brackets, backticks, and block comments already close correctly
// — it closes a gap the corpus could not previously exercise.
//
// TRANSACTION-CONTROL BEGIN IS CLASSIFIED AND REFUSED, NOT TRACKED (C4 gate fix,
// 2026-09-04): SQLite's `BEGIN;` / `BEGIN TRANSACTION` / `BEGIN DEFERRED|IMMEDIATE|EXCLUSIVE`
// is closed by COMMIT *or* by END (SQLite treats END as a synonym for COMMIT here) — a
// DIFFERENT construct from a CREATE TRIGGER body's opening BEGIN. Tracking it on the trigger
// counter is unsafe both ways: closed by COMMIT, the counter never returns to zero and the
// file wrongly hard-fails as "unterminated"; closed by a bare `END;`, the counter returns to
// zero BY COINCIDENCE and the entire file between BEGIN and END is silently swallowed into
// one "statement" — invisible to the corpus invariant test's predecessor, because
// node:sqlite's exec() runs multi-statement text happily. The gate verdict on PR #1300 named
// this exact case ("BEGIN; … END;" and "BEGIN TRANSACTION; … END TRANSACTION;" still swallow
// a whole file). The fix classifies the word immediately following BEGIN and refuses to
// generate the instant it looks like transaction control, before it ever reaches the block
// counter. No migration in this repo uses transaction-control BEGIN today (`wrangler d1
// migrations apply` already wraps each file in its own transaction — see
// migrations/0049_agent_status_inactive.sql's header — so a migration author has no reason to
// write one), and a hard failure is the correct outcome if one ever is: fail loud at
// generation time, never silently mis-split at runtime.
//
// The region between the markers below is what SPLITTER_SOURCE_SHA256_BY_VERSION (further
// down this file) hashes to tie an edit of this function to a SCHEMA_CHAIN_SPLITTER_VERSION
// bump — see that constant's doc comment for why and what it does and does not catch.

// === SPLITTER SOURCE HASH REGION START — see SPLITTER_SOURCE_SHA256_BY_VERSION below ===
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

  // Looks past whitespace AND comments from `pos` — used only to classify what follows a
  // BEGIN keyword. P2 gate fix (round 4, 2026-09-04): the original version skipped only
  // whitespace, on the theory that "comment then something" falls through to the safe default
  // (treat as a trigger-opening BEGIN) and so could never be a wrong hard-pass. That was
  // false: `BEGIN /* c */;` has a `;` sitting right after the comment, which the
  // whitespace-only version never saw — it looked past the comment's TEXT (landing inside the
  // comment, not past it) and read whatever character came next in the raw source, not the
  // real next token. The practical effect: a comment wedged between BEGIN and the token that
  // would have classified it as transaction control could suppress that classification, and
  // `BEGIN /* c */; … END;` swallowed the whole rest of the file into one statement — the
  // exact class C4 (round 3) was supposed to close, one spelling over. Fixed to loop over
  // whitespace and `--`/`/* */` comments the same way the main state machine does, so the
  // classifier sees the real next token regardless of what separates it from BEGIN.
  function skipWhitespace(pos) {
    let j = pos
    for (;;) {
      while (j < n && /\s/.test(sql[j])) j += 1
      if (sql[j] === '-' && sql[j + 1] === '-') {
        const nl = sql.indexOf('\n', j)
        j = nl === -1 ? n : nl + 1
        continue
      }
      if (sql[j] === '/' && sql[j + 1] === '*') {
        const close = sql.indexOf('*/', j + 2)
        j = close === -1 ? n : close + 2
        continue
      }
      break
    }
    return j
  }

  function fail(reason) {
    throw new Error(`splitSqlStatements: ${reason}` + (fileLabel ? ` in ${fileLabel}` : '') + '.')
  }

  while (i < n) {
    const ch = sql[i]

    // -- line comment. Ending at EOF with no trailing newline is normal (not an unterminated
    // construct) — there is nothing after it that could be silently swallowed.
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      const stop = nl === -1 ? n : nl + 1
      current += sql.slice(i, stop)
      i = stop
      continue
    }
    // /* block comment */ — must close before EOF.
    if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      if (close === -1) fail('unterminated /* block comment */ at end of file')
      current += sql.slice(i, close + 2)
      i = close + 2
      continue
    }
    // 'single-quoted string' — must close before EOF.
    if (ch === "'") {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue }
        if (sql[j] === "'") { j += 1; closed = true; break }
        j += 1
      }
      if (!closed) fail("unterminated 'string literal' at end of file")
      current += sql.slice(i, j)
      i = j
      continue
    }
    // "double-quoted identifier" — must close before EOF.
    if (ch === '"') {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue }
        if (sql[j] === '"') { j += 1; closed = true; break }
        j += 1
      }
      if (!closed) fail('unterminated "double-quoted identifier" at end of file')
      current += sql.slice(i, j)
      i = j
      continue
    }
    // `backtick-quoted identifier` (MySQL-style, SQLite accepts it too) — must close before EOF.
    if (ch === '`') {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (sql[j] === '`' && sql[j + 1] === '`') { j += 2; continue }
        if (sql[j] === '`') { j += 1; closed = true; break }
        j += 1
      }
      if (!closed) fail('unterminated `backtick-quoted identifier` at end of file')
      current += sql.slice(i, j)
      i = j
      continue
    }
    // [bracket-quoted identifier] (MS SQL Server-style, SQLite accepts it too). SQLite's own
    // tokenizer does not support an escaped `]` inside a bracket identifier — the first `]`
    // always closes it — so this branch matches that exactly rather than inventing an escape
    // convention SQLite itself does not honor. Must close before EOF.
    if (ch === '[') {
      let j = i + 1
      while (j < n && sql[j] !== ']') j += 1
      if (j >= n) fail('unterminated [bracket identifier] at end of file')
      j += 1 // include the closing bracket
      current += sql.slice(i, j)
      i = j
      continue
    }
    // keyword-based block tracking (BEGIN / CASE open, END closes whichever is innermost)
    if (/[A-Za-z]/.test(ch)) {
      const w = wordAt(i)
      if (w) {
        if (w.word === 'BEGIN') {
          const after = skipWhitespace(w.end)
          const next = wordAt(after)
          const isTransactionControl =
            sql[after] === ';' ||
            (next !== null && ['TRANSACTION', 'DEFERRED', 'IMMEDIATE', 'EXCLUSIVE'].includes(next.word))
          if (isTransactionControl) {
            fail(
              'transaction-control BEGIN (bare `BEGIN;`, `BEGIN TRANSACTION`, or ' +
                '`BEGIN DEFERRED|IMMEDIATE|EXCLUSIVE`) is not supported by this splitter — it is ' +
                'closed by COMMIT or by END (a valid SQLite synonym for COMMIT), which this ' +
                'splitter cannot distinguish from a CREATE TRIGGER body closer without either ' +
                'silently swallowing the rest of the file or wrongly refusing a well-formed ' +
                'trigger; rewrite it (a migration file is already wrapped in its own transaction ' +
                'by the apply tooling, so there is no reason to write one) or extend this ' +
                'splitter to recognize the construct',
            )
          }
          blockDepth += 1
        } else if (w.word === 'CASE') {
          blockDepth += 1
        } else if (w.word === 'END' && blockDepth > 0) {
          blockDepth -= 1
        }
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
  // opens than END closes as far as this splitter's rules understand them — a trigger-opening
  // BEGIN or a CASE expression with no matching END (transaction-control BEGIN is classified
  // and refused earlier, immediately, with its own more specific message — see above — so it
  // never reaches this generic end-of-file check). Refusing to generate is the correct
  // outcome: a migration this splitter cannot account for must be looked at by a person, not
  // silently mis-split into one giant statement that then gets exec()'d as if it were one
  // CREATE TABLE.
  if (blockDepth !== 0) {
    fail(`unterminated BEGIN/CASE block (depth=${blockDepth}) at end of file`)
  }

  // Drop fragments that are pure whitespace/comments (e.g. a trailing comment block after
  // the file's last `;`) — they are not statements and node:sqlite's exec() would choke on
  // an empty-after-comment-stripped chunk being sent as its own "statement".
  return statements.filter((stmt) => !isBlankStatement(stmt))
}

// isBlankStatement is called by splitSqlStatements above (its final line) but was, until the
// round 4 gate fix, defined AFTER the SPLITTER SOURCE HASH REGION END marker — outside the
// text SPLITTER_SOURCE_SHA256_BY_VERSION hashes. The gate proved that gap live: editing
// isBlankStatement's BEHAVIOR (not splitSqlStatements' own body) changed the real corpus'
// total statement count 955 -> 958 while SCHEMA_CHAIN_SPLITTER_VERSION, SCHEMA_CHAIN_DIGEST,
// and every per-file sha256 stayed identical — the exact silent-skip shape this hash exists to
// prevent, for a function one line outside the fence meant to catch it. A hash that only
// covers a function's own text, not the functions it calls, is not a hash of its behavior.
// Fixed by moving the END marker past isBlankStatement's definition so the hashed region
// covers the splitter's full call graph, not just splitSqlStatements' own body. (wordAt and
// skipWhitespace are nested INSIDE splitSqlStatements and were already covered.)
function isBlankStatement(stmt) {
  const stripped = stmt
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()
  return stripped.length === 0
}
// === SPLITTER SOURCE HASH REGION END ===

// ---------------------------------------------------------------------------------------
// Created-object extraction (K1 gate fix, 2026-09-04)
// ---------------------------------------------------------------------------------------
//
// verifyGroundTruth (src/pots/schema-chain.ts) must check a REAL fact about the target
// database — an object that only a genuinely-applied chain could have created — instead of
// re-reading bookkeeping this module itself wrote in the same call (the tautology the gate
// found: 134 honest `pot_schema_applied` rows plus a self-written digest, checked against
// each other, prove nothing about whether one real CREATE TABLE ever ran against the
// database). The list of "objects a genuinely-applied file would leave in sqlite_master" is
// derived HERE, from the exact statements baked into SCHEMA_CHAIN, so it cannot drift the way
// a hand-picked table name in schema-chain.ts would the moment a migration renamed or
// removed one.
//
// This is a best-effort static extraction over CREATE TABLE/INDEX/TRIGGER/VIEW statements
// (including CREATE VIRTUAL TABLE and CREATE UNIQUE INDEX), not a SQL parser: it does not
// need to be exhaustive, only correct for what it does report, because callers only need a
// FEW real objects spread across the chain, not an exhaustive inventory (ALTER TABLE, DROP,
// and plain DML statements create nothing and are simply skipped, same as any statement this
// regex doesn't match).
const CREATE_OBJECT_RE =
  /^CREATE\s+(?:VIRTUAL\s+)?(TABLE|UNIQUE\s+INDEX|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?/i

/** Strips leading whitespace AND leading line (`--`) or block comments, repeatedly, so a statement
 *  whose own text opens with a descriptive header comment (extremely common in this repo —
 *  see migrations/0001_init.sql's first statement, or 0088's) is still recognized as a
 *  CREATE. A first cut of this extractor matched `^\s*CREATE` directly and silently missed
 *  every such statement — caught by cross-checking this function's output against a file
 *  known to create a table in its FIRST (comment-led) statement, not by any assertion that
 *  shipped in the original diff. */
function stripLeadingCommentsAndWhitespace(text) {
  let i = 0
  const n = text.length
  for (;;) {
    while (i < n && /\s/.test(text[i])) i += 1
    if (text[i] === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      i = close === -1 ? n : close + 2
      continue
    }
    break
  }
  return text.slice(i)
}

function readQuotedOrBareName(text) {
  const trimmed = text.replace(/^\s+/, '')
  const first = trimmed[0]
  if (first === '"' || first === '`') {
    const end = trimmed.indexOf(first, 1)
    return end === -1 ? null : trimmed.slice(1, end)
  }
  if (first === '[') {
    const end = trimmed.indexOf(']', 1)
    return end === -1 ? null : trimmed.slice(1, end)
  }
  const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(trimmed)
  return bare ? bare[0] : null
}

/** Every schema object (table/index/trigger/view) a file's own (already-split) statements
 *  create, as `{ type, name }` pairs — `type` matches the `type` column `sqlite_master`
 *  reports (`'table' | 'index' | 'trigger' | 'view'`). Order follows statement order;
 *  duplicates (unlikely, but not this function's job to police) are not deduplicated. */
export function extractCreatedObjects(statements) {
  const objects = []
  for (const stmt of statements) {
    const stripped = stripLeadingCommentsAndWhitespace(stmt)
    const match = CREATE_OBJECT_RE.exec(stripped)
    if (!match) continue
    const name = readQuotedOrBareName(stripped.slice(match[0].length))
    if (!name) continue
    const rawType = match[1].toUpperCase()
    const type = rawType.includes('INDEX') ? 'index' : rawType.toLowerCase()
    objects.push({ type, name })
  }
  return objects
}

// ---------------------------------------------------------------------------------------
// Module generation
// ---------------------------------------------------------------------------------------

// Bumped whenever splitSqlStatements' SPLITTING RULES change (not when migrations/*.sql
// changes — that's what each entry's own sha256 already covers). Gate finding (2026-09-04):
// the per-file sha256 seals the migration TEXT, never the splitter that turned that text
// into statements. Fix a splitter bug and every already-provisioned pot's bookkeeping still
// shows the old sha256 for unchanged files, so a naive "sha256 matches, skip" would silently
// go on believing the OLD (buggy) split was what actually ran, forever. src/pots/schema-chain.ts
// folds this into each bookkeeping row's key precisely so a splitter-version bump becomes a
// visible, fail-closed content-mismatch on next apply against an already-provisioned pot,
// never a silent skip. SPLITTER_SOURCE_SHA256_BY_VERSION below (C6 gate fix) ties an actual
// edit of splitSqlStatements to this number instead of relying on a human remembering to
// bump it.
//
// Bump history:
//   1 — initial splitter (string/comment/backtick/bracket zones, BEGIN/CASE...END block
//       tracking, hard-fail on an unterminated block).
//   2 (2026-09-04, gate round 3 on PR #1300, class C4): transaction-control BEGIN is now
//       classified and hard-failed on its own instead of sharing the trigger BEGIN/END
//       counter (which either wrongly refused a well-formed trigger or, worse, silently
//       swallowed an entire file when the counter returned to zero by coincidence — see the
//       splitter's own header comment); every quoted/bracketed/commented zone left open at
//       end of file is now a hard failure instead of silently consuming to EOF. Verified:
//       every statement this produces for the migrations committed as of this bump is
//       byte-identical to version 1's output — this bump is for RULES the gate found unsafe
//       for input the splitter had not yet been asked to handle, not for today's corpus.
//   3 (2026-09-04, gate round 4 on PR #1300, P2): skipWhitespace (used only to classify what
//       follows a BEGIN keyword) now also skips `--`/`/* */` comments, not just whitespace —
//       `BEGIN /* c */;` previously fell through the comment-only skip and never got
//       classified as transaction-control, so it swallowed the whole rest of the file into one
//       statement, the exact class version 2 was supposed to close. Also: the SPLITTER SOURCE
//       HASH REGION now extends past isBlankStatement's definition (splitSqlStatements' own
//       final line calls it, but its body previously sat outside the hashed region — the gate
//       proved that gap live, changing isBlankStatement's behavior altered the real corpus'
//       statement count with the hash, version, and every per-file sha256 unchanged). Verified:
//       every statement this produces for the migrations committed as of this bump is
//       byte-identical to version 2's output — no real migration uses a comment between BEGIN
//       and its next token, or an isBlankStatement edge case this splitter did not already
//       handle; this bump is for the RULE and the HASH COVERAGE, not today's corpus.
export const SCHEMA_CHAIN_SPLITTER_VERSION = 3

const SPLITTER_HASH_REGION_START = '// === SPLITTER SOURCE HASH REGION START'
const SPLITTER_HASH_REGION_END = '// === SPLITTER SOURCE HASH REGION END ==='

/** The exact source text between the SPLITTER SOURCE HASH REGION markers above, read from
 *  this file's own bytes on disk (never from a re-serialized function, which would silently
 *  normalize formatting and defeat the point). Exported so tests can hash it directly. */
export function splitterSourceText() {
  const selfText = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const start = selfText.indexOf(SPLITTER_HASH_REGION_START)
  const end = selfText.indexOf(SPLITTER_HASH_REGION_END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'splitterSourceText: SPLITTER SOURCE HASH REGION markers not found in gen-schema-chain.mjs ' +
        '— they were renamed, removed, or reordered. SPLITTER_SOURCE_SHA256_BY_VERSION cannot be ' +
        'validated without them.',
    )
  }
  return selfText.slice(start, end)
}

/** sha256 of splitSqlStatements' own source text (splitterSourceText, above), keyed by the
 *  SCHEMA_CHAIN_SPLITTER_VERSION it was written under. C6 gate fix (2026-09-04): nothing tied
 *  an edit of splitSqlStatements to a version bump before this existed — a splitter fix with
 *  no bump would silently ship, and every already-provisioned pot would go on believing the
 *  OLD (buggy) split was what actually ran, forever (see recordedKey / splitter_version in
 *  src/pots/schema-chain.ts). assertSplitterVersionMatchesSource, called from
 *  generateSchemaChainModule below (so both `npm run gen:schema-chain` and CI's
 *  check-schema-chain-fresh guard enforce it for free, no new CI job needed), refuses to run
 *  if the CURRENT source hash does not match the entry recorded for the CURRENT version.
 *
 *  This is a best-effort TEXTUAL tie, not a semantic diff: it cannot on its own tell a real
 *  behavior change from a pure comment/formatting edit inside the marked region (the failure
 *  message spells out both cases — bump the version and add a new entry for a real change;
 *  update the existing entry's hash for a no-behavior-change edit), and it cannot stop
 *  someone from bumping the version without changing behavior either — a human still has to
 *  mean it. What it closes is the silent case the gate actually found: change the splitter,
 *  forget everything else, ship a mismatch nobody notices until an already-provisioned pot
 *  silently skips every file.
 */
export const SPLITTER_SOURCE_SHA256_BY_VERSION = {
  2: 'a4279142c00604c48c0343942008e3c2cc81cb050eae061f7313a2f7ef6840e9',
  3: '248025a0102a2364b7bfebcf28059c8b8f000c085de0a20027721af8a31be400',
}

export function assertSplitterVersionMatchesSource() {
  const currentHash = sha256Hex(splitterSourceText())
  const recorded = SPLITTER_SOURCE_SHA256_BY_VERSION[SCHEMA_CHAIN_SPLITTER_VERSION]
  if (recorded === undefined) {
    throw new Error(
      `gen-schema-chain: SCHEMA_CHAIN_SPLITTER_VERSION=${SCHEMA_CHAIN_SPLITTER_VERSION} has no entry ` +
        `in SPLITTER_SOURCE_SHA256_BY_VERSION. Add one: ${SCHEMA_CHAIN_SPLITTER_VERSION}: ${JSON.stringify(currentHash)}.`,
    )
  }
  if (recorded !== currentHash) {
    throw new Error(
      'gen-schema-chain: splitSqlStatements\' source changed (inside the SPLITTER SOURCE HASH ' +
        `REGION markers) but SCHEMA_CHAIN_SPLITTER_VERSION (${SCHEMA_CHAIN_SPLITTER_VERSION}) was not ` +
        'bumped to match. If this changes what statements the splitter produces, bump ' +
        'SCHEMA_CHAIN_SPLITTER_VERSION and add a new SPLITTER_SOURCE_SHA256_BY_VERSION entry: ' +
        `${JSON.stringify(currentHash)}. If this is a pure comment/formatting edit with NO ` +
        `behavior change, update the EXISTING entry for version ${SCHEMA_CHAIN_SPLITTER_VERSION} ` +
        `to ${JSON.stringify(currentHash)} instead.`,
    )
  }
}

export function buildSchemaChainEntries(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  return listMigrationFiles(migrationsDir).map((file) => {
    const text = readFileSync(join(migrationsDir, file), 'utf8')
    const statements = splitSqlStatements(text, file)
    return {
      file,
      sha256: sha256Hex(text),
      statements,
      objects: extractCreatedObjects(statements),
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

function renderObjectsArray(objects) {
  if (objects.length === 0) return '[]'
  const lines = ['[']
  for (const obj of objects) {
    lines.push(`      { type: ${JSON.stringify(obj.type)}, name: ${JSON.stringify(obj.name)} },`)
  }
  lines.push('    ]')
  return lines.join('\n')
}

/** Pure: builds the exact source text of src/pots/schema-chain.generated.ts. No filesystem
 *  writes here — scripts/check-schema-chain-fresh.mjs calls this and compares against disk
 *  without mutating anything, and the CLI entrypoint below is the only writer. Also the ONE
 *  place assertSplitterVersionMatchesSource is invoked, so both the CLI and the freshness
 *  guard enforce the splitter-version/source tie (see that function's doc comment) without a
 *  separate CI job. */
export function generateSchemaChainModule(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  assertSplitterVersionMatchesSource()
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
  lines.push('  /** Schema objects this file\'s statements create — used by verifyGroundTruth')
  lines.push('   *  (src/pots/schema-chain.ts) to check REAL facts about the target database instead of')
  lines.push('   *  this module\'s own bookkeeping. See extractCreatedObjects in gen-schema-chain.mjs. */')
  lines.push('  readonly objects: readonly { readonly type: string; readonly name: string }[]')
  lines.push('}')
  lines.push('')
  lines.push('export const SCHEMA_CHAIN: readonly SchemaChainFile[] = [')
  for (const entry of entries) {
    lines.push('  {')
    lines.push(`    file: ${JSON.stringify(entry.file)},`)
    lines.push(`    sha256: ${JSON.stringify(entry.sha256)},`)
    lines.push(`    statements: ${renderStatementsArray(entry.statements)},`)
    lines.push(`    objects: ${renderObjectsArray(entry.objects)},`)
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
