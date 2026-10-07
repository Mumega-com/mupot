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
import { sendAgentMessage, MAX_BODY_CHARS } from '../agents/messages'

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
  /** Authoritative tasks.project_id inherited by the bus consumer. */
  projectId?: string | null
  /** mupot#1740 — agents.id of the task assignee. When set, the envelope INSERT itself refuses
   *  (ReceiverNotLiveError) if that seat's fleet row is 'stopped' at write time. */
  receiverFenceAgentId?: string
}

export type BridgeResult = { delivered: true; seq: number; duplicate: boolean }

/**
 * InboxFullError — distinguishes backpressure (the recipient is at MAX_UNREAD_PER_RECIPIENT, a
 * legitimate, expected condition under load) from a genuine bug/db error. The consumer converts
 * this into a `RetryAfterError` with a real delay (WARN-2 fix) instead of an immediate hot-loop
 * retry that would just re-hit the same full inbox.
 */
export class InboxFullError extends Error {}

/** mupot#1740 — the in-write stopped-seat fence refused the envelope INSERT (concurrent detach). */
export class ReceiverNotLiveError extends Error {}

/** Max length (UTF-16 code units, after trim) of each task-text field copied into the envelope. */
export const DISPATCH_ENVELOPE_TEXT_MAX = 2000

/** Optional additive keys the v1 body may carry beyond the six required ones. The receipt
 *  validator (src/tasks/runtime-receipts.ts) accepts exactly the required six plus any subset of
 *  these, so older in-flight ids-only envelopes and new self-describing ones both settle. */
export const DISPATCH_ENVELOPE_OPTIONAL_KEYS = ['title', 'done_when', 'truncated', 'settle'] as const

function boundText(value: unknown): { text: string; truncated: boolean } {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length <= DISPATCH_ENVELOPE_TEXT_MAX) return { text: raw, truncated: false }
  let cut = raw.slice(0, DISPATCH_ENVELOPE_TEXT_MAX)
  // Do not leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return { text: cut, truncated: true }
}

/**
 * Read the task's title and done_when for the envelope. The tasks table is per-tenant (no
 * tenant column; env.DB is the tenant boundary), so the only selector is the task id the
 * consumer already derived from the persisted dispatch receipt.
 *
 * Failure policy (chosen deliberately):
 *  - row ABSENT -> return null: send the ids-only fields WITH the `settle` object. The settle
 *    path is the load-bearing part (a seat that cannot settle strands the task); title/done_when
 *    are convenience, and the receipt validator independently re-checks the real task row.
 *  - DB read THROWS -> propagate. The consumer treats any throw as a retryable delivery failure
 *    (request_id is idempotent, so a retry is safe). Swallowing it would permanently commit a
 *    degraded envelope, because a redelivery after the row is written is a no-op.
 */
async function readTaskText(
  env: Env,
  taskId: string,
): Promise<{ title: string; done_when: string; truncated: boolean } | null> {
  const row = await env.DB.prepare('SELECT title, done_when FROM tasks WHERE id = ?1 LIMIT 1')
    .bind(taskId)
    .first<{ title: unknown; done_when: unknown }>()
  if (!row) return null
  const title = boundText(row.title)
  const doneWhen = boundText(row.done_when)
  return {
    title: title.text,
    done_when: doneWhen.text,
    truncated: title.truncated || doneWhen.truncated,
  }
}

/** The settlement path, self-described. Built ONLY from the two opaque ids plus constants. */
function buildSettleHint(taskId: string, receiptId: string) {
  return {
    note: 'A bus ack, inbox_ack or any chat reply does NOT settle this dispatch: only task_dispatch_runtime_receipt records the runtime receipts (task_update can set a task status but records none). title/done_when are a snapshot taken at dispatch time; re-read the task for the current done_when before completing.',
    tool: 'task_dispatch_runtime_receipt',
    args: { task_id: taskId, dispatch_receipt_id: receiptId },
    attempt: 'Pass this inbox message\'s delivery_attempts value (1 on first delivery).',
    runtime_receipt_hash: 'Required on every call: lowercase hex SHA-256 of your own consumption/completion receipt.',
    stages: [
      { stage: 'runtime_consumed', when: 'once you have taken the task and are starting work' },
      {
        stage: 'completed',
        when: 'work finished; pass result, and artifact_refs plus artifact_sha256 if done_when names an Artifact: or SHA256: requirement',
      },
      { stage: 'failed', when: 'work cannot be completed; pass reason' },
    ],
  }
}

/** Encoded-size budget for the whole envelope body. sendAgentMessage refuses `body.length >
 *  MAX_BODY_CHARS` (UTF-16 code units of the ENCODED string, i.e. exactly what `.length` of the
 *  JSON.stringify output gives), so the budget is measured the same way, with headroom. */
export const DISPATCH_ENVELOPE_BODY_BUDGET = MAX_BODY_CHARS - 500

/** Encoded cost of `value` as a JSON string value (the two quotes excluded). */
function encodedLen(value: string): number {
  return JSON.stringify(value).length - 2
}

/** Longest prefix of `value` whose ENCODED length is <= maxEncoded, never splitting a surrogate
 *  pair. Encoded length is monotonic in prefix length, so a binary search is exact. */
function fitEncoded(value: string, maxEncoded: number): string {
  if (maxEncoded <= 0) return ''
  if (encodedLen(value) <= maxEncoded) return value
  let lo = 0
  let hi = value.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (encodedLen(value.slice(0, mid)) <= maxEncoded) lo = mid
    else hi = mid - 1
  }
  let cut = value.slice(0, lo)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  return cut
}

/**
 * Build the envelope body. A raw-length cap is not an encoded-size cap (`"` encodes to 2 chars,
 * a control char to 6), and sendAgentMessage refuses an oversized body PERMANENTLY (the retry
 * rebuilds the same body from the same task row). So size is enforced on the ENCODED output and
 * degrades deterministically instead of ever throwing: shrink title/done_when to fit
 * (`truncated: true`), and in the worst case drop them; the ids and the `settle` object are
 * always kept, and that ids-only+settle form always fits.
 */
async function buildEnvelopeBody(env: Env, input: DispatchBridgeInput): Promise<string> {
  const text = await readTaskText(env, input.taskId)
  const base = {
    version: 'runtime.dispatch/v1',
    type: 'task_dispatch',
    task_id: input.taskId,
    dispatch_receipt_id: input.receiptId,
    squad_id: input.squadId,
    // The consumer already resolved agentId from the persisted fleet route. Do
    // not accept a second caller-controlled address that could diverge from the
    // actual durable inbox target.
    runtime_address: input.agentId,
  }
  const settle = buildSettleHint(input.taskId, input.receiptId)
  // `title`/`done_when` are DATA authored by members/agents: only ever JSON string values here,
  // never concatenated into `settle` or any instruction text. `settle` is built from the two
  // opaque ids and constants only.
  const assemble = (t: { title: string; done_when: string; truncated: boolean } | null): string =>
    JSON.stringify({
      ...base,
      ...(t ? { title: t.title, done_when: t.done_when, ...(t.truncated ? { truncated: true } : {}) } : {}),
      settle,
    })

  if (!text) return assemble(null)
  let candidate = { title: text.title, done_when: text.done_when, truncated: text.truncated }
  let out = assemble(candidate)
  if (out.length <= DISPATCH_ENVELOPE_BODY_BUDGET) return out

  // Over budget: spend what is left after the fixed part (ids + settle + the truncated flag),
  // a quarter to the title and the rest to done_when.
  const fixed = assemble({ title: '', done_when: '', truncated: true }).length
  const room = Math.max(0, DISPATCH_ENVELOPE_BODY_BUDGET - fixed)
  const title = fitEncoded(text.title, Math.floor(room / 4))
  const doneWhen = fitEncoded(text.done_when, room - encodedLen(title))
  candidate = { title, done_when: doneWhen, truncated: true }
  out = assemble(candidate)
  if (out.length <= DISPATCH_ENVELOPE_BODY_BUDGET) return out
  // Unreachable by construction; last resort keeps delivery working rather than throwing.
  return assemble(null)
}

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
  // Redelivery must be body-independent. sendAgentMessage treats a same-request_id send as an
  // idempotent no-op ONLY if the body is byte-identical, else request_id_conflict. The envelope
  // now embeds mutable task text, so if the task was edited between the first write and a
  // Queue redelivery, rebuilding the body would conflict forever. When an envelope for this
  // dispatch already exists, resend ITS stored body (identical by construction); sendAgentMessage
  // still re-checks recipient/kind/project.
  const stored = await env.DB.prepare(
    `SELECT body FROM agent_messages WHERE tenant = ?1 AND from_agent = ?2 AND request_id = ?3 LIMIT 1`,
  )
    .bind(env.TENANT_SLUG, DISPATCH_BRIDGE_SENDER, dispatchInboxRequestId(input.receiptId))
    .first<{ body: string }>()
  const body = stored ? stored.body : await buildEnvelopeBody(env, input)

  const res = await sendAgentMessage(env, {
    fromAgent: DISPATCH_BRIDGE_SENDER,
    fromMember: input.dispatchedByMemberId,
    toAgent: input.agentId,
    kind: 'request',
    body,
    requestId: dispatchInboxRequestId(input.receiptId),
    projectId: input.projectId ?? undefined,
  }, {
    system: true,
    reason: 'target is the internally-resolved task assignee (input.agentId), not attacker input',
  }, {
    systemProjectAttribution: input.projectId != null,
    ...(input.receiverFenceAgentId ? { receiverNotStopped: { agentId: input.receiverFenceAgentId } } : {}),
  })

  if (!res.ok) {
    if (res.reason === 'receiver_not_live') {
      throw new ReceiverNotLiveError(
        `fleet-bridge: receiver ${input.receiverFenceAgentId} is stopped (receipt ${input.receiptId})`,
      )
    }
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
