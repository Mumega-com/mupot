// mupot — bridge: deliver a task_dispatch wake into an EXTERNALLY-HOSTED runtime's inbox.
//
// v2 (issue #353). v1 (commit bbec719, feat/s196-fleet-dispatch-bridge) failed the adversarial
// gate with 2 HIGH blockers:
//   BLOCK-1 (silent delivery loss) — v1 called the bridge AFTER wakeAgent, in the same try. A
//   bridge failure that threw hit a Queue retry that landed on the execution-receipt RECOVERY
//   branch (consumer.ts) — because wakeAgent's in-Worker execute had already set
//   tasks.execution_receipt_id synchronously (execute.ts claimTaskProgress) BEFORE the model
//   call — so the retry consumed the dispatch receipt and NEVER re-ran the bridge. Failed
//   delivery = permanent silent loss.
//   BLOCK-2 (double execution) — v1 ALWAYS called wakeAgent (in-Worker exec) AND, additively,
//   the bridge (external inbox delivery) for any agent with an external runtime — both bodies
//   executed the same task.
//
// v2 fix: route to EXACTLY ONE executor, decided BEFORE either side effect runs. This module is
// now a pure DELIVERY PRIMITIVE ONLY — it does not decide external-vs-in-Worker and does not
// touch task_dispatch_receipts. The route decision + the sticky-across-redeliveries state
// machine (the actual fix) lives in src/bus/consumer.ts, the only caller. See consumer.ts's
// 'agent.wake' case for the full reasoning, and issue #353 for the design doc.

import type { Env } from '../types'
import { sendAgentMessage } from '../agents/messages'

// Sender identity for a bridged dispatch message. This is NOT a welded agent — task_dispatch is
// invoked by a human member through the mupot tool surface, not by an agent acting as sender, so
// there is no honest agent principal to name here. Mirrors the existing 'fleet-panel' convention
// (src/fleet/control.ts, emitControlRequest) for a system-originated send with no bound-agent
// caller: a distinct, non-spoofable literal so a bridged message is visibly attributable in the
// inbox (never invented as if some other real agent sent it).
export const DISPATCH_BRIDGE_SENDER = 'mupot-dispatch'

/** Idempotency-key prefix for a bridged dispatch delivery. Exported so a caller that must
 *  validate a receiptId against sendAgentMessage's request_id charset/length limit (RID_RE,
 *  `[A-Za-z0-9_.:-]{1,128}`, src/agents/messages.ts) can derive the correct headroom
 *  (128 - DISPATCH_INBOX_PREFIX.length) without duplicating this literal (WARN-1, #353 v2
 *  re-gate — see consumer.ts's taskDispatchIdentity). */
export const DISPATCH_INBOX_PREFIX = 'dispatch-inbox:'

/** The sendAgentMessage idempotency key for a given dispatch receipt. Single source — used both
 *  by the actual delivery (deliverDispatchToInbox) and by the sticky-route marker check
 *  (dispatchInboxDelivered) so the two can never drift apart. */
export function dispatchInboxRequestId(receiptId: string): string {
  return `${DISPATCH_INBOX_PREFIX}${receiptId}`
}

export interface DispatchBridgeInput {
  agentId: string
  squadId: string
  taskId: string
  receiptId: string
  /** The authenticated member who dispatched (task_dispatch's `event.actor`/`payload.by`) — the
   *  real principal, recorded for accountability exactly like every other sendAgentMessage call
   *  in this codebase. Never invented; the caller derives this from the BusEvent, never trusts a
   *  caller-supplied field. */
  dispatchedByMemberId: string
}

export type BridgeResult = { delivered: true; seq: number; duplicate: boolean }

/**
 * InboxFullError — distinguishes backpressure (the recipient is at MAX_UNREAD_PER_RECIPIENT, a
 * legitimate, expected condition under load) from a genuine bug/db error. The consumer converts
 * this into a `RetryAfterError` with a real delay (WARN-2 fix) instead of an immediate hot-loop
 * retry that would just re-hit the same full inbox.
 */
export class InboxFullError extends Error {}

/**
 * deliverDispatchToInbox — write the task_dispatch as an inbox message for `input.agentId`, via
 * the existing sendAgentMessage. Idempotent: request_id is derived from `receiptId`
 * (dispatchInboxRequestId), so a Queue-redelivered `agent.wake` for the SAME dispatch is a
 * no-op here — sendAgentMessage's sender-scoped replay-once (UNIQUE(tenant, from_agent,
 * request_id)) guarantees exactly one inbox row per receipt, never a duplicate.
 *
 * Tenant scoping: sendAgentMessage is env-tenant-scoped by construction (no tenant field on its
 * input at all) — no field on DispatchBridgeInput can steer the write to another tenant.
 *
 * Fail-closed: throws on any genuine failure (InboxFullError for backpressure; a plain Error for
 * anything else — invalid input, db_error, request_id_conflict). The caller (consumer.ts) is
 * expected to treat that throw exactly like a wakeAgent failure: release the dispatch lease (if
 * one is held for this attempt) and let the Queue retry, so "the external runtime never saw this
 * dispatch" surfaces as a retried, visible failure instead of a silently-dropped write.
 */
export async function deliverDispatchToInbox(env: Env, input: DispatchBridgeInput): Promise<BridgeResult> {
  const body = JSON.stringify({
    type: 'task_dispatch',
    task_id: input.taskId,
    dispatch_receipt_id: input.receiptId,
    squad_id: input.squadId,
  })

  const res = await sendAgentMessage(env, {
    fromAgent: DISPATCH_BRIDGE_SENDER,
    fromMember: input.dispatchedByMemberId,
    toAgent: input.agentId,
    kind: 'request',
    body,
    requestId: dispatchInboxRequestId(input.receiptId),
  })

  if (!res.ok) {
    if (res.reason === 'inbox_full') {
      throw new InboxFullError(
        `fleet-bridge: recipient ${input.agentId} inbox at capacity (receipt ${input.receiptId})`,
      )
    }
    throw new Error(
      `fleet-bridge: inbox delivery failed for ${input.agentId} (receipt ${input.receiptId}): ${res.reason}` +
        (res.detail ? ` — ${res.detail}` : ''),
    )
  }
  return { delivered: true, seq: res.seq, duplicate: res.duplicate }
}

/**
 * dispatchInboxDelivered — the STICKY-ROUTE marker. True iff a bridge delivery for THIS receipt
 * has already landed in agent_messages (from_agent=DISPATCH_BRIDGE_SENDER, request_id=
 * dispatch-inbox:<receiptId>), regardless of whether the dispatch receipt itself was ever
 * consumed. Distinct from sendAgentMessage's own idempotency (which protects a single delivery
 * ATTEMPT from double-posting) — this lets the consumer detect "a PRIOR attempt already
 * committed this dispatch to the EXTERNAL route" and finish that route deterministically,
 * WITHOUT re-deciding it. That is what closes the BLOCK-2 regression: a redelivery that lands
 * after the external runtime went stale must not fall through to the in-Worker fallback and
 * execute a task that was already handed to the external runtime.
 *
 * Tenant-scoped via env.TENANT_SLUG (query, not a caller-supplied field).
 */
export async function dispatchInboxDelivered(env: Env, receiptId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM agent_messages WHERE tenant = ?1 AND from_agent = ?2 AND request_id = ?3 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, DISPATCH_BRIDGE_SENDER, dispatchInboxRequestId(receiptId))
    .first<{ x: number }>()
  return !!row
}
