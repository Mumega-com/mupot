// mupot#1740 — a check-then-write guard is not a guard under concurrency. #1729's consume-time
// liveness check is TOCTOU against a detach (markStopped) that commits between the check and the
// delivery write. The invariant "no delivery or execution to a stopped seat" must sit INSIDE the
// write: the envelope INSERT (inbox route) and the claim UPDATE (in-Worker route).
// Deterministic: the detach is injected by wrapping evaluateReceiverLiveness (the consumer's
// check) so it commits immediately AFTER the check returns ok. No timers. Real schema.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'

const hook = vi.hoisted(() => ({ afterCheck: null as null | (() => void) }))
vi.mock('../src/fleet/registry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/fleet/registry')>()
  return {
    ...orig,
    evaluateReceiverLiveness: async (...args: Parameters<typeof orig.evaluateReceiverLiveness>) => {
      const verdict = await orig.evaluateReceiverLiveness(...args)
      if (verdict.ok && hook.afterCheck) { const f = hook.afterCheck; hook.afterCheck = null; f() }
      return verdict
    },
  }
})

import { invokeTool } from '../src/mcp'
import { handleQueue } from '../src/bus/consumer'
import { runDispatchedTaskExecution } from '../src/agents/execute'
import { deliverDispatchToInbox, ReceiverNotLiveError } from '../src/bus/fleet-bridge'
import type { Agent, AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const SQUAD = 'squad-1'
const MEMBER = 'member-1'
const AGENT = 'agent-uuid-target'
const SLUG = 'target-agent'
const TASK = 'task-1'
const T0 = '2026-09-01T00:00:00.000Z'
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

let h: SqliteD1Harness
let env: Env
let events: BusEvent[]
let doRuns: number
const model = { chat: vi.fn(async () => { throw new Error('model_must_not_run') }) }

const auth = (): AuthContext => ({
  userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  boundAgentId: null,
  capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
})

function fleet(fleetAgentId: string, mode: '' | 'poll') {
  h.sqlite.prepare(
    `INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
     VALUES (?, ?, 'T', '', '[]', 'on_demand', 'running', ?, 'generic', ?, ?, ?, ?)`,
  ).run(fleetAgentId, TENANT, fleetAgentId, mode, mode === 'poll' ? 300 : null, now(), now())
}
// The real markStopped write shape (src/fleet/attach-routes.ts).
const detach = () => h.sqlite.exec(
  `UPDATE fleet_agents SET status='stopped', presence_mode='', presence_ttl_sec=NULL, last_reported_at=datetime('now'), updated_at=datetime('now')`)
const reattach = () => h.sqlite.prepare(`UPDATE fleet_agents SET status='running', last_reported_at=?`).run(now())

const agentRow = () => h.sqlite.prepare('SELECT * FROM agents WHERE id = ?').get(AGENT) as unknown as Agent

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  events = []; doRuns = 0; hook.afterCheck = null
  model.chat.mockClear()
  env = {
    DB: h.db, TENANT_SLUG: TENANT,
    BUS: { send: async (e: BusEvent) => { events.push(e) } },
    AGENT: {
      idFromName: () => 'do-id',
      get: () => ({
        fetch: async (_u: string, init: { body: string }) => {
          doRuns += 1
          const p = (JSON.parse(init.body) as BusEvent).payload as { task_id: string; dispatch_receipt_id: string }
          const r = await runDispatchedTaskExecution(env, agentRow(), p.task_id, p.dispatch_receipt_id, {
            model, emit: async () => {}, remember: async () => 'e',
            meter: { checkAndReserve: async () => ({ ok: true }), recordTokens: async () => {} } as never, // test double
          })
          return Response.json(r, { status: r.ok ? 200 : 409 })
        },
      }),
    },
  } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('${AGENT}', '${SQUAD}', '${SLUG}', 'T', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${MEMBER}', 'M', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c1', '${MEMBER}', 'squad', '${SQUAD}', 'member');
    INSERT INTO tasks (id, squad_id, title, body, status, assignee_agent_id, created_at, updated_at)
      VALUES ('${TASK}', '${SQUAD}', 't', 'b', 'open', '${AGENT}', '${T0}', '${T0}');
  `)
})
afterEach(() => h.close())

const dispatch = () => invokeTool(auth(), env, 'task_dispatch', { task_id: TASK }, 'https://pot.example')
async function deliver(event: BusEvent) {
  const item = { id: 'm1', attempts: 1, body: event, ack: vi.fn(), retry: vi.fn() }
  await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)
  return item
}
const receipt = () => h.sqlite.prepare('SELECT * FROM task_dispatch_receipts').get() as Record<string, unknown>
const count = (t: string) => (h.sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n

function expectRefused() {
  expect(receipt()).toMatchObject({ settled_stage: 'failed', settled_reason: 'receiver_not_live', delivered_via: null })
  expect(receipt().consumed_at).not.toBeNull()
  expect(count('agent_messages')).toBe(0)
  expect(h.sqlite.prepare('SELECT status s, execution_receipt_id e FROM tasks').get()).toMatchObject({ s: 'open', e: null })
  expect(model.chat).not.toHaveBeenCalled()
}

describe('atomic stop fence (#1740): detach lands between the liveness check and the write', () => {
  it('INBOX route: no envelope, receipt failed/receiver_not_live, re-dispatchable after reattach', async () => {
    fleet(AGENT, 'poll')
    expect((await dispatch()).ok).toBe(true)
    hook.afterCheck = detach
    const item = await deliver(events[0])
    expect(item.ack).toHaveBeenCalled()
    expect(item.retry).not.toHaveBeenCalled()
    expect(doRuns).toBe(0)
    expectRefused()
    reattach()
    expect((await dispatch()).ok).toBe(true)
  })

  it('INBOX route resolved through the slug fallback (fleet row keyed by slug)', async () => {
    fleet(SLUG, 'poll')
    expect((await dispatch()).ok).toBe(true)
    hook.afterCheck = detach
    await deliver(events[0])
    expectRefused()
  })

  it('IN-WORKER route: claim UPDATE refuses, no pointer, no model, receipt failed/receiver_not_live', async () => {
    fleet(AGENT, '')
    expect((await dispatch()).ok).toBe(true)
    hook.afterCheck = detach
    const item = await deliver(events[0])
    expect(item.ack).toHaveBeenCalled()
    expect(item.retry).not.toHaveBeenCalled()
    expect(doRuns).toBe(1) // the wake was attempted; the claim write itself refused
    expectRefused()
    reattach()
    expect((await dispatch()).ok).toBe(true)
  })

  it('control: no detach -> envelope lands (inbox) and fence does not over-block', async () => {
    fleet(AGENT, 'poll')
    await dispatch()
    await deliver(events[0])
    expect(count('agent_messages')).toBe(1)
    expect(receipt()).toMatchObject({ delivered_via: 'inbox', settled_stage: null })
  })

  it('control: stale (not stopped) poll seat still gets the envelope', async () => {
    fleet(AGENT, 'poll')
    h.sqlite.exec(`UPDATE fleet_agents SET last_reported_at='2000-01-01 00:00:00'`)
    await dispatch()
    await deliver(events[0])
    expect(count('agent_messages')).toBe(1)
  })

  it('deliverDispatchToInbox: a stopped seat at write time throws ReceiverNotLiveError, no row', async () => {
    fleet(AGENT, 'poll')
    detach()
    await expect(deliverDispatchToInbox(env, {
      agentId: AGENT, squadId: SQUAD, taskId: TASK, receiptId: 'r1', dispatchedByMemberId: MEMBER,
      receiverFenceAgentId: AGENT,
    })).rejects.toBeInstanceOf(ReceiverNotLiveError)
    expect(count('agent_messages')).toBe(0)
  })
})
