// src/harness/reservations.ts — D1 persistence for Harness Reservations.
//
// Authoritative pre-dispatch ledger:
// 1. Reserves Task + Flight before touching vendor APIs.
// 2. Enforces idempotency per (tenant, squad_id, adapter, idempotency_key); the reservation INSERT is the lock.
// 3. Guards against divergent payloads reusing the same idempotency key.
// 4. Manages attach lease timeouts and status reconciliation.

import type { Env } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import type {
  DispatchRequest,
  HarnessActor,
  HarnessDispatchState,
  HarnessKind,
} from './types'

export interface HarnessReservationRow {
  id: string
  tenant: string
  adapter: HarnessKind
  idempotency_key: string
  request_digest: string
  /** NULL = reserved, not yet bound to a Task/Flight (insert-first ordering). */
  task_id: string | null
  flight_id: string | null
  agent_id: string
  squad_id: string
  actor_kind: 'member' | 'agent'
  actor_id: string
  state: HarnessDispatchState
  vendor_agent_id: string | null
  vendor_run_id: string | null
  vendor_url: string | null
  last_vendor_status: string | null
  attach_lease_until: string | null
  attach_lease_id: string | null
  last_error: string | null
  reserved_at: string
  attached_at: string | null
  reconciled_at: string | null
  updated_at: string
}

export async function computeRequestDigest(adapter: HarnessKind, req: DispatchRequest): Promise<string> {
  const canonical = JSON.stringify({
    adapter,
    name: req.name.trim(),
    prompt: req.prompt.trim(),
    repoUrl: req.repoUrl?.trim() ?? '',
    model: req.model?.trim() ?? '',
    squadId: req.squadId,
    agentId: req.agentId,
  })
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** A reservation that is still reserved/attaching after this long is reported as stuck by status(). */
export const RESERVATION_STUCK_MS = 10 * 60_000

export type InsertReservationOutcome =
  | { outcome: 'inserted'; row: HarnessReservationRow }
  | { outcome: 'replay'; row: HarnessReservationRow }
  | { outcome: 'conflict'; existingRow: HarnessReservationRow }

/**
 * INSERT-FIRST: the reservation row (task_id/flight_id NULL) is the idempotency lock. Callers create Task + Flight
 * only after an 'inserted' outcome, then call bindReservationTaskFlight. A UNIQUE hit is a replay or a conflict,
 * decided before any side effect.
 */
export async function insertReservation(
  env: Env,
  params: {
    id: string
    adapter: HarnessKind
    idempotencyKey: string
    requestDigest: string
    agentId: string
    squadId: string
    actor: HarnessActor
  },
): Promise<InsertReservationOutcome> {
  const tenant = env.TENANT_SLUG
  const now = new Date().toISOString()

  try {
    await env.DB.prepare(
      `INSERT INTO harness_reservations (
        id, tenant, adapter, idempotency_key, request_digest,
        task_id, flight_id, agent_id, squad_id, actor_kind, actor_id,
        state, reserved_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'reserved', ?, ?)`,
    )
      .bind(
        params.id,
        tenant,
        params.adapter,
        params.idempotencyKey,
        params.requestDigest,
        params.agentId,
        params.squadId,
        params.actor.kind,
        params.actor.id,
        now,
        now,
      )
      .run()

    const inserted: HarnessReservationRow = {
      id: params.id,
      tenant,
      adapter: params.adapter,
      idempotency_key: params.idempotencyKey,
      request_digest: params.requestDigest,
      task_id: null,
      flight_id: null,
      agent_id: params.agentId,
      squad_id: params.squadId,
      actor_kind: params.actor.kind,
      actor_id: params.actor.id,
      state: 'reserved',
      vendor_agent_id: null,
      vendor_run_id: null,
      vendor_url: null,
      last_vendor_status: null,
      attach_lease_until: null,
      attach_lease_id: null,
      last_error: null,
      reserved_at: now,
      attached_at: null,
      reconciled_at: null,
      updated_at: now,
    }
    return { outcome: 'inserted', row: inserted }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('UNIQUE constraint failed') && !message.includes('unique_constraint')) {
      throw error
    }

    const existing = await getReservationByIdempotency(env, params.adapter, params.squadId, params.idempotencyKey)
    if (!existing) throw error
    if (existing.request_digest === params.requestDigest) {
      return { outcome: 'replay', row: existing }
    }
    return { outcome: 'conflict', existingRow: existing }
  }
}

/**
 * Bind the freshly created Task + Flight to the reservation. Only the inserter calls this, exactly once
 * (`task_id IS NULL` guard). When the flight gate held the flight, the same statement fails the reservation.
 */
export async function bindReservationTaskFlight(
  env: Env,
  id: string,
  taskId: string,
  flightId: string | null,
  opts: { held: boolean },
): Promise<boolean> {
  const now = new Date().toISOString()
  const held = opts.held ? 1 : 0
  const result = await env.DB.prepare(
    `UPDATE harness_reservations
     SET task_id = ?, flight_id = ?,
         state = CASE WHEN ? = 1 AND state = 'reserved' THEN 'failed' ELSE state END,
         last_error = CASE WHEN ? = 1 AND state = 'reserved' THEN 'flight_gate_held' ELSE last_error END,
         updated_at = ?
     WHERE tenant = ? AND id = ? AND task_id IS NULL`,
  )
    .bind(taskId, flightId, held, held, now, env.TENANT_SLUG, id)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export async function getReservation(env: Env, id: string): Promise<HarnessReservationRow | null> {
  const result = await env.DB.prepare(
    `SELECT * FROM harness_reservations WHERE tenant = ? AND id = ?`,
  )
    .bind(env.TENANT_SLUG, id)
    .first<HarnessReservationRow>()
  return result ?? null
}

export async function getReservationByIdempotency(
  env: Env,
  adapter: HarnessKind,
  squadId: string,
  idempotencyKey: string,
): Promise<HarnessReservationRow | null> {
  const result = await env.DB.prepare(
    `SELECT * FROM harness_reservations WHERE tenant = ? AND squad_id = ? AND adapter = ? AND idempotency_key = ?`,
  )
    .bind(env.TENANT_SLUG, squadId, adapter, idempotencyKey)
    .first<HarnessReservationRow>()
  return result ?? null
}

export const LAUNCH_LEASE_EXPIRED_ERROR = 'launch_unconfirmed: lease_expired'

/**
 * Claim the attach lease and return its fencing token (null = not claimed).
 *
 * An EXPIRED 'attaching' row is NEVER re-claimed: its previous attacher may already have launched the vendor run
 * (the process can be evicted between the vendor POST and the bind), so re-launching could duplicate the run. The
 * expired row moves to 'failed' with last_error 'launch_unconfirmed: lease_expired' (reconcile by vendor lookup,
 * never by re-launch). A reservation not yet bound to a Task is never leased.
 */
export async function claimAttachLease(
  env: Env,
  id: string,
  leaseMs = 45_000,
): Promise<string | null> {
  const now = new Date()
  const nowIso = now.toISOString()
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
  const leaseId = crypto.randomUUID()

  await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'failed', last_error = ?, attach_lease_until = NULL, attach_lease_id = NULL, updated_at = ?
     WHERE tenant = ? AND id = ?
       AND state = 'attaching' AND (attach_lease_until IS NULL OR attach_lease_until < ?)`,
  )
    .bind(LAUNCH_LEASE_EXPIRED_ERROR, nowIso, env.TENANT_SLUG, id, nowIso)
    .run()

  const result = await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'attaching', attach_lease_until = ?, attach_lease_id = ?, updated_at = ?
     WHERE tenant = ? AND id = ? AND state = 'reserved' AND task_id IS NOT NULL`,
  )
    .bind(leaseUntil, leaseId, nowIso, env.TENANT_SLUG, id)
    .run()

  return (result.meta?.changes ?? 0) > 0 ? leaseId : null
}

/** Give the lease back (reserved again) without launching, e.g. when execution is paused. Fenced on the lease id. */
export async function releaseAttachLease(env: Env, id: string, leaseId: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'reserved', attach_lease_until = NULL, attach_lease_id = NULL, updated_at = ?
     WHERE tenant = ? AND id = ? AND state = 'attaching' AND attach_lease_id = ?`,
  )
    .bind(new Date().toISOString(), env.TENANT_SLUG, id, leaseId)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

/** Bind vendor ids to an 'attaching' reservation. Fenced: only the holder of `leaseId` can bind. */
export async function bindVendorExecution(
  env: Env,
  id: string,
  leaseId: string,
  vendor: {
    agentId?: string
    runId?: string
    url?: string
    status?: string
  },
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'attached',
         vendor_agent_id = coalesce(?, vendor_agent_id),
         vendor_run_id = coalesce(?, vendor_run_id),
         vendor_url = coalesce(?, vendor_url),
         last_vendor_status = coalesce(?, last_vendor_status),
         attached_at = coalesce(attached_at, ?),
         attach_lease_until = NULL,
         updated_at = ?
     WHERE tenant = ? AND id = ? AND state = 'attaching' AND attach_lease_id = ?`,
  )
    .bind(
      vendor.agentId ?? null,
      vendor.runId ?? null,
      vendor.url ?? null,
      vendor.status ?? null,
      now,
      now,
      env.TENANT_SLUG,
      id,
      leaseId,
    )
    .run()

  return (result.meta?.changes ?? 0) > 0
}

/**
 * The task-body append of the atomic attach. Only valid as the statement AFTER the fenced reservation flip inside
 * one batch: `changes() = 1` anchors it on that flip, and the EXISTS re-checks the lease id AND run id (defence in
 * depth: the row it appends for must be exactly this call's binding).
 */
export function taskBindingStatement(
  env: Env,
  reservationId: string,
  leaseId: string,
  taskId: string,
  cursor: { agentId: string; runId: string; agentUrl: string },
  now: string,
) {
  const extra = ['', `cursor_agent: ${cursor.agentId}`, `cursor_run: ${cursor.runId}`, `cursor_url: ${cursor.agentUrl}`].join('\n')
  return env.DB.prepare(
    `UPDATE tasks
     SET body = body || ?, updated_at = ?
     WHERE id = ?
       AND changes() = 1
       AND EXISTS (
         SELECT 1 FROM harness_reservations
         WHERE tenant = ? AND id = ? AND state = 'attached' AND vendor_run_id = ? AND attach_lease_id = ?
       )`,
  ).bind(extra, now, taskId, env.TENANT_SLUG, reservationId, cursor.runId, leaseId)
}

/**
 * Atomic attach: flip the reservation to attached AND append the vendor binding to the task body in ONE batch.
 * Statement 1 is fenced on this call's lease id. Statement 2 (the task body append) runs only if statement 1
 * flipped a row IN THIS BATCH (`changes() = 1`) AND the reservation still carries this lease id + run id, so a
 * second call with the same ids (already attached) appends nothing. Returns false when the fence matched no row.
 */
export async function bindVendorExecutionWithTaskBinding(
  env: Env,
  reservationId: string,
  leaseId: string,
  taskId: string,
  cursor: { agentId: string; runId: string; agentUrl: string },
  vendorStatus?: string,
): Promise<boolean> {
  const now = new Date().toISOString()
  const [bound] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE harness_reservations
       SET state = 'attached',
           vendor_agent_id = ?, vendor_run_id = ?, vendor_url = ?,
           last_vendor_status = coalesce(?, last_vendor_status),
           attached_at = coalesce(attached_at, ?),
           attach_lease_until = NULL,
           updated_at = ?
       WHERE tenant = ? AND id = ? AND state = 'attaching' AND attach_lease_id = ?`,
    ).bind(cursor.agentId, cursor.runId, cursor.agentUrl, vendorStatus ?? null, now, now, env.TENANT_SLUG, reservationId, leaseId),
    taskBindingStatement(env, reservationId, leaseId, taskId, cursor, now),
  ])
  return (bound?.meta?.changes ?? 0) > 0
}

/**
 * Fail a reservation. An attacher MUST pass its `leaseId` (fenced: only the current lease holder can fail an
 * 'attaching' row). Without a lease id only a 'reserved' row (the reserve path, no attacher yet) can be failed.
 */
export async function markReservationFailed(
  env: Env,
  id: string,
  error: string,
  opts?: { leaseId?: string },
): Promise<boolean> {
  const now = new Date().toISOString()
  const truncatedError = error.slice(0, 2000)
  const leaseId = opts?.leaseId
  const result = leaseId
    ? await env.DB.prepare(
        `UPDATE harness_reservations
         SET state = 'failed', last_error = ?, attach_lease_until = NULL, updated_at = ?
         WHERE tenant = ? AND id = ? AND state = 'attaching' AND attach_lease_id = ?`,
      )
        .bind(truncatedError, now, env.TENANT_SLUG, id, leaseId)
        .run()
    : await env.DB.prepare(
        `UPDATE harness_reservations
         SET state = 'failed', last_error = ?, attach_lease_until = NULL, updated_at = ?
         WHERE tenant = ? AND id = ? AND state = 'reserved'`,
      )
        .bind(truncatedError, now, env.TENANT_SLUG, id)
        .run()

  return (result.meta?.changes ?? 0) > 0
}

/**
 * Compensate a Task created for a reservation that then failed (dispatchFlight threw / flight gate held): one
 * conditional UPDATE moves it to 'blocked', clears the assignee and appends the reason, so no orphan in_progress
 * task is left claiming an agent. Only touches a task still 'in_progress'.
 */
export async function blockTaskForFailedReservation(
  env: Env,
  taskId: string,
  reservationId: string,
  reason: string,
): Promise<boolean> {
  const note = `\nreservation ${reservationId} failed: ${reason.slice(0, 500)}`
  const result = await env.DB.prepare(
    `UPDATE tasks
     SET status = 'blocked', assignee_agent_id = NULL, body = body || ?, updated_at = ?
     WHERE id = ? AND status = 'in_progress' AND ${TASK_NOT_ARCHIVED_SQL()}`,
  )
    .bind(note, new Date().toISOString(), taskId)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

/** Reconcile an ATTACHED reservation to its terminal state. Returns false when the row was not 'attached'. */
export async function markReconciled(
  env: Env,
  id: string,
  vendorStatus?: string,
): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'reconciled',
         last_vendor_status = coalesce(?, last_vendor_status),
         reconciled_at = ?,
         attach_lease_until = NULL,
         updated_at = ?
     WHERE tenant = ? AND id = ? AND state = 'attached'`,
  )
    .bind(vendorStatus ?? null, now, now, env.TENANT_SLUG, id)
    .run()
  return (result.meta?.changes ?? 0) > 0
}

export function isReservationStuck(row: Pick<HarnessReservationRow, 'state' | 'updated_at'>, nowMs = Date.now()): boolean {
  if (row.state !== 'reserved' && row.state !== 'attaching') return false
  const updated = Date.parse(row.updated_at)
  return Number.isFinite(updated) && nowMs - updated > RESERVATION_STUCK_MS
}

export async function listReconcileBatch(
  env: Env,
  limit = 25,
): Promise<HarnessReservationRow[]> {
  const staleCutoff = new Date(Date.now() - 20_000).toISOString()
  const results = await env.DB.prepare(
    `SELECT * FROM harness_reservations
     WHERE tenant = ?
       AND state IN ('reserved', 'attaching', 'attached')
       AND updated_at < ?
     ORDER BY updated_at ASC
     LIMIT ?`,
  )
    .bind(env.TENANT_SLUG, staleCutoff, limit)
    .all<HarnessReservationRow>()

  return results.results ?? []
}
