// src/harness/reservations.ts — D1 persistence for Harness Reservations.
//
// Authoritative pre-dispatch ledger:
// 1. Reserves Task + Flight before touching vendor APIs.
// 2. Enforces idempotency per (tenant, adapter, idempotency_key).
// 3. Guards against divergent payloads reusing the same idempotency key.
// 4. Manages attach lease timeouts and status reconciliation.

import type { Env } from '../types'
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
  task_id: string
  flight_id: string
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

export type InsertReservationOutcome =
  | { outcome: 'inserted'; row: HarnessReservationRow }
  | { outcome: 'replay'; row: HarnessReservationRow }
  | { outcome: 'conflict'; existingRow: HarnessReservationRow }

export async function insertReservation(
  env: Env,
  params: {
    id: string
    adapter: HarnessKind
    idempotencyKey: string
    requestDigest: string
    taskId: string
    flightId: string
    agentId: string
    squadId: string
    actor: HarnessActor
    state?: HarnessDispatchState
  },
): Promise<InsertReservationOutcome> {
  const tenant = env.TENANT_SLUG
  const now = new Date().toISOString()
  const state = params.state ?? 'reserved'

  try {
    await env.DB.prepare(
      `INSERT INTO harness_reservations (
        id, tenant, adapter, idempotency_key, request_digest,
        task_id, flight_id, agent_id, squad_id, actor_kind, actor_id,
        state, vendor_agent_id, vendor_run_id, vendor_url, last_vendor_status,
        attach_lease_until, last_error, reserved_at, attached_at, reconciled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, ?)`,
    )
      .bind(
        params.id,
        tenant,
        params.adapter,
        params.idempotencyKey,
        params.requestDigest,
        params.taskId,
        params.flightId,
        params.agentId,
        params.squadId,
        params.actor.kind,
        params.actor.id,
        state,
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
      task_id: params.taskId,
      flight_id: params.flightId,
      agent_id: params.agentId,
      squad_id: params.squadId,
      actor_kind: params.actor.kind,
      actor_id: params.actor.id,
      state,
      vendor_agent_id: null,
      vendor_run_id: null,
      vendor_url: null,
      last_vendor_status: null,
      attach_lease_until: null,
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

    const existing = await getReservationByIdempotency(env, params.adapter, params.idempotencyKey)
    if (!existing) throw error
    if (existing.request_digest === params.requestDigest) {
      return { outcome: 'replay', row: existing }
    }
    return { outcome: 'conflict', existingRow: existing }
  }
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
  idempotencyKey: string,
): Promise<HarnessReservationRow | null> {
  const result = await env.DB.prepare(
    `SELECT * FROM harness_reservations WHERE tenant = ? AND adapter = ? AND idempotency_key = ?`,
  )
    .bind(env.TENANT_SLUG, adapter, idempotencyKey)
    .first<HarnessReservationRow>()
  return result ?? null
}

export async function claimAttachLease(
  env: Env,
  id: string,
  leaseMs = 45_000,
): Promise<boolean> {
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
  const nowIso = now.toISOString()

  const result = await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'attaching', attach_lease_until = ?, updated_at = ?
     WHERE tenant = ? AND id = ?
       AND (
         state = 'reserved'
         OR (state = 'attaching' AND (attach_lease_until IS NULL OR attach_lease_until < ?))
       )`,
  )
    .bind(leaseUntil, nowIso, env.TENANT_SLUG, id, nowIso)
    .run()

  return (result.meta?.changes ?? 0) > 0
}

export async function bindVendorExecution(
  env: Env,
  id: string,
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
     WHERE tenant = ? AND id = ? AND state = 'attaching'`,
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
    )
    .run()

  return (result.meta?.changes ?? 0) > 0
}

export async function markReservationFailed(
  env: Env,
  id: string,
  error: string,
): Promise<boolean> {
  const now = new Date().toISOString()
  const truncatedError = error.slice(0, 2000)
  const result = await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'failed',
         last_error = ?,
         attach_lease_until = NULL,
         updated_at = ?
     WHERE tenant = ? AND id = ? AND state IN ('reserved', 'attaching')`,
  )
    .bind(truncatedError, now, env.TENANT_SLUG, id)
    .run()

  return (result.meta?.changes ?? 0) > 0
}

export async function markReconciled(
  env: Env,
  id: string,
  vendorStatus?: string,
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE harness_reservations
     SET state = 'reconciled',
         last_vendor_status = coalesce(?, last_vendor_status),
         reconciled_at = ?,
         attach_lease_until = NULL,
         updated_at = ?
     WHERE tenant = ? AND id = ?`,
  )
    .bind(vendorStatus ?? null, now, now, env.TENANT_SLUG, id)
    .run()
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
