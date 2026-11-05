// Fenced disposition of a flight's child tasks when the flight ends as failed (cancel or reap).
//
// A flight links its work only through flights.meta.task_ids. Before this module a failed flight
// left every one of those tasks open or in_progress and assigned forever.
//
// Rules, decided in SQL inside the SAME D1 batch as the flight transition (no pre-read is trusted):
//   done / approved / rejected / review   untouched
//   open                                   -> blocked, reason recorded, assignee kept (recoverable)
//   in_progress, no live execution         -> blocked, reason recorded, assignee kept
//   in_progress, live execution            left running, recorded; never reopened or reassigned
//   archived                               untouched
//
// "Live execution" mirrors the incident-revert fence: an unexpired execution claim, a runtime
// receipt without an expired claim, or a dispatch that can still be executed or redelivered.
//
// TRANSITIONS (tasks/service.ts) has no open->blocked edge (and no review->blocked edge, which the
// reap already writes for routine control tasks). This is a controller write with the same shape as
// the other raw status writers; it is recoverable because blocked->in_progress is legal. The status
// is fenced in every WHERE so a concurrent legal transition always wins.
//
// Each affected child gets one mutation_audit_entries row written BEFORE the UPDATE with the very
// same predicate, so the evidence and the mutation cannot disagree about which state they matched.

import type { Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { archiveBlockingDispatchExistsSql } from '../tasks/runtime-receipts'

export type FlightChildDisposition = 'blocked' | 'left_running'

export interface FlightChildRecord {
  task_id: string
  from_status: 'open' | 'in_progress'
  disposition: FlightChildDisposition
  reason: string
}

export const FLIGHT_CHILD_BLOCKED_OP = 'flight_child_task_blocked'
export const FLIGHT_CHILD_LEFT_RUNNING_OP = 'flight_child_task_left_running'

// Params used by the statements below (positional, 1-based):
//  ?1 flight id  ?2 tenant  ?3 flight ended_at (ms)  ?4 flight gate_reason  ?5 now (ms)
//  ?6 now (ISO)  ?7 child reason (flight_cancelled | flight_reaped)  ?8 blocked result text
//  ?9 audit principal kind  ?10 audit principal id  ?11 handler  ?12 request id  ?13 audit id prefix
const IN_FLIGHT_SQL = `t.id IN (SELECT value FROM json_each(
  (SELECT CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END FROM flights f WHERE f.id = ?1 AND f.tenant = ?2),
  '$.task_ids'))`

// A routine-bound flight's only task is its attempt-scoped control task, which the routine run's own
// lifecycle (and the reap's exact-identity repair) owns. Never sweep those here.
const NOT_ROUTINE_FLIGHT_SQL = `NOT EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.tenant = ?2 AND rr.flight_id = ?1)`

const FLIGHT_FAILED_SQL = `${NOT_ROUTINE_FLIGHT_SQL} AND EXISTS (
  SELECT 1 FROM flights f
   WHERE f.id = ?1 AND f.tenant = ?2 AND f.status = 'failed' AND f.ended_at = ?3 AND f.gate_reason = ?4)`

const LIVE_EXECUTION_SQL = `(
  (t.execution_claim_expires_at IS NOT NULL AND t.execution_claim_expires_at > ?5)
  OR (t.execution_receipt_id IS NOT NULL
      AND NOT (t.execution_claim_expires_at IS NOT NULL AND t.execution_claim_expires_at <= ?5))
  OR ${archiveBlockingDispatchExistsSql({ tenantParam: '?2', taskIdExpr: 't.id' })}
)`

const BLOCKABLE_SQL = `(t.status = 'open' OR (t.status = 'in_progress' AND NOT ${LIVE_EXECUTION_SQL}))`
const LEFT_RUNNING_SQL = `(t.status = 'in_progress' AND ${LIVE_EXECUTION_SQL})`

export interface FlightChildStatements {
  statements: D1PreparedStatement[]
  /** Index (within `statements`) of the UPDATE whose RETURNING lists the blocked task ids. */
  updateIndex: number
}

/** Fenced child-disposition statements; append them to the batch that fails the flight. */
export function flightChildDispositionStatements(
  env: Env,
  p: {
    flightId: string
    endedAtMs: number
    gateReason: string
    nowMs: number
    childReason: 'flight_cancelled' | 'flight_reaped'
    principalKind: string
    principalId: string
    handler: string
    requestId: string
  },
): FlightChildStatements {
  const nowIso = new Date(p.nowMs).toISOString()
  const blockedResult = `${p.childReason}: flight ${p.flightId} ended as failed (${p.gateReason.slice(0, 120)})`
  const binds = [
    p.flightId, env.TENANT_SLUG, p.endedAtMs, p.gateReason, p.nowMs, nowIso, p.childReason, blockedResult,
    p.principalKind, p.principalId, p.handler, p.requestId,
  ]
  const audit = env.DB.prepare(
    `INSERT INTO mutation_audit_entries (
       id, tenant, principal_kind, principal_id, origin, handler, operation,
       target_kind, target_id, flight_id, task_id, request_id, evidence_json, recorded_at
     )
     SELECT lower(hex(randomblob(16))), ?2, ?9, ?10, 'controller', ?11,
            CASE WHEN ${LEFT_RUNNING_SQL} THEN '${FLIGHT_CHILD_LEFT_RUNNING_OP}' ELSE '${FLIGHT_CHILD_BLOCKED_OP}' END,
            'task', t.id, ?1, t.id, ?12,
            json_object('task_id', t.id, 'from_status', t.status,
                        'disposition', CASE WHEN ${LEFT_RUNNING_SQL} THEN 'left_running' ELSE 'blocked' END,
                        'reason', ?7),
            ?6
       FROM tasks t
      WHERE ${IN_FLIGHT_SQL}
        AND ${TASK_NOT_ARCHIVED_SQL('t')}
        AND t.status IN ('open', 'in_progress')
        AND ${FLIGHT_FAILED_SQL}`,
  ).bind(...binds)
  const update = env.DB.prepare(
    `UPDATE tasks AS t
        SET status = 'blocked',
            -- never discard what the task already carries (e.g. artifact evidence): append the reason
            result = CASE WHEN result IS NULL OR result = '' THEN ?8 ELSE result || char(10) || ?8 END,
            updated_at = ?6
      WHERE ${IN_FLIGHT_SQL}
        AND ${TASK_NOT_ARCHIVED_SQL('t')}
        AND ${BLOCKABLE_SQL}
        AND ${FLIGHT_FAILED_SQL}
      RETURNING id`,
  ).bind(...binds.slice(0, 8))
  return { statements: [audit, update], updateIndex: 1 }
}

/** SQL fragment: JSON array of the per-child records written for `requestId` (receipt payload). */
export const FLIGHT_CHILD_RECORDS_JSON_SQL = (flightIdParam: string, requestIdParam: string): string =>
  `json((SELECT COALESCE(json_group_array(json(a.evidence_json)), json('[]'))
      FROM mutation_audit_entries a
     WHERE a.flight_id = ${flightIdParam} AND a.request_id = ${requestIdParam}
       AND a.operation IN ('${FLIGHT_CHILD_BLOCKED_OP}', '${FLIGHT_CHILD_LEFT_RUNNING_OP}')))`
