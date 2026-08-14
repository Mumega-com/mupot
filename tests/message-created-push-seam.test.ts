// tests/message-created-push-seam.test.ts — the message.created push seam (mumega-com#970).
//
// Real SQLite, whole committed migration chain via applyAllMigrations (the #684 ratchet,
// scripts/check-test-schema-source.mjs). A hand-rolled `prepare()` stand-in would let these
// tests pass while naming a column that does not exist — and the point of this seam is that
// exactly one event accompanies exactly one LANDED row, which is a claim about real inserts
// hitting real constraints (the 0032 partial unique index, the unread cap). A fake engine
// cannot contradict that claim, so it cannot support it either.
//
// WHAT IS BEING PROVEN: an inbox poll is unnecessary because a send that LANDS always emits,
// and a send that does NOT land never emits. Both halves matter. An emitter that fires on a
// refused send trains a consumer to act on messages that are not there; one that misses a
// landed send leaves the poll it was meant to replace load-bearing.

import { describe, expect, it, vi } from 'vitest'

import { sendAgentMessage, MAX_UNREAD_PER_RECIPIENT } from '../src/agents/messages'
import type { Env, BusEvent, MessageCreatedPayload } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const T0 = '2026-08-14T03:00:00.000Z'
const AUTHZ = { system: true, reason: 'test: exercises sendAgentMessage primitive directly' } as const

function fixture(opts: { emit?: (e: BusEvent) => Promise<void> } = {}) {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad Alpha');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('agent-a', 'squad-a', 'agent-a', 'Agent Alpha', 'operator', 'test', 'active'),
      ('agent-b', 'squad-a', 'agent-b', 'Agent Beta', 'operator', 'test', 'active');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('owner', 'owner@pot.test', 'Owner', 'active', 'tenant-a');
  `)

  const emitted: BusEvent[] = []
  // A Queue-shaped stub. env.BUS.send is what createBus().emit() forwards to.
  const BUS = {
    send: vi.fn(async (e: BusEvent) => {
      if (opts.emit) await opts.emit(e)
      emitted.push(e)
    }),
  }

  const env = { TENANT_SLUG: 'tenant-a', DB: harness.db, BUS } as unknown as Env
  const clock = { now: () => T0, idGen: (() => { let n = 0; return () => `msg-${++n}` })() }

  const send = (over: Partial<Parameters<typeof sendAgentMessage>[1]> = {}, o: object = {}) =>
    sendAgentMessage(env, {
      fromAgent: 'agent-b', fromMember: 'owner', toAgent: 'agent-a',
      body: 'hello', kind: 'request', ...over,
    } as Parameters<typeof sendAgentMessage>[1], AUTHZ, { ...clock, ...o })

  return { harness, env, BUS, emitted, send }
}

describe('message.created — the push seam (mumega-com#970)', () => {
  it('emits exactly one event when a message LANDS, carrying the correlation a consumer needs', async () => {
    const { send, emitted } = fixture()

    const res = await send({ requestId: 'rid-1', inReplyTo: 'earlier-msg' })
    expect(res.ok).toBe(true)

    expect(emitted).toHaveLength(1)
    const ev = emitted[0]
    expect(ev.type).toBe('message.created')
    expect(ev.tenant).toBe('tenant-a')
    // Routing: the event is addressed to the RECIPIENT, attributed to the SENDER.
    expect(ev.agent_id).toBe('agent-a')
    expect(ev.actor).toEqual({ kind: 'agent', id: 'agent-b' })

    const p = ev.payload as MessageCreatedPayload
    expect(p.to_agent).toBe('agent-a')
    expect(p.from_agent).toBe('agent-b')
    expect(p.from_member).toBe('owner')
    expect(p.kind).toBe('request')
    // ACK correlation and threading survive the hop — without these a consumer cannot
    // answer a request or thread a reply without reading the inbox first, which is the
    // poll this seam exists to remove.
    expect(p.request_id).toBe('rid-1')
    expect(p.in_reply_to).toBe('earlier-msg')
    // The event must describe the SAME row the caller was told about. Asserting the
    // identity pair against the send result — rather than a magic value — keeps this
    // honest: `seq` derives from meta.last_row_id, which the SQLite harness reports as 0
    // for this INSERT…SELECT form, so `> 0` would assert the harness, not the contract.
    expect(p.message_id).toBe((res as { id: string }).id)
    expect(p.seq).toBe((res as { seq: number }).seq)
  })

  it('carries NO message body — the event is a notification, not a second read path', async () => {
    const { send, emitted } = fixture()
    await send({ body: 'SECRET-BODY-MUST-NOT-RIDE-THE-BUS' })

    expect(emitted).toHaveLength(1)
    // Reading a message stays behind the authorized inbox path. If the body travelled on
    // the bus, any queue subscriber would become a weaker copy of the tenant/project
    // authorization surface — the authenticated-≠-authorized shape (FLIGHT-001).
    expect(JSON.stringify(emitted[0])).not.toContain('SECRET-BODY-MUST-NOT-RIDE-THE-BUS')
  })

  it('does NOT emit for an idempotent duplicate — one landed row, one event', async () => {
    const { send, emitted } = fixture()

    const first = await send({ requestId: 'rid-dup' })
    const second = await send({ requestId: 'rid-dup' })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect((second as { duplicate: boolean }).duplicate).toBe(true)
    // The second send returned the ORIGINAL message; no new row landed, so no new event.
    // MUTATION: move the emit above the duplicate return in sendAgentMessage -> RED.
    expect(emitted).toHaveLength(1)
  })

  it('does NOT emit when the unread cap refuses the send', async () => {
    const { send, emitted, harness } = fixture()
    // Fill the recipient's inbox to the cap the send path enforces.
    harness.sqlite.exec(`
      INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, created_at)
      VALUES ('full-1', 'tenant-a', 'agent-a', 'agent-b', 'owner', 'message', 'x', '${T0}');
    `)

    const res = await send({}, { maxUnread: 1 })

    expect(res.ok).toBe(false)
    expect((res as { reason: string }).reason).toBe('inbox_full')
    // Nothing landed, so nothing is announced. An event here would tell a consumer to
    // activate on a message that does not exist.
    // MUTATION: emit before the changes===0 branch -> RED.
    expect(emitted).toHaveLength(0)
    expect(MAX_UNREAD_PER_RECIPIENT).toBeGreaterThan(0)
  })

  it('a failing emit does NOT fail the send — the message is already committed', async () => {
    const errs: unknown[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a) })
    const { send, harness } = fixture({
      emit: async () => { throw new Error('queue unavailable') },
    })

    const res = await send({ requestId: 'rid-emit-fail' })

    // Fail-open is deliberate: the row is in D1 before the emit runs. Rolling back a
    // DELIVERED message because a notification failed would be strictly worse than a
    // missed notification — the inbox remains the source of truth.
    expect(res.ok).toBe(true)
    const row = harness.sqlite.prepare(
      `SELECT id FROM agent_messages WHERE request_id = ?`,
    ).get('rid-emit-fail')
    expect(row).toBeTruthy()

    // ...but it is LOUD, not swallowed. A silent emit failure would recreate the exact
    // defect this seam removes: something that looks delivered and is not.
    expect(errs.length).toBeGreaterThan(0)
    expect(JSON.stringify(errs)).toContain('message.created')
    spy.mockRestore()
  })
})
