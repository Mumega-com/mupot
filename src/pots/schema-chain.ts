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
// GATE HISTORY (2026-09-04, PR #1300): the first version of this file shipped three P1s that
// an adversarial pass reproduced directly. Each is fixed below; the fix is referenced at its
// own site as F1/F2/F3/F4/F5 to match the gate verdict's numbering:
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
 *  a small internally-computed integer. */
function assertSafeInteger(value: number, label: string): number {
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

function recordedEntryFor(file: string, alreadyApplied: ReadonlySet<string>): RecordedEntry | undefined {
  const prefix = `${file}${RECORDED_KEY_SEP}`
  for (const entry of alreadyApplied) {
    if (!entry.startsWith(prefix)) continue
    const [sha256, splitterVersionRaw, status] = entry.slice(prefix.length).split(RECORDED_KEY_SEP)
    if (sha256 === undefined || splitterVersionRaw === undefined) continue
    if (status !== 'started' && status !== 'applied') continue
    const splitterVersion = Number(splitterVersionRaw)
    if (!Number.isInteger(splitterVersion)) continue
    return { sha256, splitterVersion, status }
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
   * `started` row means the true state of the database for that file is unknown.
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

/**
 * Verifies one fact about the REAL database that this run's in-memory bookkeeping cannot
 * fake — F3. `exec`'s contract is write-only (`Promise<void>`, no rows back — see the file
 * header on why), so there is no `SELECT ... ` this function can just read the answer from.
 * Instead it writes a scratch table guarded by a BEFORE INSERT trigger that RAISE(ABORT)s
 * when the fact does not hold, then tries to insert into it — the insert either succeeds
 * (fact true) or throws (fact false), and the throw is a REAL SQL failure that came from the
 * database, not from anything this module already believed.
 *
 * The two facts checked: (1) `pot_schema_applied` has exactly one 'applied' row per chain
 * file — this is what catches the F3 repro directly: a caller-supplied `alreadyApplied`
 * claiming files are applied against a virgin database now fails HERE, because the real row
 * count is 0, not `chain.length`. (2) `pot_schema_chain_meta`'s digest row reads back exactly
 * what this run just wrote — catches an `exec` that silently no-ops instead of persisting.
 *
 * Both checks run inside one BEFORE INSERT trigger (one round trip) rather than two, and the
 * scratch objects are dropped in a `finally` so a successful run leaves nothing behind.
 */
async function verifyGroundTruth(
  exec: (sql: string) => Promise<void>,
  expectedAppliedCount: number,
  expectedDigest: string,
): Promise<void> {
  const count = assertSafeInteger(expectedAppliedCount, 'expectedAppliedCount')
  const digest = escapeSqlLiteral(expectedDigest)

  await exec('DROP TRIGGER IF EXISTS __pot_schema_chain_ground_truth_trg;')
  await exec('DROP TABLE IF EXISTS __pot_schema_chain_ground_truth;')
  await exec('CREATE TABLE __pot_schema_chain_ground_truth (ok INTEGER NOT NULL);')
  await exec(
    `CREATE TRIGGER __pot_schema_chain_ground_truth_trg BEFORE INSERT ON __pot_schema_chain_ground_truth BEGIN\n` +
      `  SELECT RAISE(ABORT, 'schema-chain ground truth: pot_schema_applied has ' || (SELECT COUNT(*) FROM pot_schema_applied WHERE status = 'applied') || ' applied row(s), expected ${count}')\n` +
      `    WHERE (SELECT COUNT(*) FROM pot_schema_applied WHERE status = 'applied') != ${count};\n` +
      `  SELECT RAISE(ABORT, 'schema-chain ground truth: pot_schema_chain_meta digest does not match the expected SCHEMA_CHAIN_DIGEST')\n` +
      `    WHERE (SELECT value FROM pot_schema_chain_meta WHERE key = 'digest') != '${digest}';\n` +
      `END;`,
  )
  try {
    await exec('INSERT INTO __pot_schema_chain_ground_truth (ok) VALUES (1);')
  } finally {
    await exec('DROP TRIGGER IF EXISTS __pot_schema_chain_ground_truth_trg;')
    await exec('DROP TABLE IF EXISTS __pot_schema_chain_ground_truth;')
  }
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

    const recorded = recordedEntryFor(entry.file, alreadyApplied)

    if (recorded?.status === 'started') {
      // F1's hard fail-closed outcome. Deliberately does not compare sha256/splitterVersion
      // here — a 'started' row means we do not know how far this file got, so nothing about
      // it can be trusted regardless of whether the recorded sha256 still matches.
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

  // F3: verify against the real database before certifying success — see verifyGroundTruth's
  // doc comment for exactly what this catches and why it has to be a real database round
  // trip rather than trusting applied/skipped, which are themselves partly built from the
  // caller's own (possibly wrong) `alreadyApplied` claim.
  try {
    await exec(recordDigestSql(digest))
    await verifyGroundTruth(exec, chain.length, digest)
  } catch (error) {
    return {
      applied,
      skipped,
      failed: { file: '(ground truth)', statementIndex: -1, kind: 'ground-truth-mismatch', error: errorMessage(error) },
    }
  }

  return { applied, skipped }
}
