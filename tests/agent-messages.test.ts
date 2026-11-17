// tests/agent-messages.test.ts — agent↔agent durable inbox (squad → mupot migration, S3).
// Service (send/inbox) + the send/inbox MCP tools. Every fixture uses the real migration
// chain: SQL changes in messages, fences, wake audit, or capability reads must be exercised
// against the production schema rather than a SQL-matching mock.

import { afterEach, describe, it, expect } from 'vitest'
import { sendAgentMessage, readAgentInbox } from '../src/agents/messages'
import { TOOLS } from '../src/mcp/index'
import type { Env, AuthContext, CapabilityGrant } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

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

interface AgentRow {
  id: string
  squad_id: string
  slug: string
  name: string
}

interface TestDb {
  db: SqliteD1Harness['db']
  sqlite: SqliteD1Harness['sqlite']
  readonly messages: MsgRow[]
  readonly fences: Array<{ agent_id: string; mode: string; generation: number; key_fingerprint: string | null; updated_at: string }>
  readonly agents: AgentRow[]
}

const openHarnesses = new Set<SqliteD1Harness>()

afterEach(() => {
  for (const harness of openHarnesses) harness.close()
  openHarnesses.clear()
})

// ── real D1 fixture ────────────────────────────────────────────────────────────────────────
function makeDb(
  opts: {
    agents?: Array<{ id: string; squad_id: string; slug: string; name: string }>
    signedOnlyAgents?: string[]
    activeKeyAgents?: string[]
    /** squad_id -> department_id, for canOnSquad's department-inheritance lookup (gate 1). */
    squadDepartments?: Record<string, string | null>
  } = {},
) {
  const harness = createSqliteD1()
  openHarnesses.add(harness)
  applyAllMigrations(harness.sqlite)
  const sqlite = harness.sqlite
  sqlite.prepare(`INSERT INTO members (id, tenant, display_name, status, created_at) VALUES ('m1', 't', 'Member One', 'active', datetime('now'))`).run()
  sqlite.prepare(`INSERT INTO members (id, tenant, display_name, status, created_at) VALUES ('owner-member', 't', 'Owner', 'active', datetime('now'))`).run()

  const departments = new Set<string>()
  const squads = new Set<string>()
  const agentIds = new Set<string>()
  const squadDepartments = opts.squadDepartments ?? {}
  const fixtureAgents: AgentRow[] = [
    ...(opts.agents ?? []),
    ...[...(opts.activeKeyAgents ?? []), ...(opts.signedOnlyAgents ?? [])]
      .filter((id) => !(opts.agents ?? []).some((agent) => agent.id === id))
      .map((id) => ({ id, squad_id: 'fixture-squad', slug: id, name: id })),
  ]
  for (const agent of fixtureAgents) {
    const departmentId = squadDepartments[agent.squad_id] ?? `dept-${agent.squad_id}`
    if (!departments.has(departmentId)) {
      sqlite.prepare(`INSERT INTO departments (id, slug, name) VALUES (?1, ?2, ?3)`).run(departmentId, departmentId, departmentId)
      departments.add(departmentId)
    }
    if (!squads.has(agent.squad_id)) {
      sqlite.prepare(`INSERT INTO squads (id, department_id, slug, name, kind) VALUES (?1, ?2, ?3, ?4, 'work')`).run(agent.squad_id, departmentId, agent.squad_id, agent.squad_id)
      squads.add(agent.squad_id)
    }
    if (!agentIds.has(agent.id)) {
      sqlite.prepare(`INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, ?3, ?4, 'member', 'test', 'active')`).run(agent.id, agent.squad_id, agent.slug, agent.name)
      agentIds.add(agent.id)
    }
  }
  for (const agent of opts.activeKeyAgents ?? []) {
    sqlite.prepare(`INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES ('t', ?1, ?2, 'Ed25519', 'm1', 0)`).run(agent, 'A'.repeat(43))
  }
  for (const agent of opts.signedOnlyAgents ?? []) {
    sqlite.prepare(`INSERT INTO agent_inbox_fences (tenant, agent_id, mode, generation, key_fingerprint, updated_by_member_id, updated_at, reason)
      VALUES ('t', ?1, 'signed_only', 1, ?2, 'owner-member', '2026-06-19T12:00:00.000Z', 'fixture')`).run(agent, 'f'.repeat(64))
  }

  return {
    db: harness.db,
    sqlite,
    get messages() {
      return sqlite.prepare(`SELECT seq, id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at, read_at FROM agent_messages ORDER BY seq`).all() as MsgRow[]
    },
    get fences() {
      return sqlite.prepare(`SELECT agent_id, mode, generation, key_fingerprint, updated_at FROM agent_inbox_fences ORDER BY agent_id`).all() as TestDb['fences']
    },
    get agents() {
      return sqlite.prepare(`SELECT id, squad_id, slug, name FROM agents ORDER BY id`).all() as AgentRow[]
    },
  }
}

function envWith(fixture: TestDb, tenant: string = 't'): Env {
  return { TENANT_SLUG: tenant, DB: fixture.db } as unknown as Env
}
// Explicit no-tenant env (a defaulted param would swallow `undefined` back to 't').
function envNoTenant(fixture: TestDb): Env {
  return { DB: fixture.db } as unknown as Env
}

const fixedClock = { now: () => '2026-06-19T12:00:00.000Z', idGen: (() => { let n = 0; return () => `id-${++n}` })() }

// sendAgentMessage's authz param is a compile-time forcing function only (#401 WARN
// follow-up) — this file exercises the raw primitive directly, not through sendToRef's
// confinement, so every call below asserts that plainly.
const TEST_AUTHZ = { system: true, reason: 'test: exercises sendAgentMessage primitive directly' } as const

// Commit a competing real SQLite write after lookup, before the next run().
// Every statement/result still comes from D1; no SQL matching or lookup stubs.
function interleaveNextRun(env:Env, effect:()=>void):void {
  const real=env.DB;let fired=false
  const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>new Proxy(stmt,{get(target,key){
    if(key==='bind') return (...args:unknown[])=>wrap(target.bind(...args))
    if(key==='run') return async()=>{if(!fired){fired=true;effect()}return target.run()}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  env.DB=new Proxy(real,{get(target,key){
    if(key==='prepare') return (sql:string)=>wrap(target.prepare(sql))
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
}

// ── service: send ─────────────────────────────────────────────────────────────────────────
describe('sendAgentMessage', () => {
  it('persists a message, tenant/sender stamped, returns seq', async () => {
    const db = makeDb()
    const r = await sendAgentMessage(envWith(db), { fromAgent: 'ag-code', fromMember: 'm1', toAgent: 'ag-review', body: 'build G64b' }, TEST_AUTHZ)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.seq).toBe(1)
    expect(r.duplicate).toBe(false)
    const row = db.messages[0]
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
    expect(db.messages.length).toBe(1)
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
    expect(db.messages.length).toBe(2)
    expect(db.messages.map((m) => m.body).sort()).toEqual(['from A', 'from B'])
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
    expect(db.messages.length).toBe(1) // the conflicting second send did NOT persist
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
    expect(db.messages.length).toBe(2) // the capped send did NOT persist (atomic guard)
    // consume one → budget frees → next send accepted
    await readAgentInbox(env, { agent: 'ag-x', limit: 1 })
    expect((await send('4')).ok).toBe(true)
  })

  it('dedup wins over the cap: a same-rid duplicate arriving while at cap resolves as duplicate, NOT inbox_full', async () => {
    // The pre-check sees no row; writer A fills the cap before this INSERT.
    const db = makeDb();const env=envWith(db);let interleaved=false
    interleaveNextRun(env,()=>{
      db.sqlite.prepare(`INSERT INTO agent_messages
        (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at)
        VALUES ('A', 't', 'ag-y', 'ag-x', 'm', 'message', 'hi', 'r1', NULL, 't0')`).run()
      interleaved=true
    })
    const b = await sendAgentMessage(
      env,
      { fromAgent: 'ag-x', fromMember: 'm', toAgent: 'ag-y', body: 'hi', requestId: 'r1' },
      TEST_AUTHZ,
      { maxUnread: 1 },
    )
    expect(interleaved).toBe(true)
    expect(b.ok).toBe(true)
    if (!b.ok) return
    expect(b.duplicate).toBe(true) // NOT inbox_full — the message actually landed (writer A)
    expect(b.id).toBe('A')
    expect(db.messages.length).toBe(1) // no second row
  })

  it('at cap with a NON-duplicate rid still returns inbox_full', async () => {
    const db = makeDb()
    db.sqlite.prepare(`INSERT INTO agent_messages
      (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to, created_at)
      VALUES ('X', 't', 'ag-y', 'ag-other', 'm', 'message', 'filler', NULL, NULL, 't0')`).run()
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
    expect(db.messages[1].kind).toBe('ack')
    expect(db.messages[1].in_reply_to).toBe('q1')
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
    expect(db.messages[0].read_at).toBeNull()

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
    expect(db.messages[0].from_agent).toBe('ag-code')
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
    expect(db.messages[0].read_at).toBeNull()

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
