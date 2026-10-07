// flight/cancelled — the ONE predicate for "this flight was cancelled, not failed" (mupot#1748).
//
// flight_cancel (#1730/#1746) lands a flight as status 'failed' (the status CHECK is not widened,
// migrations/0194) and writes a flight_cancel_receipts row in the same batch. A reader that counts
// status='failed' as a failure outcome therefore miscounts cancels. Every such reader imports THIS
// module; there is no second copy of the predicate.
//
// Authority is the RECEIPT, not the gate_reason prefix: `fail` (executor-reported) takes a free-text
// reason, so an executor could type 'cancelled_by_lead: ...' into a genuine failure. The receipt is
// only written by cancelFlight, guarded on the exact transition.

/** Alias must be a plain SQL identifier: it is interpolated into SQL, never bound. */
function safeAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid_sql_alias')
  return alias
}

/**
 * SQL boolean fragment: the flight aliased `alias` was CANCELLED for counting purposes: it has a cancel
 * receipt AND that receipt is not a self-cancel. A self-cancel (executor/dispatcher through a lead grant it
 * also holds, receipt payload self_cancel=true) still counts as a failure, otherwise an executor could drop
 * its own failing flight out of the failed count (#1748 r2).
 */
export function cancelledFlightSql(alias = 'f'): string {
  const a = safeAlias(alias)
  // Legacy-receipt note (#1748 P2): the self_cancel payload key has been present since migration 0194's first
  // writer, and prod has 0 flight_cancel_receipts rows, so no receipt lacks it; COALESCE only covers hand-built rows.
  return `EXISTS (SELECT 1 FROM flight_cancel_receipts fcr WHERE fcr.tenant = ${a}.tenant AND fcr.flight_id = ${a}.id AND COALESCE(json_extract(fcr.payload, '$.self_cancel'), 0) <> 1)`
}

/**
 * SQL boolean fragment (#1756): the flight was cancelled but its routine run's effect could NOT be fenced
 * (receipt payload routine_outcome = 'unconfirmed'). A missing key (receipts written before #1756) reads as 'none'.
 * This is a LABEL concern only: such a flight still counts as cancelled, never as a failure (#1748).
 */
export function cancelUnconfirmedFlightSql(alias = 'f'): string {
  const a = safeAlias(alias)
  return `EXISTS (SELECT 1 FROM flight_cancel_receipts fcr WHERE fcr.tenant = ${a}.tenant AND fcr.flight_id = ${a}.id AND COALESCE(json_extract(fcr.payload, '$.self_cancel'), 0) <> 1 AND COALESCE(json_extract(fcr.payload, '$.routine_outcome'), 'none') = 'unconfirmed')`
}

/** SELECT-list columns `cancelled` (0/1) and `cancel_unconfirmed` (0/1); JS side: isCancelledFlight / isCancelUnconfirmed. */
export function cancelledColumnSql(alias = 'f'): string {
  return `CASE WHEN ${cancelledFlightSql(alias)} THEN 1 ELSE 0 END AS cancelled, CASE WHEN ${cancelUnconfirmedFlightSql(alias)} THEN 1 ELSE 0 END AS cancel_unconfirmed`
}

/** JS side of cancelUnconfirmedFlightSql. Absent key (hand-built rows, older queries) = not unconfirmed. */
export function isCancelUnconfirmed(
  row: { status: string; cancelled: number | boolean | null | undefined; cancel_unconfirmed?: number | boolean | null },
): boolean {
  return isCancelledFlight(row) && (row.cancel_unconfirmed === 1 || row.cancel_unconfirmed === true)
}

/** SQL fragment: a genuinely failed flight (status failed AND no cancel receipt). */
export function genuinelyFailedFlightSql(alias = 'f'): string {
  const a = safeAlias(alias)
  return `(${a}.status = 'failed' AND NOT ${cancelledFlightSql(a)})`
}

/** JS side of the predicate, over a row read with cancelledColumnSql(). */
// `cancelled` is a REQUIRED key (value may be undefined only for hand-built rows): a reader whose row type
// lacks it fails to compile instead of silently counting cancels as failures (#1748 r2).
export function isCancelledFlight(row: { status: string; cancelled: number | boolean | null | undefined }): boolean {
  return row.status === 'failed' && (row.cancelled === 1 || row.cancelled === true)
}

/** The outcome a reader should DISPLAY/COUNT: 'cancelled' replaces 'failed' for cancels only. */
export function flightOutcome<S extends string>(row: { status: S; cancelled: number | boolean | null | undefined }): S | 'cancelled' {
  return isCancelledFlight(row) ? 'cancelled' : row.status
}

/**
 * SQL boolean fragment for an outcome-feed filter (mupot#1748 r3): rows whose DISPLAYED outcome
 * (flightOutcome) is one of `outcomes`. Pushed into WHERE so it applies BEFORE any LIMIT; filtering in JS
 * after a row cap hides older matches from a cursor consumer. 'cancelled' = failed + non-self receipt,
 * 'failed' = failed with no such receipt, any other value is a stored status. Values are validated
 * (interpolated, never bound) and built only from the shared predicate above.
 */
export function outcomeFilterSql(outcomes: readonly string[], alias = 'f'): string {
  const a = safeAlias(alias)
  if (outcomes.length === 0) return '1=1'
  const parts = new Set<string>()
  for (const o of outcomes) {
    if (!/^[a-z_]+$/.test(o)) throw new Error('invalid_outcome')
    if (o === 'cancelled') parts.add(`(${a}.status = 'failed' AND ${cancelledFlightSql(a)})`)
    else if (o === 'failed') parts.add(genuinelyFailedFlightSql(a))
    else parts.add(`${a}.status = '${o}'`)
  }
  return `(${[...parts].join(' OR ')})`
}
