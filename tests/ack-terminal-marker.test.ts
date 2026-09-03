// tests/ack-terminal-marker.test.ts — an ack cannot itself demand a reply (mumega.com#1179
// discussion, ACK-chain-has-no-terminal-marker defect, 2026-09-02/03).
//
// WHY THIS EXISTS
//
// ~/.claude/rules/agent-comms.md's ACK protocol says a message carrying request_id gets an
// explicit ACK back, but names no STOP condition. Observed on the live bus: Kasra sends a
// finding (carries request_id) -> Athena ACKs it -> Kasra sends "chain: closed, no further ACK
// needed" -> Athena's receive path (an automated per-message rule: "if a message carries
// request_id, ACK it") sends a delivery-ACK of the chain-close. Writing "closed" in the BODY
// does nothing, because the automatic acker never reads free text — it reads request_id.
//
// The fix enforced here is structural, not textual: a message sent with kind:"ack" may never
// itself carry a request_id. request_id is the ONLY signal the protocol (and every automated
// receive path keyed on it, e.g. the mupot-inbox.sh Stop hook: "if a message carries
// request_id, ACK with kind=ack") uses to decide "the recipient owes a reply". Refusing it at
// the send boundary makes an ack chain terminate by construction: nothing downstream is ever
// instructed to ACK an ack, because an ack can never carry the field that instruction keys on.
//
// This does not touch kind:"message"/"request" (a normal message MAY request a reply — that is
// the whole point of request_id) and does not touch in_reply_to (an ack still needs to say
// which request it closes).

import { describe, expect, it } from 'vitest'
import { sendAgentMessage, type SendAuthzDecision } from '../src/agents/messages'
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

describe('kind:"ack" cannot itself carry request_id (ack chains terminate by construction)', () => {
  it('refuses to send an ack message that also sets request_id', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    const res = await sendAgentMessage(
      env,
      {
        fromAgent: FROM,
        fromMember: FROM_MEMBER,
        toAgent: TO,
        body: 'chain: closed, no further ACK needed',
        kind: 'ack',
        inReplyTo: 'req-1',
        requestId: 'req-2', // the ack is ALSO asking for a reply — this is the defect
      },
      SYSTEM_AUTHZ,
    )

    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected the send to be refused')
    expect(res.reason).toBe('ack_cannot_request_ack')

    // Nothing landed — a rejected send must not leave a half-written row for a later
    // reconciliation pass to trip over.
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM agent_messages WHERE tenant = ?1 AND to_agent = ?2',
    ).bind(TENANT, TO).first<{ n: number }>()
    expect(Number(row?.n ?? -1)).toBe(0)

    harness.close()
  })

  it('allows an ack with in_reply_to and no request_id — the terminal, non-escalating case', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    const res = await sendAgentMessage(
      env,
      {
        fromAgent: FROM,
        fromMember: FROM_MEMBER,
        toAgent: TO,
        body: 'chain: closed, no further ACK needed',
        kind: 'ack',
        inReplyTo: 'req-1',
      },
      SYSTEM_AUTHZ,
    )

    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error(`expected success, got ${res.reason}`)

    const row = await env.DB.prepare(
      'SELECT kind, request_id, in_reply_to FROM agent_messages WHERE id = ?1',
    ).bind(res.id).first<{ kind: string; request_id: string | null; in_reply_to: string | null }>()
    expect(row).toMatchObject({ kind: 'ack', request_id: null, in_reply_to: 'req-1' })

    harness.close()
  })

  it('does NOT restrict request_id on kind:"message" or kind:"request" — only ack is non-escalating', async () => {
    const harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const env = envFor(harness)

    for (const kind of ['message', 'request'] as const) {
      const res = await sendAgentMessage(
        env,
        {
          fromAgent: FROM,
          fromMember: FROM_MEMBER,
          toAgent: TO,
          body: `a ${kind} that legitimately wants a reply`,
          kind,
          requestId: `req-${kind}`,
        },
        SYSTEM_AUTHZ,
      )
      expect(res.ok).toBe(true)
    }

    harness.close()
  })
})
