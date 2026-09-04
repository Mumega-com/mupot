// src/pots/schema-chain.ts — applies the generated schema chain
// (src/pots/schema-chain.generated.ts) to a target database via an injected `exec`.
//
// This module NEVER calls fetch itself. Production drives `exec` with a thin wrapper over
// executeD1Query (src/pots/service.ts:78); tests drive it against real SQLite
// (tests/helpers/sqlite-d1.ts). Reads are not this module's job either — see
// `alreadyApplied` below — because a read is a network round trip in production too, and
// keeping this module fetch-free means it never needs its own retry/backoff policy for
// reads, and stays trivially testable with a bare function as `exec`.
//
// mupot#1285 Tier C slice 1. Nothing wires this into provisionSovereignPot yet — that is a
// later slice's job.
//
// GATE HISTORY (2026-09-04, PR #1300, round 2): the first version of this file shipped three
// P1s that an adversarial pass reproduced directly. Each is fixed below; the fix is
// referenced at its own site as F1/F2/F3/F4/F5 to match the gate verdict's numbering:
//   F1 — a mid-file crash left the bookkeeping table unrecorded, so the NEXT run replayed the
//        file from statement 0 against non-idempotent DDL and died forever ("bricks silently
//        after the first fail"). Fixed with a two-phase `status` marker (`started` written
//        BEFORE a file's statements, `applied` written after) — see the file-loop below.
//   F2 — the splitter had no branch for `[bracket]`/`` `backtick` `` identifiers and no
//        detection for a block that never closes, so either could silently swallow an entire
//        file into one "statement". Fixed in scripts/gen-schema-chain.mjs (not this file).
//   F3 — a caller-supplied `alreadyApplied` claiming files were applied against a virgin
//        database returned a success shape indistinguishable from real success. Fixed with a
//        genuine ground-truth check against the database itself, not the caller's claim — see
//        `verifyGroundTruth` below.
//   F4/F5 — two `exec` calls sat outside any try/catch (losing `applied`/`skipped` on throw),
//        and the bookkeeping write was a plain INSERT (throwing UNIQUE on a stale
//        `alreadyApplied`). Both are upserts now, both wrapped.
//
// GATE HISTORY, ROUND 3 (2026-09-04): round 2's fixes each closed the EXACT reproduction
// handed to the builder and left the class open one spelling over. Round 3 fixes the class,
// referenced at its own site as K1/K2/C3/C4/C5/C6/C7:
//   K1 — verifyGroundTruth's F3 fix was a TAUTOLOGY: it checked `pot_schema_applied`'s count
//        and `pot_schema_chain_meta`'s digest, both written by THIS module in the SAME call.
//        134 honest bookkeeping rows and a self-written digest, with zero real tables in the
//        database, passed. Fixed by checking real objects (`sqlite_master`) that only a
//        genuinely-applied chain could have created — see `verifyGroundTruth` and
//        `selectGroundTruthProbes` below, and `extractCreatedObjects` in
//        scripts/gen-schema-chain.mjs, which derives the object list so it cannot drift.
//   K2 — the F1 'started' marker is written BEFORE a file's statements run, so a failure on
//        literally the first statement (nothing ran, database objectively clean) permanently
//        condemned the database exactly like a genuine partial run would — a comment-only,
//        zero-statement migration could condemn a database over a no-op. Fixed: a
//        zero-statement file is always safe to retry (nothing could possibly have run), and a
//        file with created objects is retried when NONE of its own objects have any trace in
//        the real database — see `fileHasTraceInDatabase` and the 'started' branch below.
//   C3 — deleting the backtick branch entirely left the OLD test suite green because every
//        backtick fixture used a BALANCED `` `begin` ``/`` `end` `` pair, so removing the
//        branch made BEGIN/END track each other by coincidence. Fixed in
//        scripts/gen-schema-chain.mjs's tests with an UNBALANCED fixture; irrelevant to this
//        file's own code but the corresponding vacuous-assertion audit here is `assert.ok`
//        near-misses in tests/schema-chain.test.ts, addressed alongside these fixes.
//   C4 — `BEGIN; … END;` / `BEGIN TRANSACTION; … END TRANSACTION;` still swallowed a whole
//        file, because END decrements whatever BEGIN incremented — fixed in
//        scripts/gen-schema-chain.mjs (splitSqlStatements now classifies transaction-control
//        BEGIN and refuses it immediately, plus every quoted/commented/bracketed zone left
//        open at EOF is now a hard failure), not this file.
//   C5 — `recordedEntryFor` had three `continue` paths that silently fell through to "not
//        recorded, apply fresh" on a malformed bookkeeping entry — including the classic
//        empty-string-is-zero trap (`Number('') === 0` passes `Number.isInteger`). Fixed: any
//        entry whose prefix matches this file but fails to parse is now a hard throw, not a
//        silent replay. See `recordedEntryFor` below.
//   C6 — the ground-truth applied-count was unscoped to the chain (a renamed/squashed
//        migration's stale row inflated it forever); the digest was written then verified
//        against itself in the same call (detects an `exec` that no-ops, nothing else —
//        comment corrected, not the mechanism); nothing tied a `splitSqlStatements` edit to a
//        `SCHEMA_CHAIN_SPLITTER_VERSION` bump. Fixed: the count query is now scoped to the
//        current chain's file set (see `verifyGroundTruth`), and
//        scripts/gen-schema-chain.mjs's `assertSplitterVersionMatchesSource` — called from
//        `generateSchemaChainModule`, so both the CLI and CI's freshness guard enforce it for
//        free — ties an edit of the splitter's source to its version.
//   C7 — `verifyGroundTruth`'s `finally` replaced a real ground-truth failure with whatever
//        the cleanup `DROP TRIGGER`/`DROP TABLE` calls threw, hiding the diagnostic that
//        matters most exactly when a connection is already dropping (the common production
//        failure). Fixed: cleanup failures are now swallowed in favor of the original error.
//
// GATE HISTORY, ROUND 4 (2026-09-04): both of round 3's remaining P1s were caused by
// machinery round 3 itself added — a clever mechanism that created the hole it was meant to
// close. Round 4's instruction was to DELETE that machinery, not patch it further, and both
// fixes below are net removals:
//   K1 SUPERSEDED — round 3's `selectGroundTruthProbes` sampled 5 files (`fractions = [0,
//        0.25, 0.5, 0.75, 1]`) out of 115 object-creating files. The gate proved a selective
//        wipe — keep only the 5 probed objects, drop the other ~600 real objects — passed
//        clean, and so did dropping every object of any one of the 129 unprobed files. Fixed
//        by DELETING `fractions` and the fraction-walking code: `selectGroundTruthProbes` now
//        probes every object-creating file whose object still exists at the end of the
//        chain — 114 of 115 today, not a sample; the one exclusion is a trigger a later
//        migration replaces, and that later migration is itself probed. One
//        `CREATE TRIGGER` with one `RAISE(ABORT)`/`WHERE NOT EXISTS` clause per probed file,
//        still a single round trip. `objectSurvivesRestOfChain` (below) was already sound —
//        kept as-is. See `selectGroundTruthProbes` and its test for the non-empty-probe-list
//        assertion this closes.
//   K2 SUPERSEDED — round 3's `fileHasTraceInDatabase` tried to tell "nothing ran" from "the
//        file's created objects are absent from sqlite_master," to let a `started` row be
//        retried instead of hard-failed when nothing of the file's DDL survived. The gate
//        proved that unsafe: 29 of the 134 committed migrations run an `ALTER`, `UPDATE`, or
//        `INSERT` BEFORE their first `CREATE`, so a crash in that window leaves the database
//        dirty (non-idempotent DML already ran) with NO object trace at all —
//        `fileHasTraceInDatabase` read that as "safe to retry," reproducing the original F1
//        brick one door over (the exact "table already exists" / "duplicate column name"
//        signature). `sqlite_master` cannot witness "did anything run"; only the reached
//        statement index could, and this module deliberately does not record one (see the F1
//        note below on why a true resume engine is not worth building here). Fixed by DELETING
//        `fileHasTraceInDatabase` entirely and reverting to: a `started` row is unconditionally
//        a hard fail-closed, full stop, with exactly one exception that needs no database
//        query at all — a file with ZERO statements cannot have run anything. See the
//        `'started'` branch in `applySchemaChain` below.
//   Also this round: `recordedEntryFor`'s throw (C5, round 3) was unwrapped inside the file
//   loop, so a malformed bookkeeping entry lost `applied`/`skipped` for every file that
//   succeeded before it — the F4 class, one door over. Now wrapped and returned as a typed
//   `'malformed-bookkeeping'` failure like every other path in this module. And the
//   transaction-control classifier's `skipWhitespace` (scripts/gen-schema-chain.mjs) now skips
//   comments too, and the splitter-version/source hash region (same file) now covers
//   `isBlankStatement`, which `splitSqlStatements` calls but which sat outside the hashed
//   region — see that file for both.

import {
  SCHEMA_CHAIN,
  SCHEMA_CHAIN_DIGEST,
  SCHEMA_CHAIN_SPLITTER_VERSION,
  type SchemaChainFile,
} from './schema-chain.generated'

/**
 * Bookkeeping table this module creates (idempotently) before applying anything.
 *
 * `status` is the F1 two-phase marker: a row is written as `started` BEFORE that file's
 * statements run, and updated to `applied` only after every one of them succeeded. A row
 * still sitting at `started` means a prior run crashed or was killed between "wrote the
 * marker" and "ran the last statement" — see the `partial-application` failure below, which
 * is a hard, distinct, fail-closed outcome specifically for that state, not a resume attempt.
 *
 * `splitter_version` records SCHEMA_CHAIN_SPLITTER_VERSION at the time this file was applied.
 * The per-file sha256 seals the migration TEXT; it says nothing about the SPLITTER that
 * turned that text into the statements which actually ran. Folding splitter_version into the
 * match check (see `recordedEntryFor`) means a splitter fix — same file text, different
 * statements — shows up as a visible, fail-closed content-mismatch on the next apply against
 * an already-provisioned pot, rather than a silent "sha256 still matches, skip".
 */
export const POT_SCHEMA_APPLIED_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pot_schema_applied (
  file TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  splitter_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  applied_at TEXT
);`

/** F3: small key/value bookkeeping table recording SCHEMA_CHAIN_DIGEST, so it is written
 *  somewhere durable instead of being exported and never consulted. */
export const POT_SCHEMA_CHAIN_META_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pot_schema_chain_meta (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);`

// D1's REST query endpoint is one HTTP call per batch of SQL text. These two caps bound a
// batch of statements so a single call stays inside D1's request-size and statement-count
// limits. Both constants live here, nowhere else, so a limit change (the research arm is
// confirming the exact D1 REST limits in parallel) is a one-line edit that nothing else has
// to be touched for. `batchStatements` below is exported and unit-tested on its own; it is
// NOT wired into `applySchemaChain`'s exec calls in this slice — see that function's doc
// comment for why — and is prepared here for the production D1-REST wiring that lands in a
// later slice of #1285.
export const SCHEMA_CHAIN_BATCH_MAX_BYTES = 64 * 1024
export const SCHEMA_CHAIN_BATCH_MAX_STATEMENTS = 50

/**
 * Group consecutive statements into batches of SQL text, each at most `maxBytes` UTF-8
 * bytes and at most `maxStatements` statements. Never splits a single statement across two
 * batches — a statement larger than `maxBytes` on its own still gets its own batch (over
 * budget by necessity, not silently truncated or dropped).
 */
export function batchStatements(
  statements: readonly string[],
  maxBytes: number = SCHEMA_CHAIN_BATCH_MAX_BYTES,
  maxStatements: number = SCHEMA_CHAIN_BATCH_MAX_STATEMENTS,
): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let currentBytes = 0

  for (const statement of statements) {
    const bytes = byteLength(statement)
    const wouldExceed =
      current.length > 0 && (current.length + 1 > maxStatements || currentBytes + bytes > maxBytes)
    if (wouldExceed) {
      batches.push(current)
      current = []
      currentBytes = 0
    }
    current.push(statement)
    currentBytes += bytes
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function byteLength(text: string): number {
  // Workers runtime has no `Buffer`; TextEncoder is the portable way to measure UTF-8 bytes
  // and is available both in Node (for tests) and in workerd.
  return new TextEncoder().encode(text).length
}

/** Exported so its escaping behavior can be asserted directly — see the P2 gate note: with
 *  this reduced to the identity function, nothing else in this module's test suite noticed. */
export function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A non-negative integer, or throws — guards the numeric values this module interpolates
 *  directly into SQL text (splitter version, row counts) against ever carrying anything but
 *  a small internally-computed integer. Exported so its guard behavior can be asserted
 *  directly (mirrors escapeSqlLiteral's export rationale — gate note, PR #1300 round 3: this
 *  function is not reachable through any test that fails if it is removed or reduced to the
 *  identity, because every number it guards today happens to still be a syntactically valid
 *  SQL literal even when wrong, e.g. `-1` or `1.5` as an INTEGER column value under SQLite's
 *  loose type affinity — the guard exists for values this module does not yet pass it, not
 *  ones SQLite itself would reject). */
export function assertSafeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`schema-chain: ${label} must be a non-negative integer, got ${String(value)}`)
  }
  return value
}

function startRowSql(file: string, sha256: string, splitterVersion: number, startedAt: string): string {
  const f = escapeSqlLiteral(file)
  const sha = escapeSqlLiteral(sha256)
  const v = assertSafeInteger(splitterVersion, 'splitterVersion')
  const started = escapeSqlLiteral(startedAt)
  // F4/F5: an upsert, not a plain INSERT — a stale `alreadyApplied` (the caller believed this
  // file was already recorded, but it was not) must not throw UNIQUE constraint failed here;
  // it must just (re)start bookkeeping for this file honestly.
  return (
    `INSERT INTO pot_schema_applied (file, sha256, splitter_version, status, started_at, applied_at) ` +
    `VALUES ('${f}', '${sha}', ${v}, 'started', '${started}', NULL) ` +
    `ON CONFLICT(file) DO UPDATE SET sha256 = excluded.sha256, splitter_version = excluded.splitter_version, ` +
    `status = 'started', started_at = excluded.started_at, applied_at = NULL;`
  )
}

function markAppliedSql(file: string, appliedAt: string): string {
  const f = escapeSqlLiteral(file)
  const applied = escapeSqlLiteral(appliedAt)
  return `UPDATE pot_schema_applied SET status = 'applied', applied_at = '${applied}' WHERE file = '${f}';`
}

function recordDigestSql(digest: string): string {
  const d = escapeSqlLiteral(digest)
  return (
    `INSERT INTO pot_schema_chain_meta (key, value) VALUES ('digest', '${d}') ` +
    `ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  )
}

export type ApplySchemaChainFailureKind =
  | 'content-mismatch' // recorded sha256 or splitter_version for a file no longer matches the chain
  | 'partial-application' // a file is recorded 'started' but never 'applied' — unknown partial state
  | 'statement-error' // a specific chain statement (or a bookkeeping statement) threw
  | 'ground-truth-mismatch' // post-run verification against the real database failed
  | 'malformed-bookkeeping' // an `alreadyApplied` entry for this file does not parse (round 4 gate fix)

export interface ApplySchemaChainFailure {
  readonly file: string
  /** Exact index into that file's statements when `kind` is 'statement-error' and the failing
   *  statement was a real chain statement; -1 for every other case (see `kind`, which is the
   *  authoritative discriminant — this field is diagnostic detail, not the thing to switch on). */
  readonly statementIndex: number
  readonly kind: ApplySchemaChainFailureKind
  readonly error: string
}

export interface ApplySchemaChainResult {
  readonly applied: string[]
  readonly skipped: string[]
  readonly failed?: ApplySchemaChainFailure
}

const RECORDED_KEY_SEP = '\u0000'

/** Builds an entry for `alreadyApplied` representing "file was recorded with this sha256,
 *  splitter version, and status". `status` is 'started' or 'applied' — see
 *  POT_SCHEMA_APPLIED_TABLE_SQL's doc comment for what each means. */
export function recordedKey(
  file: string,
  sha256: string,
  splitterVersion: number,
  status: 'started' | 'applied',
): string {
  return `${file}${RECORDED_KEY_SEP}${sha256}${RECORDED_KEY_SEP}${splitterVersion}${RECORDED_KEY_SEP}${status}`
}

interface RecordedEntry {
  readonly sha256: string
  readonly splitterVersion: number
  readonly status: 'started' | 'applied'
}

/** C5 gate fix (2026-09-04, round 3): the pre-fix version had three `continue` paths that
 *  silently fell through to "not recorded for this file" on a malformed bookkeeping entry —
 *  which the applySchemaChain loop treats identically to "never applied," i.e. it REPLAYS the
 *  file's statements against a database that may already have run them. In a module whose
 *  whole thesis is fail-closed, a stringly-typed parse seam that fails OPEN on a parse error
 *  is a design defect: it silently reapplies non-idempotent DDL and reports success. Every one
 *  of those three paths is now a hard throw instead.
 *
 *  One of the three was also the classic empty-string-is-zero trap: `Number('')` is `0`, and
 *  `Number.isInteger(0)` is `true` — so a truncated key (e.g. two consecutive separators from
 *  a corrupted write) with an EMPTY splitter-version field used to parse as "splitter version
 *  0" instead of failing, misattributing a corrupt entry to a real-looking version number.
 *  `/^\d+$/.test(...)` rejects an empty string outright, closing that specific trap.
 *
 *  Round 4 gate fix: this function itself still throws (the fail-closed signal stays a plain
 *  exception here, unchanged) — but its ONE call site, inside `applySchemaChain`'s file loop,
 *  now wraps that call in try/catch and returns a typed `'malformed-bookkeeping'` failure
 *  instead of letting the throw escape the loop. Before this, the throw was unwrapped and
 *  propagated straight out of `applySchemaChain`, discarding `applied`/`skipped` for every file
 *  that had already succeeded earlier in the same run — the F4 class (exec calls outside
 *  try/catch losing `applied`/`skipped`) one door over, on a non-exec code path. */
function recordedEntryFor(file: string, alreadyApplied: ReadonlySet<string>): RecordedEntry | undefined {
  const prefix = `${file}${RECORDED_KEY_SEP}`
  for (const entry of alreadyApplied) {
    if (!entry.startsWith(prefix)) continue
    const parts = entry.slice(prefix.length).split(RECORDED_KEY_SEP)
    if (parts.length !== 3) {
      throw new Error(
        `schema-chain: malformed bookkeeping entry for '${file}': expected exactly 3 fields ` +
          `(sha256, splitterVersion, status) after the file prefix, got ${parts.length}. Refusing ` +
          'to guess — a fail-closed module must not silently treat an unparseable entry as ' +
          '"not recorded" and replay the file.',
      )
    }
    const [sha256, splitterVersionRaw, status] = parts
    if (sha256.length === 0) {
      throw new Error(`schema-chain: malformed bookkeeping entry for '${file}': empty sha256 field.`)
    }
    if (status !== 'started' && status !== 'applied') {
      throw new Error(
        `schema-chain: malformed bookkeeping entry for '${file}': unknown status '${status}' ` +
          "(expected 'started' or 'applied').",
      )
    }
    if (!/^\d+$/.test(splitterVersionRaw)) {
      throw new Error(
        `schema-chain: malformed bookkeeping entry for '${file}': splitter version ` +
          `'${splitterVersionRaw}' is not a non-negative integer literal (an empty string here ` +
          'would silently misparse as version 0 via Number(""), which this check rejects).',
      )
    }
    return { sha256, splitterVersion: Number(splitterVersionRaw), status }
  }
  return undefined
}

export interface ApplySchemaChainOptions {
  /**
   * What `pot_schema_applied` already contains, as recorded by the CALLER'S OWN prior read
   * — this module never reads, only writes (see file header). Each entry is
   * `recordedKey(file, sha256, splitterVersion, status)` for one row that exists in the
   * bookkeeping table.
   *
   * A chain file whose name appears under NO key here is untouched — apply it. One whose
   * name appears `applied` with the chain's own sha256 AND the chain's own splitter version
   * is already applied correctly — skip it. One whose name appears `applied` with a
   * DIFFERENT sha256 (the migration file's content changed after being applied) or a
   * DIFFERENT splitter version (the splitter that would run it today is not the splitter
   * that actually ran) fails closed rather than silently reapplying or silently skipping a
   * change nobody can see. One whose name appears `started` is a HARD fail-closed — see
   * `partial-application` below — regardless of its sha256 or splitter version, because a
   * `started` row means the true state of the database for that file is unknown, with exactly
   * one exception that needs no database query: a file with ZERO statements cannot have run
   * anything (round 4 gate fix — see the file header's K2 SUPERSEDED note for why the
   * database-probing alternative that used to live here was removed).
   *
   * An entry whose file prefix matches but does not parse (wrong field count, empty sha256,
   * an unrecognized status, or a non-digit splitter-version field) is a hard, typed
   * `'malformed-bookkeeping'` failure (C5 gate fix; wrapping fixed round 4 — see the file
   * header) rather than being silently treated as "not recorded" and replayed. It is returned
   * from `applySchemaChain`, not thrown, so `applied`/`skipped` for files that succeeded
   * before it in the loop are not lost — the empty-chain check below is the one remaining
   * case that still throws, since it fires before any file-level bookkeeping exists to lose.
   */
  alreadyApplied?: ReadonlySet<string>
  onFile?: (file: string, index: number, total: number) => void
  /** Override the chain (tests only — production always uses SCHEMA_CHAIN). */
  chain?: readonly SchemaChainFile[]
  /** Override the clock (tests only). */
  now?: () => string
  /** Override the splitter version this run records/checks against (tests only). */
  splitterVersion?: number
  /** Override the digest this run records/checks against (tests only). */
  digest?: string
}

/** One schema object, picked from a chain file's own `objects` (see extractCreatedObjects in
 *  scripts/gen-schema-chain.mjs), that `verifyGroundTruth` checks for real in `sqlite_master`. */
interface GroundTruthProbe {
  readonly file: string
  readonly type: string
  readonly name: string
}

/** Escapes a name for embedding inside a RegExp built from it (not SQL — see escapeSqlLiteral
 *  for that). */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A real migration (e.g. migrations/0042_task_status_gate_values.sql) can CREATE an object
 * and then DROP or RENAME it away later in the SAME file, or a LATER file in the chain can
 * drop/rename it (the create-new / copy-data / drop-old / rename-new-to-old pattern SQLite's
 * lack of most ALTER TABLE forms forces). An object created but not surviving to the end of
 * the chain is a USELESS ground-truth probe — checking for it after the full chain runs would
 * find it correctly absent even on a perfectly healthy pot, a false positive this function
 * exists to avoid. `laterStatements` should be every statement from (and including) the
 * object's own creating file's statements through the end of the chain being verified —
 * intentionally starting at the creating file rather than strictly after the CREATE statement
 * itself, which is a conservative choice (it can never wrongly call something "surviving," it
 * can only wrongly skip a valid probe in favor of a different one).
 */
function objectSurvivesRestOfChain(type: string, name: string, laterStatements: readonly string[]): boolean {
  const escapedName = escapeRegExp(name)
  const dropRe = new RegExp(`\\bDROP\\s+${type}\\s+(?:IF\\s+EXISTS\\s+)?["'\`\\[]?${escapedName}["'\`\\]]?\\b`, 'i')
  const renamedAwayRe =
    type === 'table'
      ? new RegExp(`\\bALTER\\s+TABLE\\s+["'\`\\[]?${escapedName}["'\`\\]]?\\s+RENAME\\s+TO\\b`, 'i')
      : null
  for (const stmt of laterStatements) {
    if (dropRe.test(stmt)) return false
    if (renamedAwayRe?.test(stmt)) return false
  }
  return true
}

/** Statements of `fileStatements` that come AFTER the one creating `type`/`name`.
 *
 *  ROUND 5 GATE FIX. The survival scan used to start at the file's OWN first statement, so the
 *  ordinary rebuild idiom — `DROP TRIGGER IF EXISTS x; CREATE TRIGGER x ...` in one migration —
 *  read the file's own DROP as "dropped later" and removed the file from probe coverage
 *  entirely. Six real migrations did exactly that, and all seven of their objects were
 *  droppable afterwards without ground truth noticing. Only statements after the CREATE can
 *  undo it, so that is the window. If no creating statement is found the whole file is scanned,
 *  which is the conservative direction: it can drop a probe, never invent one.
 */
function statementsAfterCreationOf(
  fileStatements: readonly string[],
  type: string,
  name: string,
): string[] {
  const escapedName = escapeRegExp(name)
  const createRe = new RegExp(
    `\\bCREATE\\s+(?:UNIQUE\\s+)?(?:TEMP(?:ORARY)?\\s+)?${type}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`\\[]?${escapedName}["'\`\\]]?\\b`,
    'i',
  )
  for (let i = fileStatements.length - 1; i >= 0; i -= 1) {
    if (createRe.test(fileStatements[i])) return fileStatements.slice(i + 1)
  }
  return [...fileStatements]
}

function statementsFrom(chain: readonly SchemaChainFile[], index: number): string[] {
  const statements: string[] = []
  for (let i = index; i < chain.length; i += 1) statements.push(...chain[i].statements)
  return statements
}

/**
 * Picks one real object to probe from every object-creating file whose object survives to the
 * end of the chain — 114 of the 115 object-creating files today, not a sample. The single
 * exclusion is a trigger that a later migration drops and recreates; that later file is probed
 * instead, so the object is still covered.
 *
 * ROUND 4 GATE FIX: the pre-fix version sampled 5 files (`fractions = [0, 0.25, 0.5, 0.75,
 * 1]`) out of 115 that create objects, on the theory that spreading across early/middle/late
 * chain position was enough. The gate proved it was not: a selective wipe keeping only the 5
 * probed objects (and dropping the other ~600 real objects) passed clean, and so did dropping
 * every object of any ONE of the 129 unprobed files. A sample cannot see a defect isolated to
 * a file it didn't pick. Fixed by deleting the sample: every file with at least one created
 * object (see extractCreatedObjects in scripts/gen-schema-chain.mjs) contributes one probe —
 * its first object that survives to the end of the chain (`objectSurvivesRestOfChain`, kept
 * unchanged from round 3 — the gate verified it sound: 589 claimed survivors, 0 absent after a
 * clean apply). At today's corpus size (115 object-creating files) this is still one
 * `CREATE TRIGGER` with ~115 `RAISE(ABORT)`/`WHERE NOT EXISTS` clauses — a few tens of KB,
 * The limit that actually applies is D1's 100KB per-statement cap, NOT SCHEMA_CHAIN_BATCH_MAX_BYTES
 * (batchStatements has no callers on this path, so that constant enforces nothing here). Measured
 * against real local D1: 45KB today, ~381 bytes per added migration, and SQLITE_TOOBIG at ~100KB,
 * so roughly 145 migrations of headroom. It fails loudly and never truncates. Note that node:sqlite
 * accepts >2MB and so cannot detect this ceiling — see migrations/0133 for a prior case where D1
 * was stricter than node. Chunk the trigger before that runs out.
 * If the corpus grows enough that a single trigger statement becomes too large, split
 * `raiseClauses` (in `verifyGroundTruth`, below) into multiple sequential
 * create-trigger/insert/cleanup rounds, mechanically (e.g. every N clauses), and keep the
 * failure naming the FIRST missing object and its file — not implemented here because it is
 * not needed at today's size, and building it unused would be the same mistake this round is
 * fixing in the other direction.
 *
 * Only files with at least one created object are candidates; a chain built entirely of
 * ALTER/DML-only files (no real migration in this repo is, but a synthetic test `chain`
 * override could be) yields no probes, which the caller must treat as "cannot be verified this
 * way" rather than a false pass — see the call site below. `selectGroundTruthProbes` is
 * exported (mirrors escapeSqlLiteral / assertSafeInteger's export rationale) so a dedicated
 * test can assert the REAL `SCHEMA_CHAIN` always yields a non-empty probe list — the one
 * runtime fact that must never silently go back to zero, since an empty list is exactly what
 * would restore the original K1 tautology.
 *
 * NOTE ON WHAT THIS DOES NOT CHECK: each probe compares `type` and `name` against
 * `sqlite_master` only — never the object's actual DDL/shape (`sqlite_master.sql`). A probed
 * table replaced by a same-named one-column stub still passes this check. That is a real,
 * documented limitation, not fixed this round (it would require comparing `sql` text, which
 * is brittle against harmless formatting differences the generator itself introduces) — stated
 * here plainly so this comment never claims more than the code does.
 */
export function selectGroundTruthProbes(chain: readonly SchemaChainFile[]): GroundTruthProbe[] {
  const probes: GroundTruthProbe[] = []
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index]
    if (entry.objects.length === 0) continue
    const later = statementsFrom(chain, index + 1)
    const object = entry.objects.find((obj) =>
      objectSurvivesRestOfChain(obj.type, obj.name, [
        ...statementsAfterCreationOf(entry.statements, obj.type, obj.name),
        ...later,
      ]),
    )
    // Genuinely dropped or renamed away before the chain ends — nothing to probe here.
    if (!object) continue
    probes.push({ file: entry.file, type: object.type, name: object.name })
  }
  return probes
}

/**
 * Verifies real facts about the REAL database that this run's in-memory bookkeeping cannot
 * fake. `exec`'s contract is write-only (`Promise<void>`, no rows back — see the file header
 * on why), so there is no `SELECT ...` this function can just read the answer from. Instead it
 * writes a scratch table guarded by a BEFORE INSERT trigger that RAISE(ABORT)s when a fact
 * does not hold, then tries to insert into it — the insert either succeeds (every fact true)
 * or throws (some fact false), and the throw is a REAL SQL failure that came from the
 * database, not from anything this module already believed.
 *
 * K1 GATE FIX (round 3): the pre-fix version checked exactly two things, and BOTH were
 * written by this module in the SAME call — a tautology the gate proved with 134 honest
 * `pot_schema_applied` rows and a self-written digest against a database holding zero real
 * tables. What this function now checks:
 *
 *  1. `pot_schema_applied` has exactly one 'applied' row, per chain file IN THE CURRENT
 *     CHAIN'S FILE SET, for every file in that set (C6: the pre-fix count was UNSCOPED — any
 *     stale row for a file since renamed or squashed out of the chain inflated it forever,
 *     permanently failing a healthy pot's count). This alone is still bookkeeping-only.
 *  2. EVERY real schema object `selectGroundTruthProbes` (above) picks — one per
 *     object-creating file in the chain, not a sample (round 4 gate fix; round 3 sampled 5 of
 *     115 and the gate proved a selective wipe of the other ~600 objects passed clean) —
 *     actually exists in `sqlite_master`. THIS is the fix for the tautology: an
 *     `alreadyApplied` claiming files are applied against a virgin (or partially-applied, or
 *     wrong-splitter-applied) database now fails HERE, on the real schema, not on bookkeeping
 *     this module wrote itself moments earlier. When the chain has no probeable objects at all
 *     (every file is ALTER/DML-only — never true for the real SCHEMA_CHAIN, possible only for
 *     a synthetic test override), this check is skipped and only the scoped count above
 *     applies — documented here rather than silently claimed as exhaustive.
 *  3. `pot_schema_chain_meta`'s digest row reads back exactly what THIS RUN just wrote (C6:
 *     corrected comment — this catches an `exec` that silently no-ops instead of persisting
 *     within this call; it cannot detect anything "across runs," because the digest is
 *     unconditionally overwritten to the current expected value immediately before this
 *     check runs every time — see `recordDigestSql` at the call site).
 *
 * All checks run inside one BEFORE INSERT trigger (one round trip) rather than several, and
 * the scratch objects are dropped afterward so a successful run leaves nothing behind.
 *
 * C7 GATE FIX: the pre-fix version dropped the scratch trigger/table in a bare `finally`,
 * which meant a THROWING cleanup call replaced the real ground-truth error with whatever the
 * cleanup itself threw — hiding the diagnostic that matters most exactly when a connection is
 * already failing (the common production shape: the ground-truth INSERT fails because the
 * connection just dropped, and the cleanup DROP calls right after it fail for the same
 * reason). Cleanup failures after a real failure are now swallowed in favor of the original
 * error; cleanup failures after a SUCCESSFUL check still propagate normally, since nothing
 * else failed to prioritize over them.
 */
async function verifyGroundTruth(
  exec: (sql: string) => Promise<void>,
  chain: readonly SchemaChainFile[],
  expectedDigest: string,
): Promise<void> {
  const count = assertSafeInteger(chain.length, 'chain.length')
  const digest = escapeSqlLiteral(expectedDigest)
  const fileList = chain.map((entry) => `'${escapeSqlLiteral(entry.file)}'`).join(', ')
  const probes = selectGroundTruthProbes(chain)

  const raiseClauses: string[] = [
    `  SELECT RAISE(ABORT, 'schema-chain ground truth: pot_schema_applied has ' || ` +
      `(SELECT COUNT(*) FROM pot_schema_applied WHERE status = 'applied' AND file IN (${fileList})) || ` +
      `' applied row(s) among this chain''s files, expected ${count}')\n` +
      `    WHERE (SELECT COUNT(*) FROM pot_schema_applied WHERE status = 'applied' AND file IN (${fileList})) != ${count};`,
    // `IS NOT`, not `!=`: if the digest row is MISSING entirely (the meta INSERT silently
    // no-op'd — the one thing this clause exists to catch, per the C6 doc note above) the
    // subselect returns SQL NULL, and `NULL != '<digest>'` evaluates to NULL — which WHERE
    // treats as false, so the RAISE never fired and the missing-row case slipped through as a
    // pass. Found while re-verifying this clause is load-bearing (round 4). `IS NOT` is
    // NULL-aware (`NULL IS NOT '<digest>'` is true), closing that gap with no new machinery —
    // one operator, not a mechanism.
    `  SELECT RAISE(ABORT, 'schema-chain ground truth: pot_schema_chain_meta digest does not match the expected SCHEMA_CHAIN_DIGEST')\n` +
      `    WHERE (SELECT value FROM pot_schema_chain_meta WHERE key = 'digest') IS NOT '${digest}';`,
  ]
  for (const probe of probes) {
    const type = escapeSqlLiteral(probe.type)
    const name = escapeSqlLiteral(probe.name)
    const file = escapeSqlLiteral(probe.file)
    raiseClauses.push(
      `  SELECT RAISE(ABORT, 'schema-chain ground truth: no ${type} named ${name} in sqlite_master ` +
        `(expected from ${file}) — the real schema does not match what this run believes it applied')\n` +
        `    WHERE NOT EXISTS (SELECT 1 FROM sqlite_master WHERE type = '${type}' AND name = '${name}');`,
    )
  }

  await exec('DROP TRIGGER IF EXISTS __pot_schema_chain_ground_truth_trg;')
  await exec('DROP TABLE IF EXISTS __pot_schema_chain_ground_truth;')
  await exec('CREATE TABLE __pot_schema_chain_ground_truth (ok INTEGER NOT NULL);')
  await exec(
    `CREATE TRIGGER __pot_schema_chain_ground_truth_trg BEFORE INSERT ON __pot_schema_chain_ground_truth BEGIN\n` +
      raiseClauses.join('\n') +
      `\nEND;`,
  )
  try {
    await exec('INSERT INTO __pot_schema_chain_ground_truth (ok) VALUES (1);')
  } catch (primaryError) {
    try {
      await exec('DROP TRIGGER IF EXISTS __pot_schema_chain_ground_truth_trg;')
      await exec('DROP TABLE IF EXISTS __pot_schema_chain_ground_truth;')
    } catch {
      // C7: a cleanup failure here is secondary — the ground-truth failure above is what the
      // caller needs to see, especially when both are the same underlying connection drop.
    }
    throw primaryError
  }
  await exec('DROP TRIGGER IF EXISTS __pot_schema_chain_ground_truth_trg;')
  await exec('DROP TABLE IF EXISTS __pot_schema_chain_ground_truth;')
}

/**
 * Applies every file in the schema chain, in order, via `exec`.
 *
 * `exec` is called once per STATEMENT, not per batch. That is a deliberate trade against the
 * batching machinery above: batching statements together and hitting a mid-batch failure
 * would mean replaying the batch's earlier statements to pin down which one failed, and a
 * replayed CREATE TRIGGER or a bare INSERT (no `IF NOT EXISTS`) is not always safe to run
 * twice — the replay itself could throw and misattribute the failure to the wrong
 * statement. One exec() per statement makes `failed.statementIndex` exact by construction,
 * with no replay needed. The round-trip cost of that is a concern for the production D1-REST
 * wiring landing in a later slice, not for correctness here.
 *
 * F1 — NOT A RESUME ENGINE, ON PURPOSE. Each file's bookkeeping row is written 'started'
 * BEFORE its statements run and flipped to 'applied' only after every one of them succeeded.
 * A crash between those two writes leaves the row at 'started' — and the NEXT run, on seeing
 * that row (via `alreadyApplied`, which the caller must have read from the real table), fails
 * hard and names the file rather than quietly replaying from statement 0. That replay would
 * be genuinely unsafe: 74 of the 134 committed migrations contain at least one non-idempotent
 * statement (a bare INSERT, a CREATE TRIGGER with no IF NOT EXISTS, ...), so re-running them
 * from the top throws "already exists" on the second attempt and leaves the caller unable to
 * tell a real problem from routine idempotent replay. The production path for this module is
 * the D1 `/import` API (see PR #1295's research), and the wiring slice that uses it (S4) tears
 * a failed pot down and recreates it rather than repairing it in place — so building a true
 * resume engine here is not worth it. What IS worth it is turning "bricks silently" into
 * "refuses loudly, names the file, says why, and says what to do" — that is what the 'started'
 * row and the `partial-application` failure below do.
 */
export async function applySchemaChain(
  exec: (sql: string) => Promise<void>,
  opts: ApplySchemaChainOptions = {},
): Promise<ApplySchemaChainResult> {
  const chain = opts.chain ?? SCHEMA_CHAIN
  const alreadyApplied = opts.alreadyApplied ?? new Set<string>()
  const now = opts.now ?? (() => new Date().toISOString())
  const splitterVersion = opts.splitterVersion ?? SCHEMA_CHAIN_SPLITTER_VERSION
  const digest = opts.digest ?? SCHEMA_CHAIN_DIGEST

  // F3: an empty chain used to return exactly the same shape as "everything already applied"
  // ({ applied: [], skipped: [...] } vs { applied: [], skipped: [] } — both `failed`
  // undefined). That is the success-shaped no-op this whole epic exists to remove. A caller
  // asking this module to apply zero files is virtually always a bug upstream (SCHEMA_CHAIN
  // failed to load, or an override chain was built wrong) — refuse loudly rather than
  // reporting a success that means nothing happened.
  if (chain.length === 0) {
    throw new Error(
      'applySchemaChain: chain is empty. This almost certainly means SCHEMA_CHAIN failed to ' +
        'load or an override `chain` was constructed empty by mistake — refusing to report ' +
        'success for zero migrations applied.',
    )
  }

  try {
    await exec(POT_SCHEMA_APPLIED_TABLE_SQL)
    await exec(POT_SCHEMA_CHAIN_META_TABLE_SQL)
  } catch (error) {
    // F4: this used to be an unguarded exec() outside any try/catch — a throw here lost the
    // caller's ability to see a clean, typed failure at all.
    return {
      applied: [],
      skipped: [],
      failed: { file: '(pot_schema_applied bootstrap)', statementIndex: -1, kind: 'statement-error', error: errorMessage(error) },
    }
  }

  const applied: string[] = []
  const skipped: string[] = []

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index]
    opts.onFile?.(entry.file, index, chain.length)

    let recorded: RecordedEntry | undefined
    try {
      recorded = recordedEntryFor(entry.file, alreadyApplied)
    } catch (error) {
      // Round 4 gate fix: this used to be an unwrapped call — a throw here propagated straight
      // out of applySchemaChain and discarded applied/skipped for every file that had already
      // succeeded earlier in this same run. See recordedEntryFor's doc comment.
      return {
        applied,
        skipped,
        failed: { file: entry.file, statementIndex: -1, kind: 'malformed-bookkeeping', error: errorMessage(error) },
      }
    }

    if (recorded?.status === 'started') {
      // F1's hard fail-closed outcome. Round 4 gate fix: reverted to the pre-K2 posture — a
      // `started` row is unconditionally a hard fail-closed, full stop, with exactly ONE
      // exception that needs no database query: a file with ZERO statements (a comment-only
      // migration, e.g. 0085_identity_cleanup.sql) cannot possibly have run anything, so a
      // `started` row for it can only be the marker write itself landing before a crash with
      // nothing after it to run — always safe to fall through and (re)apply.
      //
      // Round 3's K2 fix tried to go further: probe the real database (fileHasTraceInDatabase,
      // since deleted) for any trace of a non-zero-statement file's own created objects, and
      // retry when none were found. The gate proved that unsafe — 29 of the 134 committed
      // migrations run an ALTER, UPDATE, or INSERT BEFORE their first CREATE, so a crash in
      // that window leaves the database dirty (non-idempotent DML already ran) with NO object
      // trace at all, which the K2 check read as "safe to retry," reproducing the original F1
      // brick ("table already exists" / "duplicate column name" on replay) one door over.
      // `sqlite_master` cannot witness "did anything run" for a file that creates no lasting
      // object trace before it fails — only the reached statement index could, and this module
      // deliberately does not record one (see this function's doc comment on why a true resume
      // engine is not worth building here). So: any statement, any content, always hard-fails.
      if (entry.statements.length === 0) {
        // Nothing could have run — fall through to "apply fresh" below, which for a
        // zero-statement file is just rewriting 'started' then immediately 'applied'.
      } else {
        return {
          applied,
          skipped,
          failed: {
            file: entry.file,
            statementIndex: -1,
            kind: 'partial-application',
            error:
              `pot_schema_applied recorded '${entry.file}' as 'started' but never 'applied' — a ` +
              'prior run crashed or was interrupted partway through this file, leaving the ' +
              'database in an unknown partial state. This module does not resume partial ' +
              'application (blindly replaying non-idempotent DDL is not safe — see this ' +
              "function's doc comment). The database must be recreated, not repaired.",
          },
        }
      }
    }

    if (recorded?.status === 'applied') {
      if (recorded.sha256 === entry.sha256 && recorded.splitterVersion === splitterVersion) {
        skipped.push(entry.file)
        continue
      }
      const reason =
        recorded.sha256 !== entry.sha256
          ? `recorded sha256 ${recorded.sha256} does not match chain sha256 ${entry.sha256} — migration content changed after being applied to this database`
          : `recorded splitter_version ${recorded.splitterVersion} does not match the current splitter_version ${splitterVersion} for ${entry.file} — the statement splitter changed since this file was applied, so the statements this database actually ran may differ from what the current splitter would produce`
      // statementIndex -1: this is a pre-flight content-mismatch, not a statement execution
      // failure, so there is no specific statement to name.
      return {
        applied,
        skipped,
        failed: { file: entry.file, statementIndex: -1, kind: 'content-mismatch', error: reason },
      }
    }

    // Not recorded at all: apply fresh. F1 — mark 'started' BEFORE running anything in this
    // file, so a crash mid-file leaves unambiguous evidence next run.
    try {
      await exec(startRowSql(entry.file, entry.sha256, splitterVersion, now()))
    } catch (error) {
      return {
        applied,
        skipped,
        failed: { file: entry.file, statementIndex: -1, kind: 'statement-error', error: errorMessage(error) },
      }
    }

    for (let statementIndex = 0; statementIndex < entry.statements.length; statementIndex += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop -- statements within one file must apply in order
        await exec(entry.statements[statementIndex])
      } catch (error) {
        return {
          applied,
          skipped,
          failed: {
            file: entry.file,
            statementIndex,
            kind: 'statement-error',
            error: errorMessage(error),
          },
        }
      }
    }

    try {
      await exec(markAppliedSql(entry.file, now()))
    } catch (error) {
      // F4: this was the OTHER unguarded exec() — a throw here used to lose `applied` even
      // though every statement in the file genuinely ran.
      return {
        applied,
        skipped,
        failed: {
          file: entry.file,
          statementIndex: entry.statements.length,
          kind: 'statement-error',
          error: errorMessage(error),
        },
      }
    }
    applied.push(entry.file)
  }

  // F3/K1: verify against the real database before certifying success — see
  // verifyGroundTruth's doc comment for exactly what this catches (real schema objects, not
  // just bookkeeping this module wrote itself) and why it has to be a real database round
  // trip rather than trusting applied/skipped, which are themselves partly built from the
  // caller's own (possibly wrong) `alreadyApplied` claim.
  try {
    await exec(recordDigestSql(digest))
    await verifyGroundTruth(exec, chain, digest)
  } catch (error) {
    return {
      applied,
      skipped,
      failed: { file: '(ground truth)', statementIndex: -1, kind: 'ground-truth-mismatch', error: errorMessage(error) },
    }
  }

  return { applied, skipped }
}
