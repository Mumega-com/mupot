// mupot — Hermes push delivery (mumega-com#970, delivery half).
//
// Signs and POSTs a `message.created` bus event to a Hermes gateway webhook route, so a
// subscriber can activate on a landed agent message without polling the inbox on a timer.
//
// SIGNATURE SHAPE — matched, not invented. The reference implementation is the Hermes
// webhook client's own test-send path (`hermes_cli/webhook.py`, `_cmd_test`, ~L277-290):
//   sig = "sha256=" + hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
//   header: X-Hub-Signature-256
// i.e. HMAC-SHA256 over the RAW bytes of the body actually sent, hex-encoded, prefixed
// "sha256=", carried in `X-Hub-Signature-256`. This repo already verifies inbound webhooks
// in exactly this shape (src/integrations/github-routes.ts, GITHUB_WEBHOOK_SECRET) — same
// construction, GitHub-style, now used outbound. A signature that is correct in isolation
// but shaped differently from what the verifier computes (wrong header name, missing
// "sha256=" prefix, signing a re-serialized object instead of the exact bytes sent) is a
// silent 401 — see the mutation tests in tests/hermes-delivery.test.ts, which assert the
// signature is computed over exactly the bytes on the wire.
//
// SECRET — reuses HERMES_WEBHOOK_SECRET (src/types.ts), already declared and documented
// ("Same value as HERMES_R6_WEBHOOK_SECRET in the Hermes .env. Used by bus consumer",
// wrangler.toml). No new secret binding. The signing primitive itself
// (`hmacSign`) is also reused from src/telegram-bridge/bus_notify.ts rather than
// duplicated — same secret, same construction, two independent callers.
//
// REPLAY PROTECTION — the signed envelope carries `event_id` (idempotency key, stable
// across delivery retries of the SAME landed message — it is the message's own id) and
// `ts` (freshly generated at the moment each delivery ATTEMPT is signed, not the original
// message's created_at). Signing a payload with no timestamp gives replay protection of
// exactly zero — a captured request/signature pair could be re-sent forever. THE RECEIVER,
// once it exists (Hermes-side, not built by this branch), MUST:
//   1. Reject any request where `abs(now - ts) > REPLAY_WINDOW_SECONDS` (recommend 300s —
//      wide enough for Queue retry backoff, tight enough to bound a captured-signature
//      replay).
//   2. Track `event_id` values it has already accepted inside that window and reject a
//      repeat (idempotent-dedup, not just signature-valid) — two requests can carry a
//      valid signature over identical bytes if the first is captured and replayed before
//      the window closes; the timestamp check alone does not stop that.
// We do not control the receiver, so the guarantee this module can make is "the material
// needed to enforce replay protection is present and signed"; the guarantee is only REAL
// once both halves exist. Do not read this file as claiming replay protection is live.
//
// TELEGRAM CHAT/THREAD CORRELATION — #970 names it explicitly. It is NOT in the envelope
// below because MessageCreatedPayload (src/types.ts) does not carry it: the emit half
// deliberately excludes chat_id/thread_id (and the message body) at emit time, because a
// queue subscriber that could read routing/content off the bus would be a second, weaker
// copy of the tenant/project authorization the inbox already enforces (see the doc comment
// on MessageCreatedPayload — this is the same reasoning that produced the dashboard
// authenticated-≠-authorized defect, FLIGHT-001, when a read path bypassed the real
// authorization surface). If Telegram correlation is needed downstream, it has to be
// resolved receiver-side from `to_agent`/`from_agent`/`project_id` against whatever member
// identity mapping Hermes already holds — inventing a chat_id field here would be a guess,
// not a fact, and the task instruction is explicit: scope it out rather than invent it.
//
// FAIL-OPEN / FAIL-CLOSED — the underlying agent_messages row is committed in D1 BEFORE
// this ever runs (src/agents/messages.ts); a delivery failure here must never roll that
// back and does not — this module only classifies an HTTP outcome and returns it, it never
// touches D1. What DOES fail closed is the *event's* ack/retry: src/bus/consumer.ts throws
// on every outcome except 'delivered' and 'not_configured', so the Cloudflare Queue's own
// retry/DLQ policy (wrangler.toml: max_retries = 3, dead_letter_queue = "mupot-events-dlq")
// carries a failed delivery attempt forward instead of it being silently swallowed. A 404
// today — the expected state, because the Hermes route is not registered yet — is exactly
// the case this exists to make loud: it retries and lands in the DLQ rather than looking
// like a clean, silently-dropped success.
//
// THE PRECEDENT THIS AVOIDS — src/telegram-bridge/bus_notify.ts:6-18 records a prior
// attempt at this exact hop: a correctly-signed payload POSTed into an unreachable/404
// endpoint, with `resp.ok` logic that "reported a clean failure nobody watched." `resp.ok`
// alone is NOT a receipt here. classifyDeliveryOutcome() below distinguishes: a 2xx with a
// body that actually proves THIS endpoint processed THIS event (real receipt) from a 2xx
// that could be any server on the internet answering (unexpected_response); 401/403
// (signature/secret mismatch) from 404 (route not registered) from a network/timeout
// failure — four distinct loud outcomes, not one collapsed "ok/not ok" boolean.

import type { BusEvent, Env, MessageCreatedPayload } from '../types'
import { hmacSign } from '../telegram-bridge/bus_notify'

/** Same timeout budget as the telegram bridge's direct-delivery path. */
export const DELIVERY_TIMEOUT_MS = 10_000

/**
 * Receiver-side replay window this module documents (see file header). Not enforced here
 * — enforced only once the Hermes-side route exists — but exported so a test (or the
 * eventual receiver implementation) has one source of truth for the number instead of a
 * second, independently-typed "300" living in two places.
 */
export const REPLAY_WINDOW_SECONDS = 300

/** The signed, wire-exact envelope. No message body — see file header. */
export interface HermesEventEnvelope {
  event_id: string // idempotency key — the landed message's own id, stable across retries
  event_type: 'message.created'
  tenant: string // BusEvent.tenant — producer-set, never taken from anything caller-controlled
  ts: string // ISO-8601, generated fresh at signing time — the replay-window anchor
  data: {
    message_id: string
    seq: number
    to_agent: string
    from_agent: string
    from_member: string
    kind: string
    request_id: string | null
    in_reply_to: string | null
    project_id: string | null
    created_at: string
  }
}

/** Everything needed to classify a delivery outcome without re-deriving it ad hoc. */
export type DeliveryOutcome =
  | { kind: 'not_configured'; missing: string[] }
  | { kind: 'delivered'; status: number }
  | { kind: 'unexpected_response'; status: number; detail: string }
  | { kind: 'unauthorized'; status: number; detail: string }
  | { kind: 'not_found'; status: number; detail: string }
  | { kind: 'server_error'; status: number; detail: string }
  | { kind: 'network_error'; detail: string }

/**
 * Build the envelope for a landed message.created event. Pure — no I/O, no signing.
 * Exported so tests can assert its shape without going through a network call.
 */
export function buildHermesEventEnvelope(event: BusEvent<MessageCreatedPayload>, now = new Date()): HermesEventEnvelope {
  const p = event.payload
  return {
    event_id: p.message_id,
    event_type: 'message.created',
    tenant: event.tenant,
    ts: now.toISOString(),
    data: {
      message_id: p.message_id,
      seq: p.seq,
      to_agent: p.to_agent,
      from_agent: p.from_agent,
      from_member: p.from_member,
      kind: p.kind,
      request_id: p.request_id ?? null,
      in_reply_to: p.in_reply_to ?? null,
      project_id: p.project_id ?? null,
      created_at: p.created_at,
    },
  }
}

/**
 * Classify an HTTP response into a distinct, loud outcome. Never collapses to a bare
 * `resp.ok` boolean (see file header — that is the bus_notify.ts defect this must not
 * repeat). A 2xx only counts as 'delivered' if the body proves THIS endpoint accepted
 * THIS event: `{ accepted: true, event_id: "<the id we sent>" }`. Any other 2xx body
 * (a health check, a proxy's default page, some other service entirely answering on the
 * hostname) is 'unexpected_response' — a 2xx is necessary but not sufficient for a receipt.
 */
export async function classifyDeliveryOutcome(resp: Response, sentEventId: string): Promise<DeliveryOutcome> {
  const status = resp.status
  if (status === 401 || status === 403) {
    const detail = await resp.text().catch(() => '')
    return { kind: 'unauthorized', status, detail: detail.slice(0, 200) }
  }
  if (status === 404) {
    const detail = await resp.text().catch(() => '')
    return { kind: 'not_found', status, detail: detail.slice(0, 200) }
  }
  if (status >= 200 && status < 300) {
    const raw = await resp.text().catch(() => '')
    try {
      const body = JSON.parse(raw) as unknown
      if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>
        if (
          (b.accepted === true && b.event_id === sentEventId) ||
          (b.status === 'accepted' && typeof b.delivery_id === 'string')
        ) {
          return { kind: 'delivered', status }
        }
      }
    } catch {
      // fall through — not JSON, not our contract
    }
    return { kind: 'unexpected_response', status, detail: raw.slice(0, 200) }
  }
  const detail = await resp.text().catch(() => '')
  return { kind: 'server_error', status, detail: detail.slice(0, 200) }
}

/**
 * Sign and POST a message.created event to the Hermes delivery endpoint.
 *
 * Never throws for a missing-config or non-2xx/network outcome — it RETURNS a
 * DeliveryOutcome for the caller (src/bus/consumer.ts) to act on. The caller decides
 * ack-vs-retry; this function's only job is "what actually happened, precisely."
 */
export async function deliverMessageCreatedEvent(
  env: Env,
  event: BusEvent<MessageCreatedPayload>,
): Promise<DeliveryOutcome> {
  const url = env.HERMES_EVENTS_WEBHOOK_URL
  const secret = env.HERMES_WEBHOOK_SECRET
  const missing: string[] = []
  if (!url) missing.push('HERMES_EVENTS_WEBHOOK_URL')
  if (!secret) missing.push('HERMES_WEBHOOK_SECRET')
  if (missing.length > 0) return { kind: 'not_configured', missing }

  const envelope = buildHermesEventEnvelope(event)
  // Serialize EXACTLY ONCE. Signing a re-serialized copy of the object (rather than the
  // literal string handed to fetch()) is how a signature can be "correct" for a payload
  // that is not byte-identical to what actually went on the wire — see mutation test (b)
  // in tests/hermes-delivery.test.ts.
  const body = JSON.stringify(envelope)
  const signature = await hmacSign(secret as string, body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  let resp: Response
  try {
    resp = await fetch(url as string, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': `sha256=${signature}`,
      },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    return { kind: 'network_error', detail: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
  return classifyDeliveryOutcome(resp, envelope.event_id)
}
