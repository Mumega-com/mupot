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
import { dispatchInboxRequestId } from '../src/bus/fleet-bridge'
import { adminResetDispatchLease, hasInFlightDispatchReceipt, settleInWorkerDispatchReceipt } from '../src/tasks/runtime-receipts'
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
let doRuns = 0

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
  doRuns = 0
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: async (event: BusEvent) => { events.push(event) } },
    // The AgentDO transport: same call the real DO makes (runDispatchedTaskExecution), model stubbed.
    AGENT: {
      idFromName: () => 'do-id',
      get: () => ({
        fetch: async (_url: string, init: { body: string }) => {
          doRuns += 1
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


const AGENT_MEMBER = 'member-agent'
const AGENT_TOKEN = 'token-agent'

function seedRuntime(): void {
  harness.sqlite.exec(`
    INSERT INTO agents (id, squad_id, slug, name, status, created_at)
      VALUES ('agent-gate', '${SQUAD_ID}', 'gate-agent', 'Gate Agent', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${AGENT_MEMBER}', 'Agent Member', 'active', '${TENANT}'),
      ('member-gate', 'Gate Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-agent', '${AGENT_MEMBER}', 'squad', '${SQUAD_ID}', 'member'),
      ('cap-gate', 'member-gate', 'squad', '${SQUAD_ID}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES
      ('${TENANT}', '${AGENT_ID}', '${AGENT_MEMBER}', '${T0}'),
      ('${TENANT}', 'agent-gate', 'member-gate', '${T0}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at)
      VALUES ('${AGENT_TOKEN}', '${AGENT_MEMBER}', 'hash-agent', 'agent', 'workspace', '${T0}', '${AGENT_ID}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant, expires_at)
      VALUES ('token-gate', 'member-gate', 'hash-gate', 'gate', 'workspace', '${T0}', 'agent-gate', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
      VALUES ('gg-1', 'gate:independent', 'agent', 'agent-gate', '${MEMBER_ID}', '${T0}');
    UPDATE tasks SET gate_owner = 'gate:independent', done_when = 'Artifact: path and SHA256: hash are recorded' WHERE id = '${TASK_ID}';
  `)
}

function agentAuth(): AuthContext {
  return {
    userId: AGENT_MEMBER, memberId: AGENT_MEMBER, tokenId: AGENT_TOKEN, boundAgentId: AGENT_ID, email: null,
    role: 'member', tenant: TENANT, channel: 'workspace',
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  } as AuthContext
}

/** The exact Digid sequence after unwedging: external runtime consumes then completes with evidence. */
async function runtimeCompletes(receiptId: string): Promise<void> {
  seedRuntime()
  const consumed = await invokeTool(agentAuth(), env, 'task_dispatch_runtime_receipt', {
    task_id: TASK_ID, dispatch_receipt_id: receiptId, stage: 'runtime_consumed',
    runtime_receipt_hash: 'a'.repeat(64), attempt: 1,
  }, 'https://pot.example')
  expect(consumed.ok, JSON.stringify(consumed)).toBe(true)
  const sha = 'b'.repeat(64)
  const completed = await invokeTool(agentAuth(), env, 'task_dispatch_runtime_receipt', {
    task_id: TASK_ID, dispatch_receipt_id: receiptId, stage: 'completed',
    runtime_receipt_hash: 'c'.repeat(64), attempt: 1,
    result: `Done.\nArtifact: /tmp/out.txt\nSHA256: ${sha}`, artifact_refs: ['/tmp/out.txt'], artifact_sha256: sha,
  }, 'https://pot.example')
  expect(completed.ok, JSON.stringify(completed)).toBe(true)
  expect(harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get(TASK_ID)).toEqual({ status: 'review' })
}

function evFor(receiptId: string, taskId = TASK_ID): BusEvent {
  return {
    type: 'agent.wake', tenant: TENANT, squad_id: SQUAD_ID, agent_id: AGENT_ID,
    actor: { kind: 'member', id: MEMBER_ID },
    payload: { task_id: taskId, by: MEMBER_ID, dispatch_receipt_id: receiptId },
    ts: new Date().toISOString(),
  } as BusEvent
}

function insertReceipt(id: string, createdAt: string): void {
  harness.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
    VALUES ('${id}', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${AGENT_ID}', 'member', '${MEMBER_ID}', '${createdAt}', 1)`)
}

function insertInboxEnvelope(receiptId: string): void {
  harness.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at)
    VALUES ('msg-${receiptId}', '${TENANT}', 'target-agent', 'mupot-dispatch', '${MEMBER_ID}', 'request', '{}', '${dispatchInboxRequestId(receiptId)}', '${T0}')`)
}

/** Wrap env.DB.batch so `race` runs against the DB right before the batch (a concurrent writer). */
function raceBeforeBatch(race: string): void {
  const db = env.DB
  const original = db.batch.bind(db)
  env = { ...env, DB: Object.assign(Object.create(db), { batch: async (stmts: never[]) => { harness.sqlite.exec(race); return original(stmts) } }) } as Env
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
    // The failed settle cleared the dead run's pointer, so the external runtime can take over.
    expect(harness.sqlite.prepare('SELECT execution_receipt_id AS p FROM tasks WHERE id = ?').get(TASK_ID)).toEqual({ p: null })
    await runtimeCompletes(id2)
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

  it('Digid sequence: wedged pre-fix receipt -> terminate -> re-dispatch (inbox) -> runtime_consumed -> completed -> review', async () => {
    const { receiptId } = await dispatchOnce()
    harness.sqlite.exec(`
      UPDATE task_dispatch_receipts SET consumed_at = '${T0}' WHERE id = '${receiptId}';
      UPDATE tasks SET status = 'blocked', execution_receipt_id = '${receiptId}' WHERE id = '${TASK_ID}';
    `)
    const r = await adminResetDispatchLease(env, operatorAuth(), { taskId: TASK_ID, dispatchReceiptId: receiptId, reason: 'unwedge', terminate: true })
    expect(r.terminated).toBe(true)
    expect(harness.sqlite.prepare('SELECT execution_receipt_id AS p FROM tasks WHERE id = ?').get(TASK_ID)).toEqual({ p: null })
    harness.sqlite.exec(`
      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by,
                                agent_type, member_id, host, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT_ID}', '${TENANT}', 'Target', '', '[]', 'on_demand', 'running', '${AGENT_ID}',
              'generic', '${MEMBER_ID}', '', 'poll', 600, datetime('now'), datetime('now'));
    `)
    const again = await invokeTool(auth(), env, 'task_dispatch', { task_id: TASK_ID }, 'https://pot.example')
    expect(again.ok).toBe(true)
    const event2 = events.at(-1) as BusEvent
    await deliver(event2)
    const id2 = (event2.payload as { dispatch_receipt_id: string }).dispatch_receipt_id
    expect(dispatchRow(id2)).toMatchObject({ delivered_via: 'inbox' })
    await runtimeCompletes(id2)
  })

  it('a settled receipt redelivered through the queue is consumed, never re-executed', async () => {
    const { event } = await dispatchOnce()
    await deliver(event) // runs once, fails, settles + clears pointer
    expect(doRuns).toBe(1)
    const again = await deliver(event)
    expect(again.ack).toHaveBeenCalledOnce()
    expect(doRuns).toBe(1)
  })

  it('interrupted run (claim expired, task in_progress) is blocked AND its receipt settled failed:interrupted', async () => {
    const { event, receiptId } = await dispatchOnce()
    harness.sqlite.exec(`UPDATE tasks SET status = 'in_progress', execution_receipt_id = '${receiptId}', execution_claim_expires_at = ${Date.now() - 1000} WHERE id = '${TASK_ID}'`)
    await deliver(event)
    expect(doRuns).toBe(0)
    expect(harness.sqlite.prepare('SELECT status, execution_receipt_id AS p FROM tasks WHERE id = ?').get(TASK_ID)).toEqual({ status: 'blocked', p: null })
    expect(dispatchRow(receiptId)).toMatchObject({ settled_stage: 'failed', settled_reason: 'interrupted', delivered_via: 'in_worker' })
  })

  describe('superseded bypass pins', () => {
    it('latest dispatch of a blocked task with a stale pointer runs once; the older one is consumed with zero runs', async () => {
      insertReceipt('old-r', '2026-09-01T00:00:01.000Z')
      insertReceipt('new-r', '2026-09-01T00:00:02.000Z')
      harness.sqlite.exec(`UPDATE tasks SET status = 'blocked', execution_receipt_id = 'dead-r' WHERE id = '${TASK_ID}'`)
      await deliver(evFor('old-r'))
      expect(doRuns).toBe(0)
      expect(dispatchRow('old-r').consumed_at).not.toBeNull()
      await deliver(evFor('new-r'))
      expect(doRuns).toBe(1)
    })

    it('a stale pointer on a task NOT in a workable status (review) still consumes the newest dispatch as superseded', async () => {
      insertReceipt('only-r', '2026-09-01T00:00:01.000Z')
      harness.sqlite.exec(`UPDATE tasks SET status = 'review', execution_receipt_id = 'other-r' WHERE id = '${TASK_ID}'`)
      await deliver(evFor('only-r'))
      expect(doRuns).toBe(0)
      expect(dispatchRow('only-r').consumed_at).not.toBeNull()
    })
  })

  describe('consumer backstop (AgentDO settle skipped)', () => {
    async function ranButNotSettled(status: string): Promise<string> {
      const { receiptId } = await dispatchOnce()
      harness.sqlite.exec(`UPDATE tasks SET status = '${status}', execution_receipt_id = '${receiptId}' WHERE id = '${TASK_ID}'`)
      return receiptId
    }
    it('blocked -> settled failed + in_worker, pointer cleared', async () => {
      const id = await ranButNotSettled('blocked')
      await deliver(evFor(id))
      expect(doRuns).toBe(0)
      expect(dispatchRow(id)).toMatchObject({ settled_stage: 'failed', delivered_via: 'in_worker' })
      expect(harness.sqlite.prepare('SELECT execution_receipt_id AS p FROM tasks WHERE id = ?').get(TASK_ID)).toEqual({ p: null })
    })
    it('rejected (a gate rejected produced work) -> settled completed, not failed', async () => {
      const id = await ranButNotSettled('rejected')
      await deliver(evFor(id))
      expect(dispatchRow(id)).toMatchObject({ settled_stage: 'completed' })
    })
    it('done -> nothing settled (success is the AgentDO\'s settle)', async () => {
      const id = await ranButNotSettled('done')
      await deliver(evFor(id))
      expect(dispatchRow(id).settled_at).toBeNull()
    })
  })

  describe('AgentDO settle by outcome (runDispatchedTaskExecution)', () => {
    const goodModel = { chat: vi.fn(async () => 'ok\nArtifact: /tmp/a.txt\nSHA256: ' + 'a'.repeat(64)) }
    const deps = (model: { chat: () => Promise<string> }) => ({
      model, emit: async () => {}, remember: async () => 'e',
      meter: { checkAndReserve: async () => ({ ok: true }), recordTokens: async () => {} } as never, // test double
    })
    it('a verified run settles completed and keeps the pointer', async () => {
      const { receiptId } = await dispatchOnce()
      const r = await runDispatchedTaskExecution(env, agentRow(), TASK_ID, receiptId, deps(goodModel))
      expect(r.task_status).toBe('review')
      expect(dispatchRow(receiptId)).toMatchObject({ settled_stage: 'completed', delivered_via: 'in_worker' })
      expect(harness.sqlite.prepare('SELECT execution_receipt_id AS p FROM tasks WHERE id = ?').get(TASK_ID)).toEqual({ p: receiptId })
    })
    it('no_op (task already in review) settles nothing', async () => {
      const { receiptId } = await dispatchOnce()
      harness.sqlite.exec(`UPDATE tasks SET status = 'review' WHERE id = '${TASK_ID}'`)
      const r = await runDispatchedTaskExecution(env, agentRow(), TASK_ID, receiptId, deps(goodModel))
      expect(r.decided).toMatch(/^no_op:/)
      expect(dispatchRow(receiptId).settled_at).toBeNull()
    })
    it('task_not_found (task reassigned away) settles nothing', async () => {
      const { receiptId } = await dispatchOnce()
      harness.sqlite.exec(`INSERT INTO agents (id, squad_id, slug, name, status, created_at)
        VALUES ('agent-other', '${SQUAD_ID}', 'other-agent', 'Other', 'active', '${T0}');
        UPDATE tasks SET assignee_agent_id = 'agent-other' WHERE id = '${TASK_ID}'`)
      const r = await runDispatchedTaskExecution(env, agentRow(), TASK_ID, receiptId, deps(goodModel))
      expect(r.error).toBe('task_not_found')
      expect(dispatchRow(receiptId).settled_at).toBeNull()
    })
  })

  describe('settle / terminate guards', () => {
    it('settle fence: wrong task_id or agent_id settles nothing', async () => {
      const { receiptId } = await dispatchOnce()
      const base = { dispatchReceiptId: receiptId, stage: 'failed' as const, reason: 'x' }
      expect(await settleInWorkerDispatchReceipt(env, { ...base, taskId: 'other-task', agentId: AGENT_ID })).toBe(false)
      expect(await settleInWorkerDispatchReceipt(env, { ...base, taskId: TASK_ID, agentId: 'other-agent' })).toBe(false)
      expect(dispatchRow(receiptId).settled_at).toBeNull()
    })
    it('settle never touches a dispatch that has an inbox envelope, even with delivered_via NULL', async () => {
      const { receiptId } = await dispatchOnce()
      insertInboxEnvelope(receiptId)
      expect(await settleInWorkerDispatchReceipt(env, { dispatchReceiptId: receiptId, taskId: TASK_ID, agentId: AGENT_ID, stage: 'failed', reason: 'x' })).toBe(false)
      expect(dispatchRow(receiptId).settled_at).toBeNull()
    })
    async function wedgedId(): Promise<string> {
      const { receiptId } = await dispatchOnce()
      harness.sqlite.exec(`
        UPDATE task_dispatch_receipts SET consumed_at = '${T0}' WHERE id = '${receiptId}';
        UPDATE tasks SET status = 'blocked', execution_receipt_id = '${receiptId}' WHERE id = '${TASK_ID}';
      `)
      return receiptId
    }
    const term = (id: string, extra: { override?: boolean } = {}) =>
      adminResetDispatchLease(env, operatorAuth(), { taskId: TASK_ID, dispatchReceiptId: id, reason: 'r', terminate: true, ...extra })

    it('terminate UPDATE guard: a concurrent settle between check and write is not overwritten', async () => {
      const id = await wedgedId()
      raceBeforeBatch(`UPDATE task_dispatch_receipts SET settled_stage = 'failed', settled_at = '${T0}' WHERE id = '${id}'`)
      const r = await term(id)
      expect(r).toMatchObject({ reset: false, code: 'reset_refused_terminal' })
      expect(dispatchRow(id).settled_stage).toBe('failed')
    })
    it('terminate UPDATE guard: delivered_via inbox (concurrent) is not overwritten', async () => {
      const id = await wedgedId()
      raceBeforeBatch(`UPDATE task_dispatch_receipts SET delivered_via = 'inbox' WHERE id = '${id}'`)
      expect(await term(id)).toMatchObject({ reset: false, code: 'reset_refused_terminal' })
      expect(dispatchRow(id).settled_at).toBeNull()
    })
    it('terminate UPDATE guard: an inbox envelope appearing concurrently blocks the terminate', async () => {
      const id = await wedgedId()
      raceBeforeBatch(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, created_at)
        VALUES ('m-race', '${TENANT}', 'x', 'mupot-dispatch', '${MEMBER_ID}', 'request', '{}', '${dispatchInboxRequestId(id)}', '${T0}')`)
      expect(await term(id)).toMatchObject({ reset: false })
      expect(dispatchRow(id).settled_at).toBeNull()
    })
    it('refuses a LIVE in-Worker run without override; override terminates it and leaves the in-progress task alone', async () => {
      const id = await wedgedId()
      harness.sqlite.exec(`UPDATE tasks SET status = 'in_progress', execution_claim_expires_at = ${Date.now() + 600_000} WHERE id = '${TASK_ID}'`)
      const refused = await term(id)
      expect(refused).toMatchObject({ reset: false, code: 'reset_refused_lease_live' })
      expect(dispatchRow(id).settled_at).toBeNull()
      const forced = await term(id, { override: true })
      expect(forced).toMatchObject({ reset: true, overrode: true, terminated: true })
      expect(harness.sqlite.prepare('SELECT status, execution_receipt_id AS p FROM tasks WHERE id = ?').get(TASK_ID))
        .toEqual({ status: 'in_progress', p: id })
    })
    it('a naturally settled receipt reports already_terminal with terminated:false', async () => {
      const id = await wedgedId()
      expect(await settleInWorkerDispatchReceipt(env, { dispatchReceiptId: id, taskId: TASK_ID, agentId: AGENT_ID, stage: 'failed', reason: 'x' })).toBe(true)
      expect(await term(id)).toMatchObject({ reset: false, code: 'reset_refused_already_terminal', terminated: false })
    })
  })
})
