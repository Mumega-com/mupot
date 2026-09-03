// src/agents/reply-expectation.ts — ONE predicate that decides whether a message asks its
// recipient for a reply, resolved from every input that can express that intent.
//
// WHY THIS EXISTS (mumega-com#1179, observed live 2026-09-02/03)
//
// The ACK protocol says "a message carrying request_id gets an explicit ACK back" and names no
// STOP condition. Observed on the live bus: Kasra sends a finding (carries request_id) ->
// Athena ACKs it -> Kasra sends "chain: closed, no further ACK needed" -> an automated receive
// path ACKs the chain-close, because request_id is the only signal it reads and the words
// "closed" are free text no automated acker parses. The chain does not terminate on its own.
//
// The FIRST attempt at a fix (this PR's original commit) refused request_id on kind:"ack" at
// the send boundary. That was gated and rejected, correctly, for two reasons that are worth
// keeping written down next to the code:
//
//   1. It breaks live senders. 748 of 1,303 historical acks carry a request_id, and Athena's
//      own automated hook coins one (`athena-delivery-ack-<id>`) on every delivery ack. A 400
//      would have hard-failed a live participant in the very loop it was quietening.
//   2. request_id is LOAD-BEARING for something else. Per migrations/0032_agent_messages.sql
//      it is the SENDER's idempotency key, unique per sender via a partial index — the
//      replay-once mechanism. Banning it on acks would have removed dedup for retried acks:
//      fewer acks, but duplicates now land. A noise problem traded for a correctness problem.
//
// So the defect was never "acks carry identifiers". It is that NOTHING MARKS A MESSAGE AS
// TERMINAL, so the acking reflex has no stopping rule. This module supplies that mark. It is
// purely additive: it refuses nothing, breaks no sender, and removes no idempotency.
//
// DESIGN NOTES
//
// * One predicate, decided once. The earlier guard bound the LABEL (kind === 'ack') and had
//   three ways around it: `kind` defaults to 'message' when omitted, so an acknowledgement sent
//   without the label bypassed it entirely; and agents key their reflex on a `[request_id:…]`
//   token in BODY PROSE, which a server-side field check never sees. All three inputs are
//   resolved here, in one place.
// * It reports its BASIS, not just a boolean. Prose is forgeable by quotation: a body that
//   quotes someone else's `[request_id:…]` looks identical to one that requests a reply. A
//   consumer that wants to act only on structured intent can trust `request_id_field` and treat
//   `body_token` as the weak signal it is. Collapsing that to one boolean would hide the
//   difference at exactly the call site that needs it.
// * Close a chain with kind:"ack", not with words. Prose cannot carry authority here: anything
//   the predicate reads out of a body can be reproduced by QUOTING it, so a body-level "do not
//   reply" signal is forgeable by anyone who repeats it. Only fields that a sender sets on the
//   envelope — kind, request_id — are safe to treat as intent.

/** Kinds an agent message may carry. Mirrors KINDS in ./messages. */
export type ReplyExpectationKind = 'message' | 'request' | 'ack'

/**
 * Why the predicate answered the way it did. Ordered by strength of evidence, strongest first.
 * - `ack_is_terminal`  — kind:"ack". An ack closes a chain; it never opens one.
 * - `request_id_field` — the sender set the structured field. Unambiguous intent.
 * - `body_token`       — a `[request_id:…]` token appears in prose only. WEAK: may be a quote.
 * - `no_signal`        — nothing in the message asks for anything.
 */
export type ReplyBasis =
  | 'ack_is_terminal'
  | 'request_id_field'
  | 'body_token'
  | 'no_signal'

export interface ReplyExpectation {
  /** True when the recipient owes this message a reply. */
  expected: boolean
  /** Which input decided it. See ReplyBasis — `body_token` is deliberately weaker than the rest. */
  basis: ReplyBasis
}

/**
 * The prose form agents actually key their acking reflex on today, per the ACK protocol in
 * ~/.claude/rules/agent-comms.md. Charset matches RID_RE in ./messages; bounded, so no ReDoS.
 */
const BODY_REQUEST_ID_RE = /\[\s*request_id\s*:\s*[A-Za-z0-9_.:-]{1,128}\s*\]/i

export interface ReplyExpectationInput {
  kind: ReplyExpectationKind | string
  requestId?: string | null
  body?: string | null
}

/**
 * Decide whether a message asks its recipient for a reply.
 *
 * The order below IS the contract, and each step is load-bearing:
 *
 *  1. An ack is terminal, unconditionally — even when it carries a request_id. That is the fix
 *     for the live incident. The ack keeps its request_id for replay-once idempotency
 *     (migration 0032); what changes is that the field on an ack no longer READS as a request
 *     for a further ack. The label is not banned, it is interpreted.
 *  2. An explicit request_id field means the sender wants an answer.
 *  3. A `[request_id:…]` token in prose is the reflex trigger in the wild, so it counts — but
 *     it reports as `body_token` so a caller can tell it apart from real structured intent.
 *
 * There is deliberately NO body marker for "do not reply". A first draft of this module had one
 * (`[no_reply]`), and Athena's gate killed it: a body QUOTING the marker suppressed a reply that
 * a genuine `[request_id:…]` token in the same body was asking for — a required ACK cancelled by
 * quotation. The bug is not the ordering. If such a marker must lose to the structured field AND
 * must lose to the prose token, it never decides anything, and a signal that never decides
 * anything should not exist. The structured, non-quotable way to close a chain is to send it as
 * kind:"ack": it already persists, it is already terminal here, and it needs no new column.
 */
export function evaluateReplyExpectation(input: ReplyExpectationInput): ReplyExpectation {
  if (input.kind === 'ack') return { expected: false, basis: 'ack_is_terminal' }

  const requestId = typeof input.requestId === 'string' ? input.requestId.trim() : ''
  if (requestId.length > 0) return { expected: true, basis: 'request_id_field' }

  const body = typeof input.body === 'string' ? input.body : ''
  if (BODY_REQUEST_ID_RE.test(body)) return { expected: true, basis: 'body_token' }

  return { expected: false, basis: 'no_signal' }
}
