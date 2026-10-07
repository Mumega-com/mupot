// mupot#1729 — routing state outlives the process. task_dispatch must refuse (409
// receiver_not_live) to hand work to an external receiver that is not currently live, and the
// bus consumer must not deliver to a seat stopped between dispatch and consume. STOPPED is the
// fence; a stale (not stopped) poll seat keeps its mailbox and only yields a warning.
// Real-schema harness (applyAllMigrations); no hand-written DDL.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'
import { invokeTool } from '../src/mcp'
import { handleQueue } from '../src/bus/consumer'
import type { AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const SQUAD = 'squad-1'
const MEMBER = 'member-1'
const AGENT = 'agent-uuid-target'
const TASK = 'task-1'
const T0 = '2026-09-01T00:00:00.000Z'
const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
const STALE = stamp(Date.now() - 999_999_000)
const FRESH = () => stamp(Date.now())

let h: SqliteD1Harness
let env: Env
let events: BusEvent[]

const auth = (bound: string | null = null): AuthContext => ({
  userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  boundAgentId: bound,
  capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
})

function fleet(o: { runtime?: string; status?: string; mode?: string; at: string }) {
  h.sqlite.prepare(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
     VALUES (?, ?, 'T', ?, '[]', 'on_demand', ?, ?, 'generic', ?, ?, ?, ?)`,
  ).run(AGENT, TENANT, o.runtime ?? '', o.status ?? 'running', AGENT, o.mode ?? '', o.mode === 'poll' ? 300 : null, o.at, o.at)
}

const dispatch = (extra: Record<string, unknown> = {}) =>
  invokeTool(auth(), env, 'task_dispatch', { task_id: TASK, ...extra }, 'https://pot.example')

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  events = []
  env = { DB: h.db, TENANT_SLUG: TENANT, BUS: { send: async (e: BusEvent) => { events.push(e) } } } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('${AGENT}', '${SQUAD}', 'target-agent', 'T', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER}', 'M', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c1', '${MEMBER}', 'squad', '${SQUAD}', 'member');
    INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, created_at, updated_at)
      VALUES ('${TASK}', '${SQUAD}', 't', 'b', 'open', '${AGENT}', '${T0}', '${T0}');
  `)
})
afterEach(() => h.close())

const detach = (runtime = '') => h.sqlite.exec(
  `UPDATE fleet_agents SET status='stopped', presence_mode='', presence_ttl_sec=NULL, runtime='${runtime}', last_reported_at=datetime('now')`)

describe('task_dispatch receiver fence (#1729)', () => {
  it('live poll -> OK, no warning', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    const r = await dispatch()
    expect(r.ok).toBe(true)
    expect(r.result).not.toHaveProperty('warning')
    expect(events).toHaveLength(1)
  })

  it('stale poll -> OK with receiver_stale warning (mailbox preserved)', async () => {
    fleet({ mode: 'poll', at: STALE })
    const r = await dispatch()
    expect(r.ok).toBe(true)
    expect(r.result).toMatchObject({ warning: { code: 'receiver_stale', agent_id: AGENT, last_reported_at: STALE, presence_ttl_sec: 300 } })
    expect(events).toHaveLength(1)
  })

  it('REAL detach shape (stopped, mode empty, runtime empty) -> 409 unforced and forced', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    detach('')
    const r = await dispatch()
    expect(r).toMatchObject({ ok: false, status: 409, error: 'receiver_not_live' })
    expect(r.detail).toMatchObject({ agent_id: AGENT, presence_mode: '', status: 'stopped', live: false, reason: 'stopped' })
    expect(await dispatch({ delivery: 'inbox' })).toMatchObject({ status: 409, error: 'receiver_not_live' })
    expect(events).toHaveLength(0)
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM task_dispatch_receipts').get()).toMatchObject({ n: 0 })
  })

  it('REAL detach shape with runtime kept -> 409 unforced and forced', async () => {
    fleet({ runtime: 'claude-code', mode: 'poll', at: FRESH() })
    detach('claude-code')
    expect(await dispatch()).toMatchObject({ status: 409, error: 'receiver_not_live' })
    expect(await dispatch({ delivery: 'inbox' })).toMatchObject({ status: 409, error: 'receiver_not_live' })
  })

  it('no fleet surface -> in-worker route unchanged', async () => {
    const r = await dispatch()
    expect(r.ok).toBe(true)
    expect(r.result).not.toHaveProperty('warning')
    expect(events).toHaveLength(1)
  })

  it('live resident runtime -> unchanged', async () => {
    fleet({ runtime: 'claude-code', at: FRESH() })
    expect((await dispatch()).ok).toBe(true)
  })

  it('re-dispatch after the seat reattaches and is live -> OK', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    detach('')
    expect((await dispatch()).status).toBe(409)
    h.sqlite.prepare(`UPDATE fleet_agents SET status='running', last_reported_at=?`).run(FRESH())
    expect((await dispatch()).ok).toBe(true)
  })
})

describe('bus consumer (#1729)', () => {
  const deliver = async (event: BusEvent) => {
    const item = { id: 'm1', attempts: 1, body: event, ack: vi.fn(), retry: vi.fn() }
    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)
    return item
  }

  it('seat stopped between dispatch and consume -> failed settle, no envelope, no in-Worker run', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    expect((await dispatch()).ok).toBe(true)
    detach('')
    const item = await deliver(events[0])
    expect(item.ack).toHaveBeenCalled()
    expect(item.retry).not.toHaveBeenCalled()
    const row = h.sqlite.prepare('SELECT * FROM task_dispatch_receipts').get() as Record<string, unknown>
    expect(row).toMatchObject({ settled_stage: 'failed', settled_reason: 'receiver_not_live', delivered_via: null })
    expect(row.consumed_at).not.toBeNull()
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM agent_messages').get()).toMatchObject({ n: 0 })
    expect(h.sqlite.prepare('SELECT execution_receipt_id e FROM tasks').get()).toMatchObject({ e: null })
    const audit = h.sqlite.prepare(`SELECT principal_id, handler FROM mutation_audit_entries WHERE target_id = ?`).get(row.id) as Record<string, unknown>
    expect(audit).toMatchObject({ principal_id: 'dispatch_receiver_fence', handler: 'receiver_not_live_settle' })
    h.sqlite.prepare(`UPDATE fleet_agents SET status='running', last_reported_at=?`).run(FRESH())
    expect((await dispatch()).ok).toBe(true)
  })

  it('settle that does not land is retried, not silently consumed', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    await dispatch()
    detach('')
    // pre-settle the row out from under the consumer is covered by idempotence; force a no-land
    // by marking a conflicting delivered_via so the settle UPDATE matches nothing.
    h.sqlite.exec(`UPDATE task_dispatch_receipts SET delivered_via = 'inbox'`)
    const item = await deliver(events[0])
    const row = h.sqlite.prepare('SELECT consumed_at c FROM task_dispatch_receipts').get() as Record<string, unknown>
    expect(row.c).toBeNull()
    expect(item.ack).not.toHaveBeenCalled()
  })

  it('stale (not stopped) poll seat still gets the inbox envelope', async () => {
    fleet({ mode: 'poll', at: STALE })
    await dispatch()
    await deliver(events[0])
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM agent_messages').get()).toMatchObject({ n: 1 })
    expect(h.sqlite.prepare('SELECT delivered_via v FROM task_dispatch_receipts').get()).toMatchObject({ v: 'inbox' })
  })

  it('live poll seat gets the inbox envelope', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    await dispatch()
    await deliver(events[0])
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM agent_messages').get()).toMatchObject({ n: 1 })
  })
})
