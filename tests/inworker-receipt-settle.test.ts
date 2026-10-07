// tests/inworker-receipt-settle.test.ts — mupot#1723 / #1721. An in_worker task_dispatch has no
// agent_messages row and no runtime credential, so before this fix its dispatch receipt was
// consumed but never settled: a run ending in artifact_verification_failed left the dispatch
// "in flight" forever (task_dispatch refused task_not_dispatchable) and the operator repair
// task_dispatch_lease_reset(terminate:true) refused too (no message to load). Real migrations,
// real SQL; only the model and the AgentDO transport are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'
import { invokeTool } from '../src/mcp'
import { handleQueue } from '../src/bus/consumer'
import { runDispatchedTaskExecution } from '../src/agents/execute'
import { adminResetDispatchLease, hasInFlightDispatchReceipt } from '../src/tasks/runtime-receipts'
import type { Agent, AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const SQUAD_ID = 'squad-1'
const MEMBER_ID = 'member-1'
const OPERATOR_ID = 'member-op'
const OPERATOR_TOKEN = 'token-op'
const AGENT_ID = 'agent-uuid-target'
const TASK_ID = 'task-1'
const T0 = '2026-09-01T00:00:00.000Z'

let harness: SqliteD1Harness
let env: Env
let events: BusEvent[]

const proseModel = { chat: vi.fn(async () => 'I believe this task is now complete.') }

function auth(): AuthContext {
  return {
    userId: MEMBER_ID, memberId: MEMBER_ID, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    capabilities: [{ member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }
}

function operatorAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: OPERATOR_ID, memberId: OPERATOR_ID, tokenId: OPERATOR_TOKEN, email: null, role: 'member',
    tenant: TENANT, channel: 'workspace',
    capabilities: [{ member_id: OPERATOR_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
    ...overrides,
  } as AuthContext
}

function seed(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-1', 'squad-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at)
      VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'target-agent', 'Target Agent', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${MEMBER_ID}', 'Dispatcher', 'active', '${TENANT}'),
      ('${OPERATOR_ID}', 'Operator', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-1', '${MEMBER_ID}', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, expires_at)
      VALUES ('${OPERATOR_TOKEN}', '${OPERATOR_ID}', 'hash-op', 'op', 'workspace', '${T0}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('${TASK_ID}', '${SQUAD_ID}', 'In-worker task', 'work', 'Reviewer accepts the draft', 'open', '${AGENT_ID}', '${T0}', '${T0}');
  `)
}

function agentRow(): Agent {
  const row = harness.sqlite.prepare('SELECT * FROM agents WHERE id = ?').get(AGENT_ID)
  return row as unknown as Agent
}

function makeEnv(): Env {
  events = []
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: async (event: BusEvent) => { events.push(event) } },
    // The AgentDO transport: same call the real DO makes (runDispatchedTaskExecution), model stubbed.
    AGENT: {
      idFromName: () => 'do-id',
      get: () => ({
        fetch: async (_url: string, init: { body: string }) => {
          const event = JSON.parse(init.body) as BusEvent
          const payload = event.payload as { task_id: string; dispatch_receipt_id: string }
          const r = await runDispatchedTaskExecution(env, agentRow(), payload.task_id, payload.dispatch_receipt_id, {
            model: proseModel,
            emit: async () => {},
            remember: async () => 'engram',
            meter: {
              checkAndReserve: async () => ({ ok: true }),
              recordTokens: async () => {},
            } as never, // test double: the meter's full return shape is irrelevant to this seam
          })
          return Response.json(r, { status: r.ok ? 200 : 409 })
        },
      }),
    },
  } as unknown as Env
}

function queueItem(event: BusEvent) {
  return { id: 'm1', attempts: 1, body: event, ack: vi.fn(), retry: vi.fn() }
}

async function deliver(event: BusEvent) {
  const item = queueItem(event)
  await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)
  return item
}

function dispatchRow(id: string) {
  return harness.sqlite.prepare('SELECT * FROM task_dispatch_receipts WHERE id = ?').get(id) as Record<string, unknown>
}

describe('in_worker dispatch receipts settle (mupot#1723, #1721)', () => {
  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    seed()
    env = makeEnv()
  })
  afterEach(() => harness.close())

  async function dispatchOnce(): Promise<{ event: BusEvent; receiptId: string }> {
    const res = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID }, 'https://pot.example')
    expect(res.ok).toBe(true)
    const event = events.at(-1) as BusEvent
    const receiptId = (event.payload as { dispatch_receipt_id: string }).dispatch_receipt_id
    return { event, receiptId }
  }

  it('(a) failed artifact verification settles the receipt failed + in_worker; once the agent polls, task_dispatch succeeds and routes to the inbox', async () => {
    const { event, receiptId } = await dispatchOnce()

    // First delivery: in-Worker run fails artifact verification -> 409 -> queue retry.
    const first = await deliver(event)
    expect(first.retry).toHaveBeenCalledOnce()
    expect(harness.sqlite.prepare('SELECT status, result FROM tasks WHERE id = ?').get(TASK_ID))
      .toMatchObject({ status: 'blocked' })
    expect(dispatchRow(receiptId)).toMatchObject({
      settled_stage: 'failed', delivered_via: 'in_worker',
    })
    expect(String(dispatchRow(receiptId).settled_reason)).toContain('artifact_verification_failed')
    expect(await hasInFlightDispatchReceipt(env, TASK_ID)).toBe(false)
    const audit = harness.sqlite.prepare(
      `SELECT operation, principal_kind FROM mutation_audit_entries WHERE handler = 'in_worker_dispatch_settle' AND target_id = ?`,
    ).all(receiptId)
    expect(audit).toEqual([{ operation: 'settle_failed', principal_kind: 'system' }])

    // Redelivery (recovery branch) consumes the receipt and does not double-settle.
    const second = await deliver(event)
    expect(second.ack).toHaveBeenCalledOnce()
    expect(dispatchRow(receiptId).consumed_at).not.toBeNull()
    expect(harness.sqlite.prepare(
      `SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE handler = 'in_worker_dispatch_settle' AND target_id = ?`,
    ).get(receiptId)).toEqual({ n: 1 })

    // The agent gains poll presence -> a fresh dispatch is accepted and routes to the inbox.
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by,
                                agent_type, member_id, host, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT_ID}', '${TENANT}', 'Target', '', '[]', 'on_demand', 'running', '${AGENT_ID}',
              'generic', '${MEMBER_ID}', '', 'poll', 600, datetime('now'), datetime('now'));
    `)
    const again = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID }, 'https://pot.example')
    expect(again.ok).toBe(true)
    expect(again.result).toMatchObject({ dispatched: true })
    const event2 = events.at(-1) as BusEvent
    const item = await deliver(event2)
    expect(item.ack).toHaveBeenCalledOnce()
    const id2 = (event2.payload as { dispatch_receipt_id: string }).dispatch_receipt_id
    expect(dispatchRow(id2)).toMatchObject({ delivered_via: 'inbox' })
    expect(harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_messages WHERE request_id = ?`)
      .get(`dispatch-inbox:${id2}`)).toEqual({ n: 1 })
  })

  it('settle is idempotent and fenced: a settled receipt is never re-settled, an inbox receipt is never in_worker-settled', async () => {
    const { settleInWorkerDispatchReceipt } = await import('../src/tasks/runtime-receipts')
    const { receiptId } = await dispatchOnce()
    const input = { dispatchReceiptId: receiptId, taskId: TASK_ID, agentId: AGENT_ID, reason: 'x' }
    expect(await settleInWorkerDispatchReceipt(env, { ...input, stage: 'failed' })).toBe(true)
    expect(await settleInWorkerDispatchReceipt(env, { ...input, stage: 'failed' })).toBe(false)
    expect(await settleInWorkerDispatchReceipt(env, { ...input, stage: 'completed' })).toBe(false)
    harness.sqlite.exec(`UPDATE task_dispatch_receipts SET settled_at = NULL, settled_stage = NULL, delivered_via = 'inbox' WHERE id = '${receiptId}'`)
    expect(await settleInWorkerDispatchReceipt(env, { ...input, stage: 'failed' })).toBe(false)
  })

  it('hasInFlightDispatchReceipt: unsettled is in flight; failed / reset_terminated settles are not', async () => {
    const { receiptId } = await dispatchOnce()
    expect(await hasInFlightDispatchReceipt(env, TASK_ID)).toBe(true)
    for (const stage of ['failed', 'reset_terminated']) {
      harness.sqlite.exec(`UPDATE task_dispatch_receipts SET settled_stage = '${stage}', settled_at = '${T0}' WHERE id = '${receiptId}'`)
      expect(await hasInFlightDispatchReceipt(env, TASK_ID)).toBe(false)
      harness.sqlite.exec(`UPDATE task_dispatch_receipts SET settled_stage = NULL, settled_at = NULL WHERE id = '${receiptId}'`)
      expect(await hasInFlightDispatchReceipt(env, TASK_ID)).toBe(true)
    }
  })

  describe('(b) task_dispatch_lease_reset terminate:true on a message-less in_worker receipt', () => {
    async function wedged(): Promise<string> {
      // The pre-fix production shape: consumed, execution_receipt_id points at it, delivered_via NULL.
      const { receiptId } = await dispatchOnce()
      harness.sqlite.exec(`
        UPDATE task_dispatch_receipts SET consumed_at = '${T0}' WHERE id = '${receiptId}';
        UPDATE tasks SET status = 'blocked', execution_receipt_id = '${receiptId}' WHERE id = '${TASK_ID}';
      `)
      return receiptId
    }

    it('terminates on the dispatch row + audit; a second call is already_terminal', async () => {
      const receiptId = await wedged()
      expect(await hasInFlightDispatchReceipt(env, TASK_ID)).toBe(true)
      const r = await adminResetDispatchLease(env, operatorAuth(), { taskId: TASK_ID, dispatchReceiptId: receiptId, reason: 'unwedge', terminate: true })
      expect(r).toMatchObject({ reset: true, code: 'reset', terminated: true, message_id: null })
      expect(dispatchRow(receiptId)).toMatchObject({ settled_stage: 'reset_terminated', delivered_via: 'in_worker' })
      expect(await hasInFlightDispatchReceipt(env, TASK_ID)).toBe(false)
      expect(harness.sqlite.prepare(`SELECT operation, handler FROM mutation_audit_entries WHERE id = ?`).get(r.audit_id))
        .toEqual({ operation: 'reset_terminate_in_worker', handler: 'task_dispatch_lease_reset' })
      const second = await adminResetDispatchLease(env, operatorAuth(), { taskId: TASK_ID, dispatchReceiptId: receiptId, reason: 'again', terminate: true })
      expect(second).toMatchObject({ reset: false, code: 'reset_refused_already_terminal' })
    })

    it('without a credential anchor terminate is refused; without terminate a message-less receipt stays not-found', async () => {
      const receiptId = await wedged()
      const noCred = await adminResetDispatchLease(env, operatorAuth({ tokenId: undefined }), { taskId: TASK_ID, dispatchReceiptId: receiptId, reason: 'r', terminate: true })
      expect(noCred.code).toBe('reset_refused_credential_required')
      const plain = await adminResetDispatchLease(env, operatorAuth(), { taskId: TASK_ID, dispatchReceiptId: receiptId, reason: 'r' })
      expect(plain.code).toBe('reset_not_found')
      expect(dispatchRow(receiptId).settled_at).toBeNull()
    })

    it('a non-operator / non-admin principal is refused by the tool before the service runs', async () => {
      const receiptId = await wedged()
      const res = await invokeTool(auth(), env, 'task_dispatch_lease_reset',
        { task_id: TASK_ID, dispatch_receipt_id: receiptId, reason: 'nope', terminate: true }, 'https://pot.example')
      expect(res.ok).toBe(false)
      expect(dispatchRow(receiptId).settled_at).toBeNull()
    })

    it('a receipt that is not provably in_worker (no delivered_via, no execution pointer) stays not-found even with terminate', async () => {
      const { receiptId } = await dispatchOnce()
      const r = await adminResetDispatchLease(env, operatorAuth(), { taskId: TASK_ID, dispatchReceiptId: receiptId, reason: 'r', terminate: true })
      expect(r.code).toBe('reset_not_found')
      expect(dispatchRow(receiptId).settled_at).toBeNull()
    })
  })
})
