// src/bus/events-delivery.ts — MCP Events (mupot#1618, PR 2): delivery of `message.created`.
//
// SOURCE. There is no second emitter. The existing `message.created` bus event (emitted once, on a
// real agent_messages insert, by sendAgentMessage — the same source publishSeatHint consumes) is
// the only trigger. handleQueue's `message.created` case calls enqueueMessageCreatedDeliveries()
// when EVENTS_ENABLED === 'true'; with the flag off that call is not made at all, so the send path
// and the consumer do no subscription read and produce no queue message.
//
// FLOW.   message.created (queue) -> enqueue one `mcp.event.delivery` job per active subscription
//         (same mupot-events queue) -> handleQueue -> deliverSubscriptionEvent(): re-check
//         everything, sign, POST, write ONE receipt, schedule a retry job with delaySeconds.
//
// BODY-FREE. The job and the request body carry {message_id, seq, read_after_seq, kind,
// request_id} only (the catalogue's payloadSchema) — never the message body. Receipts carry metadata only.

import type { BusEvent, Env, MessageCreatedPayload } from '../types'
import { isEventsEnabled, readAfterSeq } from '../mcp/events'
import { MAX_EVENT_BODY_BYTES, postSigned, signedHeaders } from '../mcp/events-webhook'
import { loadSigningSecrets, subscriberAccessLive, type SubscriptionRow } from '../mcp/events-subscriptions'

export const MAX_DELIVERY_ATTEMPTS = 5
export const RETRY_BASE_DELAY_SEC = 10
export const RETRY_MAX_DELAY_SEC = 15 * 60
/** Per-subscription cap on NEW events (attempt 1) started per rolling minute. */
export const MAX_DELIVERIES_PER_MINUTE = 30

export interface DeliveryJob {
  subscription_id: string
  event_id: string
  event_name: 'message.created'
  /** ISO 8601 with timezone: when the event occurred (the message's created_at). */
  timestamp: string
  data: { message_id: string; seq: number; read_after_seq: number; kind: string; request_id: string | null }
  /** Sender of the underlying message — used ONLY for the self-event guard; never sent out. */
  from_agent: string
  attempt: number
}

export function backoffDelaySec(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_SEC * 2 ** (attempt - 1), RETRY_MAX_DELAY_SEC)
}

async function eventIdFor(subscriptionId: string, messageId: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${subscriptionId}\n${messageId}`))
  return `evt_${Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}`
}

/** Hook called by the queue consumer for a `message.created` bus event. Caller gates on the flag;
 *  this re-checks it (belt and braces) before any read. Never throws to its caller's ack path. */
export async function enqueueMessageCreatedDeliveries(env: Env, event: BusEvent): Promise<number> {
  if (!isEventsEnabled(env)) return 0
  const p = event.payload as Partial<MessageCreatedPayload> | null
  if (!p || typeof p.message_id !== 'string' || typeof p.to_agent !== 'string' || typeof p.from_agent !== 'string') return 0
  // Feedback-loop guard: never fan out a message the subscribing agent itself sent. The
  // subscription is always to the recipient's own inbox, so sender === recipient is the only
  // case where the subscriber is the sender.
  if (p.from_agent === p.to_agent) return 0
  // seq is the inbox row id (>= 1 for a real row); a malformed one is dropped, not coerced.
  const seq = p.seq
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) return 0
  const nowIso = new Date().toISOString()
  const subs = await env.DB.prepare(
    `SELECT id FROM event_subscriptions
      WHERE tenant = ?1 AND agent_id = ?2 AND event_name = 'message.created'
        AND status = 'active' AND refresh_before > ?3`,
  ).bind(event.tenant, p.to_agent, nowIso).all<{ id: string }>()
  let n = 0
  for (const s of subs.results ?? []) {
    const job: DeliveryJob = {
      subscription_id: s.id,
      event_id: await eventIdFor(s.id, p.message_id),
      event_name: 'message.created',
      timestamp: typeof p.created_at === 'string' ? p.created_at : event.ts,
      data: {
        message_id: p.message_id,
        seq: seq,
        read_after_seq: readAfterSeq(seq),
        kind: typeof p.kind === 'string' ? p.kind : 'message',
        request_id: typeof p.request_id === 'string' ? p.request_id : null,
      },
      from_agent: p.from_agent,
      attempt: 1,
    }
    await env.BUS.send({
      type: 'mcp.event.delivery',
      tenant: event.tenant,
      agent_id: p.to_agent,
      payload: job,
      ts: nowIso,
    })
    n++
  }
  return n
}

type Outcome = 'delivered' | 'retry' | 'failed' | 'gone' | 'refused'

async function writeReceipt(
  env: Env,
  job: DeliveryJob,
  outcome: Outcome,
  fields: { httpStatus?: number; errorClass?: string; signedAt?: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event_delivery_receipts
       (id, subscription_id, event_id, attempt, outcome, http_status, error_class, signed_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    crypto.randomUUID(),
    job.subscription_id,
    job.event_id,
    job.attempt,
    outcome,
    fields.httpStatus ?? null,
    fields.errorClass ?? null,
    fields.signedAt ?? null,
    new Date().toISOString(),
  ).run()
}

async function markSubscription(env: Env, id: string, status: 'revoked' | 'expired', reason: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE event_subscriptions
        SET status = ?2, revoked_at = CASE WHEN ?2 = 'revoked' THEN ?4 ELSE revoked_at END, revoke_reason = ?3
      WHERE id = ?1 AND status = 'active'`,
  ).bind(id, status, reason, new Date().toISOString()).run()
}

function isDeliveryJob(v: unknown): v is DeliveryJob {
  if (typeof v !== 'object' || v === null) return false
  const j = v as Record<string, unknown>
  const d = j.data as Record<string, unknown> | null
  return typeof j.subscription_id === 'string' && typeof j.event_id === 'string' &&
    j.event_name === 'message.created' && typeof j.timestamp === 'string' &&
    typeof j.from_agent === 'string' && typeof j.attempt === 'number' && j.attempt >= 1 &&
    typeof d === 'object' && d !== null && typeof d.message_id === 'string'
}

export interface DeliverOptions {
  nowMs?: number
  timeoutMs?: number
}

/**
 * Deliver one job. Returns normally in every case (a recorded outcome, including a scheduled
 * retry); it throws only for infrastructure faults the queue should retry (receipt write / retry
 * enqueue failing).
 */
export async function deliverSubscriptionEvent(env: Env, payload: unknown, opts: DeliverOptions = {}): Promise<Outcome | 'skipped'> {
  if (!isEventsEnabled(env)) return 'skipped'
  if (!isDeliveryJob(payload)) return 'skipped'
  const job = payload
  const nowMs = opts.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const sub = await env.DB.prepare(
    `SELECT id, tenant, agent_id, member_id, token_id, consented_by_member_id, event_name, arguments_json,
            callback_url, secret_ciphertext, secret_fingerprint, prev_secret_ciphertext,
            prev_secret_expires_at, status, refresh_before, verified_at
       FROM event_subscriptions WHERE id = ?1 AND tenant = ?2`,
  ).bind(job.subscription_id, env.TENANT_SLUG).first<SubscriptionRow>()
  if (!sub) return 'skipped'

  const refuse = async (errorClass: string): Promise<Outcome> => {
    await writeReceipt(env, job, 'refused', { errorClass })
    return 'refused'
  }

  if (sub.status !== 'active') return refuse(`subscription_${sub.status}`)
  if (sub.refresh_before <= nowIso) {
    await markSubscription(env, sub.id, 'expired', 'expired')
    return refuse('subscription_expired')
  }
  // Feedback-loop guard, re-asserted at delivery (the job may have been produced by any path).
  if (job.from_agent === sub.agent_id) return refuse('self_event')

  const access = await subscriberAccessLive(env, sub)
  if (!access.live) {
    await markSubscription(env, sub.id, 'revoked', `access_${access.reason}`)
    return refuse(`access_${access.reason}`)
  }

  if (job.attempt === 1) {
    const minuteAgo = new Date(nowMs - 60_000).toISOString()
    const recent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM event_delivery_receipts
        WHERE subscription_id = ?1 AND attempt = 1 AND outcome != 'refused' AND created_at > ?2`,
    ).bind(sub.id, minuteAgo).first<{ n: number }>()
    if ((recent?.n ?? 0) >= MAX_DELIVERIES_PER_MINUTE) return refuse('rate_limited')
  }

  let secrets: string[]
  try {
    secrets = await loadSigningSecrets(env, sub, nowMs)
  } catch {
    await writeReceipt(env, job, 'failed', { errorClass: 'secret_unavailable' })
    return 'failed'
  }

  // Serialize ONCE; the exact same string is signed and sent.
  const body = JSON.stringify({
    eventId: job.event_id,
    name: job.event_name,
    timestamp: job.timestamp,
    data: job.data,
    cursor: null,
  })
  if (new TextEncoder().encode(body).length > MAX_EVENT_BODY_BYTES) {
    await writeReceipt(env, job, 'failed', { errorClass: 'payload_too_large' })
    return 'failed'
  }

  // FRESH timestamp + signature on every attempt; webhook-id (= eventId) is stable.
  const { headers, signedAtIso } = await signedHeaders(secrets, job.event_id, sub.id, body, nowMs)
  const out = await postSigned(sub.callback_url, headers, body, opts.timeoutMs)

  if (out.kind === 'response' && out.status >= 200 && out.status < 300) {
    await writeReceipt(env, job, 'delivered', { httpStatus: out.status, signedAt: signedAtIso })
    return 'delivered'
  }
  if (out.kind === 'response' && out.status === 410) {
    await markSubscription(env, sub.id, 'revoked', 'callback_gone')
    await writeReceipt(env, job, 'gone', { httpStatus: 410, errorClass: 'gone', signedAt: signedAtIso })
    return 'gone'
  }
  if (out.kind === 'response' && out.status === 413) {
    await writeReceipt(env, job, 'failed', { httpStatus: 413, errorClass: 'payload_too_large', signedAt: signedAtIso })
    return 'failed'
  }
  if (out.kind === 'redirect') {
    await writeReceipt(env, job, 'failed', { httpStatus: out.status, errorClass: 'redirect_refused', signedAt: signedAtIso })
    return 'failed'
  }

  // Transient: 5xx, 408, 429, timeout, network error. Any other status is a permanent refusal.
  const transient =
    out.kind === 'timeout' ||
    out.kind === 'network_error' ||
    (out.kind === 'response' && (out.status >= 500 || out.status === 408 || out.status === 429))
  const httpStatus = out.kind === 'response' ? out.status : undefined
  const errorClass = out.kind === 'response' ? `http_${out.status}` : out.kind
  if (!transient) {
    await writeReceipt(env, job, 'failed', { httpStatus, errorClass, signedAt: signedAtIso })
    return 'failed'
  }
  if (job.attempt >= MAX_DELIVERY_ATTEMPTS) {
    await writeReceipt(env, job, 'failed', { httpStatus, errorClass: `retries_exhausted:${errorClass}`, signedAt: signedAtIso })
    return 'failed'
  }
  await writeReceipt(env, job, 'retry', { httpStatus, errorClass, signedAt: signedAtIso })
  await env.BUS.send(
    {
      type: 'mcp.event.delivery',
      tenant: env.TENANT_SLUG,
      agent_id: sub.agent_id,
      payload: { ...job, attempt: job.attempt + 1 } satisfies DeliveryJob,
      ts: nowIso,
    },
    { delaySeconds: backoffDelaySec(job.attempt) },
  )
  return 'retry'
}
