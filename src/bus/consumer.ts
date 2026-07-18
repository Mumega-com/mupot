// mupot — bus Queue consumer. Owns the queue handler exported as default.queue
// from src/index.ts. Routes each BusEvent to the right Durable Object (agent or
// squad) and acks on success / retries on throw.
//
// Routing:
//   agent.wake     → AgentDO(agent_id).fetch(/wake)
//   squad.dispatch → SquadCoordinatorDO(squad_id).fetch(/dispatch)
//   task.created   → wake the owning squad (if squad_id present), else log
//   lead.new       → wake the owning squad (if squad_id present), else log
//   task.updated   → log (terminal observation; no DO wake by default)
//
// Per-message ack/retry: ack on success, retry() on throw, so a single poison
// message does not block a healthy batch. After max_retries (wrangler.toml) the
// message lands in the DLQ.

import type { MessageBatch, Message } from '@cloudflare/workers-types'
import type { Env, BusEvent, Task } from '../types'
import { postAgentActivity } from '../channels'
import { getFleetAgentLiveness } from '../fleet/registry'
import { deliverDispatchToInbox, dispatchInboxDelivered, InboxFullError, DISPATCH_INBOX_PREFIX } from './fleet-bridge'

// Internal origin for DO fetch routing. DO fetch ignores host; the path carries
// the intent. The agents component routes these paths inside its DO classes.
const DO_ORIGIN = 'https://do.mupot.internal'
const TASK_DISPATCH_LEASE_MS = 60_000
// Backpressure backoff (WARN-2, #353 v2): when the bridge reports the recipient's inbox is at
// capacity, back off instead of hot-looping an immediate retry against the same full inbox.
const INBOX_FULL_RETRY_DELAY_SEC = 15
// WARN-1 (#353 v2 re-gate): sendAgentMessage's request_id charset is [A-Za-z0-9_.:-]{1,128}
// (RID_RE, src/agents/messages.ts). The bridge's idempotency key is
// DISPATCH_INBOX_PREFIX + receiptId, so receiptId itself must fit that SAME charset within the
// remaining headroom — otherwise deliverDispatchToInbox throws a plain Error (not
// InboxFullError) on every single attempt, and since that throw releases the lease and
// rethrows (not a RetryAfterError), a malformed receiptId would tight-loop retries until DLQ
// instead of being rejected once, up front, at the identity gate.
const RECEIPT_ID_RE = new RegExp(`^[A-Za-z0-9_.:-]{1,${128 - DISPATCH_INBOX_PREFIX.length}}$`)

class RetryAfterError extends Error {
  constructor(message: string, readonly delaySeconds: number) {
    super(message)
  }
}

async function wakeAgent(env: Env, agentId: string, event: BusEvent): Promise<void> {
  const id = env.AGENT.idFromName(agentId)
  const stub = env.AGENT.get(id)
  const res = await stub.fetch(`${DO_ORIGIN}/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (!res.ok) {
    throw new Error(`AgentDO ${agentId} wake failed: ${res.status}`)
  }
}

type TaskDispatchPayload = { task_id?: unknown; dispatch_receipt_id?: unknown }

interface TaskDispatchReceiptState {
  consumed_at: string | null
  claim_expires_at: number | null
  execution_receipt_id: string | null
  execution_claim_expires_at: number | null
  task_status: Task['status'] | null
}

function taskDispatchIdentity(event: BusEvent): { taskId: string; receiptId: string } | null {
  const payload = event.payload as TaskDispatchPayload
  if (typeof payload?.dispatch_receipt_id !== 'string' || typeof payload.task_id !== 'string') return null
  // WARN-1 (#353 v2, extended at re-gate): reject empty/whitespace-only task_id, and reject a
  // dispatch_receipt_id that isn't a well-formed, bounded token in sendAgentMessage's request_id
  // charset. An empty receiptId would collapse the bridge's idempotency key to the constant
  // prefix for every such event (false dedup); an out-of-charset or oversized one would fail
  // sendAgentMessage's own validation on every retry (see RECEIPT_ID_RE above) — reject once,
  // here, rather than tight-loop retries against a request that can never succeed. A malformed
  // identity falls through to the generic agent.wake path below (same as "not a task dispatch"),
  // never into the receipt state machine.
  if (payload.task_id.trim().length === 0) return null
  if (!RECEIPT_ID_RE.test(payload.dispatch_receipt_id)) return null
  return { taskId: payload.task_id, receiptId: payload.dispatch_receipt_id }
}

// The dispatching principal, for the fleet-bridge's sender attribution (fleet-bridge.ts). Prefers
// the structured `actor` field (the same "who caused this" attribution the activity feed already
// trusts) and falls back to the task_dispatch payload's `by` field, which carries the same member
// id (src/mcp/index.ts toolTaskDispatch sets both from the same `memberId`). Never fabricates a
// specific identity — 'system' is the fail-closed default when neither is present.
function dispatchMemberId(event: BusEvent): string {
  if (event.actor?.kind === 'member' && typeof event.actor.id === 'string' && event.actor.id) {
    return event.actor.id
  }
  const payload = event.payload as { by?: unknown }
  return typeof payload?.by === 'string' && payload.by ? payload.by : 'system'
}

async function readTaskDispatchReceipt(env: Env, event: BusEvent): Promise<TaskDispatchReceiptState | null> {
  const identity = taskDispatchIdentity(event)
  if (!identity || !event.agent_id) return null
  return await env.DB.prepare(
    `SELECT r.consumed_at, r.claim_expires_at, t.execution_receipt_id,
            t.execution_claim_expires_at, t.status AS task_status
       FROM task_dispatch_receipts r
       LEFT JOIN tasks t ON t.id = r.task_id AND t.squad_id = r.squad_id
      WHERE r.tenant = ? AND r.id = ? AND r.task_id = ? AND r.agent_id = ?
      LIMIT 1`,
  ).bind(event.tenant, identity.receiptId, identity.taskId, event.agent_id).first<TaskDispatchReceiptState>() ?? null
}

async function claimTaskDispatchReceipt(env: Env, event: BusEvent, now: number): Promise<number | null> {
  const identity = taskDispatchIdentity(event)
  if (!identity || !event.agent_id) return null
  const expiresAt = now + TASK_DISPATCH_LEASE_MS
  const result = await env.DB.prepare(
    `UPDATE task_dispatch_receipts
        SET claimed_at = ?, claim_expires_at = ?, last_error = NULL
      WHERE tenant = ? AND id = ? AND task_id = ? AND agent_id = ?
        AND consumed_at IS NULL
        AND (claimed_at IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)`,
  ).bind(
    new Date().toISOString(),
    expiresAt,
    event.tenant,
    identity.receiptId,
    identity.taskId,
    event.agent_id,
    now,
  ).run()
  return result.meta?.changes === 1 ? expiresAt : null
}

async function releaseTaskDispatchReceipt(env: Env, event: BusEvent, leaseExpiresAt: number, error: unknown): Promise<void> {
  const identity = taskDispatchIdentity(event)
  if (!identity || !event.agent_id) return
  const message = error instanceof Error ? error.message.slice(0, 500) : 'agent_wake_failed'
  await env.DB.prepare(
    `UPDATE task_dispatch_receipts
        SET claimed_at = NULL, claim_expires_at = NULL, attempts = attempts + 1, last_error = ?
      WHERE tenant = ? AND id = ? AND task_id = ? AND agent_id = ?
        AND claim_expires_at = ? AND consumed_at IS NULL`,
  ).bind(message, event.tenant, identity.receiptId, identity.taskId, event.agent_id, leaseExpiresAt).run()
}

async function consumeTaskDispatchReceipt(env: Env, event: BusEvent, leaseExpiresAt?: number): Promise<boolean> {
  const identity = taskDispatchIdentity(event)
  if (!identity || !event.agent_id) return true
  const leaseClause = leaseExpiresAt === undefined ? '' : ' AND claim_expires_at = ?'
  const result = await env.DB.prepare(
    `UPDATE task_dispatch_receipts
        SET consumed_at = ?, claim_expires_at = NULL, last_error = NULL
      WHERE tenant = ? AND id = ? AND task_id = ? AND agent_id = ?
        AND consumed_at IS NULL${leaseClause}`,
  ).bind(
    new Date().toISOString(), event.tenant, identity.receiptId, identity.taskId, event.agent_id,
    ...(leaseExpiresAt === undefined ? [] : [leaseExpiresAt]),
  ).run()
  return result.meta?.changes === 1
}

async function blockInterruptedTaskExecution(env: Env, event: BusEvent, now: number): Promise<boolean> {
  const identity = taskDispatchIdentity(event)
  if (!identity || !event.agent_id) return false
  const timestamp = new Date(now).toISOString()
  const result = await env.DB.prepare(
    `UPDATE tasks
        SET status = 'blocked', result = ?, completed_at = ?, updated_at = ?,
            execution_claim_expires_at = NULL
      WHERE id = ? AND status = 'in_progress'
        AND execution_receipt_id = ?
        AND execution_claim_expires_at IS NOT NULL AND execution_claim_expires_at <= ?`,
  ).bind(
    'Execution interrupted before a terminal receipt. Review the task before explicit redispatch.',
    timestamp,
    timestamp,
    identity.taskId,
    identity.receiptId,
    now,
  ).run()
  return result.meta?.changes === 1
}

async function dispatchSquad(env: Env, squadId: string, event: BusEvent): Promise<void> {
  const id = env.SQUAD.idFromName(squadId)
  const stub = env.SQUAD.get(id)
  const res = await stub.fetch(`${DO_ORIGIN}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (!res.ok) {
    throw new Error(`SquadCoordinatorDO ${squadId} dispatch failed: ${res.status}`)
  }
}

async function claimFlightEvent(env: Env, event: BusEvent): Promise<boolean> {
  const payload = event.payload as { outbox_id?: unknown }
  if (typeof payload?.outbox_id !== 'string' || payload.outbox_id.length === 0) return true
  const result = await env.DB.prepare(
    `UPDATE flight_event_outbox
        SET consumed_at=?3
      WHERE tenant=?1 AND id=?2 AND event_type='flight.landed' AND consumed_at IS NULL`,
  ).bind(event.tenant, payload.outbox_id, new Date().toISOString()).run()
  return result.meta?.changes === 1
}

async function routeEvent(env: Env, event: BusEvent): Promise<boolean> {
  switch (event.type) {
    case 'agent.wake': {
      if (!event.agent_id) {
        // Nothing to wake — drop quietly (ack) rather than retry forever.
        console.error('bus: agent.wake missing agent_id', { tenant: event.tenant })
        return true
      }
      const identity = taskDispatchIdentity(event)
      if (!identity) {
        await wakeAgent(env, event.agent_id, event)
        return true
      }
      const receipt = await readTaskDispatchReceipt(env, event)
      if (!receipt || receipt.consumed_at) return true
      if (receipt.execution_receipt_id === identity.receiptId) {
        if (receipt.task_status !== 'in_progress') {
          if (!(await consumeTaskDispatchReceipt(env, event))) {
            throw new Error('task dispatch receipt recovery consume failed')
          }
          return true
        }
        if (receipt.execution_claim_expires_at !== null && receipt.execution_claim_expires_at > Date.now()) {
          const remainingMs = receipt.execution_claim_expires_at - Date.now()
          throw new RetryAfterError('task execution receipt lease busy', Math.max(1, Math.ceil(remainingMs / 1000)))
        }
        if (!(await blockInterruptedTaskExecution(env, event, Date.now()))) {
          throw new Error('task interrupted execution recovery lost race')
        }
        if (!(await consumeTaskDispatchReceipt(env, event))) {
          throw new Error('task interrupted execution receipt consume failed')
        }
        return true
      }
      if (receipt.execution_receipt_id !== null) {
        if (!(await consumeTaskDispatchReceipt(env, event))) {
          throw new Error('superseded task dispatch receipt consume failed')
        }
        return true
      }

      // execution_receipt_id is null: this dispatch has NOT committed to the IN-WORKER route.
      // Two possibilities remain, and they must be told apart WITHOUT re-deciding a route that
      // was already chosen (BLOCK-2 fix, #353 v2):
      //   (a) a prior attempt already committed to the EXTERNAL route (inbox delivery landed)
      //       but crashed/threw before consuming the dispatch receipt — STICKY: finish that
      //       route, never fall through to in-Worker.
      //   (b) no route has been decided yet — a genuinely fresh dispatch.
      // (a) is checked first via durable state (an agent_messages row for this receipt), not an
      // in-memory flag, so it survives across Queue redeliveries and worker restarts.
      //
      // Both branches below resolve `route.agentId` — NOT `event.agent_id` — as the inbox
      // delivery target. `event.agent_id` is always `agents.id` (the uuid task assignment
      // uses), but the fleet-attach/signed-inbox surface a real external runtime polls under is
      // keyed by WHATEVER identifier that runtime's own attach call declared (confirmed against
      // the live mumega tenant DB, 2026-07-14: kasra's fleet_agents.agent_id/agent_keys.agent_id
      // are both its slug 'kasra', never its uuid). Delivering to `event.agent_id` would write a
      // message no real signed-inbox poll ever asks for — silently unreachable, formally
      // "delivered." `getFleetAgentLiveness` resolves the bridge (src/fleet/registry.ts); using
      // its `agentId` here is what makes delivery actually reach the runtime's own poll query.
      const route = await getFleetAgentLiveness(env, event.agent_id)
      const deliveryTarget = route.agentId || event.agent_id
      if (await dispatchInboxDelivered(env, identity.receiptId)) {
        try {
          await deliverDispatchToInbox(env, {
            agentId: deliveryTarget,
            squadId: event.squad_id ?? '',
            taskId: identity.taskId,
            receiptId: identity.receiptId,
            dispatchedByMemberId: dispatchMemberId(event),
          })
        } catch (error) {
          if (error instanceof InboxFullError) {
            throw new RetryAfterError(error.message, INBOX_FULL_RETRY_DELAY_SEC)
          }
          throw error
        }
        if (!(await consumeTaskDispatchReceipt(env, event))) {
          throw new Error('external dispatch receipt consume failed')
        }
        return true
      }

      // (b) Fresh decision point. Claim the dispatch lease BEFORE acting on the route (not just
      // before wakeAgent, as v1 did) — this serializes concurrent redeliveries of the SAME event
      // so only the lease-holder decides AND acts. Without this, two in-flight attempts could
      // independently pick DIFFERENT routes for the same receipt (one sees a live runtime, the
      // other — racing right at the presence TTL boundary — sees it stale) and both act: one
      // delivers externally, the other wakes in-Worker. That split-route race is the same class
      // of double execution as BLOCK-2, just via true concurrency instead of sequential retry;
      // claiming the lease first closes it the same way the pre-existing code already closed the
      // sequential-retry case for wakeAgent alone.
      const leaseExpiresAt = await claimTaskDispatchReceipt(env, event, Date.now())
      if (leaseExpiresAt === null) {
        const current = await readTaskDispatchReceipt(env, event)
        if (current?.claim_expires_at !== null && current?.claim_expires_at !== undefined
          && current.claim_expires_at > Date.now()) {
          const remainingMs = current.claim_expires_at - Date.now()
          throw new RetryAfterError('task dispatch receipt lease busy', Math.max(1, Math.ceil(remainingMs / 1000)))
        }
        throw new Error('task dispatch receipt lease busy')
      }

      try {
        if (route.runtime && route.live) {
          // EXTERNAL route: deliver to inbox only. Deliberately do NOT wake-execute in-Worker
          // and do NOT set execution_receipt_id — a failed delivery genuinely re-reaches
          // delivery on retry via the (a) branch above, not the execution-receipt recovery
          // branch (BLOCK-1 fix: no recovery-branch bypass, because execution_receipt_id is
          // never touched by this route at all).
          await deliverDispatchToInbox(env, {
            agentId: deliveryTarget,
            squadId: event.squad_id ?? '',
            taskId: identity.taskId,
            receiptId: identity.receiptId,
            dispatchedByMemberId: dispatchMemberId(event),
          })
        } else {
          // IN-WORKER route (fallback: no fleet row, empty runtime, or stale/dead presence) —
          // today's behavior, unchanged. This is the only path that executes in-Worker, so a
          // dead external runtime can never strand the task (BLOCK-2 fix: exactly one route is
          // chosen and acted on per lease-holder).
          await wakeAgent(env, event.agent_id, event)
        }
      } catch (error) {
        await releaseTaskDispatchReceipt(env, event, leaseExpiresAt, error)
        if (error instanceof InboxFullError) {
          throw new RetryAfterError(error.message, INBOX_FULL_RETRY_DELAY_SEC)
        }
        throw error
      }
      if (!(await consumeTaskDispatchReceipt(env, event, leaseExpiresAt))) {
        throw new Error('task dispatch receipt consume failed')
      }
      return true
    }
    case 'squad.dispatch': {
      if (!event.squad_id) {
        console.error('bus: squad.dispatch missing squad_id', { tenant: event.tenant })
        return true
      }
      await dispatchSquad(env, event.squad_id, event)
      return true
    }
    case 'task.created':
    case 'lead.new': {
      // Wake the owning squad so it can triage/assign. If no squad is named,
      // this is an org-level signal — log it and ack.
      if (event.squad_id) {
        await dispatchSquad(env, event.squad_id, event)
      } else {
        console.error(`bus: ${event.type} with no squad_id (org-level)`, {
          tenant: event.tenant,
        })
      }
      return true
    }
    case 'task.updated':
    case 'task.completed':
    case 'task.review':   // K1: gated execution success — task awaits verdict; no DO wake
    case 'task.blocked':
    case 'task.verdict':
    case 'fleet.control.requested':
    case 'brain.directive.updated':
    case 'org.provisioned':
    case 'project.mutated': {
      // Terminal observations, gate decisions, and structural provisioning; no DO
      // wake by default. Log for the activity feed (the agent-actor branch in
      // handleQueue surfaces task.completed/blocked into the squad's bound channel).
      console.log(`bus: ${event.type}`, {
        tenant: event.tenant,
        squad_id: event.squad_id,
      })
      return true
    }
    case 'flight.landed': {
      if (!(await claimFlightEvent(env, event))) return false
      console.log('bus: flight.landed', {
        tenant: event.tenant,
        squad_id: event.squad_id,
      })
      return true
    }
    default: {
      // Exhaustiveness guard. Unknown types are acked (not retried) to avoid
      // poisoning the queue with events we will never understand.
      const _exhaustive: never = event.type
      console.error('bus: unknown event type', { type: _exhaustive, tenant: event.tenant })
      return true
    }
  }
}

/**
 * handleQueue — the CF Queue consumer entrypoint. Mounted as default.queue.
 * Processes each message independently: ack on success, retry on throw.
 */
export async function handleQueue(batch: MessageBatch<BusEvent>, env: Env): Promise<void> {
  for (const message of batch.messages as Message<BusEvent>[]) {
    try {
      const routed = await routeEvent(env, message.body)
      // Best-effort live activity feed: surface agent actions into the squad's
      // bound channel. A feed-post failure must NOT retry the message (the work
      // already routed) — it is observability, not the action itself.
      if (routed && message.body.actor?.kind === 'agent') {
        try {
          await postAgentActivity(env, message.body)
        } catch (e) {
          console.error('bus: activity-feed post failed (non-fatal)', {
            id: message.id,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      message.ack()
    } catch (err) {
      console.error('bus: message failed, will retry', {
        id: message.id,
        attempts: message.attempts,
        error: err instanceof Error ? err.message : String(err),
      })
      if (err instanceof RetryAfterError) {
        message.retry({ delaySeconds: err.delaySeconds })
      } else {
        message.retry()
      }
    }
  }
}
