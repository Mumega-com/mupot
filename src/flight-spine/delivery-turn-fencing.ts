// src/flight-spine/delivery-turn-fencing.ts — Thread-bound delivery turn fencing & consumption service.
//
// WHY THIS EXISTS (FLIGHT DELIV-03 / #1031 & #1050):
//
// A runtime delivery must be consumed strictly within the active {threadId, turnId, generation, correlation, nonce}
// context that leased it. Allowing ambient or un-fenced consumption lets out-of-order responses,
// cross-turn races, replay attacks, and loaded-idle executions corrupt delivery receipts.
//
// This module provides:
// 1. `registerDeliveryTurnFence`: creates or activates a turn fence for an incoming delivery.
// 2. `consumeDeliveryTurnFence`: atomically consumes the fence strictly when all 5 tuple parameters match.
// 3. `invalidateDeliveryTurnFence`: invalidates fences when turns advance or timeout.

import type { Env } from '../types'
import { sha256Hex } from '../lib/crypto'

export interface DeliveryTurnFence {
  delivery_id: string
  tenant: string
  thread_id: string
  turn_id: string
  generation: number
  correlation_id: string
  nonce_hash: string
  status: 'active' | 'consumed' | 'invalidated'
  created_at: string
  consumed_at: string | null
}

export interface RegisterTurnFenceInput {
  deliveryId: string
  threadId: string
  turnId: string
  generation: number
  correlationId: string
  nonce: string
}

export interface ConsumeTurnFenceInput {
  deliveryId: string
  threadId: string
  turnId: string
  generation: number
  correlation: string
  nonce: string
  summary?: string
}

export type ConsumeTurnFenceResult =
  | {
      ok: true
      deliveryId: string
      status: 'consumed'
      consumedAt: string
    }
  | {
      ok: false
      error:
        | 'delivery_not_found'
        | 'already_consumed'
        | 'cross_turn_rejection'
        | 'cross_thread_rejection'
        | 'stale_generation'
        | 'turn_fencing_conflict'
        | 'invalid_nonce'
        | 'invalid_args'
      status: number
      detail?: string
    }

/**
 * Register an active turn fence for a delivery before executing the model turn.
 */
export async function registerDeliveryTurnFence(
  env: Env,
  input: RegisterTurnFenceInput,
): Promise<DeliveryTurnFence> {
  const nonceHash = await sha256Hex(input.nonce)
  const now = new Date().toISOString()
  const tenant = env.TENANT_SLUG

  await env.DB.prepare(
    `INSERT INTO delivery_turn_fences
       (delivery_id, tenant, thread_id, turn_id, generation, correlation_id, nonce_hash, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8)
     ON CONFLICT(delivery_id) DO UPDATE SET
       thread_id      = excluded.thread_id,
       turn_id        = excluded.turn_id,
       generation     = excluded.generation,
       correlation_id = excluded.correlation_id,
       nonce_hash     = excluded.nonce_hash,
       status         = 'active',
       consumed_at    = NULL`,
  )
    .bind(
      input.deliveryId,
      tenant,
      input.threadId,
      input.turnId,
      input.generation,
      input.correlationId,
      nonceHash,
      now,
    )
    .run()

  return {
    delivery_id: input.deliveryId,
    tenant,
    thread_id: input.threadId,
    turn_id: input.turnId,
    generation: input.generation,
    correlation_id: input.correlationId,
    nonce_hash: nonceHash,
    status: 'active',
    created_at: now,
    consumed_at: null,
  }
}

/**
 * Atomically consume a delivery turn fence. Strictly verifies all 5 tuple fields.
 */
export async function consumeDeliveryTurnFence(
  env: Env,
  input: ConsumeTurnFenceInput,
): Promise<ConsumeTurnFenceResult> {
  if (!input.deliveryId || !input.threadId || !input.turnId || !input.nonce || !input.correlation) {
    return {
      ok: false,
      error: 'invalid_args',
      status: 400,
      detail: 'deliveryId, threadId, turnId, nonce, and correlation are required',
    }
  }

  const nonceHash = await sha256Hex(input.nonce)
  const now = new Date().toISOString()
  const tenant = env.TENANT_SLUG

  const result = await env.DB.prepare(
    `UPDATE delivery_turn_fences
        SET status = 'consumed',
            consumed_at = ?1
      WHERE delivery_id = ?2
        AND tenant = ?3
        AND thread_id = ?4
        AND turn_id = ?5
        AND generation = ?6
        AND correlation_id = ?7
        AND nonce_hash = ?8
        AND status = 'active'`,
  )
    .bind(
      now,
      input.deliveryId,
      tenant,
      input.threadId,
      input.turnId,
      input.generation,
      input.correlation,
      nonceHash,
    )
    .run()

  if (result.meta?.changes && result.meta.changes > 0) {
    return {
      ok: true,
      deliveryId: input.deliveryId,
      status: 'consumed',
      consumedAt: now,
    }
  }

  // Determine exact epistemic refusal reason
  const existing = await env.DB.prepare(
    `SELECT delivery_id, thread_id, turn_id, generation, correlation_id, nonce_hash, status
       FROM delivery_turn_fences
      WHERE delivery_id = ?1 AND tenant = ?2`,
  )
    .bind(input.deliveryId, tenant)
    .first<{
      delivery_id: string
      thread_id: string
      turn_id: string
      generation: number
      correlation_id: string
      nonce_hash: string
      status: string
    }>()

  if (!existing) {
    return { ok: false, error: 'delivery_not_found', status: 404, detail: `delivery ${input.deliveryId} not found` }
  }

  if (existing.status === 'consumed') {
    return { ok: false, error: 'already_consumed', status: 409, detail: `delivery ${input.deliveryId} already consumed` }
  }

  if (existing.thread_id !== input.threadId) {
    return {
      ok: false,
      error: 'cross_thread_rejection',
      status: 409,
      detail: `thread mismatch: active is ${existing.thread_id}, requested is ${input.threadId}`,
    }
  }

  if (existing.turn_id !== input.turnId) {
    return {
      ok: false,
      error: 'cross_turn_rejection',
      status: 409,
      detail: `turn mismatch: active is ${existing.turn_id}, requested is ${input.turnId}`,
    }
  }

  if (existing.generation !== input.generation) {
    return {
      ok: false,
      error: 'stale_generation',
      status: 409,
      detail: `generation mismatch: active is ${existing.generation}, requested is ${input.generation}`,
    }
  }

  if (existing.nonce_hash !== nonceHash) {
    return {
      ok: false,
      error: 'invalid_nonce',
      status: 409,
      detail: 'nonce hash verification failed',
    }
  }

  return {
    ok: false,
    error: 'turn_fencing_conflict',
    status: 409,
    detail: `fence status is ${existing.status}`,
  }
}

/**
 * Invalidate fences for a thread when a turn advances or completes.
 */
export async function invalidateThreadTurnFences(
  env: Env,
  threadId: string,
  exceptTurnId?: string,
): Promise<number> {
  const tenant = env.TENANT_SLUG
  let query = `UPDATE delivery_turn_fences SET status = 'invalidated' WHERE tenant = ?1 AND thread_id = ?2 AND status = 'active'`
  const bindings: unknown[] = [tenant, threadId]

  if (exceptTurnId) {
    query += ` AND turn_id != ?3`
    bindings.push(exceptTurnId)
  }

  const result = await env.DB.prepare(query).bind(...bindings).run()
  return result.meta?.changes ?? 0
}
