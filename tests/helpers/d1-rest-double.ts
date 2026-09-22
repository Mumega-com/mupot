// tests/helpers/d1-rest-double.ts — a D1 REST `/query` double that behaves like the REAL
// Cloudflare D1 REST API for the properties that actually mattered to real defects
// (mupot#1507-v2 P0-A, mupot#1516 round-2 P2-1), not just "answers success to every insert"
// — mupot#1507 round-1's own postmortem named that exact gap: a fake CF that always
// answered `{success:true}` could not see a real schema refusal, so `seedPotIdentities`'
// happy path had NEVER once actually run before it shipped.
//
// SIX PROPERTIES THIS DOUBLE ENFORCES, each documented with its source
//
// 1. TRANSACTION CONTROL IS REFUSED, with D1's own real error text, PER STATEMENT — not
//    just when it is the first thing in the whole batch. Cloudflare's D1 REST `/query`
//    endpoint rejects any `BEGIN` / `COMMIT` / `ROLLBACK` statement sent through it —
//    "cannot start a transaction within a transaction" — because the semicolon-joined
//    statements in ONE `/query` call are ALREADY executed as a single atomic batch; wrapping
//    them in an app-level BEGIN/COMMIT is not merely redundant, it errors.
//    (developers.cloudflare.com/d1/best-practices/import-export-data/,
//    developers.cloudflare.com/d1/worker-api/d1-database/, cloudflare/workers-sdk#2733 — NOT
//    verified against the live Cloudflare API in this session, per this file's own history;
//    Kasra-core should confirm live before this ships broadly). mupot#1516 round-2 P2-1:
//    the round-1 version of this check only tested `^\s*(BEGIN|COMMIT|ROLLBACK)` against the
//    WHOLE multi-statement string with no `m` flag — `^` without `m` matches only the very
//    START of the string, so a transaction-control statement anywhere but the FIRST line of
//    a batch slipped through undetected. Detecting it correctly, though, is NOT as simple as
//    adding the `m` flag to a whole-batch regex: a `CREATE TRIGGER ... BEGIN ... END` body
//    legitimately contains a bare `BEGIN` on its own line, and a per-LINE regex cannot tell
//    that apart from real transaction control without understanding block nesting — getting
//    this wrong would make the double refuse every trigger-bearing migration in the real
//    schema chain (45+ files, per `scripts/gen-schema-chain.mjs`'s own header). This double
//    instead SPLITS the batch into real top-level statements via that same repo's own
//    battle-tested `splitSqlStatements` (which already tracks BEGIN/CASE/END nesting
//    correctly and already throws on transaction-control BEGIN specifically — see its own
//    doc comment) and checks EACH resulting statement's own leading keyword — a CREATE
//    TRIGGER statement's OWN first token is `CREATE`, never `BEGIN`, so per-statement
//    checking on correctly-split statements avoids the trigger false-positive by
//    construction, not by carving out an exception.
//
// 2. A MULTI-STATEMENT BATCH RUNS INSIDE ITS OWN IMPLICIT TRANSACTION — mirroring the real
//    engine's behavior (the whole point of #1) — so a failure partway through a
//    semicolon-joined `/query` body leaves NOTHING committed, without the caller ever
//    sending BEGIN/COMMIT.
//
// 3. PARAMETER BINDING IS SINGLE-STATEMENT ONLY, AND CAPPED AT 100 BOUND PARAMETERS PER
//    CALL. D1 REST's `?N` binding behavior for a MULTI-statement string in one call is
//    undocumented (see src/pots/service.ts's own doc comment on `seedPotIdentities`, which
//    is exactly why that function inlines literals instead) — this double refuses that
//    combination outright. The 100-param cap mirrors Cloudflare's documented D1 limit (not
//    verified live this session, same caveat as #1).
//
// 4. A SINGLE STATEMENT OVER ~100KB IS REFUSED — Cloudflare's documented per-statement size
//    limit for D1 (not verified live this session). `validate.ts`'s own caller-string bounds
//    (mupot#1516 round-2 P2-5) exist partly so an ordinary provisioning call never comes
//    close to this — the cap here exists so a regression that DID grow a statement past it
//    fails in a test, not silently in production.
//
// 5. ONE RESULT ELEMENT PER STATEMENT — matching D1 REST's actual `/query` response shape
//    (an array, one entry per statement in the request body). mupot#1507-v2's version of
//    this double always returned exactly one result element regardless of how many
//    statements were in the call; nothing in this codebase currently reads past `result[0]`,
//    but a double that lies about the SHAPE of a real API response is a double that will
//    mislead the next caller who does need element N.
//
// 6. THE SQL AUTHORIZER'S OWN REFUSALS: `ATTACH` and `CREATE TEMP TABLE`. `CREATE TEMP
//    TABLE` is EMPIRICALLY VERIFIED in this repo already — see
//    migrations/0049_agent_status_inactive.sql's own header: "D1's SQL authorizer rejects
//    `CREATE TEMP TABLE` outright (SQLITE_AUTH) both locally and against remote D1 —
//    verified empirically via `wrangler d1 execute --local`." `ATTACH` is refused per
//    Cloudflare's published D1 documentation (D1 does not support attaching additional
//    databases) — NOT independently re-verified live in this session; same caveat as #1.
//
// CAVEAT (honest, not a full SQL parser): the leading-keyword checks below (`ATTACH`,
// `CREATE TEMP TABLE`, `COMMIT`/`ROLLBACK`) use `^\s*KEYWORD` against each ALREADY-SPLIT
// statement — they do not skip a `--`/`/* */` comment header the way
// `stripLeadingCommentsAndWhitespace` (also in `scripts/gen-schema-chain.mjs`) does, so a
// comment-prefixed instance of one of these WOULD slip past this double undetected. No
// caller in this repo's real corpus sends any of these three constructs at all (D1's real
// authorizer is the actual enforcement point in production; this double exists to catch a
// REGRESSION in application code before it reaches D1, not to be D1 itself), so this is a
// documented gap, not a silent one.
//
// Any test building a fake Cloudflare REST backend for D1 (see
// tests/helpers/fake-cf-provisioner.ts) should route every `/d1/database/{id}/query` POST
// through `execD1RestQuery` below instead of hand-rolling a new one — reuse, not a fourth
// copy of "what does D1 actually do here."

// @ts-expect-error scripts/gen-schema-chain.mjs is plain Node ESM (no .d.ts) — already
// imported this way from a .ts test file, see tests/schema-chain.test.ts.
import { splitSqlStatements } from '../../scripts/gen-schema-chain.mjs'
import type { SqliteD1Harness } from './sqlite-d1'

export interface D1RestQueryResult {
  success: boolean
  result?: Array<{ results?: unknown[]; success?: boolean }>
  errors?: Array<{ message: string }>
}

/** D1's real refusal text for any transaction-control statement sent through `/query`
 *  (cloudflare/workers-sdk#2733). Exported so a test can assert on it directly rather than
 *  restating the string. */
export const D1_TRANSACTION_CONTROL_ERROR = 'D1_ERROR: cannot start a transaction within a transaction'

/** D1's (documented-by-this-double) refusal for combining bound params with more than one
 *  statement in a single `/query` call — see property #3 above. */
export const D1_MULTI_STATEMENT_PARAMS_ERROR = 'D1_ERROR: parameter binding is only supported for a single statement'

/** See property #3 above (Cloudflare's documented D1 bound-parameter cap). */
export const D1_TOO_MANY_PARAMS_ERROR = 'D1_ERROR: too many bound parameters (max 100)'

/** See property #4 above (Cloudflare's documented D1 per-statement size cap). */
export const D1_STATEMENT_TOO_LARGE_ERROR = 'D1_ERROR: statement too long (over 100KB)'

/** See property #6 above — Cloudflare D1 documentation (not independently verified live). */
export const D1_ATTACH_REFUSED_ERROR = 'D1_ERROR: not authorized to use function: ATTACH'

/** See property #6 above — EMPIRICALLY VERIFIED, migrations/0049_agent_status_inactive.sql's
 *  own header ("D1's SQL authorizer rejects `CREATE TEMP TABLE` outright (SQLITE_AUTH) both
 *  locally and against remote D1"). */
export const D1_TEMP_TABLE_REFUSED_ERROR = 'D1_ERROR: not authorized to use temporary tables'

export const D1_MAX_BOUND_PARAMS = 100
export const D1_MAX_STATEMENT_BYTES = 100_000

const COMMIT_ROLLBACK_RE = /^\s*(COMMIT|ROLLBACK)\b/i
const ATTACH_RE = /^\s*ATTACH\b/i
const CREATE_TEMP_TABLE_RE = /^\s*CREATE\s+TEMP(?:ORARY)?\s+TABLE\b/i
const SELECT_RE = /^\s*SELECT\b/i

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Executes one D1 REST `/query` call's `{sql, params}` body against a real
 * `SqliteD1Harness`, enforcing the six properties documented above. `harness.db` (the D1
 * emulation layer, `?N` param rewriting) is used for the single-statement bound-param path;
 * raw `harness.sqlite` is used for the zero-param path (which may be a multi-statement
 * batch, e.g. `seedPotIdentities`' inlined-literal seed, or a single schema-chain DDL
 * statement) — both run inside the SAME implicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`
 * wrapper this function owns, exactly once per call, never left to the caller.
 */
export async function execD1RestQuery(
  harness: SqliteD1Harness,
  sql: string,
  params: readonly unknown[] = [],
): Promise<D1RestQueryResult> {
  if (params.length > D1_MAX_BOUND_PARAMS) {
    return { success: false, errors: [{ message: D1_TOO_MANY_PARAMS_ERROR }] }
  }

  // Real statement splitting (property #1) — see this file's own header for why a naive
  // per-line regex over the WHOLE batch is unsafe (it would refuse every CREATE TRIGGER).
  let statements: string[]
  try {
    statements = splitSqlStatements(sql, 'd1-rest-double') as string[]
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/transaction-control BEGIN/i.test(message)) {
      return { success: false, errors: [{ message: D1_TRANSACTION_CONTROL_ERROR }] }
    }
    // Anything else the real splitter refuses (an unterminated string, an unbalanced
    // BEGIN/CASE block, ...) is a genuine malformed-SQL failure, not modeled further here.
    return { success: false, errors: [{ message }] }
  }

  if (params.length > 0 && statements.length > 1) {
    return { success: false, errors: [{ message: D1_MULTI_STATEMENT_PARAMS_ERROR }] }
  }

  for (const statement of statements) {
    if (COMMIT_ROLLBACK_RE.test(statement)) {
      return { success: false, errors: [{ message: D1_TRANSACTION_CONTROL_ERROR }] }
    }
    if (ATTACH_RE.test(statement)) {
      return { success: false, errors: [{ message: D1_ATTACH_REFUSED_ERROR }] }
    }
    if (CREATE_TEMP_TABLE_RE.test(statement)) {
      return { success: false, errors: [{ message: D1_TEMP_TABLE_REFUSED_ERROR }] }
    }
    if (byteLength(statement) > D1_MAX_STATEMENT_BYTES) {
      return { success: false, errors: [{ message: D1_STATEMENT_TOO_LARGE_ERROR }] }
    }
  }

  harness.sqlite.exec('BEGIN IMMEDIATE')
  try {
    const resultElements: Array<{ results: unknown[]; success: boolean }> = []

    if (params.length > 0) {
      // Exactly one statement (enforced above) — routed through the D1-emulation layer,
      // which handles `?N` -> anonymous-`?` rewriting.
      const stmt = harness.db.prepare(sql).bind(...(params as unknown[]))
      if (SELECT_RE.test(statements[0])) {
        const res = await stmt.all()
        resultElements.push({ results: (res.results ?? []) as unknown[], success: true })
      } else {
        const res = await stmt.run()
        resultElements.push({ results: [], success: res.success !== false })
      }
    } else {
      // Zero-param — one result element PER STATEMENT (property #5), executed via raw
      // `harness.sqlite` (bypassing the D1-emulation wrapper's `?N` rewriter entirely,
      // which would otherwise corrupt unparameterized SQL containing a `?1`-shaped
      // substring inside a `--` comment — see migrations/0040's own header).
      for (const statement of statements) {
        if (SELECT_RE.test(statement)) {
          resultElements.push({ results: harness.sqlite.prepare(statement).all(), success: true })
        } else {
          harness.sqlite.exec(statement)
          resultElements.push({ results: [], success: true })
        }
      }
    }

    harness.sqlite.exec('COMMIT')
    return { success: true, result: resultElements }
  } catch (error) {
    // node:sqlite leaves a failed multi-statement `exec()` transaction OPEN rather than
    // auto-rolling back (empirically verified — see seedPotIdentities' doc comment history)
    // — the explicit ROLLBACK here is load-bearing, not defensive-only. This is also
    // exactly what property #2 above buys the application code: seedPotIdentities no
    // longer has to issue this itself.
    try {
      harness.sqlite.exec('ROLLBACK')
    } catch {
      // Nothing was open to roll back (e.g. the failure happened before BEGIN could take
      // effect) — not an additional failure worth surfacing.
    }
    return { success: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] }
  }
}
