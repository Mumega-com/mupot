// One shared predicate for "this routine run has an action whose effect may already be in flight".
// A cancel surface (cancelRoutineRun, flight_cancel) cannot fence a 'running' action: executeRoutineAction
// skips its run-status claim guard for an already-running action and commits the effect afterwards.
// So any cancel that finds one must record an UNCONFIRMED outcome, never a confirmed cancellation.
// runIdExpr / tenantExpr are SQL expressions (a bind placeholder or a column reference), never user text.
export function runningActionExistsSql(runIdExpr: string, tenantExpr: string): string {
  return `EXISTS (SELECT 1 FROM routine_run_actions ra WHERE ra.run_id = ${runIdExpr} AND ra.tenant = ${tenantExpr} AND ra.status = 'running')`
}
