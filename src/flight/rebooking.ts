// flight/rebooking — refuse duplicate bookings of already-landed work (mupot#1540 C).
//
// Motivating incident (prod 2026-09-25): a booker's turn hit its 5-minute timeout AFTER it
// had already dispatched; the harness correctly deferred and redelivered the message; the
// fresh turn read state, found no IN-AIR flight, and dispatched again. Clearance
// (clearance.ts) only compares against LIVE flights, so a flight for the same task that had
// landed 27s earlier was invisible to it — 454dcfd0 departed as a no-op duplicate, and
// 121ff12e was even auto-landed by its executor at score 0.7385, reading as a second
// successful landing of one task (fake throughput).
//
// Two independent guards, both used by the MCP flight_dispatch tool and the org-admin
// POST /api/flights route (one predicate, two surfaces):
//
//   1. FINISHED-WORK REFUSAL. Two typed refusals, checked in this order:
//        - `flight_task_already_landed`: a task_id already belongs to a LANDED flight in
//          this tenant (lists the landed flight ids);
//        - `flight_task_already_done` (round 2, gate P1-2): a task_id is already 'done'
//          or 'approved', WHATEVER happened to its earlier flight. The #1540 victims'
//          earlier flights were REAPED ('failed'), not landed, so the landed check alone
//          still let the approved work be re-booked — and a fresh flight over already-
//          done tasks can land at once, which is exactly the fake throughput of 121ff12e.
//      'done' is terminal in the task transition matrix (src/tasks/service.ts), so
//      finished work never legitimately needs another flight — except by an explicit,
//      RECEIPTED override (redispatch_landed_reason). The flight_redispatch_receipts row
//      is written in the SAME D1 batch as the flight INSERT (createFlight's
//      redispatchReceipt option): no receipt without its flight, no flight without its
//      receipt.
//
//   2. IDEMPOTENCY KEY. client_request_id, unique per (tenant, dispatching agent). A retry
//      carrying the same key returns the ORIGINAL flight (no second row, no second
//      envelope). The same key with a DIFFERENT request is refused
//      `client_request_id_conflict` rather than silently returning a flight for work the
//      caller did not ask for. The unique index in 0172 closes the read→insert race: the
//      loser's INSERT throws FlightIdempotencyConflictError and the caller re-reads.
//
// Not closed here, deliberately: clearance's own TOCTOU note (two LIVE dispatches racing
// within the read→insert window) is unchanged — the idempotency key covers the redelivery
// shape, which is the one observed.

import type { Env } from '../types'
import type { FlightRow } from './service'
import { parseFlightMetaV1, type FlightMetaV1 } from './meta'

export const CLIENT_REQUEST_ID_MAX_LENGTH = 200
export const REDISPATCH_REASON_MAX_LENGTH = 500

/** Printable, non-blank, bounded. Refuses control chars so a key can never smuggle log lines. */
export function parseClientRequestId(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > CLIENT_REQUEST_ID_MAX_LENGTH) return { ok: false }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false }
  return { ok: true, value: trimmed }
}

export function parseRedispatchReason(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false }
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > REDISPATCH_REASON_MAX_LENGTH) return { ok: false }
  return { ok: true, value: trimmed }
}

export interface LandedTaskFlight {
  flight_id: string
  task_id: string
}

/** Every (landed flight, task_id) pair in this tenant whose task_id is in `taskIds`. */
export async function listLandedFlightsForTasks(env: Env, taskIds: readonly string[]): Promise<LandedTaskFlight[]> {
  if (taskIds.length === 0) return []
  const rows = await env.DB.prepare(
    `SELECT f.id AS flight_id, CAST(ref.value AS TEXT) AS task_id
       FROM flights f,
            json_each(CASE WHEN json_valid(f.meta) THEN f.meta ELSE '{}' END, '$.task_ids') ref
      WHERE f.tenant = ?1
        AND f.status = 'landed'
        AND ref.type = 'text'
        AND ref.value IN (SELECT value FROM json_each(?2))
      ORDER BY f.ended_at DESC, f.id ASC`,
  ).bind(env.TENANT_SLUG, JSON.stringify(taskIds)).all<LandedTaskFlight>()
  return rows.results ?? []
}

/** Every task in `taskIds` that is already finished ('done') or approved-awaiting-done. */
export async function listFinishedTaskIds(env: Env, taskIds: readonly string[]): Promise<string[]> {
  if (taskIds.length === 0) return []
  const rows = await env.DB.prepare(
    `SELECT id FROM tasks
      WHERE id IN (SELECT value FROM json_each(?1))
        AND status IN ('done', 'approved')
      ORDER BY id`,
  ).bind(JSON.stringify(taskIds)).all<{ id: string }>()
  return (rows.results ?? []).map((row) => row.id)
}

export type FinishedWorkConflict =
  | { error: 'flight_task_already_landed'; landed_flight_ids: string[]; task_ids: string[] }
  | { error: 'flight_task_already_done'; landed_flight_ids: string[]; task_ids: string[] }

/** The single predicate both dispatch surfaces call. null = no finished work named. */
export async function findFinishedWorkConflict(
  env: Env,
  taskIds: readonly string[],
): Promise<FinishedWorkConflict | null> {
  const landed = await listLandedFlightsForTasks(env, taskIds)
  if (landed.length > 0) return { error: 'flight_task_already_landed', ...summarizeLandedConflict(landed) }
  const finished = await listFinishedTaskIds(env, taskIds)
  if (finished.length > 0) return { error: 'flight_task_already_done', landed_flight_ids: [], task_ids: finished }
  return null
}

export function summarizeLandedConflict(rows: readonly LandedTaskFlight[]): {
  landed_flight_ids: string[]
  task_ids: string[]
} {
  return {
    landed_flight_ids: [...new Set(rows.map((row) => row.flight_id))],
    task_ids: [...new Set(rows.map((row) => row.task_id))],
  }
}

export interface RedispatchReceiptInput {
  actor: { kind: 'member' | 'agent'; id: string }
  reason: string
  landedFlightIds: readonly string[]
  taskIds: readonly string[]
}

/**
 * The receipt INSERT, bound to `flightId`. createFlight runs it in the SAME batch as the
 * flight INSERT and guards it on that row existing, so the two commit or roll back together.
 */
export function redispatchReceiptStatement(env: Env, flightId: string, input: RedispatchReceiptInput, nowMs = Date.now()) {
  return env.DB.prepare(
    `INSERT INTO flight_redispatch_receipts
       (id, tenant, flight_id, actor_kind, actor_id, reason, landed_flight_ids, task_ids, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE EXISTS (SELECT 1 FROM flights WHERE id = ?3 AND tenant = ?2)`,
  ).bind(
    crypto.randomUUID(),
    env.TENANT_SLUG,
    flightId,
    input.actor.kind,
    input.actor.id,
    input.reason,
    JSON.stringify(input.landedFlightIds),
    JSON.stringify(input.taskIds),
    nowMs,
  )
}

export async function findFlightByClientRequestId(
  env: Env,
  dispatchedByAgentId: string,
  clientRequestId: string,
): Promise<FlightRow | null> {
  return (
    (await env.DB.prepare(
      `SELECT * FROM flights
        WHERE tenant = ?1 AND dispatched_by_agent_id = ?2 AND client_request_id = ?3`,
    ).bind(env.TENANT_SLUG, dispatchedByAgentId, clientRequestId).first<FlightRow>()) ?? null
  )
}

export interface IdempotentRequestShape {
  agent: string
  goal: string
  project_id: string | null
  budget_micro_usd: number | null
  meta: FlightMetaV1
}

/**
 * True when a stored flight is the SAME request as the retry. Meta is compared after
 * re-parsing the stored JSON, so key order in storage can never produce a false conflict.
 */
export function sameDispatchRequest(stored: FlightRow, request: IdempotentRequestShape): boolean {
  let storedMeta: FlightMetaV1 | null = null
  try {
    storedMeta = parseFlightMetaV1(JSON.parse(stored.meta) as unknown)
  } catch {
    storedMeta = null
  }
  if (!storedMeta) return false
  return stored.agent === request.agent
    && stored.goal === request.goal
    && (stored.project_id ?? null) === request.project_id
    && (stored.budget_micro_usd ?? null) === request.budget_micro_usd
    && JSON.stringify(storedMeta) === JSON.stringify(request.meta)
}
