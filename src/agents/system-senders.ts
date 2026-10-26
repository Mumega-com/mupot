// src/agents/system-senders.ts — the ONE registry of fixed system-sender literals.
//
// mupot writes some inbox rows from literals that are deliberately NOT agent rows, so no caller
// can spoof or address them (real senders are stamped with their bound agent UUID, never one of
// these strings). Several of those rows carry kind:'request' + request_id for idempotency or
// correlation, which the reply predicate used to read as "reply owed" — recipients then sent an
// ACK to a literal that cannot receive one (refused as send_target_not_visible).
//
// Each entry names the tool that IS the real response (reply_via), or null when the message is
// informational. Consuming the row with inbox_ack is the receipt; no message reply is owed.
//
// These names are public constants in this repo, so naming them in a refusal is not an
// existence oracle. Registering a literal here never makes it addressable or impersonable.

export const REVIEW_WAKE_SENDER = 'mupot-review-gate'
// Informational only: a decision card tells a HUMAN something awaits them. It must not tell the
// recipient model to act with a tool (reply_via null), unlike the review-wake delegation above.
export const DECISION_CARD_SENDER = 'mupot-decision-card'
export const FLIGHTS_SENDER = 'mupot-flights'
export const DISPATCH_BRIDGE_SENDER = 'mupot-dispatch'
export const SWEEPER_SENDER = 'mupot-approval-sweeper'
export const SECURE_DROP_NOTIFY_SENDER = 'mupot-secure-drop'
export const WAKE_ROUTER_SENDER = 'mupot-wake-router'
// Wake-on-assign doorbell (src/agents/assignment-wake.ts): an identifier plus a pointer to the task. Informational:
// the response is task notes on the task itself, not a message reply.
export const ASSIGNMENT_WAKE_SENDER = 'mupot-assignment-wake'
// One-time welcome after a human claims an agent (src/members/claim-welcome.ts). Informational: the response is the agent's own next steps.
export const ONBOARDING_SENDER = 'mupot-onboarding'

/** Response tool per system sender; null = informational, nothing to answer. */
export const SYSTEM_SENDERS: Readonly<Record<string, string | null>> = Object.freeze({
  [REVIEW_WAKE_SENDER]: 'task_verdict',
  [DECISION_CARD_SENDER]: null,
  [FLIGHTS_SENDER]: 'flight_land',
  // The dispatch envelope itself names this tool as the only thing that settles the dispatch.
  [DISPATCH_BRIDGE_SENDER]: 'task_dispatch_runtime_receipt',
  [SWEEPER_SENDER]: null,
  [SECURE_DROP_NOTIFY_SENDER]: null,
  [WAKE_ROUTER_SENDER]: null,
  [ASSIGNMENT_WAKE_SENDER]: null,
  [ONBOARDING_SENDER]: null,
})

export function isSystemSender(ref: unknown): ref is string {
  return typeof ref === 'string' && Object.prototype.hasOwnProperty.call(SYSTEM_SENDERS, ref)
}

/** Response tool for a registered system sender, null when informational or not registered. */
export function systemSenderReplyVia(ref: unknown): string | null {
  return isSystemSender(ref) ? SYSTEM_SENDERS[ref] : null
}
