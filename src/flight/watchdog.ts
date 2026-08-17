// src/flight/watchdog.ts — Flight Liveness Predicate & Governed Reaper (Flight-014)
//
// Detects zombie/stalled flights that have exceeded execution or wake deadlines.
//
// Invariant Guarantees:
// 1. Precise Classification:
//    - 'running' / 'preflight' > timeout (default 60m, or meta.timeout_ms [5m..24h]) -> 'reap'
//    - 'sleeping' with missed wake deadline (now > next_run_at + 30m) -> 'reap'
//    - 'waiting' (human review gate) > 24h -> 'escalate' (HARD INVARIANT: NEVER REAP)
//    - 'landed' / 'failed' / 'held' -> 'healthy' (terminal states cannot be reaped)
// 2. Authoritative Principal Enforcement:
//    - Only dispatched_by_agent_id, flight.agent, squad:lead on flight squad, org:admin,
//      or system actor ('mupot-watchdog') may trigger a reap. Zero hardcoded name literals.
// 3. Complete Auditability:
//    - Every reap writes an immutable 'flight.reaped' event to flight_event_outbox
//      capturing actor, reason, age_ms, previous status, and timestamp.

import type { Env } from '../types'
import type { FlightRow, FlightStatus } from './service'
import { getFlight } from './service'

export interface FlightActor {
  kind: 'member' | 'agent' | 'system'
  id: string
}

export const DEFAULT_RUNNING_STALL_TIMEOUT_MS = 60 * 60 * 1000 // 60 minutes
export const DEFAULT_SLEEPING_STALL_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes past next_run_at
export const DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24 hours
export const MIN_CONFIGURED_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
export const MAX_CONFIGURED_TIMEOUT_MS = 24 * 60 * 60 * 1000 // 24 hours

export type FlightWatchdogAction = 'healthy' | 'reap' | 'escalate'

export interface FlightWatchdogEvaluation {
  action: FlightWatchdogAction
  reason: string
  ageMs: number
  timeoutMs: number
  stalledAt?: number
}

export interface FlightReapResult {
  transitioned: boolean
  flight_id: string
  previous_status?: FlightStatus
  age_ms?: number
  reason?: string
  receipt?: boolean
  error?: string
}

/**
 * Pure evaluation function checking whether a single flight record is active,
 * stalled (requiring reap), or waiting at a human gate (requiring escalation).
 */
export function evaluateFlightLiveness(
  flight: FlightRow,
  nowMs: number = Date.now(),
): FlightWatchdogEvaluation {
  const status = flight.status

  // Terminal states are never stalled
  if (status === 'landed' || status === 'failed' || status === 'held') {
    return {
      action: 'healthy',
      reason: 'flight_terminal',
      ageMs: 0,
      timeoutMs: 0,
    }
  }

  // 1. Human Gate State: NEVER auto-reap. Slow human is not a dead flight.
  if (status === 'waiting') {
    const baseline = flight.started_at ?? flight.created_at
    const ageMs = Math.max(0, nowMs - baseline)
    if (ageMs > DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS) {
      return {
        action: 'escalate',
        reason: 'waiting_gate_exceeded_24h',
        ageMs,
        timeoutMs: DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS,
        stalledAt: baseline + DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS,
      }
    }
    return {
      action: 'healthy',
      reason: 'waiting_gate_active',
      ageMs,
      timeoutMs: DEFAULT_WAITING_GATE_ESCALATION_TIMEOUT_MS,
    }
  }

  // 2. Sleeping State: Missed wake deadline
  if (status === 'sleeping') {
    if (flight.next_run_at === null) {
      return {
        action: 'reap',
        reason: 'sleeping_without_next_run_at',
        ageMs: 0,
        timeoutMs: 0,
        stalledAt: flight.created_at,
      }
    }
    const missedByMs = nowMs - flight.next_run_at
    if (missedByMs > DEFAULT_SLEEPING_STALL_TIMEOUT_MS) {
      return {
        action: 'reap',
        reason: 'sleeping_missed_wake_deadline',
        ageMs: Math.max(0, missedByMs),
        timeoutMs: DEFAULT_SLEEPING_STALL_TIMEOUT_MS,
        stalledAt: flight.next_run_at + DEFAULT_SLEEPING_STALL_TIMEOUT_MS,
      }
    }
    return {
      action: 'healthy',
      reason: 'sleeping_in_window',
      ageMs: Math.max(0, nowMs - (flight.started_at ?? flight.created_at)),
      timeoutMs: DEFAULT_SLEEPING_STALL_TIMEOUT_MS,
    }
  }

  // 3. Running / Preflight State: Exceeded execution timeout
  let timeoutMs = DEFAULT_RUNNING_STALL_TIMEOUT_MS
  try {
    if (typeof flight.meta === 'string' && flight.meta.trim().startsWith('{')) {
      const parsed = JSON.parse(flight.meta) as { timeout_ms?: unknown }
      if (typeof parsed.timeout_ms === 'number' && Number.isFinite(parsed.timeout_ms)) {
        timeoutMs = Math.min(
          Math.max(Math.floor(parsed.timeout_ms), MIN_CONFIGURED_TIMEOUT_MS),
          MAX_CONFIGURED_TIMEOUT_MS,
        )
      }
    }
  } catch {
    // Malformed meta falls back to default
  }

  const baseline = flight.started_at ?? flight.created_at
  const ageMs = Math.max(0, nowMs - baseline)

  if (ageMs > timeoutMs) {
    return {
      action: 'reap',
      reason: status === 'preflight' ? 'preflight_exceeded_timeout' : 'running_exceeded_timeout',
      ageMs,
      timeoutMs,
      stalledAt: baseline + timeoutMs,
    }
  }

  return {
    action: 'healthy',
    reason: status === 'preflight' ? 'preflight_in_progress' : 'running_in_progress',
    ageMs,
    timeoutMs,
  }
}

/**
 * Scan database for non-terminal flights and evaluate liveness.
 */
export async function listStalledFlights(
  env: Env,
  opts: { nowMs?: number; limit?: number } = {},
): Promise<Array<{ flight: FlightRow; evaluation: FlightWatchdogEvaluation }>> {
  const nowMs = opts.nowMs ?? Date.now()
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

  const rows = await env.DB.prepare(
    `SELECT f.*, a.name AS agent_name, s.name AS squad_name
       FROM flights f
       LEFT JOIN agents a ON a.id = f.agent
       LEFT JOIN squads s ON s.id = a.squad_id
      WHERE f.tenant = ?1
        AND f.status IN ('preflight', 'running', 'sleeping', 'waiting')
      ORDER BY f.created_at ASC
      LIMIT ?2`,
  )
    .bind(env.TENANT_SLUG, limit)
    .all<FlightRow>()

  const stalled: Array<{ flight: FlightRow; evaluation: FlightWatchdogEvaluation }> = []

  for (const flight of rows.results ?? []) {
    const evaluation = evaluateFlightLiveness(flight, nowMs)
    if (evaluation.action === 'reap' || evaluation.action === 'escalate') {
      stalled.push({ flight, evaluation })
    }
  }

  return stalled
}

export interface ReapPrincipalContext {
  actor: FlightActor
  isOrgAdmin?: boolean
  leadSquadIds?: string[]
}

/**
 * Verify whether caller holds authority to force-reap a stalled flight.
 * Zero hardcoded name literals; column matching and capability checks only.
 */
export function canReapFlight(
  flight: FlightRow,
  ctx: ReapPrincipalContext,
): boolean {
  // 1. System watchdog daemon
  if (ctx.actor.kind === 'system' && ctx.actor.id === 'mupot-watchdog') {
    return true
  }

  // 2. Org Admin
  if (ctx.isOrgAdmin) {
    return true
  }

  // 3. Flight Dispatcher
  if (flight.dispatched_by_agent_id && ctx.actor.id === flight.dispatched_by_agent_id) {
    return true
  }

  // 4. Assigned Flying Agent (self-declared deadlock)
  if (flight.agent && ctx.actor.id === flight.agent) {
    return true
  }

  // 5. Squad Lead of flight squads
  if (ctx.leadSquadIds && ctx.leadSquadIds.length > 0) {
    try {
      if (typeof flight.meta === 'string' && flight.meta.trim().startsWith('{')) {
        const parsed = JSON.parse(flight.meta) as { squad_ids?: unknown }
        if (Array.isArray(parsed.squad_ids)) {
          const matching = parsed.squad_ids.some((sqId) =>
            typeof sqId === 'string' && ctx.leadSquadIds?.includes(sqId),
          )
          if (matching) return true
        }
      }
    } catch {
      // ignore JSON error
    }
  }

  return false
}

/**
 * Governed terminal reap transition. Idempotent, safe, and fully audited.
 */
export async function reapStalledFlight(
  env: Env,
  flightId: string,
  principal: ReapPrincipalContext,
  reason: string,
  nowMs: number = Date.now(),
): Promise<FlightReapResult> {
  const flight = await getFlight(env, flightId)
  if (!flight) {
    return { transitioned: false, flight_id: flightId, error: 'flight_not_found' }
  }

  // HARD INVARIANT: Waiting human review gate NEVER reaped
  if (flight.status === 'waiting') {
    return {
      transitioned: false,
      flight_id: flightId,
      previous_status: flight.status,
      error: 'cannot_reap_waiting_gate_must_escalate',
    }
  }

  // Terminal flights cannot be reaped
  if (flight.status === 'landed' || flight.status === 'failed' || flight.status === 'held') {
    return {
      transitioned: false,
      flight_id: flightId,
      previous_status: flight.status,
      error: 'flight_already_terminal',
    }
  }

  // Check liveness predicate
  const evalResult = evaluateFlightLiveness(flight, nowMs)
  if (evalResult.action !== 'reap') {
    return {
      transitioned: false,
      flight_id: flightId,
      previous_status: flight.status,
      error: 'flight_not_stalled',
    }
  }

  // Authorization check
  if (!canReapFlight(flight, principal)) {
    return {
      transitioned: false,
      flight_id: flightId,
      previous_status: flight.status,
      error: 'forbidden_insufficient_reap_capability',
    }
  }

  const gateReason = `watchdog_reap: ${reason.slice(0, 400)}`
  const previousStatus = flight.status

  // 1. Atomic D1 state transition
  const transition = await env.DB.prepare(
    `UPDATE flights
        SET status = 'failed',
            gate_reason = ?3,
            ended_at = ?4
      WHERE id = ?1
        AND tenant = ?2
        AND status IN ('preflight', 'running', 'sleeping')
      RETURNING id, status`,
  )
    .bind(flightId, env.TENANT_SLUG, gateReason, nowMs)
    .all<{ id: string; status: string }>()

  const rows = transition.results ?? []
  if (rows.length === 0) {
    return {
      transitioned: false,
      flight_id: flightId,
      previous_status: previousStatus,
      error: 'transition_race_or_already_terminal',
    }
  }

  // 2. Write immutable audit receipt to flight_reap_receipts (migration 0109).
  //
  // This previously targeted flight_event_outbox with event_type='flight.reaped', against that
  // table's `CHECK (event_type = 'flight.landed')` (0046). It therefore THREW ON EVERY REAP, was
  // swallowed below, and the function returned transitioned:true / receipt:false — a reaped flight
  // with no audit trail, visible only in a console line nobody reads.
  //
  // The obvious repair — widen the CHECK — is the wrong one, for a reason that is not obvious:
  // deliverFlightLandedEvent (src/flight/service.ts) selects undelivered outbox rows with NO
  // event_type filter, emits a HARDCODED type:'flight.landed', and updates delivered_at with NO
  // event_type filter. The moment 'flight.reaped' became insertable, flushFlightEventOutbox would
  // pick it up and ANNOUNCE A REAP AS A LANDING on the bus, then mark it delivered. A stalled
  // flight broadcast as a successful landing is worse than the silence it replaces.
  //
  // A reap is not a landing. It is the system giving up on a flight, and its consumer is an
  // auditor rather than the delivery pipeline. Keeping the surfaces separate makes the two
  // structurally unconfusable. Full reasoning in migrations/0109_flight_reap_receipts.sql.
  let receipt = false
  const receiptPayload = JSON.stringify({
    flight_id: flightId,
    previous_status: previousStatus,
    target_status: 'failed',
    reap_reason: reason,
    predicate_reason: evalResult.reason,
    age_ms: evalResult.ageMs,
    timeout_ms: evalResult.timeoutMs,
    reaped_at: new Date(nowMs).toISOString(),
    actor: principal.actor,
  })

  const eventId = crypto.randomUUID()
  const createdAt = new Date(nowMs).toISOString()

  try {
    await env.DB.prepare(
      `INSERT INTO flight_reap_receipts
         (id, tenant, flight_id, previous_status, actor_kind, actor_id,
          reap_reason, predicate_reason, age_ms, timeout_ms, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (tenant, flight_id) DO NOTHING`,
    )
      .bind(
        eventId,
        env.TENANT_SLUG,
        flightId,
        previousStatus,
        principal.actor.kind,
        principal.actor.id,
        reason,
        evalResult.reason,
        evalResult.ageMs ?? null,
        evalResult.timeoutMs ?? null,
        receiptPayload,
        createdAt,
      )
      .run()
    receipt = true
  } catch (error) {
    // The flight is ALREADY transitioned by this point, so a receipt failure means a reap with no
    // audit trail — exactly the condition that hid this defect. It must be loud, and the caller
    // must not read transitioned:true as success on its own.
    console.error('flight reap receipt insert failed — FLIGHT REAPED WITHOUT AUDIT TRAIL', {
      flight_id: flightId,
      previous_status: previousStatus,
      actor_kind: principal.actor.kind,
      actor_id: principal.actor.id,
      error: error instanceof Error ? error.message : 'unknown_error',
    })
  }

  return {
    transitioned: true,
    flight_id: flightId,
    previous_status: previousStatus,
    age_ms: evalResult.ageMs,
    reason: gateReason,
    receipt,
  }
}
