// tests/helpers/d1-rest-double.ts — a D1 REST `/query` double that behaves like the REAL
// Cloudflare D1 REST API for the properties that actually mattered to a real defect
// (mupot#1507-v2 P0-A), not just "answers success to every insert" — mupot#1507 round-1's
// own postmortem named that exact gap: a fake CF that always answered `{success:true}`
// could not see a real schema refusal, so `seedPotIdentities`' happy path had NEVER once
// actually run before it shipped.
//
// THREE PROPERTIES THIS DOUBLE ENFORCES
//
// 1. TRANSACTION CONTROL IS REFUSED, with D1's own real error text. Cloudflare's D1 REST
//    `/query` endpoint rejects any `BEGIN` / `COMMIT` / `ROLLBACK` statement sent through
//    it — "cannot start a transaction within a transaction" — because the semicolon-joined
//    statements in ONE `/query` call are ALREADY executed as a single atomic batch;
//    wrapping them in an app-level BEGIN/COMMIT is not merely redundant, it errors.
//    (developers.cloudflare.com/d1/best-practices/import-export-data/,
//    developers.cloudflare.com/d1/worker-api/d1-database/, cloudflare/workers-sdk#2733).
//    This repo's own `scripts/gen-schema-chain.mjs` already refuses to GENERATE a migration
//    containing transaction-control BEGIN for the identical reason (see its "TRANSACTION-
//    CONTROL BEGIN IS CLASSIFIED AND REFUSED" doc comment) — this double is the runtime
//    half of the same rule, so a regression that reintroduces an app-level BEGIN/COMMIT
//    into any D1-REST caller fails a real test instead of only ever being caught by a live
//    Cloudflare 500 nobody sees until production.
//
// 2. A MULTI-STATEMENT BATCH RUNS INSIDE ITS OWN IMPLICIT TRANSACTION — mirroring the real
//    engine's behavior (the whole point of #1: the caller doesn't need to, and must not,
//    wrap it itself) — so a failure partway through a semicolon-joined `/query` body
//    leaves NOTHING committed, without the caller ever sending BEGIN/COMMIT.
//
// 3. PARAMETER BINDING IS SINGLE-STATEMENT ONLY. D1 REST's `?N` binding behavior for a
//    MULTI-statement string in one call is undocumented (see src/pots/service.ts's own doc
//    comment on `seedPotIdentities`, which is exactly why that function inlines literals
//    instead) — this double refuses that combination outright rather than silently
//    guessing a semantics Cloudflare has never published, so a future caller that tries it
//    fails LOUD in tests before it ever reaches production.
//
// Any test building a fake Cloudflare REST backend for D1 (see
// tests/pot-provisioner.test.ts's `createRealisticFakeCf`) should route every
// `/d1/database/{id}/query` POST through `execD1RestQuery` below instead of hand-rolling a
// new one — reuse, not a fourth copy of "what does D1 actually do here."

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

const TRANSACTION_CONTROL_RE = /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i

/** True when `sql` (after stripping ONE optional trailing terminator) still contains a
 *  `;` — i.e. it names more than one statement. A heuristic, not a full SQL parser (it does
 *  not account for a `;` inside a string literal or comment, unlike
 *  `scripts/gen-schema-chain.mjs`'s real state-machine splitter) — sufficient here because
 *  this check only ever fires on the `params.length > 0` branch, and every genuinely
 *  parameterized call in this codebase (the `readFullSeedIdentityState` identity-check
 *  SELECTs) is already a single statement with no embedded semicolons. */
function looksMultiStatement(sql: string): boolean {
  return /;/.test(sql.trim().replace(/;\s*$/, ''))
}

/**
 * Executes one D1 REST `/query` call's `{sql, params}` body against a real
 * `SqliteD1Harness`, enforcing the three properties documented above. `harness.db` (the D1
 * emulation layer, `?N` param rewriting) is used for the bound-param path; raw
 * `harness.sqlite` is used for the zero-param path (which may be a multi-statement batch,
 * e.g. `seedPotIdentities`' inlined-literal seed, or a single schema-chain DDL statement) —
 * both run inside the SAME implicit `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` wrapper this
 * function owns, exactly once per call, never left to the caller.
 */
export async function execD1RestQuery(
  harness: SqliteD1Harness,
  sql: string,
  params: readonly unknown[] = [],
): Promise<D1RestQueryResult> {
  if (TRANSACTION_CONTROL_RE.test(sql)) {
    return { success: false, errors: [{ message: D1_TRANSACTION_CONTROL_ERROR }] }
  }
  if (params.length > 0 && looksMultiStatement(sql)) {
    return { success: false, errors: [{ message: D1_MULTI_STATEMENT_PARAMS_ERROR }] }
  }

  const isSelect = /^\s*SELECT/i.test(sql)

  harness.sqlite.exec('BEGIN IMMEDIATE')
  try {
    let resultRows: unknown[] = []
    let ok = true

    if (params.length > 0) {
      const stmt = harness.db.prepare(sql).bind(...(params as unknown[]))
      if (isSelect) {
        const res = await stmt.all()
        resultRows = (res.results ?? []) as unknown[]
      } else {
        const res = await stmt.run()
        ok = res.success !== false
      }
    } else if (isSelect) {
      resultRows = harness.sqlite.prepare(sql).all()
    } else {
      harness.sqlite.exec(sql)
    }

    harness.sqlite.exec('COMMIT')
    return { success: true, result: [{ results: resultRows, success: ok }] }
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
