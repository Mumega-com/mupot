// tests/system-sender-reply.test.ts — system-sender literals (mupot-flights, mupot-review-gate, …)
// are not agents: their request_id rows owe no message reply, and a send to one is refused with an
// actionable reason while every other unresolvable ref keeps the collapsed refusal.

import { describe, expect, it } from 'vitest'
import { evaluateReplyExpectation } from '../src/agents/reply-expectation'
import { SYSTEM_SENDERS, systemSenderReplyVia } from '../src/agents/system-senders'
import { sendAgentMessage, sendToRef, readAgentInbox, type SendAuthzDecision } from '../src/agents/messages'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

const SYSTEM_AUTHZ: SendAuthzDecision = { system: true, reason: 'test' }
const EXPECTED_VIA: Record<string, string | null> = {
  'mupot-review-gate': 'task_verdict',
  'mupot-decision-card': null,
  'mupot-flights': 'flight_land',
  'mupot-dispatch': 'task_dispatch_runtime_receipt',
  'mupot-approval-sweeper': null,
  'mupot-secure-drop': null,
  'mupot-wake-router': null,
}

describe('registry', () => {
  it('registers exactly the seven known literals with the right response tool', () => {
    expect({ ...SYSTEM_SENDERS }).toEqual(EXPECTED_VIA)
  })
  it('does not treat prototype keys or lookalikes as system senders', () => {
    for (const ref of ['toString', '__proto__', 'constructor', 'mupot-flights ', 'MUPOT-FLIGHTS', 'central-command'])
      expect(systemSenderReplyVia(ref)).toBeNull()
  })
})

describe('predicate', () => {
  for (const sender of Object.keys(EXPECTED_VIA)) {
    it(`${sender} request with request_id owes no reply`, () => {
      expect(evaluateReplyExpectation({ kind: 'request', requestId: 'x.1', fromAgent: sender }))
        .toEqual({ expected: false, basis: 'system_sender' })
    })
  }
  it('a normal agent request still expects a reply via request_id_field', () => {
    expect(evaluateReplyExpectation({ kind: 'request', requestId: 'x.1', fromAgent: 'agent-1' }))
      .toEqual({ expected: true, basis: 'request_id_field' })
  })
  it('an ack stays terminal', () => {
    expect(evaluateReplyExpectation({ kind: 'ack', requestId: 'x.1', fromAgent: 'agent-1' }))
      .toEqual({ expected: false, basis: 'ack_is_terminal' })
  })
})

function setup() {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  return { harness, env: { DB: harness.db, TENANT_SLUG: 'mumega' } as unknown as Env }
}

describe('inbox annotation', () => {
  it('system-sender rows carry reply_via; ordinary rows do not', async () => {
    const { harness, env } = setup()
    for (const [i, sender] of Object.keys(EXPECTED_VIA).entries()) {
      const r = await sendAgentMessage(env, {
        fromAgent: sender, fromMember: 'm1', toAgent: 'agent-to', kind: 'request', body: 'b', requestId: `rid.${i}`,
      }, SYSTEM_AUTHZ)
      expect(r.ok).toBe(true)
    }
    await sendAgentMessage(env, {
      fromAgent: 'agent-from', fromMember: 'm1', toAgent: 'agent-to', kind: 'request', body: 'b', requestId: 'rid.normal',
    }, SYSTEM_AUTHZ)
    const read = await readAgentInbox(env, { agent: 'agent-to', peek: true })
    if (!read.ok) throw new Error(read.reason)
    expect(read.messages).toHaveLength(8)
    for (const m of read.messages) {
      if (m.from_agent in EXPECTED_VIA) {
        expect(m.expects_reply).toBe(false)
        expect(m.reply_basis).toBe('system_sender')
        expect(m.reply_via).toBe(EXPECTED_VIA[m.from_agent])
      } else {
        expect(m.expects_reply).toBe(true)
        expect(m.reply_basis).toBe('request_id_field')
        expect(m.reply_via).toBeUndefined()
      }
    }
    harness.close()
  })
})

describe('send to a system sender', () => {
  it('is refused as system_sender_not_addressable naming reply_via, for admin and non-admin', async () => {
    const { harness, env } = setup()
    for (const isAdmin of [false, true]) {
      const res = await sendToRef(env, { fromAgent: 'a1', fromMember: 'm1', toRef: 'mupot-flights', body: 'ACK', kind: 'ack' }, { isAdmin, grants: [] })
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toBe('system_sender_not_addressable')
      expect(res.detail).toContain('flight_land')
    }
    const info = await sendToRef(env, { fromAgent: 'a1', fromMember: 'm1', toRef: 'mupot-secure-drop', body: 'x' }, { isAdmin: false, grants: [] })
    expect(info.ok === false && info.reason).toBe('system_sender_not_addressable')
    expect(info.ok === false && info.detail).toContain('inbox_ack')
    const direct = await sendAgentMessage(env, { fromAgent: 'a1', fromMember: 'm1', toAgent: 'mupot-review-gate', body: 'x' }, SYSTEM_AUTHZ)
    expect(direct.ok === false && direct.reason).toBe('system_sender_not_addressable')
    const rows = harness.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_messages WHERE to_agent LIKE 'mupot-%'").get() as { n: number }
    expect(rows.n).toBe(0)
    harness.close()
  })

  it('an unknown ref still collapses to send_target_not_visible for non-admin', async () => {
    const { harness, env } = setup()
    for (const ref of ['no-such-agent', 'central-command', 'mupot-unregistered']) {
      const res = await sendToRef(env, { fromAgent: 'a1', fromMember: 'm1', toRef: ref, body: 'x' }, { isAdmin: false, grants: [] })
      expect(res.ok === false && res.reason).toBe('send_target_not_visible')
    }
    harness.close()
  })
})
