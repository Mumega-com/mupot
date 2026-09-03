// tests/reply-expectation.test.ts — a message says whether it wants an answer, and an ack
// never does (mumega-com#1179, ACK-chain-has-no-terminal-marker, observed live 2026-09-02/03).
//
// WHY THIS EXISTS
//
// The ACK protocol says "a message carrying request_id gets an explicit ACK back" and names no
// STOP condition. Live: Kasra sends a finding (carries request_id) -> Athena ACKs it -> Kasra
// sends "chain: closed, no further ACK needed" -> an automated receive path ACKs the
// chain-close, because request_id is the only signal it reads and "closed" is prose no acker
// parses.
//
// THE FIRST FIX WAS WRONG AND THE GATE CAUGHT IT. Refusing request_id on kind:"ack" would have
// (a) hard-failed 748 of 1,303 historical acks and Athena's own automated hook, and (b) removed
// the replay-once idempotency key that migration 0032 defines request_id to be. These tests
// pin BOTH of those as requirements now, so the rejected design cannot come back by accident.
//
// The shipped fix is additive: one predicate over kind, the request_id field and the body
// prose token, surfaced on every inbox read as expects_reply + reply_basis. Nothing is refused.

import { describe, expect, it } from 'vitest'
import { evaluateReplyExpectation } from '../src/agents/reply-expectation'
import { sendAgentMessage, readAgentInbox, leaseAgentInbox, type SendAuthzDecision } from '../src/agents/messages'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

const TENANT = 'mumega'
const FROM = 'agent-ack-sender'
const FROM_MEMBER = 'member-ack-sender'
const TO = 'agent-ack-recipient'

const SYSTEM_AUTHZ: SendAuthzDecision = { system: true, reason: 'test: bypasses squad-visibility confinement, unrelated to this rule' }

function envFor(harness: SqliteD1Harness): Env {
  return { DB: harness.db, TENANT_SLUG: TENANT } as unknown as Env
}

describe('the predicate — one decision, from every input that can express it', () => {
  it('an ack is terminal EVEN WHEN it carries a request_id — this is the live incident', () => {
    const got = evaluateReplyExpectation({ kind: 'ack', requestId: 'athena-delivery-ack-b6e6437e', body: 'received' })
    expect(got).toEqual({ expected: false, basis: 'ack_is_terminal' })
  })

  it('an ack with no request_id is terminal too', () => {
    expect(evaluateReplyExpectation({ kind: 'ack', body: 'received' }).expected).toBe(false)
  })

  it('the request_id FIELD on an ordinary message asks for a reply', () => {
    const got = evaluateReplyExpectation({ kind: 'message', requestId: 'req-1', body: 'build G64b' })
    expect(got).toEqual({ expected: true, basis: 'request_id_field' })
  })

  it('a chain is closed by kind:"ack", which is structured and cannot be quoted', () => {
    // The ONLY close. A body cannot carry this authority — see the quoted-marker regressions.
    expect(evaluateReplyExpectation({ kind: 'ack', body: 'chain closed, nothing further owed' }))
      .toEqual({ expected: false, basis: 'ack_is_terminal' })
  })

  it('a [request_id:...] token in PROSE counts, because that is what agents actually key on', () => {
    const got = evaluateReplyExpectation({ kind: 'message', body: '[request_id:550e8400-e29b-41d4-a716-446655440000] build it' })
    expect(got).toEqual({ expected: true, basis: 'body_token' })
  })

  it('reports body_token distinctly, so a caller can refuse to act on a QUOTE', () => {
    // A body that quotes someone else's message is indistinguishable from one that requests a
    // reply, if you only look at a boolean. The basis is how a consumer tells them apart.
    const quoting = evaluateReplyExpectation({
      kind: 'message',
      body: 'Athena wrote: "[request_id:abc-123] gate this" — I have already answered her.',
    })
    expect(quoting.expected).toBe(true)
    expect(quoting.basis).toBe('body_token')
    expect(quoting.basis).not.toBe('request_id_field')
  })

  it('the structured field decides regardless of what the prose says', () => {
    // A spurious ack is noise; a missing ack is a stall. Fail toward answering.
    const got = evaluateReplyExpectation({ kind: 'message', requestId: 'req-1', body: 'answer me [no_reply]' })
    expect(got).toEqual({ expected: true, basis: 'request_id_field' })
  })

  it('a plain message asks for nothing', () => {
    expect(evaluateReplyExpectation({ kind: 'message', body: 'fyi, prod is clean' }))
      .toEqual({ expected: false, basis: 'no_signal' })
  })

  // REGRESSION — Athena's BLOCK on d117565e. A first draft honoured a `[no_reply]` body marker.
  // A body QUOTING that marker suppressed a reply the same body was genuinely asking for: a
  // required ACK cancelled by quotation. The lesson generalises past the one token — ANY
  // authority read out of a body is forgeable by repeating it — so the marker is gone rather
  // than reordered, and these pin that it stays gone.
  it('a body marker no longer suppresses anything — it is inert text', () => {
    for (const body of ['[no_reply]', '[ no_reply ]', '[no-reply]', 'done. [NO_REPLY]']) {
      const got = evaluateReplyExpectation({ kind: 'message', body })
      expect(got.expected).toBe(false)
      // false because NOTHING asked, not because the marker was honoured
      expect(got.basis).toBe('no_signal')
    }
  })

  it("Athena's exact probe body is inert, not a honoured close", () => {
    // Verbatim from the gate verdict on d117565e. Previously this returned
    // basis:'explicit_no_reply' — a quoted marker treated as authoritative.
    const got = evaluateReplyExpectation({ kind: 'message', body: 'Quoting "[no_reply]" but please answer' })
    expect(got.expected).toBe(false)
    expect(got.basis).toBe('no_signal')
  })

  it('QUOTING a no-reply marker cannot cancel a genuine request in the same body', () => {
    // Athena's exact probe shape, plus the real request the probe was protecting.
    const got = evaluateReplyExpectation({
      kind: 'message',
      body: 'Quoting "[no_reply]" but please answer: [request_id:550e8400-e29b-41d4-a716-446655440000]',
    })
    expect(got.expected).toBe(true)
    expect(got.basis).toBe('body_token')
  })

  it('QUOTING a no-reply marker cannot cancel a structured request either', () => {
    const got = evaluateReplyExpectation({
      kind: 'message',
      requestId: 'req-must-be-answered',
      body: 'They wrote "[no_reply]" — ignore that, I still need an answer.',
    })
    expect(got).toEqual({ expected: true, basis: 'request_id_field' })
  })

  it('KNOWN RESIDUAL: an acknowledgement sent WITHOUT kind:"ack" still reads as a request', () => {
    // Honest limit, recorded rather than hidden. `kind` defaults to 'message', so an agent that
    // acknowledges without setting the label and DOES set request_id gets expects_reply:true.
    // That is the correct reading of what it sent — it labelled itself a message and asked for a
    // reply. The escape is available to every kind and costs one token: [no_reply].
    expect(evaluateReplyExpectation({ kind: 'message', requestId: 'req-9', body: 'ack: got it' }).expected).toBe(true)
    // ...and the fix is to send it as what it is:
    expect(evaluateReplyExpectation({ kind: 'ack', requestId: 'req-9', body: 'ack: got it' }).expected).toBe(false)
  })
})

describe('the send path refuses nothing — the rejected design must not come back', () => {
  it('an ack WITH request_id sends, stores the id, and still reads as terminal', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    // Athena's live hook coins exactly this shape on every delivery ack. 748 of 1,303
    // historical acks carry one. A 400 here would wedge her turn.
    const res = await sendAgentMessage(env, {
      fromAgent: FROM,
      fromMember: FROM_MEMBER,
      toAgent: TO,
      body: 'ACK from authenticated Athena bearer.',
      kind: 'ack',
      inReplyTo: 'kasra-gate-request-pr1280',
      requestId: 'athena-delivery-ack-b6e6437e',
    }, SYSTEM_AUTHZ)

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(`expected success, got ${res.reason}`)

    // request_id is PERSISTED — it is the replay-once idempotency key (migration 0032),
    // not decoration. Banning it would have removed dedup for retried acks.
    const row = await env.DB.prepare(
      'SELECT kind, request_id, in_reply_to FROM agent_messages WHERE id = ?1',
    ).bind(res.id).first<{ kind: string; request_id: string | null; in_reply_to: string | null }>()
    expect(row).toMatchObject({
      kind: 'ack',
      request_id: 'athena-delivery-ack-b6e6437e',
      in_reply_to: 'kasra-gate-request-pr1280',
    })

    // ...and the recipient is told not to answer it.
    const read = await readAgentInbox(env, { agent: TO, peek: true })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.messages).toHaveLength(1)
    expect(read.messages[0].expects_reply).toBe(false)
    expect(read.messages[0].reply_basis).toBe('ack_is_terminal')

    harness.close()
  })

  it('replay-once still dedups a retried ack by request_id', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    const send = () => sendAgentMessage(env, {
      fromAgent: FROM,
      fromMember: FROM_MEMBER,
      toAgent: TO,
      body: 'ACK',
      kind: 'ack',
      requestId: 'athena-delivery-ack-retried',
    }, SYSTEM_AUTHZ)

    const first = await send()
    const second = await send()
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.duplicate).toBe(false)
    expect(second.duplicate).toBe(true)

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2',
    ).bind(TENANT, TO).first<{ n: number }>()
    expect(Number(row?.n ?? -1)).toBe(1)

    harness.close()
  })
})

describe('every inbox surface carries the answer', () => {
  it('a peeked read annotates expects_reply and its basis', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    await sendAgentMessage(env, {
      fromAgent: FROM, fromMember: FROM_MEMBER, toAgent: TO,
      body: 'build G64b', kind: 'message', requestId: 'req-wants-answer',
    }, SYSTEM_AUTHZ)
    await sendAgentMessage(env, {
      fromAgent: FROM, fromMember: FROM_MEMBER, toAgent: TO,
      body: 'chain closed', kind: 'ack', inReplyTo: 'req-wants-answer',
    }, SYSTEM_AUTHZ)

    const read = await readAgentInbox(env, { agent: TO, peek: true })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    const byBody = Object.fromEntries(read.messages.map((m) => [m.body, m]))
    expect(byBody['build G64b'].expects_reply).toBe(true)
    expect(byBody['build G64b'].reply_basis).toBe('request_id_field')
    expect(byBody['chain closed'].expects_reply).toBe(false)
    expect(byBody['chain closed'].reply_basis).toBe('ack_is_terminal')

    harness.close()
  })

  it('a lease answers the same question — the annotation cannot drift between surfaces', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    await sendAgentMessage(env, {
      fromAgent: FROM, fromMember: FROM_MEMBER, toAgent: TO,
      body: 'ACK', kind: 'ack', requestId: 'athena-delivery-ack-leased',
    }, SYSTEM_AUTHZ)

    const leased = await leaseAgentInbox(env, { agent: TO, limit: 10 })
    expect(leased.ok).toBe(true)
    if (!leased.ok) return
    expect(leased.messages).toHaveLength(1)
    expect(leased.messages[0].expects_reply).toBe(false)
    expect(leased.messages[0].reply_basis).toBe('ack_is_terminal')

    harness.close()
  })
})
