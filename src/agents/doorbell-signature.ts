// src/agents/doorbell-signature.ts — verifier for the signed webhook doorbell.
//
// The pot signs with Standard Webhooks (src/mcp/events-webhook.ts): headers
// `webhook-id`, `webhook-timestamp`, `webhook-signature` over
// `"<id>.<timestamp>.<body>"`. The body is the narrow doorbell payload plus a
// per-attempt `nonce`. This module is what a receiver runs. It does not read D1.
//
// Reject when:
//   - |now - webhook-timestamp| > 300s (DOORBELL_MAX_SKEW_SEC)
//   - the signature does not match (constant-time, src/lib/crypto timingSafeEqual)
//   - the pair (webhook-id, nonce) was already accepted (the caller-supplied store)
//
// The HMAC key is a `whsec_` secret of at least 32 raw bytes, stored encrypted
// (vault domain agent_doorbell_hmac, AAD = the agent id). This helper never
// sees ciphertext. A wrong key fails the signature. A ciphertext decrypted with
// another agent's id fails in decryptConnectorSecret, before a signature exists.

import { timingSafeEqual } from '../lib/crypto'
import { parseWebhookSecret, standardWebhooksSignature } from '../mcp/events-webhook'

export const DOORBELL_MAX_SKEW_SEC = 300
/** Raw HMAC key length. Standard Webhooks allows 24..64; the doorbell requires 32..64. */
export const DOORBELL_HMAC_MIN_BYTES = 32

/** Keys a signed body is allowed to carry. Nothing else is signed or sent. */
export const SIGNED_DOORBELL_PAYLOAD_KEYS = {
  'mupot.inbox.wake': ['type', 'agent_id', 'seq', 'message_id', 'kind', 'nonce'],
  'mupot.task.assigned': ['type', 'agent_id', 'task_id', 'nonce'],
  'mupot.doorbell.test': ['type', 'agent_id', 'nonce'],
} as const

const FORBIDDEN_PAYLOAD_KEYS = ['from_agent', 'body', 'text', 'request', 'webhook_url', 'authorization'] as const

export type SignedDoorbellPayload =
  | { type: 'mupot.inbox.wake'; agent_id: string; seq: number; message_id: string; kind: string; nonce: string }
  | { type: 'mupot.task.assigned'; agent_id: string; task_id: string; nonce: string }
  | { type: 'mupot.doorbell.test'; agent_id: string; nonce: string }

/** Distributive so each variant keeps its own fields. A plain Omit collapses the union to the shared keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type SignedDoorbellFields = DistributiveOmit<SignedDoorbellPayload, 'nonce'>

export interface DoorbellReplayStore {
  /** True when this (webhook-id, nonce) was already accepted. */
  seen(webhookId: string, nonce: string): boolean
  remember(webhookId: string, nonce: string): void
}

export type DoorbellVerifyResult =
  | { ok: true; payload: SignedDoorbellPayload }
  | { ok: false; reason: 'malformed' | 'stale_timestamp' | 'bad_signature' | 'replayed' }

/** In-memory replay store for tests and single-isolate receivers. A Bot with more than one instance needs a shared store. */
export function memoryDoorbellReplayStore(): DoorbellReplayStore {
  const seen = new Set<string>()
  return {
    seen(webhookId, nonce) {
      return seen.has(`${webhookId}\n${nonce}`)
    },
    remember(webhookId, nonce) {
      seen.add(`${webhookId}\n${nonce}`)
    },
  }
}

/**
 * Accept a caller-supplied signing secret only when it is `whsec_` + base64 of
 * 32..64 bytes. The canonical string is what gets encrypted and what the
 * receiver configures. Shorter keys are refused so last4 cannot reveal the key.
 */
export function normalizeDoorbellHmacSecret(raw: string): { ok: true; secret: string } | { ok: false; detail: string } {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('whsec_')) {
    return { ok: false, detail: 'signed doorbell key must be a whsec_ secret of at least 32 bytes' }
  }
  const key = parseWebhookSecret(trimmed)
  if (!key || key.length < DOORBELL_HMAC_MIN_BYTES) {
    return { ok: false, detail: 'signed doorbell key must decode to at least 32 bytes' }
  }
  return { ok: true, secret: trimmed }
}

/** The exact JSON bytes that are signed and POSTed. Key order is fixed. */
export function signedDoorbellBody(fields: SignedDoorbellFields, nonce: string): string {
  let payload: SignedDoorbellPayload
  if (fields.type === 'mupot.inbox.wake') {
    payload = {
      type: fields.type,
      agent_id: fields.agent_id,
      seq: fields.seq,
      message_id: fields.message_id,
      kind: fields.kind,
      nonce,
    }
  } else if (fields.type === 'mupot.task.assigned') {
    payload = { type: fields.type, agent_id: fields.agent_id, task_id: fields.task_id, nonce }
  } else {
    payload = { type: fields.type, agent_id: fields.agent_id, nonce }
  }
  const allowed = SIGNED_DOORBELL_PAYLOAD_KEYS[payload.type]
  for (const key of Object.keys(payload)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new Error('doorbell-signature: payload key not allowed')
    }
  }
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      throw new Error('doorbell-signature: payload key not allowed')
    }
  }
  return JSON.stringify(payload)
}

/** Standard Webhooks headers for one doorbell attempt. Fresh timestamp and signature every call. */
export async function signDoorbellAttempt(
  secret: string,
  webhookId: string,
  body: string,
  nowMs: number,
): Promise<{ headers: Record<string, string>; timestampSec: number; signedAtIso: string }> {
  const timestampSec = Math.floor(nowMs / 1000)
  const signature = await standardWebhooksSignature([secret], webhookId, timestampSec, body)
  return {
    headers: {
      'content-type': 'application/json',
      'webhook-id': webhookId,
      'webhook-timestamp': String(timestampSec),
      'webhook-signature': signature,
    },
    timestampSec,
    signedAtIso: new Date(timestampSec * 1000).toISOString(),
  }
}

function payloadFromBody(body: string): SignedDoorbellPayload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    if (key in obj) return null
  }
  if (typeof obj.nonce !== 'string' || obj.nonce.length === 0 || obj.nonce.length > 200) return null
  if (typeof obj.agent_id !== 'string' || obj.agent_id.length === 0) return null
  if (obj.type === 'mupot.inbox.wake') {
    if (typeof obj.message_id !== 'string' || typeof obj.kind !== 'string' || typeof obj.seq !== 'number') return null
    const keys = Object.keys(obj)
    if (keys.length !== SIGNED_DOORBELL_PAYLOAD_KEYS['mupot.inbox.wake'].length) return null
    return { type: obj.type, agent_id: obj.agent_id, seq: obj.seq, message_id: obj.message_id, kind: obj.kind, nonce: obj.nonce }
  }
  if (obj.type === 'mupot.task.assigned') {
    if (typeof obj.task_id !== 'string') return null
    if (Object.keys(obj).length !== SIGNED_DOORBELL_PAYLOAD_KEYS['mupot.task.assigned'].length) return null
    return { type: obj.type, agent_id: obj.agent_id, task_id: obj.task_id, nonce: obj.nonce }
  }
  if (obj.type === 'mupot.doorbell.test') {
    if (Object.keys(obj).length !== SIGNED_DOORBELL_PAYLOAD_KEYS['mupot.doorbell.test'].length) return null
    return { type: obj.type, agent_id: obj.agent_id, nonce: obj.nonce }
  }
  return null
}

/**
 * Verify one signed doorbell delivery.
 *
 * `headers.signature` is the `webhook-signature` header (`v1,<base64>`, possibly
 * several space-separated during a rotation). Comparison is constant-time.
 * Timestamp skew is checked before the signature so a stale delivery does not
 * depend on the key. Replay is checked only after the signature matches, and
 * the nonce is remembered only on success, so a bad signature cannot burn it.
 */
export async function verifySignedDoorbell(input: {
  secret: string
  webhookId: string
  timestampSec: number
  signature: string
  body: string
  nowSec: number
  replay: DoorbellReplayStore
}): Promise<DoorbellVerifyResult> {
  if (!Number.isFinite(input.timestampSec) || !Number.isFinite(input.nowSec)) {
    return { ok: false, reason: 'malformed' }
  }
  if (Math.abs(input.nowSec - input.timestampSec) > DOORBELL_MAX_SKEW_SEC) {
    return { ok: false, reason: 'stale_timestamp' }
  }
  const payload = payloadFromBody(input.body)
  if (!payload) return { ok: false, reason: 'malformed' }
  if (typeof input.webhookId !== 'string' || input.webhookId.length === 0 || input.webhookId.length > 200) {
    return { ok: false, reason: 'malformed' }
  }
  let expected: string
  try {
    expected = await standardWebhooksSignature([input.secret], input.webhookId, input.timestampSec, input.body)
  } catch {
    return { ok: false, reason: 'bad_signature' }
  }
  const parts = input.signature.split(' ').filter((part) => part.length > 0)
  if (parts.length === 0) return { ok: false, reason: 'bad_signature' }
  let match = 0
  for (const part of parts) {
    match |= timingSafeEqual(part, expected) ? 1 : 0
  }
  if (match !== 1) return { ok: false, reason: 'bad_signature' }
  if (input.replay.seen(input.webhookId, payload.nonce)) return { ok: false, reason: 'replayed' }
  input.replay.remember(input.webhookId, payload.nonce)
  return { ok: true, payload }
}
