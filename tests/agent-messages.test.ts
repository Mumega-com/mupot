// tests/agent-messages.test.ts — agent↔agent durable inbox (squad → mupot migration, S3).
// Service (send/inbox) + the send/inbox MCP tools. Uses a FAITHFUL in-memory D1 that mirrors
// the real SQL semantics (auto seq, UNIQUE(tenant,request_id), consume-once, agents resolve).

import { describe, it, expect } from 'vitest'
import { sendAgentMessage, readAgentInbox } from '../src/agents/messages'
import { TOOLS } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

// ── faithful in-memory D1 ─────────────────────────────────────────────────────────────────
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
  in_reply_to: string | null
  created_at: string
  read_at: string | null
}

function makeDb(opts: { agents?: Array<{ id: string; squad_id: string; slug: string; name: string }> } = {}) {
  const messages: MsgRow[] = []
  const agents = opts.agents ?? []
  let seqCounter = 0

  function runRun(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO agent_messages')) {
      const [id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, maxUnread] =
        b as [string, string, string, string, string, string, string, string | null, string | null, string, number]
      // atomic cap guard — the real INSERT…SELECT…WHERE (unread count) < cap. At cap → 0 rows.
      const unread = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
      if (typeof maxUnread === 'number' && unread >= maxUnread) {
        return { meta: { changes: 0 } }
      }
      if (
        request_id != null &&
        messages.some((m) => m.tenant === tenant && m.from_agent === from_agent && m.request_id === request_id)
      ) {
        throw new Error('UNIQUE constraint failed: idx_agent_messages_rid')
      }
      const seq = ++seqCounter
      messages.push({ seq, id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, read_at: null })
      return { meta: { last_row_id: seq, changes: 1 } }
    }
    throw new Error('unhandled run sql: ' + sql)
  }

  function runFirst(sql: string, b: unknown[]) {
    if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
      const [tenant, from_agent, request_id] = b as [string, string, string]
      const m = messages.find(
        (x) => x.tenant === tenant && x.from_agent === from_agent && x.request_id === request_id,
      )
      return m
        ? { id: m.id, seq: m.seq, to_agent: m.to_agent, kind: m.kind, body: m.body, in_reply_to: m.in_reply_to }
        : null
    }
    if (sql.includes('COUNT(*) AS n FROM agent_messages')) {
      const [tenant, to_agent] = b as [string, string]
      const n = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
      return { n }
    }
    if (sql.includes('FROM agents WHERE id = ?1 LIMIT 1')) {
      const [ref] = b as [string]
      return agents.find((a) => a.id === ref) ?? null
    }
    throw new Error('unhandled first sql: ' + sql)
  }

  function runAll(sql: string, b: unknown[]) {
    if (sql.includes('UPDATE agent_messages SET read_at')) {
      const [readAt, tenant, to_agent, limit] = b as [string, string, string, number]
      const claimed = messages
        .filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null)
        .sort((x, y) => x.seq - y.seq)
        .slice(0, limit)
      for (const m of claimed) m.read_at = readAt
      // RETURNING order is unspecified — shuffle to prove the service re-sorts by seq.
      return claimed.slice().reverse().map((m) => ({ ...m }))
    }
    if (sql.includes('FROM agent_messages') && sql.includes('read_at IS NULL') && sql.includes('ORDER BY seq ASC')) {
      const [tenant, to_agent, limit] = b as [string, string, number]
      return messages
        .filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null)
        .sort((x, y) => x.seq - y.seq)
        .slice(0, limit)
        .map((m) => ({ ...m }))
    }
    if (sql.includes('FROM agents WHERE slug = ?1')) {
      const [ref] = b as [string]
      return agents.filter((a) => a.slug === ref)
    }
    throw new Error('unhandled all sql: ' + sql)
  }

  const db = {
    _messages: messages,
    prepare(sql: string) {
      const binds: unknown[] = []
      const api = {
        bind(...a: unknown[]) {
          binds.push(...a)
          return api
        },
        async first<T>() {
          return runFirst(sql, binds) as T
        },
        async all<T>() {
          return { results: runAll(sql, binds) as T[] }
        },
        async run() {
          return runRun(sql, binds)
        },
      }
      return api
    },
  }
  return db
}

function envWith(db: ReturnType<typeof makeDb>, tenant: string = 't'): Env {
  return { TENANT_SLUG: tenant, DB: db } as unknown as Env
}
// Explicit no-tenant env (a defaulted param would swallow `undefined` back to 't').
function envNoTenant(db: ReturnType<typeof makeDb>): Env {
  return { DB: db } as unknown as Env
}

const fixedClock = { now: () => '2026-06-19T12:00:00.000Z', idGen: (() => { let n = 0; return () => `id-${++n}` })() }

// ── service: send ─────────────────────────────────────────────────────────────────────────
describe('sendAgentMessage', () => {
  it('persists a message, tenant/sender stamped, returns seq', async () => {
    const db = makeDb()
    const r = await sendAgentMessage(envWith(db), { fromAgent: 'ag-code', fromMember: 'm1', toAgent: 'ag-review', body: 'build G64b' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.seq).toBe(1)
    expect(r.duplicate).toBe(false)
    const row = db._messages[0]
    expect(row.tenant).toBe('t')
    expect(row.to_agent).toBe('ag-review')
    expect(row.from_agent).toBe('ag-code')
    expect(row.from_member).toBe('m1')
    expect(row.kind).toBe('message')
  })

  it('replay-once: same request_id is an idempotent no-op (no second row)', async () => {
    const db = makeDb()
    const env = envWith(db)
    // identical content + same sender + same rid = a true idempotent replay (e.g. a retry).
    const msg = { fromAgent: 'ag-code', fromMember: 'm1', toAgent: 'ag-review', body: 'x', requestId: 'rid-1' }
    const a = await sendAgentMessage(env, msg)
    const b = await sendAgentMessage(env, msg)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.duplicate).toBe(true)
    expect(b.id).toBe(a.id)
    expect(b.seq).toBe(a.seq)
    expect(db._messages.length).toBe(1)
  })

  it('replay-once is SENDER-SCOPED — a different sender reusing the same rid is NOT a collision', async () => {
    const db = makeDb()
    const env = envWith(db)
    // ag-a and ag-b both pick request_id 'rid-x' addressed to ag-x. Neither must suppress the other.
    const a = await sendAgentMessage(env, { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'from A', requestId: 'rid-x' })
    const b = await sendAgentMessage(env, { fromAgent: 'ag-b', fromMember: 'm', toAgent: 'ag-x', body: 'from B', requestId: 'rid-x' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.duplicate).toBe(false) // ag-b's send is NOT swallowed by ag-a's rid
    expect(db._messages.length).toBe(2)
    expect(db._messages.map((m) => m.body).sort()).toEqual(['from A', 'from B'])
  })

  it('an agent CANNOT pre-seed an rid to silently drop another agent‘s later send (anti-poison)', async () => {
    const db = makeDb()
    const env = envWith(db)
    // attacker ag-evil pre-seeds rid 'shared' to ag-victim-inbox
    await sendAgentMessage(env, { fromAgent: 'ag-evil', fromMember: 'm', toAgent: 'ag-x', body: 'poison', requestId: 'shared' })
    // honest ag-good sends with the same rid string — must land, NOT return the attacker's row
    const good = await sendAgentMessage(env, { fromAgent: 'ag-good', fromMember: 'm', toAgent: 'ag-x', body: 'real message', requestId: 'shared' })
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.duplicate).toBe(false)
    const inbox = await readAgentInbox(env, { agent: 'ag-x' })
    if (!inbox.ok) return
    expect(inbox.messages.map((m) => m.body)).toContain('real message') // not silently dropped
  })

  it('same sender + same rid + DIFFERENT content → request_id_conflict (never a silent success)', async () => {
    const db = makeDb()
    const env = envWith(db)
    const first = await sendAgentMessage(env, { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'v1', requestId: 'r1' })
    const reused = await sendAgentMessage(env, { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'v2-different', requestId: 'r1' })
    expect(first.ok).toBe(true)
    expect(reused.ok).toBe(false)
    if (reused.ok) return
    expect(reused.reason).toBe('request_id_conflict')
    expect(db._messages.length).toBe(1) // the conflicting second send did NOT persist
  })

  it('same sender + same rid + SAME content → idempotent duplicate', async () => {
    const env = envWith(makeDb())
    const base = { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'same', requestId: 'r2', kind: 'request' as const, inReplyTo: undefined }
    const a = await sendAgentMessage(env, base)
    const b = await sendAgentMessage(env, base)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.duplicate).toBe(true)
    expect(b.seq).toBe(a.seq)
  })

  it('per-recipient unread cap refuses spam (inbox_full); a read frees the budget', async () => {
    const db = makeDb()
    const env = envWith(db)
    const send = (body: string) => sendAgentMessage(env, { fromAgent: 'ag-spammer', fromMember: 'm', toAgent: 'ag-x', body }, { maxUnread: 2 })
    expect((await send('1')).ok).toBe(true)
    expect((await send('2')).ok).toBe(true)
    const third = await send('3')
    expect(third.ok).toBe(false)
    if (third.ok) return
    expect(third.reason).toBe('inbox_full')
    expect(db._messages.length).toBe(2) // the capped send did NOT persist (atomic guard)
    // consume one → budget frees → next send accepted
    await readAgentInbox(env, { agent: 'ag-x', limit: 1 })
    expect((await send('4')).ok).toBe(true)
  })

  it('fail-closed without a tenant', async () => {
    const r = await sendAgentMessage(envNoTenant(makeDb()), { fromAgent: 'a', fromMember: 'm', toAgent: 'b', body: 'x' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('no_tenant')
  })

  it.each([
    ['empty body', { body: '' }, 'invalid_body'],
    ['oversized body', { body: 'x'.repeat(8001) }, 'invalid_body'],
    ['bad kind', { kind: 'shout' as unknown as 'message' }, 'invalid_kind'],
    ['bad request_id', { requestId: 'has space' }, 'invalid_request_id'],
    ['bad in_reply_to', { inReplyTo: 'has space' }, 'invalid_in_reply_to'],
    ['empty to', { toAgent: '' }, 'invalid_to'],
    ['empty from', { fromAgent: '' }, 'invalid_from'],
  ])('validation rejects %s', async (_l, patch, reason) => {
    const base = { fromAgent: 'a', fromMember: 'm', toAgent: 'b', body: 'ok' }
    const r = await sendAgentMessage(envWith(makeDb()), { ...base, ...(patch as object) })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe(reason)
  })

  it('accepts request/ack kinds + in_reply_to', async () => {
    const db = makeDb()
    const env = envWith(db)
    const req = await sendAgentMessage(env, { fromAgent: 'a', fromMember: 'm', toAgent: 'b', body: 'do X', kind: 'request', requestId: 'q1' })
    const ack = await sendAgentMessage(env, { fromAgent: 'b', fromMember: 'm', toAgent: 'a', body: 'done', kind: 'ack', inReplyTo: 'q1' })
    expect(req.ok && ack.ok).toBe(true)
    expect(db._messages[1].kind).toBe('ack')
    expect(db._messages[1].in_reply_to).toBe('q1')
  })
})

// ── service: inbox ────────────────────────────────────────────────────────────────────────
describe('readAgentInbox', () => {
  async function seed(env: Env, to: string, bodies: string[]) {
    for (const body of bodies) await sendAgentMessage(env, { fromAgent: 'ag-code', fromMember: 'm1', toAgent: to, body }, fixedClock)
  }

  it('consumes oldest-first, ordered by seq, then empty', async () => {
    const db = makeDb()
    const env = envWith(db)
    await seed(env, 'ag-review', ['one', 'two', 'three'])
    const first = await readAgentInbox(env, { agent: 'ag-review' })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.messages.map((m) => m.body)).toEqual(['one', 'two', 'three'])
    expect(first.messages.map((m) => m.seq)).toEqual([1, 2, 3]) // ascending despite shuffled RETURNING
    expect(first.remaining).toBe(0)
    const second = await readAgentInbox(env, { agent: 'ag-review' })
    if (!second.ok) return
    expect(second.messages.length).toBe(0) // consumed once
  })

  it('peek does NOT consume', async () => {
    const db = makeDb()
    const env = envWith(db)
    await seed(env, 'ag-review', ['a', 'b'])
    const p1 = await readAgentInbox(env, { agent: 'ag-review', peek: true })
    const p2 = await readAgentInbox(env, { agent: 'ag-review', peek: true })
    expect(p1.ok && p2.ok).toBe(true)
    if (!p1.ok || !p2.ok) return
    expect(p1.messages.length).toBe(2)
    expect(p2.messages.length).toBe(2) // still there
  })

  it('limit caps the batch; remaining reports the rest', async () => {
    const db = makeDb()
    const env = envWith(db)
    await seed(env, 'ag-review', ['1', '2', '3', '4', '5'])
    const batch = await readAgentInbox(env, { agent: 'ag-review', limit: 2 })
    if (!batch.ok) return
    expect(batch.messages.map((m) => m.body)).toEqual(['1', '2'])
    expect(batch.remaining).toBe(3)
    const next = await readAgentInbox(env, { agent: 'ag-review', limit: 2 })
    if (!next.ok) return
    expect(next.messages.map((m) => m.body)).toEqual(['3', '4'])
  })

  it('isolates inboxes — an agent never sees another agent‘s messages', async () => {
    const db = makeDb()
    const env = envWith(db)
    await seed(env, 'ag-a', ['for A'])
    await seed(env, 'ag-b', ['for B1', 'for B2'])
    const a = await readAgentInbox(env, { agent: 'ag-a' })
    if (!a.ok) return
    expect(a.messages.map((m) => m.body)).toEqual(['for A'])
  })

  it('fail-closed: no tenant / bad agent / bad limit', async () => {
    const db = makeDb()
    const noTenant = await readAgentInbox(envNoTenant(db), { agent: 'x' })
    expect(noTenant.ok).toBe(false)
    const badAgent = await readAgentInbox(envWith(db), { agent: '' })
    expect(badAgent.ok).toBe(false)
    const badLimit = await readAgentInbox(envWith(db), { agent: 'x', limit: Number.NaN })
    expect(badLimit.ok).toBe(false)
    if (badLimit.ok) return
    expect(badLimit.reason).toBe('invalid_limit')
  })
})

// ── the send/inbox MCP tools ────────────────────────────────────────────────────────────────
const toolSend = TOOLS.find((t) => t.name === 'send')!
const toolInbox = TOOLS.find((t) => t.name === 'inbox')!
const CTX = { origin: 'https://pot.test' }

function auth(boundAgentId: string | null): AuthContext {
  return { userId: 'u1', email: 'a@b.com', role: 'member', tenant: 't', memberId: 'm1', capabilities: [], boundAgentId } as AuthContext
}

describe('send / inbox tools', () => {
  const agents = [{ id: 'ag-review', squad_id: 's1', slug: 'review', name: 'Review' }]

  it('registered in TOOLS', () => {
    expect(toolSend).toBeTruthy()
    expect(toolInbox).toBeTruthy()
  })

  it('send: a non-agent-bound token is refused (403)', async () => {
    const r = await toolSend.run(auth(null), envWith(makeDb({ agents })), { to: 'ag-review', body: 'hi' }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(403)
    expect(r.error).toBe('not_agent_bound')
  })

  it('send: unknown recipient → 404', async () => {
    const r = await toolSend.run(auth('ag-code'), envWith(makeDb({ agents })), { to: 'nobody', body: 'hi' }, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(404)
  })

  it('send: happy path resolves recipient + persists', async () => {
    const db = makeDb({ agents })
    const r = await toolSend.run(auth('ag-code'), envWith(db), { to: 'review', body: 'build it' }, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect((r.result as { to: string }).to).toBe('ag-review')
    expect(db._messages[0].from_agent).toBe('ag-code')
  })

  it('inbox: a non-agent-bound token is refused (403)', async () => {
    const r = await toolInbox.run(auth(null), envWith(makeDb()), {}, CTX)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.status).toBe(403)
  })

  it('inbox: caller reads its OWN welded inbox', async () => {
    const db = makeDb({ agents })
    const env = envWith(db)
    await toolSend.run(auth('ag-code'), env, { to: 'review', body: 'for review' }, CTX)
    const r = await toolInbox.run(auth('ag-review'), env, {}, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as { messages: Array<{ body: string }>; consumed: boolean }
    expect(res.messages.map((m) => m.body)).toEqual(['for review'])
    expect(res.consumed).toBe(true)
  })
})
