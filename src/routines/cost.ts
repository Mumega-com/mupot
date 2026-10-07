// mupot#1738 (follow-up to #1732): routine_runs.cost_micro_usd is SUM(flights.cost_micro_usd),
// and an unmetered flight (cost_metered=0) stores cost 0. Summing it as 0 fabricates a
// "free" run that feeds budget ENFORCEMENT. The unmetered signal is computed at READ time
// (no column, no backfill, never stale) with the same flight-membership predicate the cost
// aggregation uses, so the two can never disagree about which flights belong to a run.

/** SQL scalar subquery: how many of the run's flights have an unknown (unmetered) cost. */
export function unmeteredFlightsSql(runAlias: string): string {
  return `(SELECT COUNT(*) FROM flights uf
            WHERE uf.tenant = ${runAlias}.tenant AND uf.cost_metered = 0 AND (
              uf.id = ${runAlias}.flight_id OR uf.id IN (
                SELECT ref_id FROM routine_run_refs
                 WHERE run_id = ${runAlias}.id AND ref_type = 'flight'
              )
            ))`
}

/** Budget compliance is unknown (fail closed) when ANY flight of the run is unmetered. */
export function runBudgetUnknown(run: { cost_unmetered_flights?: number | null }): boolean {
  return Number(run.cost_unmetered_flights ?? 0) > 0
}
