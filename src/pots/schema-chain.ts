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

import { SCHEMA_CHAIN, type SchemaChainFile } from './schema-chain.generated'

/** Bookkeeping table this module creates (idempotently) before applying anything. */
export const POT_SCHEMA_APPLIED_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pot_schema_applied (
  file TEXT NOT NULL PRIMARY KEY,
  sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL
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

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''")
}

function recordAppliedSql(file: string, sha256: string, appliedAt: string): string {
  return `INSERT INTO pot_schema_applied (file, sha256, applied_at) VALUES ('${escapeSqlLiteral(file)}', '${escapeSqlLiteral(sha256)}', '${escapeSqlLiteral(appliedAt)}');`
}

export interface ApplySchemaChainResult {
  readonly applied: string[]
  readonly skipped: string[]
  readonly failed?: { file: string; statementIndex: number; error: string }
}

const RECORDED_KEY_SEP = '\u0000'

/** Builds an entry for `alreadyApplied` representing "file was recorded with this sha256". */
export function recordedKey(file: string, sha256: string): string {
  return `${file}${RECORDED_KEY_SEP}${sha256}`
}

function recordedShaFor(file: string, alreadyApplied: ReadonlySet<string>): string | undefined {
  const prefix = `${file}${RECORDED_KEY_SEP}`
  for (const entry of alreadyApplied) {
    if (entry.startsWith(prefix)) return entry.slice(prefix.length)
  }
  return undefined
}

export interface ApplySchemaChainOptions {
  /**
   * What `pot_schema_applied` already contains, as recorded by the CALLER'S OWN prior read
   * — this module never reads, only writes (see file header). Each entry is
   * `recordedKey(file, sha256)` for one row that exists in the bookkeeping table.
   *
   * A chain file whose name appears under NO key here is untouched — apply it. One whose
   * name appears with the chain's own sha256 is already applied correctly — skip it. One
   * whose name appears with a DIFFERENT sha256 means the migration file's content changed
   * after it was applied to this database — fail closed rather than silently reapplying or
   * silently skipping a change.
   */
  alreadyApplied?: ReadonlySet<string>
  onFile?: (file: string, index: number, total: number) => void
  /** Override the chain (tests only — production always uses SCHEMA_CHAIN). */
  chain?: readonly SchemaChainFile[]
  /** Override the clock (tests only). */
  now?: () => string
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
 */
export async function applySchemaChain(
  exec: (sql: string) => Promise<void>,
  opts: ApplySchemaChainOptions = {},
): Promise<ApplySchemaChainResult> {
  const chain = opts.chain ?? SCHEMA_CHAIN
  const alreadyApplied = opts.alreadyApplied ?? new Set<string>()
  const now = opts.now ?? (() => new Date().toISOString())

  await exec(POT_SCHEMA_APPLIED_TABLE_SQL)

  const applied: string[] = []
  const skipped: string[] = []

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index]
    opts.onFile?.(entry.file, index, chain.length)

    const recordedSha = recordedShaFor(entry.file, alreadyApplied)
    if (recordedSha === entry.sha256) {
      skipped.push(entry.file)
      continue
    }
    if (recordedSha !== undefined && recordedSha !== entry.sha256) {
      // statementIndex -1: this is a pre-flight content-mismatch, not a statement execution
      // failure, so there is no specific statement to name.
      return {
        applied,
        skipped,
        failed: {
          file: entry.file,
          statementIndex: -1,
          error: `recorded sha256 ${recordedSha} does not match chain sha256 ${entry.sha256} — migration content changed after being applied to this database`,
        },
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
            error: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }

    await exec(recordAppliedSql(entry.file, entry.sha256, now()))
    applied.push(entry.file)
  }

  return { applied, skipped }
}
