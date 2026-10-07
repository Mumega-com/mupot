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
  return `EXISTS (SELECT 1 FROM flight_cancel_receipts fcr WHERE fcr.tenant = ${a}.tenant AND fcr.flight_id = ${a}.id AND COALESCE(json_extract(fcr.payload, '$.self_cancel'), 0) <> 1)`
}

/** SELECT-list column `cancelled` (0/1) so the JS side can ask isCancelledFlight(row). */
export function cancelledColumnSql(alias = 'f'): string {
  return `CASE WHEN ${cancelledFlightSql(alias)} THEN 1 ELSE 0 END AS cancelled`
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
