// tests/execution-brakes.test.ts — "agents as themselves" step 1: LOOP BRAKES (migration 0203).
// Incident 2026-10-09 (mupot#1780): a bulk router_tick queued 24 unrecallable agent.wake messages and
// the in-Worker executor re-claimed artifact-refused tasks for 89 executions. Row-level guards held,
// nothing braked the LOOP. Real migrations + real SQL; only the model and the AgentDO transport are
// stubbed. Every guard below was proven by mutating the code (see the PR description).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageBatch } from '@cloudflare/workers-types'

// AgentDO extends the workerd-only DurableObject base; stand it in so the REAL AgentDO class (not a
// mock of it) can be constructed against a fake ctx below.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) { this.ctx = ctx; this.env = env }
  },
}))

import { invokeTool } from '../src/mcp'
import { handleQueue } from '../src/bus/consumer'
import { AgentDO } from '../src/agents/agent-do'
import { runTaskExecution, runDispatchedTaskExecution } from '../src/agents/execute'
import {
  EXECUTION_RETRY_CEILING, escalateRefusedTask, isExecutionPaused, recordRefusedAttempt,
} from '../src/agents/execution-brakes'
import type { Agent, AuthContext, BusEvent, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const TENANT = 'mumega'
const SQUAD_ID = 'squad-1'
const SQUAD_2 = 'squad-2'
const AGENT_ID = 'agent-1'
const OTHER_AGENT = 'agent-2'
const TASK_ID = 'task-1'
const ADMIN = 'member-admin'
const MEMBER = 'member-plain'
const T0 = '2026-09-01T00:00:00.000Z'

let harness: SqliteD1Harness
let env: Env
let events: BusEvent[]
let modelCalls = 0

// The incident's model output: prose that fails artifact verification every time.
const proseModel = {
  chat: vi.fn(async () => {
    modelCalls += 1
    return 'I believe this task is now complete.'
  }),
}
const meterOk = { checkAndReserve: async () => ({ ok: true }), recordTokens: async () => {} } as never // test double: meter result shape irrelevant here

function deps(extra: Record<string, unknown> = {}) {
  return { model: proseModel, emit: async () => {}, remember: async () => 'engram', meter: meterOk, ...extra }
}

function orgAdminAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ADMIN, memberId: ADMIN, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: ADMIN, scope_type: 'org', scope_id: null, capability: 'admin' }],
    ...overrides,
  } as AuthContext
}

function plainAuth(): AuthContext {
  return {
    userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: null,
    capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
  } as AuthContext
}

function seed(): void {
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'test-dept', 'Test Department');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('${SQUAD_ID}', 'dept-1', 'squad-one', 'Squad One'),
      ('${SQUAD_2}', 'dept-1', 'squad-two', 'Squad Two');
    INSERT INTO agents (id, squad_id, slug, name, status, created_at) VALUES
      ('${AGENT_ID}', '${SQUAD_ID}', 'agent-one', 'Agent One', 'active', '${T0}'),
      ('${OTHER_AGENT}', '${SQUAD_2}', 'agent-two', 'Agent Two', 'active', '${T0}');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('${ADMIN}', 'Admin', 'active', '${TENANT}'),
      ('${MEMBER}', 'Plain', 'active', '${TENANT}'),
      ('member-bound', 'Bound', 'active', '${TENANT}');
    INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, created_at, updated_at)
      VALUES ('${TASK_ID}', '${SQUAD_ID}', 'Looping task', 'work', 'Reviewer accepts the draft', 'open', '${AGENT_ID}', '${T0}', '${T0}');
  `)
}

function agentRow(id = AGENT_ID): Agent {
  return harness.sqlite.prepare('SELECT * FROM agents WHERE id = ?').get(id) as unknown as Agent
}

function task(id = TASK_ID) {
  return harness.sqlite.prepare('SELECT status, assignee_agent_id, gate_owner FROM tasks WHERE id = ?').get(id) as
    { status: string; assignee_agent_id: string | null; gate_owner: string | null }
}

function attempts(taskId = TASK_ID) {
  return harness.sqlite.prepare('SELECT * FROM task_execution_attempts WHERE task_id = ?').get(taskId) as
    { refused_count: number; last_agent_id: string; last_reason: string } | undefined
}

function hold(taskId = TASK_ID) {
  return harness.sqlite.prepare('SELECT * FROM execution_holds WHERE task_id = ?').get(taskId) as
    { escalation_id: string; agent_id: string; released_at: string | null; released_by_member_id: string | null } | undefined
}

function seedAttempts(count: number, taskId = TASK_ID): void {
  harness.sqlite.exec(`INSERT OR REPLACE INTO task_execution_attempts (task_id, refused_count, last_agent_id, first_at, last_at)
    VALUES ('${taskId}', ${count}, '${AGENT_ID}', '${T0}', '${T0}')`)
}

function agentBoundAuth(agentId: string): AuthContext {
  return {
    userId: 'member-bound', memberId: 'member-bound', email: null, role: 'member', tenant: TENANT, channel: 'workspace',
    boundAgentId: agentId,
    capabilities: [{ member_id: 'member-bound', scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
  } as AuthContext
}

function makeEnv(): Env {
  events = []
  modelCalls = 0
  proseModel.chat.mockClear()
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: async (event: BusEvent) => { events.push(event) } },
  } as unknown as Env
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  seed()
  env = makeEnv()
})
afterEach(() => harness.close())

const call = (auth: AuthContext, tool: string, args: Record<string, unknown>) =>
  invokeTool(auth, env, tool, args, 'https://pot.example')

// ───────────────────────── brake 2: execution pause tools ─────────────────────────

describe('execution_pause / execution_resume tools', () => {
  it('pauses an agent with a receipt + one audit row; a repeat is already_paused and writes no second audit row', async () => {
    const first = await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'incident 1780' })
    expect(first).toMatchObject({ ok: true, result: { status: 'paused', scope: 'agent', id: AGENT_ID } })
    const row = harness.sqlite.prepare('SELECT * FROM execution_pauses').get() as Record<string, unknown>
    expect(row).toMatchObject({ scope_type: 'agent', scope_id: AGENT_ID, reason: 'incident 1780', paused_by_member_id: ADMIN, resumed_at: null })
    expect(await isExecutionPaused(env, AGENT_ID)).toBe(true)

    const again = await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'again' })
    expect(again).toMatchObject({ ok: true, result: { status: 'already_paused' } })
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM execution_pauses').get()).toEqual({ n: 1 })
    expect(harness.sqlite.prepare(`SELECT count(*) AS n FROM mutation_audit_entries WHERE handler = 'execution_pause'`).get()).toEqual({ n: 1 })
  })

  it('resume closes the episode with its own receipt + audit row, is idempotent, and a new pause is a new episode', async () => {
    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'p1' })
    const resumed = await call(orgAdminAuth(), 'execution_resume', { scope: 'agent', id: AGENT_ID, reason: 'fixed' })
    expect(resumed).toMatchObject({ ok: true, result: { status: 'resumed' } })
    expect(await isExecutionPaused(env, AGENT_ID)).toBe(false)
    expect(harness.sqlite.prepare('SELECT resumed_by_member_id, resume_reason FROM execution_pauses').get())
      .toEqual({ resumed_by_member_id: ADMIN, resume_reason: 'fixed' })
    expect(await call(orgAdminAuth(), 'execution_resume', { scope: 'agent', id: AGENT_ID, reason: 'x' }))
      .toMatchObject({ ok: true, result: { status: 'not_paused' } })
    expect(harness.sqlite.prepare(`SELECT operation FROM mutation_audit_entries WHERE handler = 'execution_pause' ORDER BY operation`).all())
      .toEqual([{ operation: 'pause' }, { operation: 'resume' }])

    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'p2' })
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM execution_pauses').get()).toEqual({ n: 2 })
    expect(await isExecutionPaused(env, AGENT_ID)).toBe(true)
  })

  it('a squad pause covers its agents (current squad) and not another squad; resuming the agent does not lift it', async () => {
    await call(orgAdminAuth(), 'execution_pause', { scope: 'squad', id: SQUAD_ID, reason: 'squad stop' })
    expect(await isExecutionPaused(env, AGENT_ID)).toBe(true)
    expect(await isExecutionPaused(env, OTHER_AGENT)).toBe(false)
    expect(await call(orgAdminAuth(), 'execution_resume', { scope: 'agent', id: AGENT_ID, reason: 'wrong target' }))
      .toMatchObject({ ok: true, result: { status: 'not_paused' } })
    expect(await isExecutionPaused(env, AGENT_ID)).toBe(true)
    await call(orgAdminAuth(), 'execution_resume', { scope: 'squad', id: SQUAD_ID, reason: 'done' })
    expect(await isExecutionPaused(env, AGENT_ID)).toBe(false)
  })

  it('refuses an agent-bound caller, a non-org-admin, an unknown target and malformed args', async () => {
    const agentBound = orgAdminAuth({ boundAgentId: AGENT_ID })
    expect(await call(agentBound, 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'self' }))
      .toMatchObject({ ok: false, status: 403, error: 'operator_principal_required' })
    expect(await call(agentBound, 'execution_resume', { scope: 'agent', id: AGENT_ID, reason: 'self' }))
      .toMatchObject({ ok: false, status: 403, error: 'operator_principal_required' })
    expect(await call(plainAuth(), 'execution_pause', { scope: 'squad', id: SQUAD_ID, reason: 'lead only' }))
      .toMatchObject({ ok: false, status: 403 })
    expect(await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: 'nope', reason: 'r' }))
      .toMatchObject({ ok: false, status: 404, error: 'not_found' })
    expect(await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: SQUAD_ID, reason: 'wrong table' }))
      .toMatchObject({ ok: false, status: 404 })
    expect(await call(orgAdminAuth(), 'execution_pause', { scope: 'org', id: AGENT_ID, reason: 'r' }))
      .toMatchObject({ ok: false, status: 400 })
    expect(await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: '' }))
      .toMatchObject({ ok: false, status: 400 })
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM execution_pauses').get()).toEqual({ n: 0 })
  })

  it('two concurrent pauses yield exactly one episode and one audit row', async () => {
    const results = await Promise.all([
      call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'a' }),
      call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'b' }),
    ])
    const statuses = results.map((r) => (r as { result: { status: string } }).result.status).sort()
    expect(statuses).toEqual(['already_paused', 'paused'])
    expect(harness.sqlite.prepare(`SELECT count(*) AS n FROM mutation_audit_entries WHERE handler = 'execution_pause'`).get()).toEqual({ n: 1 })
  })
})

// ───────────────── brake 2: enforced at the point of execution, not at enqueue ─────────────────

describe('a pause stops execution where it happens', () => {
  function wakeEvent(extra: Record<string, unknown> = {}): BusEvent {
    return {
      type: 'agent.wake', tenant: TENANT, squad_id: SQUAD_ID, agent_id: AGENT_ID,
      payload: { task_id: TASK_ID, reason: 'router.tick', ...extra }, ts: new Date().toISOString(),
    } as BusEvent
  }

  function envWithDo(): { env: Env; doFetches: { n: number } } {
    const doFetches = { n: 0 }
    const e = {
      ...env,
      AGENT: {
        idFromName: () => 'do-id',
        get: () => ({ fetch: async () => { doFetches.n += 1; return Response.json({ ok: true }) } }),
      },
    } as unknown as Env
    return { env: e, doFetches }
  }

  async function deliver(e: Env, event: BusEvent) {
    const item = { id: 'm1', attempts: 1, body: event, ack: vi.fn(), retry: vi.fn() }
    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, e)
    return item
  }

  it('an agent.wake QUEUED BEFORE the pause is a no-op when consumed: DO untouched, acked, not retried', async () => {
    const { env: e, doFetches } = envWithDo()
    const queued = wakeEvent() // enqueued while the agent was unpaused
    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop the loop' })
    const item = await deliver(e, queued)
    expect(doFetches.n).toBe(0)
    expect(item.ack).toHaveBeenCalledOnce()
    expect(item.retry).not.toHaveBeenCalled()
  })

  it('control: the same queued wake reaches the DO once the agent is resumed', async () => {
    const { env: e, doFetches } = envWithDo()
    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop' })
    await call(orgAdminAuth(), 'execution_resume', { scope: 'agent', id: AGENT_ID, reason: 'go' })
    const item = await deliver(e, wakeEvent())
    expect(doFetches.n).toBe(1)
    expect(item.ack).toHaveBeenCalledOnce()
  })

  it('a squad pause stops a queued wake for a member agent', async () => {
    const { env: e, doFetches } = envWithDo()
    await call(orgAdminAuth(), 'execution_pause', { scope: 'squad', id: SQUAD_ID, reason: 'squad stop' })
    await deliver(e, wakeEvent())
    expect(doFetches.n).toBe(0)
  })

  it('a paused task_dispatch wake settles its receipt failed (execution_paused), consumes it, and leaves the task untouched', async () => {
    harness.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
      VALUES ('rcpt-1', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${AGENT_ID}', 'member', '${ADMIN}', '${T0}', 1)`)
    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop' })
    const { env: e, doFetches } = envWithDo()
    const item = await deliver(e, wakeEvent({ dispatch_receipt_id: 'rcpt-1' }))
    expect(doFetches.n).toBe(0)
    expect(item.retry).not.toHaveBeenCalled()
    expect(item.ack).toHaveBeenCalledOnce()
    expect(harness.sqlite.prepare('SELECT settled_stage, settled_reason, consumed_at FROM task_dispatch_receipts WHERE id = ?').get('rcpt-1'))
      .toMatchObject({ settled_stage: 'failed', settled_reason: 'execution_paused' })
    expect(task()).toMatchObject({ status: 'open', assignee_agent_id: AGENT_ID })
  })

  it('the executor claim UPDATE itself refuses a paused agent (a pause landing after the consumer check): no model call, task unclaimed', async () => {
    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop' })
    const r = await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(r).toMatchObject({ ok: false, error: 'execution_paused' })
    expect(modelCalls).toBe(0)
    expect(task()).toMatchObject({ status: 'open' })
  })

  it('the claim UPDATE refuses a paused agent on the UNASSIGNED-task branch too (squad pause, task not yet assigned)', async () => {
    harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = NULL WHERE id = '${TASK_ID}'`)
    await call(orgAdminAuth(), 'execution_pause', { scope: 'squad', id: SQUAD_ID, reason: 'stop' })
    const r = await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(r).toMatchObject({ ok: false })
    expect(modelCalls).toBe(0)
    expect(task()).toMatchObject({ status: 'open', assignee_agent_id: null })
  })

  describe('AgentDO (real class, fake storage)', () => {
    function makeDo() {
      const alarms: number[] = []
      const kv = new Map<string, string>()
      const ctx = {
        id: { toString: () => 'do-id' },
        storage: {
          sql: {
            exec: (q: string, ...a: unknown[]) => {
              if (/^\s*INSERT INTO runtime/i.test(q)) kv.set(String(a[0]), String(a[1]))
              const read = /SELECT v FROM runtime WHERE k = \?/i.test(q)
              return { toArray: () => (read && kv.has(String(a[0])) ? [{ v: kv.get(String(a[0])) }] : []) }
            },
          },
          setAlarm: async (t: number) => { alarms.push(t) },
          getAlarm: async () => null,
        },
      }
      const durable = new AgentDO(ctx as unknown as DurableObjectState, env)
      return { durable, alarms }
    }

    it('wake and alarm are no-ops for a paused agent; the alarm stays armed so a resume needs no manual wake', async () => {
      await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop' })
      const { durable, alarms } = makeDo()
      const res = await durable.fetch(new Request('https://agent/wake', {
        method: 'POST', body: JSON.stringify({ agent_id: AGENT_ID, task_id: TASK_ID }),
      }))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ ok: false, error: 'execution_paused' })
      expect(task()).toMatchObject({ status: 'open' })

      await durable.alarm()
      expect(alarms).toHaveLength(1)
      expect(task()).toMatchObject({ status: 'open' })
      expect(harness.sqlite.prepare('SELECT count(*) AS n FROM tasks').get()).toEqual({ n: 1 })
    })

    it('control: a resumed agent gets past the gate (task_not_found proves the executor was reached)', async () => {
      await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop' })
      await call(orgAdminAuth(), 'execution_resume', { scope: 'agent', id: AGENT_ID, reason: 'go' })
      const { durable } = makeDo()
      const res = await durable.fetch(new Request('https://agent/wake', {
        method: 'POST', body: JSON.stringify({ agent_id: AGENT_ID, task_id: 'no-such-task' }),
      }))
      expect(await res.json()).toMatchObject({ error: 'task_not_found' })
    })
  })
})

// ───────────────────────── brake 3: per-task retry ceiling ─────────────────────────

describe('wake_agent on a paused agent', () => {
  it('returns an explicit execution_paused outcome, never the inbox-fallback success; touches no DO and writes no message', async () => {
    const doFetches = { n: 0 }
    const e = {
      ...env,
      AGENT: { idFromName: () => 'x', get: () => ({ fetch: async () => { doFetches.n += 1; return Response.json({ ok: true }) } }) },
    } as unknown as Env
    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop' })
    const res = await invokeTool(orgAdminAuth(), e, 'wake_agent', { agent_id: AGENT_ID }, 'https://pot.example')
    expect(res).toMatchObject({ ok: false, status: 409, error: 'execution_paused' })
    expect(doFetches.n).toBe(0)
    expect(harness.sqlite.prepare('SELECT count(*) AS n FROM agent_messages').get()).toEqual({ n: 0 })

    await call(orgAdminAuth(), 'execution_resume', { scope: 'agent', id: AGENT_ID, reason: 'go' })
    const ok = await invokeTool(orgAdminAuth(), e, 'wake_agent', { agent_id: AGENT_ID }, 'https://pot.example')
    expect(ok).toMatchObject({ ok: true })
    expect(doFetches.n).toBe(1)
  })
})

describe('per-TASK retry ceiling + escalation HOLD', () => {
  async function refuseUntilHeld() {
    for (let i = 1; i <= EXECUTION_RETRY_CEILING; i++) {
      const r = await runTaskExecution(env, agentRow(), TASK_ID, deps())
      expect(r).toMatchObject({ ok: false, error: 'artifact_verification_failed', task_status: 'blocked' })
      expect(attempts()?.refused_count).toBe(i)
    }
  }

  it('replays the incident: the 3rd artifact refusal HOLDS the task and raises it; the 4th wake never calls the model', async () => {
    await refuseUntilHeld()
    expect(modelCalls).toBe(EXECUTION_RETRY_CEILING)
    expect(task()).toEqual({ status: 'blocked', assignee_agent_id: null, gate_owner: 'gate:escalation' })
    expect(hold()).toMatchObject({ agent_id: AGENT_ID, released_at: null })
    expect(harness.sqlite.prepare(`SELECT operation, principal_kind FROM mutation_audit_entries WHERE handler = 'execution_retry_ceiling'`).all())
      .toEqual([{ operation: 'escalate_to_human', principal_kind: 'system' }])
    const again = await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(again).toMatchObject({ ok: false, error: 'task_held' })
    expect(modelCalls).toBe(EXECUTION_RETRY_CEILING)
  })

  it('does not hold before the ceiling: after 2 refusals the task stays assigned and workable', async () => {
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(attempts()?.refused_count).toBe(2)
    expect(hold()).toBeUndefined()
    expect(task()).toMatchObject({ status: 'blocked', assignee_agent_id: AGENT_ID, gate_owner: null })
  })

  describe('the hold survives every actor that can write the assignee (only a human releases)', () => {
    it('an agent self-task_update after escalation: still held, executor still refuses', async () => {
      await refuseUntilHeld()
      const res = await call(agentBoundAuth(AGENT_ID), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID, status: 'open' })
      void res // whether the update itself is accepted is not the point; the hold is
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${AGENT_ID}', status = 'open' WHERE id = '${TASK_ID}'`)
      expect(hold()?.released_at).toBeNull()
      const before = modelCalls
      const r = await runTaskExecution(env, agentRow(), TASK_ID, deps())
      expect(r).toMatchObject({ ok: false, error: 'task_held' })
      expect(modelCalls).toBe(before)
    })

    it("another agent's executor claim is refused (the hold is per task, not per agent)", async () => {
      await refuseUntilHeld()
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${OTHER_AGENT}', status = 'open' WHERE id = '${TASK_ID}'`)
      const before = modelCalls
      const r = await runTaskExecution(env, agentRow(OTHER_AGENT), TASK_ID, deps())
      expect(r).toMatchObject({ ok: false, error: 'task_held' })
      expect(modelCalls).toBe(before)
      expect(task()).toMatchObject({ status: 'open', assignee_agent_id: OTHER_AGENT })
    })

    it('the claim UPDATE alone refuses a held task on BOTH branches (a hold landing after the pre-check)', async () => {
      // Bypass the pre-check by placing the hold while runTaskExecution is mid-flight: the claim UPDATE
      // is the first write after loadTask, so wrap the DB to insert the hold right before it.
      for (const assignee of [AGENT_ID, null]) {
        harness.sqlite.exec(`DELETE FROM execution_holds; DELETE FROM task_execution_attempts;
          UPDATE tasks SET status = 'open', assignee_agent_id = ${assignee === null ? 'NULL' : `'${assignee}'`} WHERE id = '${TASK_ID}'`)
        const db = env.DB
        let armed = true
        const racing = {
          ...env,
          DB: Object.assign(Object.create(db), {
            prepare(sql: string) {
              if (armed && /^\s*UPDATE tasks\s+SET status = 'in_progress'/i.test(sql)) {
                armed = false
                harness.sqlite.exec(`INSERT INTO execution_holds (task_id, escalation_id, agent_id, refused_count, held_at)
                  VALUES ('${TASK_ID}', 'e1', '${AGENT_ID}', 3, '${T0}')`)
              }
              return db.prepare(sql)
            },
          }),
        } as Env
        // pre-check passes (no hold yet) -> claim UPDATE must refuse
        const before = modelCalls
        const r = await runTaskExecution(racing, agentRow(), TASK_ID, deps())
        expect(r, String(assignee)).toMatchObject({ ok: false, error: 'task_held' })
        expect(modelCalls).toBe(before)
        expect(task().status).toBe('open')
      }
    })

    it('unassign + a queued wake: refused terminally (task_held), settles the receipt, never retried', async () => {
      await refuseUntilHeld()
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = NULL WHERE id = '${TASK_ID}'`)
      const before = modelCalls
      const r = await runTaskExecution(env, agentRow(), TASK_ID, deps())
      expect(r).toMatchObject({ ok: false, error: 'task_held' })
      expect(modelCalls).toBe(before)
    })

    it('raw assignee changes (and a new dispatch receipt) do NOT reset the counter any more', async () => {
      seedAttempts(2)
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${OTHER_AGENT}' WHERE id = '${TASK_ID}'`)
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = NULL WHERE id = '${TASK_ID}'`)
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${AGENT_ID}' WHERE id = '${TASK_ID}'`)
      harness.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
        VALUES ('rcpt-x', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${AGENT_ID}', 'member', '${ADMIN}', '${T0}', 0)`)
      expect(attempts()?.refused_count).toBe(2)
    })

    it('5 dispatches by an agent: the ceiling still trips at 3 and then holds (attempts accumulate across dispatches)', async () => {
      harness.sqlite.exec(`INSERT INTO members (id, display_name, status, tenant) VALUES ('m-disp', 'Disp', 'active', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-disp', 'm-disp', 'squad', '${SQUAD_ID}', 'member')`)
      const dispatcher = { ...agentBoundAuth(AGENT_ID), memberId: 'm-disp', userId: 'm-disp' } as AuthContext
      let ran = 0
      for (let i = 0; i < 5; i++) {
        const res = await call(dispatcher, 'task_dispatch', { task_id: TASK_ID })
        const receiptRow = harness.sqlite.prepare(
          `SELECT id FROM task_dispatch_receipts WHERE task_id = ? AND settled_at IS NULL ORDER BY created_at DESC LIMIT 1`,
        ).get(TASK_ID) as { id: string } | undefined
        if (!res.ok || !receiptRow) continue
        const r = await runDispatchedTaskExecution(env, agentRow(), TASK_ID, receiptRow.id, deps())
        if (r.error === 'artifact_verification_failed') ran += 1
        // a fresh dispatch must find the task re-assignable; the refusal path leaves it blocked+assigned
      }
      expect(ran).toBe(EXECUTION_RETRY_CEILING)
      expect(modelCalls).toBe(EXECUTION_RETRY_CEILING)
      expect(hold()).toMatchObject({ released_at: null })
      expect(task()).toMatchObject({ status: 'blocked', assignee_agent_id: null })
    })
  })

  describe('only a human releases the hold', () => {
    it('execution_release: refuses agent-bound callers and non-admins; org-admin releases, audited, counter reset', async () => {
      await refuseUntilHeld()
      expect(await call(agentBoundAuth(AGENT_ID), 'execution_release', { task_id: TASK_ID, reason: 'self' }))
        .toMatchObject({ ok: false, status: 403, error: 'operator_principal_required' })
      expect(await call(plainAuth(), 'execution_release', { task_id: TASK_ID, reason: 'lead is not admin' }))
        .toMatchObject({ ok: false, status: 403 })
      expect(hold()?.released_at).toBeNull()
      expect(await call(orgAdminAuth(), 'execution_release', { task_id: 'nope', reason: 'r' })).toMatchObject({ ok: false, status: 404 })
      expect(await call(orgAdminAuth(), 'execution_release', { task_id: TASK_ID, reason: '' })).toMatchObject({ ok: false, status: 400 })

      const rel = await call(orgAdminAuth(), 'execution_release', { task_id: TASK_ID, reason: 'fixed the prompt' })
      expect(rel).toMatchObject({ ok: true, result: { status: 'released' } })
      expect(hold()).toMatchObject({ released_by_member_id: ADMIN })
      expect(hold()?.released_at).not.toBeNull()
      expect(attempts()).toBeUndefined()
      expect(harness.sqlite.prepare(`SELECT operation FROM mutation_audit_entries WHERE handler = 'execution_release'`).all())
        .toEqual([{ operation: 'execution_release' }])
      expect(await call(orgAdminAuth(), 'execution_release', { task_id: TASK_ID, reason: 'again' }))
        .toMatchObject({ ok: true, result: { status: 'not_held' } })

      // released + a human assigns -> the agent executes again (and can be re-held later)
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${AGENT_ID}', status = 'open' WHERE id = '${TASK_ID}'`)
      const before = modelCalls
      await runTaskExecution(env, agentRow(), TASK_ID, deps())
      expect(modelCalls).toBe(before + 1)
      expect(attempts()?.refused_count).toBe(1)
    })

    it('a squad-admin human (not org-admin) of the task squad may release; an admin of another squad may not', async () => {
      await refuseUntilHeld()
      harness.sqlite.exec(`INSERT INTO members (id, display_name, status, tenant) VALUES ('sq-admin', 'SqA', 'active', '${TENANT}'), ('sq2-admin', 'Sq2A', 'active', '${TENANT}');
        INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
          ('c-sqa', 'sq-admin', 'squad', '${SQUAD_ID}', 'admin'), ('c-sq2a', 'sq2-admin', 'squad', '${SQUAD_2}', 'admin')`)
      const mk = (id: string, sq: string): AuthContext => ({ userId: id, memberId: id, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null,
        capabilities: [{ member_id: id, scope_type: 'squad', scope_id: sq, capability: 'admin' }] }) as AuthContext
      expect(await call(mk('sq2-admin', SQUAD_2), 'execution_release', { task_id: TASK_ID, reason: 'wrong squad' })).toMatchObject({ ok: false, status: 403 })
      expect(await call(mk('sq-admin', SQUAD_ID), 'execution_release', { task_id: TASK_ID, reason: 'mine' })).toMatchObject({ ok: true, result: { status: 'released' } })
    })

    it('a HUMAN task_update that assigns an agent releases the hold; the same call from an agent-bound principal does not', async () => {
      await refuseUntilHeld()
      const agentTry = await call(agentBoundAuth(AGENT_ID), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID })
      void agentTry
      expect(hold()?.released_at).toBeNull()
      const human = await call(orgAdminAuth(), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID })
      expect(human.ok, JSON.stringify(human)).toBe(true)
      expect(hold()?.released_at).not.toBeNull()
      expect(attempts()).toBeUndefined()
    })

    it('a task can be re-held after a release (hold row re-armed; history stays in the audit log)', async () => {
      await refuseUntilHeld()
      await call(orgAdminAuth(), 'execution_release', { task_id: TASK_ID, reason: 'r1' })
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${AGENT_ID}', status = 'open' WHERE id = '${TASK_ID}'`)
      await refuseUntilHeld()
      expect(hold()?.released_at).toBeNull()
      expect(harness.sqlite.prepare(`SELECT count(*) AS n FROM mutation_audit_entries WHERE handler = 'execution_retry_ceiling'`).get()).toEqual({ n: 2 })
    })
  })

  it('the claim UPDATE refuses a task at the counter ceiling even with no hold row (crash between bump and hold), and places the hold', async () => {
    seedAttempts(EXECUTION_RETRY_CEILING)
    const r = await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(r).toMatchObject({ ok: false, error: 'retry_ceiling_reached' })
    expect(modelCalls).toBe(0)
    expect(hold()).toMatchObject({ released_at: null })
    expect(task()).toMatchObject({ assignee_agent_id: null, status: 'blocked' })
  })

  it('the ceiling counter fence is in the claim UPDATE on the UNASSIGNED-task branch too', async () => {
    harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = NULL WHERE id = '${TASK_ID}'`)
    seedAttempts(EXECUTION_RETRY_CEILING)
    const r = await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(r).toMatchObject({ ok: false })
    expect(modelCalls).toBe(0)
  })

  it('a failing escalation write in the claim-refusal path never throws out of the executor', async () => {
    seedAttempts(EXECUTION_RETRY_CEILING)
    const db = env.DB
    const broken = { ...env, DB: Object.assign(Object.create(db), { batch: async () => { throw new Error('d1 down') } }) } as Env
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const r = await runTaskExecution(broken, agentRow(), TASK_ID, deps())
    expect(r).toMatchObject({ ok: false, error: 'retry_ceiling_reached' })
    err.mockRestore()
  })

  it('a dispatched run refused by a brake settles its receipt failed with a DISTINCT audit label', async () => {
    harness.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
      VALUES ('rcpt-2', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${AGENT_ID}', 'member', '${ADMIN}', '${T0}', 1)`)
    seedAttempts(EXECUTION_RETRY_CEILING)
    const r = await runDispatchedTaskExecution(env, agentRow(), TASK_ID, 'rcpt-2', deps())
    expect(r.error).toBe('retry_ceiling_reached')
    expect(harness.sqlite.prepare('SELECT settled_stage, settled_reason FROM task_dispatch_receipts WHERE id = ?').get('rcpt-2'))
      .toEqual({ settled_stage: 'failed', settled_reason: 'retry_ceiling_reached' })
    expect(harness.sqlite.prepare(`SELECT principal_id, handler FROM mutation_audit_entries WHERE target_id = 'rcpt-2'`).all())
      .toEqual([{ principal_id: 'execution_brake', handler: 'retry_ceiling_reached_settle' }])
  })

  it('a paused consumer-settled dispatch carries the execution_paused audit label', async () => {
    harness.sqlite.exec(`INSERT INTO task_dispatch_receipts (id, tenant, task_id, squad_id, agent_id, actor_kind, actor_id, created_at, attempts)
      VALUES ('rcpt-3', '${TENANT}', '${TASK_ID}', '${SQUAD_ID}', '${AGENT_ID}', 'member', '${ADMIN}', '${T0}', 1)`)
    await call(orgAdminAuth(), 'execution_pause', { scope: 'agent', id: AGENT_ID, reason: 'stop' })
    const item = { id: 'm1', attempts: 1, ack: vi.fn(), retry: vi.fn(), body: {
      type: 'agent.wake', tenant: TENANT, squad_id: SQUAD_ID, agent_id: AGENT_ID,
      payload: { task_id: TASK_ID, dispatch_receipt_id: 'rcpt-3' }, ts: new Date().toISOString() } }
    const e = { ...env, AGENT: { idFromName: () => 'x', get: () => ({ fetch: async () => Response.json({}) }) } } as unknown as Env
    await handleQueue({ messages: [item] } as unknown as MessageBatch<BusEvent>, e)
    expect(harness.sqlite.prepare(`SELECT handler FROM mutation_audit_entries WHERE target_id = 'rcpt-3'`).all())
      .toEqual([{ handler: 'execution_paused_settle' }])
  })

  it('meter refusals (daily caps) are load shedding and never count toward the ceiling', async () => {
    const blocking = {
      checkAndReserve: async () => ({ ok: false, reason: 'rate_limited', windowKey: 'w', count: 1, tokens: 0, retryAfterSec: 60 }),
      recordTokens: async () => {},
    } as never // test double
    const r = await runTaskExecution(env, agentRow(), TASK_ID, deps({ meter: blocking }))
    expect(r).toMatchObject({ ok: false, error: 'rate_limited', task_status: 'blocked' })
    expect(attempts()).toBeUndefined()
  })

  it('provider/model/gateway outages (the model call throws) never count toward the ceiling; a bad output still does', async () => {
    const down = { chat: vi.fn(async () => { throw new Error('AI Gateway 503') }) }
    for (let i = 0; i < EXECUTION_RETRY_CEILING + 2; i++) {
      const r = await runTaskExecution(env, agentRow(), TASK_ID, deps({ model: down }))
      expect(r).toMatchObject({ ok: false, task_status: 'blocked' })
    }
    expect(attempts()).toBeUndefined()
    expect(hold()).toBeUndefined()
    expect(task().assignee_agent_id).toBe(AGENT_ID)
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(attempts()?.refused_count).toBe(1)
  })

  it('concurrent refusals each get a distinct count from one atomic statement (no lost update)', async () => {
    const counts = await Promise.all(Array.from({ length: 8 }, () => recordRefusedAttempt(env, AGENT_ID, TASK_ID, 'r')))
    expect([...counts].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(attempts()?.refused_count).toBe(8)
  })

  it('concurrent escalations hold the task exactly once with exactly one audit row', async () => {
    seedAttempts(EXECUTION_RETRY_CEILING)
    harness.sqlite.exec(`UPDATE tasks SET status = 'blocked' WHERE id = '${TASK_ID}'`)
    const outcomes = await Promise.all([
      escalateRefusedTask(env, AGENT_ID, TASK_ID), escalateRefusedTask(env, AGENT_ID, TASK_ID), escalateRefusedTask(env, AGENT_ID, TASK_ID),
    ])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(harness.sqlite.prepare(`SELECT count(*) AS n FROM mutation_audit_entries WHERE handler = 'execution_retry_ceiling'`).get()).toEqual({ n: 1 })
  })

  it('escalation below the ceiling is refused (the guard is in the statement, not the caller)', async () => {
    await recordRefusedAttempt(env, AGENT_ID, TASK_ID, 'r')
    expect(await escalateRefusedTask(env, AGENT_ID, TASK_ID)).toBe(false)
    expect(task()).toMatchObject({ assignee_agent_id: AGENT_ID })
    expect(hold()).toBeUndefined()
  })

  it('escalation refuses a task assigned to ANOTHER agent or not in a raisable status (assignee/status guard lives in the hold statement)', async () => {
    seedAttempts(EXECUTION_RETRY_CEILING)
    harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${OTHER_AGENT}' WHERE id = '${TASK_ID}'`)
    expect(await escalateRefusedTask(env, AGENT_ID, TASK_ID)).toBe(false)
    expect(hold()).toBeUndefined()
    for (const status of ['in_progress', 'review', 'done']) {
      harness.sqlite.exec(`UPDATE tasks SET assignee_agent_id = '${AGENT_ID}', status = '${status}' WHERE id = '${TASK_ID}'`)
      expect(await escalateRefusedTask(env, AGENT_ID, TASK_ID), status).toBe(false)
      expect(hold(), status).toBeUndefined()
    }
    expect(harness.sqlite.prepare(`SELECT count(*) AS n FROM mutation_audit_entries WHERE handler = 'execution_retry_ceiling'`).get()).toEqual({ n: 0 })
  })

  it('an archived task is never held, raised or touched by the escalation write', async () => {
    seedAttempts(EXECUTION_RETRY_CEILING)
    harness.sqlite.exec(`UPDATE tasks SET status = 'blocked' WHERE id = '${TASK_ID}'`)
    harness.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status)
      VALUES ('${TASK_ID}', '${T0}', 'test', '${ADMIN}', 'blocked')`)
    expect(await escalateRefusedTask(env, AGENT_ID, TASK_ID)).toBe(false)
    expect(task()).toMatchObject({ assignee_agent_id: AGENT_ID })
    expect(hold()).toBeUndefined()
    expect(harness.sqlite.prepare(`SELECT count(*) AS n FROM mutation_audit_entries WHERE handler = 'execution_retry_ceiling'`).get()).toEqual({ n: 0 })
  })

  describe('the human queue is really human', () => {
    function inProject(): void {
      harness.sqlite.exec(`
        INSERT INTO projects (id, slug, name, status) VALUES ('proj-1', 'proj-1', 'Proj', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('proj-1', '${SQUAD_ID}', 'write');
        UPDATE tasks SET project_id = 'proj-1' WHERE id = '${TASK_ID}';
      `)
    }
    async function needsYouIds(): Promise<string[]> {
      const res = await call(orgAdminAuth(), 'needs_you_list', {})
      expect(res.ok, JSON.stringify(res)).toBe(true)
      return (res as { result: { items: Array<{ source_id: string }> } }).result.items.map((i) => i.source_id)
    }

    it('a task with no real gate lands in needs_you under gate:escalation', async () => {
      inProject()
      await refuseUntilHeld()
      expect(task().gate_owner).toBe('gate:escalation')
      expect(await needsYouIds()).toContain(TASK_ID)
    })

    it('an AGENT-held gate lane (gate:athena) is replaced by gate:escalation so the task is visible to a human', async () => {
      inProject()
      harness.sqlite.exec(`INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
        VALUES ('gg-ath', 'gate:athena', 'agent', '${OTHER_AGENT}', '${ADMIN}', '${T0}');
        UPDATE tasks SET gate_owner = 'gate:athena' WHERE id = '${TASK_ID}'`)
      await refuseUntilHeld()
      expect(task()).toEqual({ status: 'blocked', assignee_agent_id: null, gate_owner: 'gate:escalation' })
      expect(await needsYouIds()).toContain(TASK_ID)
    })

    it('a lane with a HUMAN holder is kept (and is visible)', async () => {
      inProject()
      harness.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-gh', '${MEMBER}', 'squad', '${SQUAD_ID}', 'member');
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at)
          VALUES ('gg-hum', 'gate:hadi', 'member', '${MEMBER}', '${ADMIN}', '${T0}');
        UPDATE tasks SET gate_owner = 'gate:hadi' WHERE id = '${TASK_ID}'`)
      await refuseUntilHeld()
      expect(task()).toEqual({ status: 'blocked', assignee_agent_id: null, gate_owner: 'gate:hadi' })
      expect(await needsYouIds()).toContain(TASK_ID)
    })

    it('a lane with BOTH a human and an agent holder keeps the lane (the human holder makes it a human queue)', async () => {
      inProject()
      harness.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-gh2', '${MEMBER}', 'squad', '${SQUAD_ID}', 'member');
        INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES
          ('gg-m1', 'gate:mixed', 'member', '${MEMBER}', '${ADMIN}', '${T0}'),
          ('gg-m2', 'gate:mixed', 'agent', '${OTHER_AGENT}', '${ADMIN}', '${T0}');
        UPDATE tasks SET gate_owner = 'gate:mixed' WHERE id = '${TASK_ID}'`)
      await refuseUntilHeld()
      expect(task().gate_owner).toBe('gate:mixed')
      expect(await needsYouIds()).toContain(TASK_ID)
    })
  })
})

// ───────── mupot#1809 follow-up: ONE release policy + the stale-attempt re-hold race ─────────

describe('one release policy across execution_release, task_update and REST PATCH (mupot#1809)', () => {
  async function held() {
    for (let i = 1; i <= EXECUTION_RETRY_CEILING; i++) await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(hold()?.released_at).toBeNull()
  }
  const lowly = (): AuthContext => ({
    userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null,
    capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' }],
  }) as AuthContext
  const squadAdmin = (): AuthContext => ({
    userId: MEMBER, memberId: MEMBER, email: null, role: 'member', tenant: TENANT, channel: 'workspace', boundAgentId: null,
    capabilities: [{ member_id: MEMBER, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'admin' }],
  }) as AuthContext

  it('task_update assigning a HELD task is refused 409 task_held below the bar (squad member), task untouched, hold stays', async () => {
    await held()
    const before = task()
    const res = await call(lowly(), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID })
    expect(res).toMatchObject({ ok: false, status: 409, error: 'task_held' })
    expect(task()).toEqual(before)
    expect(hold()?.released_at).toBeNull()
  })

  it('an agent-bound caller that holds ORG ADMIN is still refused task_held (an agent never lifts its own loop)', async () => {
    await held()
    const before = task()
    expect(await call(orgAdminAuth({ boundAgentId: AGENT_ID }), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID }))
      .toMatchObject({ ok: false, status: 409, error: 'task_held' })
    expect(task()).toEqual(before)
    expect(hold()?.released_at).toBeNull()
  })

  it('the SAME member is refused by execution_release too (one bar)', async () => {
    await held()
    expect(await call(lowly(), 'execution_release', { task_id: TASK_ID, reason: 'r' })).toMatchObject({ ok: false, status: 403 })
  })

  it('an agent-bound caller reassigning a held task is refused task_held (never assigned-but-stalled)', async () => {
    await held()
    const before = task()
    expect(await call(agentBoundAuth(AGENT_ID), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID }))
      .toMatchObject({ ok: false, status: 409, error: 'task_held' })
    expect(task()).toEqual(before)
  })

  it('a squad-admin human task_update releases (same bar as execution_release)', async () => {
    await held()
    const res = await call(squadAdmin(), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(hold()?.released_at).not.toBeNull()
    expect(attempts()).toBeUndefined()
  })

  it('a non-assigning edit by a member on a held task is allowed and the hold stays visible', async () => {
    await held()
    const res = await call(lowly(), 'task_update', { task_id: TASK_ID, title: 'renamed' })
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(hold()?.released_at).toBeNull()
  })

  it('a member reassigning a NON-held task is unaffected', async () => {
    const res = await call(lowly(), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID })
    expect(res.ok, JSON.stringify(res)).toBe(true)
  })
})

describe('stale-attempt bookkeeping cannot re-hold a task a human just reassigned (mupot#1809 re-hold race)', () => {
  /** The third refusal's bookkeeping runs AFTER the attempt settles; a human reassign lands in between
   *  (emit('task.blocked') is awaited after settle and before bookkeeping). */
  function raceDeps(humanAction: () => Promise<unknown>) {
    let fired = false
    return deps({
      emit: async (e: BusEvent) => {
        if (e.type === 'task.blocked' && !fired) { fired = true; await humanAction() }
      },
    })
  }

  it('a human reassign between the 3rd refusal settling and its bookkeeping: counter NOT bumped, NO hold, new assignment executes', async () => {
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(attempts()?.refused_count).toBe(2)
    const r = await runTaskExecution(env, agentRow(), TASK_ID, raceDeps(async () => {
      const out = await call(orgAdminAuth(), 'task_update', { task_id: TASK_ID, assignee_agent_id: AGENT_ID })
      expect(out.ok, JSON.stringify(out)).toBe(true)
    }))
    expect(r).toMatchObject({ ok: false })
    expect(attempts()?.refused_count).toBe(2) // the stale 3rd attempt was dropped
    expect(hold()).toBeUndefined()
    expect(task()).toMatchObject({ assignee_agent_id: AGENT_ID, status: 'blocked' })
    const before = modelCalls
    await runTaskExecution(env, agentRow(), TASK_ID, deps()) // the newly assigned agent really executes
    expect(modelCalls).toBe(before + 1)
  })

  it('control: with NO human action in between, the 3rd refusal still holds', async () => {
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    await runTaskExecution(env, agentRow(), TASK_ID, raceDeps(async () => undefined))
    expect(hold()).toMatchObject({ released_at: null })
  })

  it('the epoch is stamped by an execution_release too, and a late bump after the counter was already AT the ceiling is cleared by the release', async () => {
    seedAttempts(EXECUTION_RETRY_CEILING) // counter at ceiling, hold not yet placed
    const rel = await call(orgAdminAuth(), 'execution_release', { task_id: TASK_ID, reason: 'human looked' })
    expect(rel).toMatchObject({ ok: true, result: { status: 'not_held' } })
    expect(attempts()).toBeUndefined() // ceiling-without-hold cleared
    expect(harness.sqlite.prepare(`SELECT task_id FROM task_execution_attempts WHERE task_id LIKE 'release-epoch:%'`).all())
      .toEqual([{ task_id: `release-epoch:${TASK_ID}` }])
  })

  it('an attempt that STARTS after the release counts normally', async () => {
    await call(orgAdminAuth(), 'execution_release', { task_id: TASK_ID, reason: 'epoch' })
    await runTaskExecution(env, agentRow(), TASK_ID, deps())
    expect(attempts()?.refused_count).toBe(1)
  })
})
