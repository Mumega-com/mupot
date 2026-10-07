// mupot#1729 — routing state outlives the process. task_dispatch must refuse (409
// receiver_not_live) to hand work to an external receiver that is not currently live, and the
// bus consumer must not deliver a poll-routed dispatch to a no-longer-live receiver.
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

describe('task_dispatch receiver liveness fence (#1729)', () => {
  it('poll + live -> dispatch OK', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    const r = await dispatch()
    expect(r.ok).toBe(true)
    expect(events).toHaveLength(1)
  })

  it('poll + stale -> 409 receiver_not_live, nothing emitted, no receipt row', async () => {
    fleet({ mode: 'poll', at: STALE })
    const r = await dispatch()
    expect(r).toMatchObject({ ok: false, status: 409, error: 'receiver_not_live' })
    expect(r.detail).toMatchObject({ agent_id: AGENT, presence_mode: 'poll', status: 'running', live: false, reason: 'poll_stale' })
    expect(events).toHaveLength(0)
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM task_dispatch_receipts').get()).toMatchObject({ n: 0 })
  })

  it('poll + stale + forced inbox -> 409 too', async () => {
    fleet({ mode: 'poll', at: STALE })
    expect(await dispatch({ delivery: 'inbox' })).toMatchObject({ status: 409, error: 'receiver_not_live' })
  })

  it('stopped + forced inbox (runtime kept) -> 409', async () => {
    fleet({ runtime: 'claude-code', status: 'stopped', at: FRESH() })
    const r = await dispatch({ delivery: 'inbox' })
    expect(r).toMatchObject({ status: 409, error: 'receiver_not_live' })
    expect(r.detail).toMatchObject({ status: 'stopped', reason: 'stopped_forced_inbox' })
  })

  it('detached poll row (stopped, poll + runtime kept) -> 409 even unforced', async () => {
    fleet({ runtime: 'claude-code', mode: 'poll', status: 'stopped', at: FRESH() })
    const r = await dispatch()
    expect(r).toMatchObject({ status: 409, error: 'receiver_not_live' })
    expect(r.detail).toMatchObject({ reason: 'poll_stopped', live: false })
  })

  it('no fleet surface -> in-worker route unchanged', async () => {
    const r = await dispatch()
    expect(r.ok).toBe(true)
    expect(events).toHaveLength(1)
  })

  it('live resident runtime -> unchanged (also with forced inbox)', async () => {
    fleet({ runtime: 'claude-code', at: FRESH() })
    expect((await dispatch()).ok).toBe(true)
    h.sqlite.exec(`UPDATE task_dispatch_receipts SET settled_at='${T0}', settled_stage='failed'`)
    expect((await dispatch({ delivery: 'inbox' })).ok).toBe(true)
  })

  it('stale resident (no poll), unforced -> unchanged (not in scope)', async () => {
    fleet({ runtime: 'claude-code', at: STALE })
    expect((await dispatch()).ok).toBe(true)
  })

  it('after check_in poll refresh the receiver is live again -> dispatch OK', async () => {
    fleet({ mode: 'poll', at: STALE })
    expect((await dispatch()).status).toBe(409)
    const ci = await invokeTool(auth(AGENT), env, 'check_in', { presence_mode: 'poll', poll_interval_sec: 300 }, 'https://pot.example')
    expect(ci.ok).toBe(true)
    expect((await dispatch()).ok).toBe(true)
  })
})

describe('bus consumer: poll receiver not live at consume time (#1729)', () => {
  const deliver = async (event: BusEvent) => {
    const item = { id: 'm1', attempts: 1, body: event, ack: vi.fn(), retry: vi.fn() }
    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)
    return item
  }

  it('settles the receipt failed/receiver_not_live, writes no inbox envelope, does not wedge', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    expect((await dispatch()).ok).toBe(true)
    // receiver stops/expires between dispatch and consume
    h.sqlite.prepare(`UPDATE fleet_agents SET last_reported_at = ?`).run(STALE)
    const item = await deliver(events[0])
    expect(item.ack).toHaveBeenCalled()
    expect(item.retry).not.toHaveBeenCalled()
    const row = h.sqlite.prepare('SELECT * FROM task_dispatch_receipts').get() as Record<string, unknown>
    expect(row).toMatchObject({ settled_stage: 'failed', settled_reason: 'receiver_not_live', delivered_via: null })
    expect(row.consumed_at).not.toBeNull()
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM agent_messages').get()).toMatchObject({ n: 0 })
    // task stays dispatchable once the receiver is live again
    h.sqlite.prepare(`UPDATE fleet_agents SET last_reported_at = ?`).run(FRESH())
    expect((await dispatch()).ok).toBe(true)
  })

  it('live poll receiver still gets the inbox envelope', async () => {
    fleet({ mode: 'poll', at: FRESH() })
    await dispatch()
    await deliver(events[0])
    expect(h.sqlite.prepare('SELECT COUNT(*) n FROM agent_messages').get()).toMatchObject({ n: 1 })
    expect(h.sqlite.prepare('SELECT delivered_via v FROM task_dispatch_receipts').get()).toMatchObject({ v: 'inbox' })
  })
})
