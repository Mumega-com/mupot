// One shared predicate for "this routine run has an action whose effect may already be in flight".
// A cancel surface (cancelRoutineRun, flight_cancel) cannot fence a 'running' action: executeRoutineAction
// skips its run-status claim guard for an already-running action and commits the effect afterwards.
// So any cancel that finds one must record an UNCONFIRMED outcome, never a confirmed cancellation.
// runIdExpr / tenantExpr are SQL expressions (a bind placeholder or a column reference), never user text.
export function runningActionExistsSql(runIdExpr: string, tenantExpr: string): string {
  return `EXISTS (SELECT 1 FROM routine_run_actions ra WHERE ra.run_id = ${runIdExpr} AND ra.tenant = ${tenantExpr} AND ra.status = 'running')`
}

/** The from_agent every routine control message is sent as (agent_messages.from_agent). */
export const ROUTINE_ACTOR = 'mupot-routines'

// A control message for this run is already in the agent inbox (request_id = routine-run:<run> or
// routine-run:<run>:attempt:<n>). Once delivered it is external work: nothing here can recall it, so a cancel
// that finds one must record an UNCONFIRMED outcome. Same columns/semantics cancelRoutineRun always used.
// Expressions are SQL (bind placeholders or column references), never user text.
export function routineMessageDeliveredExistsSql(runIdExpr: string, tenantExpr: string, projectExpr: string): string {
  return `EXISTS (SELECT 1 FROM agent_messages am WHERE am.tenant = ${tenantExpr} AND am.project_id = ${projectExpr} AND am.from_agent = '${ROUTINE_ACTOR}' AND (am.request_id = 'routine-run:' || ${runIdExpr} OR instr(am.request_id, 'routine-run:' || ${runIdExpr} || ':attempt:') = 1))`
}

// The ONE predicate for "this run's effect may already be in flight": a running action OR a delivered message.
// Both cancel surfaces (cancelRoutineRun, flight_cancel) must treat a hit as unconfirmed (#1746, #1756).
export function routineEffectInFlightSql(runIdExpr: string, tenantExpr: string, projectExpr: string): string {
  return `(${runningActionExistsSql(runIdExpr, tenantExpr)} OR ${routineMessageDeliveredExistsSql(runIdExpr, tenantExpr, projectExpr)})`
}
