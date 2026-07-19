// tests/agent-messages.test.ts — agent↔agent durable inbox (squad → mupot migration, S3).
// Service (send/inbox) + the send/inbox MCP tools. Uses a FAITHFUL in-memory D1 that mirrors
// the real SQL semantics (auto seq, UNIQUE(tenant,request_id), consume-once, agents resolve).

import { describe, it, expect } from 'vitest'
import { sendAgentMessage, readAgentInbox } from '../src/agents/messages'
import { TOOLS } from '../src/mcp/index'
import type { Env, AuthContext, CapabilityGrant } from '../src/types'

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

function makeDb(
  opts: {
    agents?: Array<{ id: string; squad_id: string; slug: string; name: string }>
    /** Force the first N findBySenderRequestId lookups to MISS — simulates the race where a
     *  concurrent writer's row isn't visible to the pre-check but exists by re-check time. */
    missDedupCalls?: number
    signedOnlyAgents?: string[]
    activeKeyAgents?: string[]
    /** squad_id -> department_id, for canOnSquad's department-inheritance lookup (gate 1). */
    squadDepartments?: Record<string, string | null>
  } = {},
) {
  const messages: MsgRow[] = []
  const agents = opts.agents ?? []
  const signedOnlyAgents = new Set(opts.signedOnlyAgents ?? [])
  const fences = new Map<string, {
    mode: 'bearer_only' | 'signed_only'; generation: number; key_fingerprint: string | null; updated_at: string
  }>([...signedOnlyAgents].map((agent) => [agent, {
    mode: 'signed_only', generation: 1, key_fingerprint: 'f'.repeat(64), updated_at: '2026-06-19T12:00:00.000Z',
  }]))
  const activeKeyAgents = new Set(opts.activeKeyAgents ?? [])
  let missLeft = opts.missDedupCalls ?? 0
  let seqCounter = 0

  function runRun(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO agent_inbox_fences')) {
      const [, agent, mode, keyFingerprint, , updatedAt, , expectedGeneration] = b as [
        string, string, 'bearer_only' | 'signed_only', string | null, string, string, string, number,
      ]
      const prior = fences.get(agent)
      if ((prior?.generation ?? 0) !== expectedGeneration) return { meta: { changes: 0 } }
      fences.set(agent, {
        mode, generation: (prior?.generation ?? 0) + 1, key_fingerprint: keyFingerprint, updated_at: updatedAt,
      })
      return { meta: { changes: 1 } }
    }
    if (sql.includes('DELETE FROM agent_inbox_fences')) {
      const [, agent] = b as [string, string]
      const changes = fences.delete(agent) ? 1 : 0
      return { meta: { changes } }
    }
    if (sql.includes('UPDATE agent_inbox_fences') && sql.includes("mode = 'bearer_only'")) {
      const [, agent, updatedAt] = b as [string, string, string, string]
      const prior = fences.get(agent)
      fences.set(agent, {
        mode: 'bearer_only', generation: (prior?.generation ?? 0) + 1, key_fingerprint: null, updated_at: updatedAt,
      })
      return { meta: { changes: 1 } }
    }
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
    if (sql.includes('FROM agent_keys k') && sql.includes('JOIN members m')) {
      const [, agent] = b as [string, string]
      return activeKeyAgents.has(agent)
        ? { pubkey: 'A'.repeat(43), algo: 'Ed25519', member_id: 'm1' }
        : null
    }
    if (/^\s*SELECT mode, generation(?:, key_fingerprint)?(?:, updated_at)? FROM agent_inbox_fences/.test(sql)) {
      const [tenant, agent] = b as [string, string]
      return tenant === 't' ? fences.get(agent) ?? null : null
    }
    if (sql.includes('from_agent = ?2 AND request_id = ?3')) {
      if (missLeft > 0) {
        missLeft--
        return null // forced pre-check miss (race simulation)
      }
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
      const effectiveMode = fences.get(to_agent)?.mode ?? 'bearer_only'
      if (!sql.includes("mode = 'signed_only'") && effectiveMode !== 'bearer_only') return { n: 0 }
      const n = messages.filter((m) => m.tenant === tenant && m.to_agent === to_agent && m.read_at === null).length
      return { n }
    }
    if (sql.includes('FROM agents WHERE id = ?1 LIMIT 1')) {
      const [ref] = b as [string]
      return agents.find((a) => a.id === ref) ?? null
    }
    if (sql.includes('SELECT department_id FROM squads WHERE id = ?1')) {
      const [squadId] = b as [string]
      const dept = (opts.squadDepartments ?? {})[squadId]
      return dept === undefined ? null : { department_id: dept }
    }
    throw new Error('unhandled first sql: ' + sql)
  }

  function runAll(sql: string, b: unknown[]) {
    if (sql.includes('INSERT INTO agent_inbox_fences')) {
      const [, agent, mode, keyFingerprint, , updatedAt, , expectedGeneration] = b as [
        string, string, 'bearer_only' | 'signed_only', string | null, string, string, string, number,
      ]
      const prior = fences.get(agent)
      if ((prior?.generation ?? 0) !== expectedGeneration) return []
      const row = {
        mode, generation: (prior?.generation ?? 0) + 1, key_fingerprint: keyFingerprint, updated_at: updatedAt,
      }
      fences.set(agent, row)
      return [row]
    }
    if (sql.includes('UPDATE agent_messages SET read_at')) {
      const [readAt, tenant, to_agent, limit] = b as [string, string, string, number]
      const effectiveMode = fences.get(to_agent)?.mode ?? 'bearer_only'
      if (!sql.includes("mode = 'signed_only'") && effectiveMode !== 'bearer_only') return []
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
      const effectiveMode = fences.get(to_agent)?.mode ?? 'bearer_only'
      if (!sql.includes("mode = 'signed_only'") && effectiveMode !== 'bearer_only') return []
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
    _fences: fences,
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

// sendAgentMessage's authz param is a compile-time forcing function only (#401 WARN
// follow-up) — this file exercises the raw primitive directly, not through sendToRef's
// confinement, so every call below asserts that plainly.
const TEST_AUTHZ = { system: true, reason: 'test: exercises sendAgentMessage primitive directly' } as const

// ── service: send ─────────────────────────────────────────────────────────────────────────
describe('sendAgentMessage', () => {
  it('persists a message, tenant/sender stamped, returns seq', async () => {
    const db = makeDb()
    const r = await sendAgentMessage(envWith(db), { fromAgent: 'ag-code', fromMember: 'm1', toAgent: 'ag-review', body: 'build G64b' }, TEST_AUTHZ)
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
    const a = await sendAgentMessage(env, msg, TEST_AUTHZ)
    const b = await sendAgentMessage(env, msg, TEST_AUTHZ)
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
    const a = await sendAgentMessage(env, { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'from A', requestId: 'rid-x' }, TEST_AUTHZ)
    const b = await sendAgentMessage(env, { fromAgent: 'ag-b', fromMember: 'm', toAgent: 'ag-x', body: 'from B', requestId: 'rid-x' }, TEST_AUTHZ)
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
    await sendAgentMessage(env, { fromAgent: 'ag-evil', fromMember: 'm', toAgent: 'ag-x', body: 'poison', requestId: 'shared' }, TEST_AUTHZ)
    // honest ag-good sends with the same rid string — must land, NOT return the attacker's row
    const good = await sendAgentMessage(env, { fromAgent: 'ag-good', fromMember: 'm', toAgent: 'ag-x', body: 'real message', requestId: 'shared' }, TEST_AUTHZ)
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
    const first = await sendAgentMessage(env, { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'v1', requestId: 'r1' }, TEST_AUTHZ)
    const reused = await sendAgentMessage(env, { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'v2-different', requestId: 'r1' }, TEST_AUTHZ)
    expect(first.ok).toBe(true)
    expect(reused.ok).toBe(false)
    if (reused.ok) return
    expect(reused.reason).toBe('request_id_conflict')
    expect(db._messages.length).toBe(1) // the conflicting second send did NOT persist
  })

  it('same sender + same rid + SAME content → idempotent duplicate', async () => {
    const env = envWith(makeDb())
    const base = { fromAgent: 'ag-a', fromMember: 'm', toAgent: 'ag-x', body: 'same', requestId: 'r2', kind: 'request' as const, inReplyTo: undefined }
    const a = await sendAgentMessage(env, base, TEST_AUTHZ)
    const b = await sendAgentMessage(env, base, TEST_AUTHZ)
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.duplicate).toBe(true)
    expect(b.seq).toBe(a.seq)
  })

  it('per-recipient unread cap refuses spam (inbox_full); a read frees the budget', async () => {
    const db = makeDb()
    const env = envWith(db)
    const send = (body: string) => sendAgentMessage(env, { fromAgent: 'ag-spammer', fromMember: 'm', toAgent: 'ag-x', body }, TEST_AUTHZ, { maxUnread: 2 })
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

  it('dedup wins over the cap: a same-rid duplicate arriving while at cap resolves as duplicate, NOT inbox_full', async () => {
    // Race: a concurrent writer already landed (rid r1, fills the cap of 1); THIS send is the
    // same (sender, rid, content) but its pre-check misses the not-yet-visible row. The cap
    // guard then refuses the insert (changes=0) — it must re-check and return the original.
    const db = makeDb({ missDedupCalls: 1 })
    db._messages.push({
      seq: 1, id: 'A', tenant: 't', to_agent: 'ag-y', from_agent: 'ag-x', from_member: 'm',
      kind: 'message', body: 'hi', request_id: 'r1', in_reply_to: null, created_at: 't0', read_at: null,
    })
    const env = envWith(db)
    const b = await sendAgentMessage(
      env,
      { fromAgent: 'ag-x', fromMember: 'm', toAgent: 'ag-y', body: 'hi', requestId: 'r1' },
      TEST_AUTHZ,
      { maxUnread: 1 },
    )
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.duplicate).toBe(true) // NOT inbox_full — the message actually landed (writer A)
    expect(b.id).toBe('A')
    expect(db._messages.length).toBe(1) // no second row
  })

  it('at cap with a NON-duplicate rid still returns inbox_full', async () => {
    const db = makeDb({ missDedupCalls: 1 }) // force the (empty) pre-check + re-check to miss
    db._messages.push({
      seq: 1, id: 'X', tenant: 't', to_agent: 'ag-y', from_agent: 'ag-other', from_member: 'm',
      kind: 'message', body: 'filler', request_id: null, in_reply_to: null, created_at: 't0', read_at: null,
    })
    const env = envWith(db)
    const r = await sendAgentMessage(
      env,
      { fromAgent: 'ag-x', fromMember: 'm', toAgent: 'ag-y', body: 'new', requestId: 'fresh' },
      TEST_AUTHZ,
      { maxUnread: 1 },
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('inbox_full')
  })

  it('fail-closed without a tenant', async () => {
    const r = await sendAgentMessage(envNoTenant(makeDb()), { fromAgent: 'a', fromMember: 'm', toAgent: 'b', body: 'x' }, TEST_AUTHZ)
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
    const r = await sendAgentMessage(envWith(makeDb()), { ...base, ...(patch as object) }, TEST_AUTHZ)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe(reason)
  })

  it('accepts request/ack kinds + in_reply_to', async () => {
    const db = makeDb()
    const env = envWith(db)
    const req = await sendAgentMessage(env, { fromAgent: 'a', fromMember: 'm', toAgent: 'b', body: 'do X', kind: 'request', requestId: 'q1' }, TEST_AUTHZ)
    const ack = await sendAgentMessage(env, { fromAgent: 'b', fromMember: 'm', toAgent: 'a', body: 'done', kind: 'ack', inReplyTo: 'q1' }, TEST_AUTHZ)
    expect(req.ok && ack.ok).toBe(true)
    expect(db._messages[1].kind).toBe('ack')
    expect(db._messages[1].in_reply_to).toBe('q1')
  })
})

// ── service: inbox ────────────────────────────────────────────────────────────────────────
describe('readAgentInbox', () => {
  async function seed(env: Env, to: string, bodies: string[]) {
    for (const body of bodies) await sendAgentMessage(env, { fromAgent: 'ag-code', fromMember: 'm1', toAgent: to, body }, TEST_AUTHZ, fixedClock)
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

  it('signed-only fence rejects bearer/MCP reads without consuming', async () => {
    const db = makeDb({ signedOnlyAgents: ['ag-review'] })
    const env = envWith(db)
    await seed(env, 'ag-review', ['fenced work'])

    const bearer = await readAgentInbox(env, { agent: 'ag-review' })
    expect(bearer).toMatchObject({ ok: false, reason: 'consumer_fenced' })
    expect(db._messages[0].read_at).toBeNull()

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
const toolInboxFenceSet = TOOLS.find((t) => t.name === 'set_agent_inbox_consumer')!
const toolInboxFenceStatus = TOOLS.find((t) => t.name === 'inbox_consumer_status')!
const CTX = { origin: 'https://pot.test' }

function auth(boundAgentId: string | null, capabilities: CapabilityGrant[] = []): AuthContext {
  return { userId: 'u1', email: 'a@b.com', role: 'member', tenant: 't', memberId: 'm1', capabilities, boundAgentId } as AuthContext
}

// Gate 1 (#392): a squad-scoped observer grant, the minimum that makes a target agent on that
// squad VISIBLE to a non-admin sender's `send`. Squad 's1' is ag-review's squad throughout
// this file's fixtures.
const OBSERVES_S1: CapabilityGrant[] = [{ member_id: 'm1', scope_type: 'squad', scope_id: 's1', capability: 'observer' }]

function ownerAuth(): AuthContext {
  return { userId: 'owner', email: 'owner@example.com', role: 'owner', tenant: 't', memberId: 'owner-member', boundAgentId: null } as AuthContext
}

describe('send / inbox tools', () => {
  const agents = [{ id: 'ag-review', squad_id: 's1', slug: 'review', name: 'Review' }]

  it('registered in TOOLS', () => {
    expect(toolSend).toBeTruthy()
    expect(toolInbox).toBeTruthy()
    expect(toolInboxFenceSet).toBeTruthy()
    expect(toolInboxFenceStatus).toBeTruthy()
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
    const db = makeDb({ agents, activeKeyAgents: ['ag-review'] })
    const r = await toolSend.run(auth('ag-code', OBSERVES_S1), envWith(db), { to: 'review', body: 'build it' }, CTX)
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
    await toolSend.run(auth('ag-code', OBSERVES_S1), env, { to: 'review', body: 'for review' }, CTX)
    const r = await toolInbox.run(auth('ag-review'), env, {}, CTX)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const res = r.result as { messages: Array<{ body: string }>; consumed: boolean }
    expect(res.messages.map((m) => m.body)).toEqual(['for review'])
    expect(res.consumed).toBe(true)
  })

  it('workspace admin fences one agent to signed-only and can reopen it', async () => {
    const db = makeDb({ agents, activeKeyAgents: ['ag-review'] })
    const env = envWith(db)
    await toolSend.run(auth('ag-code', OBSERVES_S1), env, { to: 'review', body: 'fenced task' }, CTX)

    const fenced = await toolInboxFenceSet.run(ownerAuth(), env, {
      agent: 'review', mode: 'signed_only', expected_generation: 0, reason: 'activate Kubernetes Host',
    }, CTX)
    expect(fenced, JSON.stringify(fenced)).toMatchObject({ ok: true, result: { agent_id: 'ag-review', mode: 'signed_only', generation: 1 } })
    const status = await toolInboxFenceStatus.run(auth('ag-review'), env, {}, CTX)
    expect(status).toMatchObject({ ok: true, result: { agent_id: 'ag-review', mode: 'signed_only', generation: 1 } })

    const blocked = await toolInbox.run(auth('ag-review'), env, {}, CTX)
    expect(blocked).toMatchObject({ ok: false, status: 409, error: 'consumer_fenced' })
    expect(db._messages[0].read_at).toBeNull()

    const opened = await toolInboxFenceSet.run(ownerAuth(), env, {
      agent: 'ag-review', mode: 'bearer_only', expected_generation: 1, reason: 'rollback to legacy subscriber',
    }, CTX)
    expect(opened).toMatchObject({ ok: true, result: { agent_id: 'ag-review', mode: 'bearer_only', generation: 2 } })
    expect((await toolInbox.run(auth('ag-review'), env, {}, CTX)).ok).toBe(true)

    const refenced = await toolInboxFenceSet.run(ownerAuth(), env, {
      agent: 'ag-review', mode: 'signed_only', expected_generation: 2, reason: 'reactivate Host',
    }, CTX)
    expect(refenced).toMatchObject({ ok: true, result: { mode: 'signed_only', generation: 3 } })
  })

  it('ordinary members cannot change the inbox fence', async () => {
    const result = await toolInboxFenceSet.run(auth('ag-code'), envWith(makeDb({ agents })), {
      agent: 'ag-review', mode: 'signed_only', expected_generation: 0, reason: 'unauthorized',
    }, CTX)
    expect(result).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('signed-only activation requires an active key and the expected generation', async () => {
    const env = envWith(makeDb({ agents }))
    const noKey = await toolInboxFenceSet.run(ownerAuth(), env, {
      agent: 'ag-review', mode: 'signed_only', expected_generation: 0, reason: 'activate',
    }, CTX)
    expect(noKey).toMatchObject({ ok: false, status: 409, error: 'active_agent_key_required' })

    const keyedEnv = envWith(makeDb({ agents, activeKeyAgents: ['ag-review'] }))
    const stale = await toolInboxFenceSet.run(ownerAuth(), keyedEnv, {
      agent: 'ag-review', mode: 'signed_only', expected_generation: 4, reason: 'activate',
    }, CTX)
    expect(stale).toMatchObject({ ok: false, status: 409, error: 'fence_generation_conflict' })
  })
})
