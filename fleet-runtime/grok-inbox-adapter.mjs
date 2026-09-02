#!/usr/bin/env node
// Grok TUI Stop-hook inbox adapter — compose with, do not replace, herdr polling.
//
// Delivery Sequence for this artifact: peek → spool → inject via Stop
// {decision:block,reason} → consume. Identity from check_in, never $AGENT_NAME.
//
// Complementary to scripts/grok-inbox-watch.mjs (kasra/grok-connector):
//   Stop hook  — mail arriving while a turn is running, delivered at genuine
//                completion (reason == end_turn).
//   herdr prompt — wakes an IDLE seat. Stop cannot: no turn is ending.
// A seat with only this hook goes silent exactly when it is doing nothing.
//
// Contract functions are reused from claude-code-inbox-adapter.mjs (YC27):
// planInboxConsume, bearerConsumerAllowed, verifyConsumedBatch,
// assertCanonicalRuntimeIdentity, isUnsafeStopHookDelivery, formatClaudeCodeNudge.
// All-or-nothing consume is correct HERE: one Stop block can carry the whole
// peeked batch. Per-message consume belongs on the herdr-polling transport,
// where only one confirmed delivery per cycle is possible.

import {
  assertCanonicalRuntimeIdentity,
  bearerConsumerAllowed,
  formatClaudeCodeNudge,
  isUnsafeStopHookDelivery,
  planInboxConsume,
  verifyConsumedBatch,
} from './claude-code-inbox-adapter.mjs'

export {
  assertCanonicalRuntimeIdentity,
  bearerConsumerAllowed,
  formatClaudeCodeNudge,
  isUnsafeStopHookDelivery,
  planInboxConsume,
  verifyConsumedBatch,
}

/** Grok Stop fires 8 continuations then force-stops. Count is per turn. */
export const GROK_STOP_CONTINUATION_CAP = 8

export function formatGrokNudge(message) {
  return formatClaudeCodeNudge(message)
}

/**
 * Whether this Stop event may drain. Session-end Stop is observe-only
 * (reason channel_closed / shutdown). Only genuine end_turn is a gate.
 */
export function grokStopShouldDrain(hookInput) {
  const event = String(
    hookInput?.hookEventName ?? hookInput?.hook_event_name ?? '',
  )
  const normalized = event.replace(/_/g, '').toLowerCase()
  if (normalized !== 'stop') {
    return { drain: false, reason: 'not_stop_event' }
  }
  const reason = hookInput?.reason
  if (reason === 'channel_closed' || reason === 'shutdown') {
    return { drain: false, reason: 'session_end_stop' }
  }
  if (reason != null && reason !== 'end_turn') {
    return { drain: false, reason: 'not_end_turn' }
  }
  return { drain: true, reason: 'end_turn' }
}

/**
 * A previous Stop block in this same turn already injected mail.
 * Re-blocking the same spool manufactures a loop until the 8-cap.
 */
export function grokStopShouldSkip(hookInput, alreadyDeliveredThisTurn) {
  if (alreadyDeliveredThisTurn === true && hookInput?.stopHookActive === true) {
    return { skip: true, reason: 'stop_hook_active_already_delivered' }
  }
  return { skip: false, reason: 'ok' }
}

/**
 * Grok overrides the Stop gate after 8 continuations. Do not emit another
 * block once the next fire would be ignored.
 */
export function grokContinuationAllowed(continuationCount) {
  const n = Number(continuationCount)
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, reason: 'invalid_continuation_count' }
  }
  if (n >= GROK_STOP_CONTINUATION_CAP) {
    return { ok: false, reason: 'continuation_cap' }
  }
  return { ok: true, reason: 'under_cap' }
}

/** Fail-open envelope: never break the Grok session. */
export function grokFailOpen() {
  return { suppressOutput: true }
}

export function grokBlockDecision(reason) {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new TypeError('block reason required')
  }
  return { decision: 'block', reason }
}
