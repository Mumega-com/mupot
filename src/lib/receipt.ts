// Write receipts (#186) — turn a silent 0-row D1 write into a loud failure.
//
// Phantom success: `.run()` / `.batch()` only THROW on a hard DB error. An INSERT
// that affects no rows (a swallowed ON CONFLICT, a constraint no-op, a write to a
// replica that doesn't land) resolves "successfully" — so a handler that returns
// done(...) right after is reporting a write that never happened. This module is
// the "check the column, not the log" rule made reusable: assert D1 actually
// acknowledged the rows. The convention already lived ad-hoc across the codebase
// (`res.meta?.changes ?? 0` checks in loops/, prospects/, org/); this codifies it.

/** The shape both `D1PreparedStatement.run()` and each `D1.batch()` element share. */
export interface D1WriteLike {
  success?: boolean
  meta?: { changes?: number; rows_written?: number }
}

/** Rows a D1 write acknowledged. `changes` is the canonical field; `rows_written`
 *  is the fallback some bindings surface. Absent → 0 (fail-closed). */
export function rowsWritten(result: D1WriteLike): number {
  return result.meta?.changes ?? result.meta?.rows_written ?? 0
}

/**
 * Throw unless `result` acknowledged at least `expected` rows. `what` names the
 * write for the error (e.g. "tasks.insert"). Use immediately after `.run()` on any
 * mutating statement whose success the caller is about to report.
 */
export function assertWritten(result: D1WriteLike, what: string, expected = 1): void {
  const n = rowsWritten(result)
  if (result.success === false || n < expected) {
    throw new Error(
      `receipt_failed: ${what} reported no error but wrote ${n} row(s), expected >= ${expected}`,
    )
  }
}

/**
 * Assert every statement in a `D1.batch()` result wrote `perStatement` rows. A
 * partial batch (e.g. one INSERT of a multi-row mint silently no-ops) is exactly
 * the phantom-success this catches — a "minted" token whose capability row never
 * landed is worse than a clean failure.
 */
export function assertBatchWritten(results: D1WriteLike[], what: string, perStatement = 1): void {
  results.forEach((r, i) => assertWritten(r, `${what}[${i}]`, perStatement))
}
