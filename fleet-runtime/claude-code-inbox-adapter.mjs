#!/usr/bin/env node
// Claude Code inbox adapter — peek → local handoff → consume-on-success.
//
// YC27 diagnosed failure: a Stop-hook branch called mupot `inbox` with peek=false,
// wrote a truncated line to stderr (dropping request_id / in_reply_to), then returned
// `{suppressOutput:true}`. That marked the durable row read without ever injecting it
// into the Claude Code turn — so ACKs could not correlate and the message was gone.
//
// This module is the pure contract for the authoritative Claude Code receive path:
// format a nudge that preserves correlation fields, refuse consume until delivery
// succeeds, and refuse bearer consume when the consumer fence is not bearer_only.

const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const KINDS = new Set(['message', 'request', 'ack'])

/** Legacy Stop-hook line that dropped correlation fields (the YC27 bug). */
export function legacyStopHookFormat(message) {
  const frm = String(message?.from_agent ?? '?').slice(0, 8)
  const kind = message?.kind ?? 'message'
  const body = message?.body ?? ''
  return `  • [${kind}] ${frm}: ${body}`
}

export function formatClaudeCodeNudge(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new TypeError('message must be an object')
  }
  const kind = typeof message.kind === 'string' && KINDS.has(message.kind) ? message.kind : null
  if (!kind) throw new TypeError('message.kind invalid')
  if (typeof message.body !== 'string' || message.body.length === 0 || message.body.length > 8000) {
    throw new TypeError('message.body invalid')
  }
  const fromAgent = typeof message.from_agent === 'string' && message.from_agent ? message.from_agent : '?'
  const requestId = message.request_id == null ? null : String(message.request_id)
  if (requestId != null && !REF_RE.test(requestId)) throw new TypeError('message.request_id invalid')
  const inReplyTo = message.in_reply_to == null ? null : String(message.in_reply_to)
  if (inReplyTo != null && !REF_RE.test(inReplyTo)) throw new TypeError('message.in_reply_to invalid')
  const seq = Number(message.seq)
  const id = typeof message.id === 'string' ? message.id : ''

  const lines = [
    '[mupot inbox — authoritative receive]',
    `seq: ${Number.isFinite(seq) ? seq : '?'}`,
    `id: ${id || '?'}`,
    `from_agent: ${fromAgent}`,
    `kind: ${kind}`,
    `request_id: ${requestId ?? ''}`,
    `in_reply_to: ${inReplyTo ?? ''}`,
    `body: ${message.body}`,
  ]
  if (kind === 'request' && requestId) {
    lines.push(
      `ACK required: send kind=ack in_reply_to=${requestId} (preserve this request_id).`,
    )
  }
  return lines.join('\n')
}

/**
 * Decide whether the peeked batch may be consumed after local handoff.
 * Consume count is 0 unless every peeked message was delivered.
 */
export function planInboxConsume(input) {
  const peeked = Number(input?.peekedCount)
  const delivered = Number(input?.deliveredCount)
  if (!Number.isInteger(peeked) || peeked < 0) {
    return { consume: 0, reason: 'invalid_peeked_count' }
  }
  if (!Number.isInteger(delivered) || delivered < 0) {
    return { consume: 0, reason: 'invalid_delivered_count' }
  }
  if (peeked === 0) return { consume: 0, reason: 'inbox_empty' }
  if (delivered !== peeked) {
    return { consume: 0, reason: 'delivery_incomplete' }
  }
  return { consume: peeked, reason: 'delivered' }
}

/**
 * Bearer MCP / Stop-hook consumers are only legal while the fence is bearer_only
 * (or absent → default bearer_only). signed_only must not be drained by a bearer token.
 */
export function bearerConsumerAllowed(fence) {
  const mode = fence?.mode == null || fence.mode === '' ? 'bearer_only' : fence.mode
  if (mode !== 'bearer_only' && mode !== 'signed_only') {
    return { ok: false, reason: 'invalid_fence_mode' }
  }
  if (mode !== 'bearer_only') {
    return { ok: false, reason: 'consumer_fenced' }
  }
  return { ok: true, reason: 'bearer_only' }
}

/**
 * Runtime identity gate: the welded token must bind the canonical Kasra agent.
 * Prevents a stale/wrong token from consuming Kasra's inbox.
 */
export function assertCanonicalRuntimeIdentity(boot, expectedAgentId) {
  if (typeof expectedAgentId !== 'string' || !expectedAgentId) {
    return { ok: false, reason: 'expected_agent_required' }
  }
  const bound = boot?.bound_agent_id
  if (typeof bound !== 'string' || !bound) {
    return { ok: false, reason: 'token_not_agent_bound' }
  }
  if (bound !== expectedAgentId) {
    return { ok: false, reason: 'wrong_bound_agent' }
  }
  return { ok: true, reason: 'identity_ok', agent_id: bound }
}

/**
 * Anti-pattern detector for the YC27 Stop-hook failure mode.
 * A consuming read paired with suppressOutput (and no block decision) loses the message.
 */
export function isUnsafeStopHookDelivery(hookResult) {
  const peek = hookResult?.peek === true
  const consumed = hookResult?.peek === false || hookResult?.consumed === true
  const suppressed = hookResult?.suppressOutput === true
  const blocked = hookResult?.decision === 'block'
  const hasCorrelation =
    typeof hookResult?.text === 'string' &&
    hookResult.text.includes('request_id')
  if (consumed && suppressed && !blocked) return true
  if (consumed && !hasCorrelation && typeof hookResult?.text === 'string') return true
  if (!peek && suppressed && !blocked) return true
  return false
}
