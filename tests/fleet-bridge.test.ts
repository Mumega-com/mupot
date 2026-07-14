// tests/fleet-bridge.test.ts — dispatch → external-runtime inbox delivery primitive (S353 v2).
//
// deliverDispatchToInbox / dispatchInboxDelivered (src/bus/fleet-bridge.ts) are the pure
// delivery + sticky-marker primitives the consumer's route decision (src/bus/consumer.ts) is
// built on. This module does NOT decide the route (that regressed to v1's BLOCK-2 bug) — these
// tests exercise it in isolation. Faithful in-memory D1 for agent_messages (mirrors the real SQL
// semantics — auto seq, UNIQUE(tenant, from_agent, request_id), atomic unread cap) so
// deliverDispatchToInbox runs against the REAL sendAgentMessage, not a mock of it.

import { describe, it, expect } from 'vitest'
import { deliverDispatchToInbox, dispatchInboxDelivered, dispatchInboxRequestId, DISPATCH_BRIDGE_SENDER, InboxFullError } from '../src/bus/fleet-bridge'
import type { Env } from '../src/types'

interface MsgRow {
  seq: number
  id: string
  tenant: string
  to_agent: string
  from_agent: string
  from_member: string
  kind: string
  body: string
  request_id: string | null
  created_at: string
  read_at: string | null
}

function makeDb(opts: { forceInsertError?: boolean; prefillUnread?: number } = {}) {
  const messages: MsgRow[] = []
  let seqCounter = 0
  if (opts.prefillUnread) {
    for (let i = 0; i < opts.prefillUnread; i++) {
      seqCounter++
      messages.push({
        seq: seqCounter, id: `pre-${i}`, tenant: 't', to_agent: 'hermes-mac', from_agent: 'someone-else',
        from_member: 'm', kind: 'message', body: 'x', request_id: null,
        created_at: '2026-07-14T00:00:00.000Z', read_at: null,
      })
    }
  }

  function runFirst(sql: string, b: unknown[]) {
    // Shared by sendAgentMessage's findBySenderRequestId AND dispatchInboxDelivered — both
    // query the same (tenant, from_agent, request_id) triple; callers only read `!!row` or the
    // message-shaped fields, so one handler serves both.
    if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
      const [tenant, fromAgent, requestId] = b as [string, string, string]
      const m = messages.find((x) => x.tenant === tenant && x.from_agent === fromAgent && x.request_id === requestId)
      return m ? { id: m.id, seq: m.seq, to_agent: m.to_agent, kind: m.kind, body: m.body, in_reply_to: null } : null
    }
    throw new Error('unhandled first sql: ' + sql)
  }

  function runRun(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO agent_messages')) {
      if (opts.forceInsertError) throw new Error('D1_ERROR: simulated write failure')
      const [id, tenant, to_agent, from_agent, from_member, kind, body, request_id, , created_at, maxUnread] =
        b as [string, string, string, string, string, string, string, string | null, string | null, string, number]
      const unread = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
      if (typeof maxUnread === 'number' && unread >= maxUnread) return { meta: { changes: 0 } }
      if (request_id != null && messages.some((m) => m.tenant === tenant && m.from_agent === from_agent && m.request_id === request_id)) {
        throw new Error('UNIQUE constraint failed: idx_agent_messages_rid')
      }
      const seq = ++seqCounter
      messages.push({ seq, id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at, read_at: null })
      return { meta: { last_row_id: seq, changes: 1 } }
    }
    throw new Error('unhandled run sql: ' + sql)
  }

  return {
    _messages: messages,
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) { binds.push(...a); return api },
        async first<T>() { return runFirst(sql, binds) as T },
        async run() { return runRun(sql, binds) },
      }
      return api
    },
  }
}

function envWith(db: ReturnType<typeof makeDb>, tenant = 't'): Env {
  return { TENANT_SLUG: tenant, DB: db } as unknown as Env
}

const baseInput = {
  agentId: 'hermes-mac',
  squadId: 'squad-1',
  taskId: 'task-1',
  receiptId: 'receipt-1',
  dispatchedByMemberId: 'member-1',
}

describe('dispatchInboxRequestId', () => {
  it('is a stable, single-source idempotency key', () => {
    expect(dispatchInboxRequestId('receipt-1')).toBe('dispatch-inbox:receipt-1')
  })
})

describe('deliverDispatchToInbox', () => {
  it('writes an inbox message addressed to the agent, tagged with the dispatch-bridge sender', async () => {
    const db = makeDb()
    const res = await deliverDispatchToInbox(envWith(db), baseInput)
    expect(res).toEqual({ delivered: true, seq: 1, duplicate: false })
    expect(db._messages).toHaveLength(1)
    const row = db._messages[0]
    expect(row.tenant).toBe('t')
    expect(row.to_agent).toBe('hermes-mac')
    expect(row.from_agent).toBe(DISPATCH_BRIDGE_SENDER)
    expect(row.from_member).toBe('member-1')
    expect(row.kind).toBe('request')
    expect(row.request_id).toBe('dispatch-inbox:receipt-1')
    const body = JSON.parse(row.body) as Record<string, unknown>
    expect(body).toEqual({
      type: 'task_dispatch',
      task_id: 'task-1',
      dispatch_receipt_id: 'receipt-1',
      squad_id: 'squad-1',
    })
  })

  it('a redelivery with the same receipt is an idempotent no-op (exactly one message)', async () => {
    const db = makeDb()
    const env = envWith(db)
    const first = await deliverDispatchToInbox(env, baseInput)
    const redelivered = await deliverDispatchToInbox(env, baseInput)
    expect(first).toEqual({ delivered: true, seq: 1, duplicate: false })
    expect(redelivered).toEqual({ delivered: true, seq: 1, duplicate: true })
    expect(db._messages).toHaveLength(1)
  })

  it('a different task/receipt is NOT collapsed into the same idempotency key', async () => {
    const db = makeDb()
    const env = envWith(db)
    await deliverDispatchToInbox(env, baseInput)
    await deliverDispatchToInbox(env, { ...baseInput, taskId: 'task-2', receiptId: 'receipt-2' })
    expect(db._messages).toHaveLength(2)
  })

  it('throws a plain Error (not InboxFullError) on a genuine write failure', async () => {
    const db = makeDb({ forceInsertError: true })
    await expect(deliverDispatchToInbox(envWith(db), baseInput)).rejects.toThrow(/fleet-bridge: inbox delivery failed/)
    await expect(deliverDispatchToInbox(envWith(db), baseInput)).rejects.not.toBeInstanceOf(InboxFullError)
    expect(db._messages).toHaveLength(0)
  })

  it('throws InboxFullError (distinct class) when the recipient is at the unread cap — WARN-2', async () => {
    const db = makeDb({ prefillUnread: 1000 })
    await expect(deliverDispatchToInbox(envWith(db), baseInput)).rejects.toBeInstanceOf(InboxFullError)
    expect(db._messages).toHaveLength(1000) // no new row landed
  })

  it('writes under env.TENANT_SLUG, never a caller-supplied value (no tenant field exists on the input)', async () => {
    const db = makeDb()
    await deliverDispatchToInbox(envWith(db, 'tenant-b'), baseInput)
    expect(db._messages).toHaveLength(1)
    expect(db._messages[0].tenant).toBe('tenant-b')
  })
})

describe('dispatchInboxDelivered — sticky-route marker', () => {
  it('is false before any delivery', async () => {
    const db = makeDb()
    expect(await dispatchInboxDelivered(envWith(db), 'receipt-1')).toBe(false)
  })

  it('is true after a successful delivery for that receipt', async () => {
    const db = makeDb()
    const env = envWith(db)
    await deliverDispatchToInbox(env, baseInput)
    expect(await dispatchInboxDelivered(env, 'receipt-1')).toBe(true)
  })

  it('is scoped to the exact receipt — a different receipt is still false', async () => {
    const db = makeDb()
    const env = envWith(db)
    await deliverDispatchToInbox(env, baseInput)
    expect(await dispatchInboxDelivered(env, 'receipt-other')).toBe(false)
  })

  it('is tenant-scoped: a delivery in one tenant is invisible when checked under another', async () => {
    const db = makeDb()
    await deliverDispatchToInbox(envWith(db, 'tenant-a'), baseInput)
    expect(await dispatchInboxDelivered(envWith(db, 'tenant-a'), 'receipt-1')).toBe(true)
    expect(await dispatchInboxDelivered(envWith(db, 'tenant-b'), 'receipt-1')).toBe(false)
  })

  it('survives a failed delivery attempt not landing (stays false)', async () => {
    const db = makeDb({ forceInsertError: true })
    const env = envWith(db)
    await expect(deliverDispatchToInbox(env, baseInput)).rejects.toThrow()
    expect(await dispatchInboxDelivered(env, 'receipt-1')).toBe(false)
  })
})
