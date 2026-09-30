// src/bus/events-delivery.ts — MCP Events (mupot#1618, PR 2): delivery of `message.created`.
//
// SOURCE. This module adds NO new emitter of message.created: the trigger is the existing
// `message.created` bus event that sendAgentMessage emits once on a real agent_messages insert (the
// same source publishSeatHint consumes). handleQueue's `message.created` case calls
// enqueueMessageCreatedDeliveries() when EVENTS_ENABLED === 'true'; with the flag off that call is
// not made at all, so the send path and the consumer do no subscription read and enqueue nothing.
// NOTE the queue is NOT a trust boundary: other producers can put a `message.created` (org-admin
// /bus/emit, the shared-secret sos addon) or forge any job on it. So nothing in the event or in a
// job is trusted: the delivery re-derives recipient/seq/kind/request_id/time from the
// agent_messages row and derives the attempt number from the receipts table (see below).
//
// FLOW.   message.created (queue) -> enqueue one `mcp.event.delivery` job {subscription_id,
//         message_id} per active subscription (same mupot-events queue; deduped per
//         (subscription, event) by event_delivery_enqueued) -> handleQueue ->
//         deliverSubscriptionEvent(): re-check everything, sign, POST, write ONE receipt, schedule
//         a retry job with delaySeconds.
//
// BODY-FREE. The request body carries {message_id, seq, read_after_seq, kind, request_id} only (the
// catalogue's payloadSchema) — never the message body. Receipts carry metadata only.

import type { BusEvent, Env, MessageCreatedPayload } from '../types'
import { InvalidEventSeqError, isEventsEnabled, readAfterSeq } from '../mcp/events'
import { MAX_EVENT_BODY_BYTES, postSigned, signedHeaders, validateCallbackUrl } from '../mcp/events-webhook'
import { loadSigningSecrets, subscriberAccessLive, type SubscriptionRow } from '../mcp/events-subscriptions'

export const MAX_DELIVERY_ATTEMPTS = 5
export const RETRY_BASE_DELAY_SEC = 10
export const RETRY_MAX_DELAY_SEC = 15 * 60
/** Per-subscription cap on NEW events (first attempt) started per rolling minute. */
export const MAX_DELIVERIES_PER_MINUTE = 30

/** The ONLY thing a job carries. Every other fact is rebuilt from D1 at delivery time. */
export interface DeliveryJob {
  subscription_id: string
  message_id: string
}

export function backoffDelaySec(attempt: number): number {
  return Math.min(RETRY_BASE_DELAY_SEC * 2 ** (attempt - 1), RETRY_MAX_DELAY_SEC)
}

export async function eventIdFor(subscriptionId: string, messageId: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${subscriptionId}\n${messageId}`))
  return `evt_${Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)}`
}

/** Hook called by the queue consumer for a `message.created` bus event. Caller gates on the flag;
 *  this re-checks it (belt and braces) before any read. The event's fields are only ROUTING HINTS
 *  (which subscriptions to consider); delivery re-validates against agent_messages. */
export async function enqueueMessageCreatedDeliveries(env: Env, event: BusEvent): Promise<number> {
  if (!isEventsEnabled(env)) return 0
  const p = event.payload as Partial<MessageCreatedPayload> | null
  if (!p || typeof p.message_id !== 'string' || typeof p.to_agent !== 'string' || typeof p.from_agent !== 'string') return 0
  // Feedback-loop guard (early exit; delivery re-derives the sender from the row and re-checks).
  if (p.from_agent === p.to_agent) return 0
  const nowIso = new Date().toISOString()
  const subs = await env.DB.prepare(
    `SELECT id FROM event_subscriptions
      WHERE tenant = ?1 AND agent_id = ?2 AND event_name = 'message.created'
        AND status = 'active' AND refresh_before > ?3`,
  ).bind(event.tenant, p.to_agent, nowIso).all<{ id: string }>()
  let n = 0
  for (const s of subs.results ?? []) {
    const eventId = await eventIdFor(s.id, p.message_id)
    // Dedupe: a retry of the whole message.created queue message (another leg threw) must not
    // enqueue a second job for the same (subscription, event).
    const mark = await env.DB.prepare(
      `INSERT OR IGNORE INTO event_delivery_enqueued (subscription_id, event_id, created_at) VALUES (?1, ?2, ?3)`,
    ).bind(s.id, eventId, nowIso).run()
    if ((mark.meta?.changes ?? 0) === 0) continue
    const job: DeliveryJob = { subscription_id: s.id, message_id: p.message_id }
    try {
      await env.BUS.send({ type: 'mcp.event.delivery', tenant: event.tenant, agent_id: p.to_agent, payload: job, ts: nowIso })
    } catch (err) {
      // The job never left: drop its marker so the message-level retry can enqueue it.
      await env.DB.prepare(`DELETE FROM event_delivery_enqueued WHERE subscription_id = ?1 AND event_id = ?2`)
        .bind(s.id, eventId).run()
      throw err
    }
    n++
  }
  return n
}

type Outcome = 'delivered' | 'retry' | 'failed' | 'gone' | 'refused'

/** Facts of ONE delivery attempt, all derived server-side (never from the job). */
interface Attempt {
  subscriptionId: string
  eventId: string
  attempt: number
}

async function writeReceipt(
  env: Env,
  a: Attempt,
  outcome: Outcome,
  fields: { httpStatus?: number; errorClass?: string; signedAt?: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO event_delivery_receipts
       (id, subscription_id, event_id, attempt, outcome, http_status, error_class, signed_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).bind(
    crypto.randomUUID(),
    a.subscriptionId,
    a.eventId,
    a.attempt,
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

function parseJob(v: unknown): DeliveryJob | null {
  if (typeof v !== 'object' || v === null) return null
  const j = v as Record<string, unknown>
  if (typeof j.subscription_id !== 'string' || typeof j.message_id !== 'string') return null
  if (j.subscription_id.length === 0 || j.message_id.length === 0 || j.message_id.length > 200) return null
  return { subscription_id: j.subscription_id, message_id: j.message_id }
}

/** agent_messages.created_at is ISO with tz when written by sendAgentMessage, but the column
 *  default is `datetime('now')` (no tz). The spec wants ISO 8601 with a timezone. */
function isoWithTz(raw: string): string {
  const t = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw
  const ms = Date.parse(t)
  return Number.isNaN(ms) ? new Date(0).toISOString() : new Date(ms).toISOString()
}

interface MessageRow {
  seq: number
  to_agent: string
  from_agent: string
  kind: string
  request_id: string | null
  created_at: string
}

export interface DeliverOptions {
  nowMs?: number
  timeoutMs?: number
}

/**
 * Deliver one job. The job names only {subscription_id, message_id}; everything else is rebuilt
 * from D1 here: the recipient/seq/kind/request_id/time from the agent_messages row (refused when
 * the row is missing or is not addressed to the subscription's agent), the event id from
 * (subscription, message), and the attempt number from the receipts table. Returns normally in
 * every case (a recorded outcome, including a scheduled retry); it throws only for infrastructure
 * faults the queue should retry (receipt write / retry enqueue failing).
 */
export async function deliverSubscriptionEvent(env: Env, payload: unknown, opts: DeliverOptions = {}): Promise<Outcome | 'skipped'> {
  if (!isEventsEnabled(env)) return 'skipped'
  const job = parseJob(payload)
  if (!job) return 'skipped'
  const nowMs = opts.nowMs ?? Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const sub = await env.DB.prepare(
    `SELECT id, tenant, agent_id, member_id, token_id, consented_by_member_id, event_name, arguments_json,
            callback_url, secret_ciphertext, secret_fingerprint, prev_secret_ciphertext,
            prev_secret_expires_at, status, refresh_before, verified_at
       FROM event_subscriptions WHERE id = ?1 AND tenant = ?2`,
  ).bind(job.subscription_id, env.TENANT_SLUG).first<SubscriptionRow>()
  if (!sub) return 'skipped'

  const eventId = await eventIdFor(sub.id, job.message_id)

  // Attempt state comes from the receipts table, not the job. A terminal receipt (anything but
  // 'retry') means this (subscription, event) is finished: a duplicate/forged/replayed job is
  // dropped without a POST and without a new receipt.
  const terminal = await env.DB.prepare(
    `SELECT 1 AS x FROM event_delivery_receipts WHERE subscription_id = ?1 AND event_id = ?2 AND outcome != 'retry' LIMIT 1`,
  ).bind(sub.id, eventId).first<{ x: number }>()
  if (terminal) return 'skipped'
  const retries = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM event_delivery_receipts WHERE subscription_id = ?1 AND event_id = ?2 AND outcome = 'retry'`,
  ).bind(sub.id, eventId).first<{ n: number }>()
  const att: Attempt = { subscriptionId: sub.id, eventId, attempt: (retries?.n ?? 0) + 1 }

  const refuse = async (errorClass: string): Promise<Outcome> => {
    await writeReceipt(env, att, 'refused', { errorClass })
    return 'refused'
  }

  if (sub.status !== 'active') return refuse(`subscription_${sub.status}`)
  if (sub.refresh_before <= nowIso) {
    await markSubscription(env, sub.id, 'expired', 'expired')
    return refuse('subscription_expired')
  }
  // The operator's CURRENT allowlist governs every attempt, not just subscribe time.
  if (!validateCallbackUrl(sub.callback_url, env).ok) {
    await markSubscription(env, sub.id, 'revoked', 'callback_host_removed')
    return refuse('callback_host_removed')
  }

  // Facts of the message come from the row, never from the job or the queue event.
  const msg = await env.DB.prepare(
    `SELECT seq, to_agent, from_agent, kind, request_id, created_at FROM agent_messages WHERE id = ?1 AND tenant = ?2`,
  ).bind(job.message_id, env.TENANT_SLUG).first<MessageRow>()
  if (!msg) return refuse('message_not_found')
  if (msg.to_agent !== sub.agent_id) return refuse('message_not_addressed_to_subscriber')
  // Feedback-loop guard, from the row's real sender.
  if (msg.from_agent === sub.agent_id) return refuse('self_event')
  let readAfter: number
  try {
    readAfter = readAfterSeq(msg.seq)
  } catch (err) {
    if (err instanceof InvalidEventSeqError) return refuse('invalid_seq')
    throw err
  }

  const access = await subscriberAccessLive(env, sub)
  if (!access.live) {
    await markSubscription(env, sub.id, 'revoked', `access_${access.reason}`)
    return refuse(`access_${access.reason}`)
  }

  if (att.attempt === 1) {
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
    await writeReceipt(env, att, 'failed', { errorClass: 'secret_unavailable' })
    return 'failed'
  }

  // Serialize ONCE; the exact same string is signed and sent.
  const body = JSON.stringify({
    eventId,
    name: 'message.created',
    timestamp: isoWithTz(msg.created_at),
    data: {
      message_id: job.message_id,
      seq: msg.seq,
      read_after_seq: readAfter,
      kind: msg.kind,
      request_id: msg.request_id,
    },
    cursor: null,
  })
  if (new TextEncoder().encode(body).length > MAX_EVENT_BODY_BYTES) {
    await writeReceipt(env, att, 'failed', { errorClass: 'payload_too_large' })
    return 'failed'
  }

  // FRESH timestamp + signature on every attempt; webhook-id (= eventId) is stable.
  const { headers, signedAtIso } = await signedHeaders(secrets, eventId, sub.id, body, nowMs)
  const out = await postSigned(sub.callback_url, headers, body, opts.timeoutMs)

  if (out.kind === 'response' && out.status >= 200 && out.status < 300) {
    await writeReceipt(env, att, 'delivered', { httpStatus: out.status, signedAt: signedAtIso })
    return 'delivered'
  }
  if (out.kind === 'response' && out.status === 410) {
    await markSubscription(env, sub.id, 'revoked', 'callback_gone')
    await writeReceipt(env, att, 'gone', { httpStatus: 410, errorClass: 'gone', signedAt: signedAtIso })
    return 'gone'
  }
  if (out.kind === 'response' && out.status === 413) {
    await writeReceipt(env, att, 'failed', { httpStatus: 413, errorClass: 'payload_too_large', signedAt: signedAtIso })
    return 'failed'
  }
  if (out.kind === 'redirect') {
    await writeReceipt(env, att, 'failed', { httpStatus: out.status, errorClass: 'redirect_refused', signedAt: signedAtIso })
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
    await writeReceipt(env, att, 'failed', { httpStatus, errorClass, signedAt: signedAtIso })
    return 'failed'
  }
  if (att.attempt >= MAX_DELIVERY_ATTEMPTS) {
    await writeReceipt(env, att, 'failed', { httpStatus, errorClass: `retries_exhausted:${errorClass}`, signedAt: signedAtIso })
    return 'failed'
  }
  await writeReceipt(env, att, 'retry', { httpStatus, errorClass, signedAt: signedAtIso })
  await env.BUS.send(
    {
      type: 'mcp.event.delivery',
      tenant: env.TENANT_SLUG,
      agent_id: sub.agent_id,
      payload: { subscription_id: sub.id, message_id: job.message_id } satisfies DeliveryJob,
      ts: nowIso,
    },
    { delaySeconds: backoffDelaySec(att.attempt) },
  )
  return 'retry'
}
