// tests/execution-brakes-external-fence.test.ts — "agents as themselves" follow-up to #1807 (mupot#1809).
//
// DEFECT CLASS: a brake enforced at one execution entrypoint is not a brake. #1807 enforced the
// per-task hold, the retry ceiling and the execution pause on the IN-WORKER path only; Athena's review
// proved (real SQLite+D1) that task_dispatch issued a receipt for a held task and that the external
// runtime_consumed path moved a held task to in_progress. These tests hold the same three brakes at
// EVERY point where a task becomes "being worked on": the task_dispatch receipt INSERT, the inbox
// envelope INSERT, the runtime_consumed UPDATE, plus external failure counting and the task_get read
// surface. Real migrated schema; only the queue transport is stubbed. Every guard was proven by mutation
// (see the PR description) - the test names below are the ones that fail when a guard is removed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'

import { invokeTool } from '../src/mcp'
import { handleQueue } from '../src/bus/consumer'
import { escalateRefusedTask } from '../src/agents/execution-brakes'
import { recordTaskDispatchRuntimeReceipt } from '../src/tasks/runtime-receipts'
import type { AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const SQUAD = 'squad-1'
const SQUAD_2 = 'squad-2'
const OPERATOR = 'member-op'
const RT_MEMBER = 'member-rt'
const RT_TOKEN = 'tok-rt'
const AGENT = 'agent-uuid-target'
const SLUG = 'target-agent'
const TASK = 'task-1'
const T0 = '2026-09-01T00:00:00.000Z'
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

let h: SqliteD1Harness
let env: Env
let events: BusEvent[]

const operator = (): AuthContext => ({
  userId: OPERATOR, memberId: OPERATOR, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
  boundAgentId: null,
  capabilities: [{ member_id: OPERATOR, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
})
const runtimeAuth = (): AuthContext => ({
  userId: RT_MEMBER, tenant: TENANT, channel: 'workspace', role: 'member', memberId: RT_MEMBER, tokenId: RT_TOKEN,
  boundAgentId: AGENT, email: null,
  capabilities: [{ member_id: RT_MEMBER, scope_type: 'squad', scope_id: SQUAD, capability: 'member' }],
} as AuthContext)

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  events = []
  env = { DB: h.db, TENANT_SLUG: TENANT, BUS: { send: async (e: BusEvent) => { events.push(e) } } } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD}', 'dept-1', 'sq', 'Sq'), ('${SQUAD_2}', 'dept-1', 'sq2', 'Sq2');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES ('${AGENT}', '${SQUAD}', '${SLUG}', 'T', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${OPERATOR}', 'Op', 'active', '${TENANT}'), ('${RT_MEMBER}', 'RT', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('c-op', '${OPERATOR}', 'squad', '${SQUAD}', 'member'), ('c-rt', '${RT_MEMBER}', 'squad', '${SQUAD}', 'member');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', '${AGENT}', '${RT_MEMBER}', '${T0}');
    INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, revoked_at, agent_id, tenant, expires_at)
      VALUES ('${RT_TOKEN}', '${RT_MEMBER}', 'hash-rt', 'rt', 'workspace', '${T0}', NULL, '${AGENT}', '${TENANT}', '2099-01-01T00:00:00.000Z');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('${TASK}', '${SQUAD}', 't', 'b', 'done', 'open', '${AGENT}', '${T0}', '${T0}');
    INSERT INTO fleet_agents (agent_id, tenant, display, runtime, squads, lifecycle, status, reported_by, agent_type, presence_mode, presence_ttl_sec, last_reported_at, updated_at)
      VALUES ('${AGENT}', '${TENANT}', 'T', '', '[]', 'on_demand', 'running', '${AGENT}', 'generic', 'poll', 300, '${now()}', '${now()}');
  `)
})
afterEach(() => h.close())

// ── fixtures ──
const seedHold = (taskId = TASK) => h.sqlite.exec(
  `INSERT INTO execution_holds (task_id, escalation_id, agent_id, refused_count, reason, held_at)
   VALUES ('${taskId}', 'esc-1', '${AGENT}', 3, 'seed', '${T0}')`)
const seedCeiling = (n = 3, taskId = TASK) => h.sqlite.exec(
  `INSERT OR REPLACE INTO task_execution_attempts (task_id, refused_count, last_agent_id, first_at, last_at)
   VALUES ('${taskId}', ${n}, '${AGENT}', '${T0}', '${T0}')`)
const pauseAgent = () => h.sqlite.exec(
  `INSERT INTO execution_pauses (id, tenant, scope_type, scope_id, reason, paused_by_member_id, paused_at)
   VALUES ('p-a', '${TENANT}', 'agent', '${AGENT}', 'r', '${OPERATOR}', '${T0}')`)
const pauseSquad = (squad = SQUAD) => h.sqlite.exec(
  `INSERT INTO execution_pauses (id, tenant, scope_type, scope_id, reason, paused_by_member_id, paused_at)
   VALUES ('p-s', '${TENANT}', 'squad', '${squad}', 'r', '${OPERATOR}', '${T0}')`)

const count = (t: string) => (h.sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n
const dispatch = () => invokeTool(operator(), env, 'task_dispatch', { task_id: TASK }, 'https://pot.example')
const taskRow = () => h.sqlite.prepare('SELECT status, assignee_agent_id a, execution_receipt_id e, gate_owner g FROM tasks WHERE id = ?').get(TASK) as
  { status: string; a: string | null; e: string | null; g: string | null }
const receiptRow = () => h.sqlite.prepare('SELECT * FROM task_dispatch_receipts ORDER BY created_at DESC LIMIT 1').get() as Record<string, unknown>
const attempts = () => h.sqlite.prepare('SELECT * FROM task_execution_attempts WHERE task_id = ?').get(TASK) as { refused_count: number; last_reason: string } | undefined
const holdRow = () => h.sqlite.prepare('SELECT * FROM execution_holds WHERE task_id = ?').get(TASK) as { released_at: string | null; escalation_id: string } | undefined

/** Run `action` the first time a statement containing `fragment` is PREPARED (just before it runs). */
function whenPrepared(fragment: string, action: () => void) {
  const realPrepare = h.db.prepare.bind(h.db)
  let armed = true
  h.db.prepare = ((sql: string) => {
    if (armed && sql.includes(fragment)) { armed = false; action() }
    return realPrepare(sql)
  }) as typeof h.db.prepare
}

async function deliver(event: BusEvent) {
  const item = { id: 'm1', attempts: 1, body: event, ack: vi.fn(), retry: vi.fn() }
  await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, env)
  return item
}

/** Dispatch (real task_dispatch) + real inbox delivery + lease, ready for runtime_consumed. */
async function dispatchedAndDelivered() {
  const out = await dispatch()
  expect(out.ok, JSON.stringify(out)).toBe(true)
  await deliver(events[events.length - 1])
  const dispatchId = receiptRow().id as string
  const msg = h.sqlite.prepare('SELECT id FROM agent_messages WHERE request_id = ?').get(`dispatch-inbox:${dispatchId}`) as { id: string }
  h.sqlite.prepare(`UPDATE agent_messages SET delivery_attempts = 1, lease_expires_at = '2099-01-01T00:00:00.000Z' WHERE id = ?`).run(msg.id)
  return { dispatchId, messageId: msg.id }
}
const consumeInput = (dispatchId: string, messageId: string) => ({
  taskId: TASK, dispatchReceiptId: dispatchId, messageId, stage: 'runtime_consumed' as const,
  runtimeReceiptHash: 'a'.repeat(64), attempt: 1,
})
const failInput = (dispatchId: string, messageId: string) => ({
  ...consumeInput(dispatchId, messageId), stage: 'failed' as const, reason: 'could not do it',
})

// ═════════════════════════ 1. task_dispatch ═════════════════════════
describe('task_dispatch refuses at the receipt INSERT', () => {
  it('control: a clean task dispatches', async () => {
    expect((await dispatch()).ok).toBe(true)
    expect(count('task_dispatch_receipts')).toBe(1)
  })

  it('refuses a task with an unreleased hold (task_held), no receipt, no wake event', async () => {
    seedHold()
    expect(await dispatch()).toMatchObject({ ok: false, status: 409, error: 'task_held' })
    expect(count('task_dispatch_receipts')).toBe(0)
    expect(events).toHaveLength(0)
  })

  it('a RELEASED hold no longer refuses', async () => {
    seedHold()
    h.sqlite.exec(`UPDATE execution_holds SET released_at = '${T0}', released_by_member_id = '${OPERATOR}'`)
    expect((await dispatch()).ok).toBe(true)
  })

  it('refuses a task at the retry ceiling (retry_ceiling_reached)', async () => {
    seedCeiling(3)
    expect(await dispatch()).toMatchObject({ ok: false, status: 409, error: 'retry_ceiling_reached' })
    expect(count('task_dispatch_receipts')).toBe(0)
  })

  it('under the ceiling still dispatches', async () => {
    seedCeiling(2)
    expect((await dispatch()).ok).toBe(true)
  })

  it('refuses dispatch to a paused agent (execution_paused)', async () => {
    pauseAgent()
    expect(await dispatch()).toMatchObject({ ok: false, status: 409, error: 'execution_paused' })
    expect(count('task_dispatch_receipts')).toBe(0)
  })

  it('refuses dispatch to an agent whose CURRENT squad is paused; a different squad pause does not', async () => {
    pauseSquad(SQUAD_2)
    expect((await dispatch()).ok).toBe(true)
    h.sqlite.exec('DELETE FROM task_dispatch_receipts')
    h.sqlite.exec(`UPDATE execution_pauses SET resumed_at = '${T0}', resumed_by_member_id = '${OPERATOR}'`)
    h.sqlite.exec(`INSERT INTO execution_pauses (id, tenant, scope_type, scope_id, reason, paused_by_member_id, paused_at)
      VALUES ('p-s2', '${TENANT}', 'squad', '${SQUAD}', 'r', '${OPERATOR}', '${T0}')`)
    expect(await dispatch()).toMatchObject({ ok: false, error: 'execution_paused' })
    expect(count('task_dispatch_receipts')).toBe(0)
  })

  it('an archived task is still task_archived (brake diagnosis does not mask it)', async () => {
    seedHold()
    h.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status) VALUES ('${TASK}', '${T0}', 'test', '${OPERATOR}', 'open')`)
    expect(await dispatch()).toMatchObject({ ok: false, error: 'task_archived' })
  })

  it('RACE hold-vs-dispatch: a hold landing between the dispatch pre-reads and the INSERT is refused by the INSERT itself', async () => {
    whenPrepared('INSERT INTO task_dispatch_receipts', seedHold)
    expect(await dispatch()).toMatchObject({ ok: false, status: 409, error: 'task_held' })
    expect(count('task_dispatch_receipts')).toBe(0)
  })

  it('RACE pause-vs-dispatch: a pause landing before the INSERT is refused by the INSERT itself', async () => {
    whenPrepared('INSERT INTO task_dispatch_receipts', pauseAgent)
    expect(await dispatch()).toMatchObject({ ok: false, error: 'execution_paused' })
    expect(count('task_dispatch_receipts')).toBe(0)
  })

  it('Promise.all hold-vs-dispatch: hold always lands; once it exists a fresh dispatch is refused', async () => {
    seedCeiling(2)
    const place = (async () => {
      h.sqlite.exec(`UPDATE task_execution_attempts SET refused_count = 3`)
      return escalateRefusedTask(env, AGENT, TASK)
    })()
    const [d, escalated] = await Promise.all([dispatch(), place])
    expect(escalated).toBe(true)
    expect(holdRow()?.released_at).toBeNull()
    expect(count('task_dispatch_receipts')).toBe(d.ok ? 1 : 0)
    h.sqlite.exec('DELETE FROM task_dispatch_receipts')
    h.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${AGENT}', status = 'open'`)
    const again = await dispatch()
    expect(again.ok).toBe(false)
  })
})

// ═════════════════════════ 2. inbox route ═════════════════════════
describe('the inbox envelope INSERT is fenced (nothing delivered to an external runtime)', () => {
  async function dispatchThenBrake(brake: () => void, reason: string) {
    expect((await dispatch()).ok).toBe(true)
    brake()
    const item = await deliver(events[0])
    expect(item.ack).toHaveBeenCalled()
    expect(item.retry).not.toHaveBeenCalled()
    expect(count('agent_messages')).toBe(0)
    expect(receiptRow()).toMatchObject({ settled_stage: 'failed', settled_reason: reason })
    expect(receiptRow().consumed_at).not.toBeNull()
    expect(taskRow()).toMatchObject({ status: 'open', e: null })
    expect(h.sqlite.prepare(`SELECT handler FROM mutation_audit_entries WHERE handler = ?`).get(`${reason}_settle`)).toBeTruthy()
  }

  it('held task: no envelope, dispatch settled failed task_held', async () => { await dispatchThenBrake(seedHold, 'task_held') })
  it('ceiling task: no envelope, settled retry_ceiling_reached', async () => { await dispatchThenBrake(() => seedCeiling(3), 'retry_ceiling_reached') })
  it('paused agent: no envelope, settled execution_paused', async () => { await dispatchThenBrake(pauseAgent, 'execution_paused') })
  it('paused squad: no envelope, settled execution_paused', async () => { await dispatchThenBrake(() => pauseSquad(SQUAD), 'execution_paused') })

  it('RACE: a hold landing AFTER the route decision is refused by the envelope INSERT', async () => {
    expect((await dispatch()).ok).toBe(true)
    whenPrepared('INSERT INTO agent_messages', seedHold)
    await deliver(events[0])
    expect(count('agent_messages')).toBe(0)
    expect(receiptRow()).toMatchObject({ settled_stage: 'failed', settled_reason: 'task_held' })
  })

  it('control: a clean dispatch is delivered to the inbox', async () => {
    expect((await dispatch()).ok).toBe(true)
    await deliver(events[0])
    expect(count('agent_messages')).toBe(1)
  })
})

// ═════════════════════════ 3. runtime_consumed ═════════════════════════
describe('runtime_consumed refuses inside its guarded UPDATE', () => {
  it('control: a clean dispatch is consumed and the task moves to in_progress', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    const out = await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId))
    expect(out.task_status).toBe('in_progress')
  })

  async function consumeRefused(brake: () => void, code: string) {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    brake() // INSERTED BETWEEN DISPATCH AND CONSUME
    await expect(recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId)))
      .rejects.toMatchObject({ code })
    expect(taskRow()).toMatchObject({ status: 'open', e: null })
    expect(count('task_dispatch_runtime_receipts')).toBe(0)
    expect(h.sqlite.prepare('SELECT settled_stage s, settled_reason r FROM task_dispatch_receipts WHERE id = ?').get(dispatchId))
      .toEqual({ s: 'failed', r: code })
    expect(h.sqlite.prepare('SELECT principal_id p, operation o FROM mutation_audit_entries WHERE handler = ?').get(`${code}_settle`))
      .toEqual({ p: 'execution_brake', o: 'settle_failed' })
    return { dispatchId, messageId }
  }

  it('hold inserted between dispatch and consume -> task_held, dispatch settled task_held_settle', async () => { await consumeRefused(seedHold, 'task_held') })
  it('ceiling reached between dispatch and consume -> retry_ceiling_reached', async () => { await consumeRefused(() => seedCeiling(3), 'retry_ceiling_reached') })
  it('agent paused between dispatch and consume -> execution_paused', async () => { await consumeRefused(pauseAgent, 'execution_paused') })
  it('squad paused between dispatch and consume -> execution_paused', async () => { await consumeRefused(() => pauseSquad(SQUAD), 'execution_paused') })

  it('the settled-failed dispatch is NOT consumable later, even after the hold is released', async () => {
    const { dispatchId, messageId } = await consumeRefused(seedHold, 'task_held')
    h.sqlite.exec(`UPDATE execution_holds SET released_at = '${T0}', released_by_member_id = '${OPERATOR}'`)
    await expect(recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId))).rejects.toBeTruthy()
    expect(taskRow()).toMatchObject({ status: 'open', e: null })
    expect((await dispatch()).ok).toBe(true) // a NEW dispatch after release is allowed
  })

  it('RACE hold-vs-consume (hold lands AFTER every pre-check, before the claim UPDATE): refused by the UPDATE itself', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    whenPrepared("SET status = 'in_progress', execution_receipt_id", seedHold)
    await expect(recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId)))
      .rejects.toMatchObject({ code: 'task_held' })
    expect(taskRow()).toMatchObject({ status: 'open', e: null })
    expect(h.sqlite.prepare('SELECT settled_reason r FROM task_dispatch_receipts WHERE id = ?').get(dispatchId)).toEqual({ r: 'task_held' })
  })

  it('Promise.all hold-vs-consume: the task never ends in_progress under an active hold', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    seedCeiling(3)
    const settled = await Promise.allSettled([
      recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId)),
      escalateRefusedTask(env, AGENT, TASK),
    ])
    expect(settled[0].status).toBe('rejected')
    expect(taskRow().status).not.toBe('in_progress')
    expect(count('task_dispatch_runtime_receipts')).toBe(0)
  })

  it('a runtime_consumed receipt that already landed is not disturbed by a LATER hold (replay stays read-only)', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId))
    seedHold()
    const again = await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId))
    expect(again.task_status).toBe('in_progress')
    expect(h.sqlite.prepare('SELECT settled_stage s FROM task_dispatch_receipts WHERE id = ?').get(dispatchId)).toEqual({ s: null })
  })

  it('the MCP tool maps the refusals to 409 with the distinct code', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    seedHold()
    const out = await invokeTool(runtimeAuth(), env, 'task_dispatch_runtime_receipt', {
      task_id: TASK, dispatch_receipt_id: dispatchId, message_id: messageId, stage: 'runtime_consumed',
      runtime_receipt_hash: 'a'.repeat(64), attempt: 1,
    }, 'https://pot.example')
    expect(out).toMatchObject({ ok: false, status: 409, error: 'task_held' })
  })
})

// ═════════════════════════ 4. counting external failures ═════════════════════════
describe('external runtime failures count toward the per-task ceiling', () => {
  it('a failed receipt AFTER custody (runtime_consumed) bumps the counter', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId))
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), failInput(dispatchId, messageId))
    expect(attempts()).toMatchObject({ refused_count: 1, last_reason: 'runtime_failed' })
    expect(holdRow()).toBeUndefined()
  })

  it('a failed receipt with NO prior custody (never started: delivery/outage class) is NOT counted', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), failInput(dispatchId, messageId))
    expect(attempts()).toBeUndefined()
  })

  it('the failure that reaches the ceiling PLACES THE HOLD (blocked, unassigned, escalated) and dispatch is then refused', async () => {
    seedCeiling(2)
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId))
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), failInput(dispatchId, messageId))
    expect(attempts()?.refused_count).toBe(3)
    expect(holdRow()).toMatchObject({ released_at: null })
    expect(taskRow()).toMatchObject({ status: 'blocked', a: null })
    expect((await dispatch()).ok).toBe(false)
  })

  it('a replayed failed receipt does not double count', async () => {
    const { dispatchId, messageId } = await dispatchedAndDelivered()
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), consumeInput(dispatchId, messageId))
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), failInput(dispatchId, messageId))
    await recordTaskDispatchRuntimeReceipt(env, runtimeAuth(), failInput(dispatchId, messageId))
    expect(attempts()?.refused_count).toBe(1)
  })
})

// ═════════════════════════ 5. read surface ═════════════════════════
describe('task_get shows the execution hold from the SAME query', () => {
  const get = () => invokeTool(operator(), env, 'task_get', { task_id: TASK }, 'https://pot.example')
  type Got = { ok: true; result: { execution_hold: { held: boolean; escalated_at: string | null; released_at: string | null } } }

  it('no hold row -> held false, both timestamps null', async () => {
    const out = await get() as unknown as Got
    expect(out.ok).toBe(true)
    expect(out.result.execution_hold).toEqual({ held: false, escalated_at: null, released_at: null })
  })

  it('unreleased hold -> held true with escalated_at', async () => {
    seedHold()
    expect((await get() as unknown as Got).result.execution_hold).toEqual({ held: true, escalated_at: T0, released_at: null })
  })

  it('released hold -> held false, both timestamps shown', async () => {
    seedHold()
    h.sqlite.exec(`UPDATE execution_holds SET released_at = '2026-09-02T00:00:00.000Z', released_by_member_id = '${OPERATOR}'`)
    expect((await get() as unknown as Got).result.execution_hold)
      .toEqual({ held: false, escalated_at: T0, released_at: '2026-09-02T00:00:00.000Z' })
  })

  it('reads the hold with ONE statement (a join), not an extra round-trip', async () => {
    seedHold()
    const realPrepare = h.db.prepare.bind(h.db)
    const holdReads: string[] = []
    h.db.prepare = ((sql: string) => {
      if (sql.includes('execution_holds')) holdReads.push(sql)
      return realPrepare(sql)
    }) as typeof h.db.prepare
    await get()
    expect(holdReads).toHaveLength(1)
    expect(holdReads[0]).toMatch(/LEFT JOIN/)
  })
})
