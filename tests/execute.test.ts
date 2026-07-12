import { describe, expect, it, vi } from 'vitest'
import { runTaskExecution, resolveTaskId, capResult, MAX_RESULT_CHARS } from '../src/agents/execute'
import type { Agent, Task, ModelPort, BusEvent } from '../src/types'

// ── test doubles ───────────────────────────────────────────────────────────────

const AGENT: Agent = {
  id: 'agent-1',
  squad_id: 'squad-1',
  slug: 'scout',
  name: 'Scout',
  role: 'researcher',
  model: '@cf/meta/llama-3.3',
  status: 'active',
  created_at: '2026-06-06T00:00:00.000Z',
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    squad_id: 'squad-1',
    title: 'Draft the intro',
    body: 'two paragraphs',
    // Door 5: default to a real predicate so existing execute tests are unaffected
    // by the completion gate. Tests that specifically test placeholder blocking
    // override done_when with a sentinel in their own setup.
    done_when: 'Draft intro section accepted by reviewer',
    status: 'open',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,  // K1: default ungated; override in tests for gated behaviour
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
    ...over,
  }
}

// A hand-mocked DB: returns a seeded task for the scoped SELECT, a seeded charter
// for the squad SELECT, and records every UPDATE so the test can assert the row
// transitions (in_progress → done|blocked) and never gets stuck.
function makeEnv(opts: { task: Task | null; charter?: string | null; updateChanges?: number[] }) {
  const updates: { sql: string; args: unknown[] }[] = []
  const updateChanges = [...(opts.updateChanges ?? [])]
  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('FROM tasks')) return (opts.task as unknown as T) ?? null
                if (sql.includes('FROM agents')) return (AGENT as unknown as T)
                if (sql.includes('SELECT department_id FROM squads')) {
                  return ({ department_id: 'dept-1' } as unknown as T)
                }
                if (sql.includes('FROM squads')) return ({ charter: opts.charter ?? null } as unknown as T)
                return null as unknown as T
              },
              async run() {
                if (sql.includes('UPDATE tasks')) {
                  updates.push({ sql, args })
                  return { meta: { changes: updateChanges.shift() ?? 1 } }
                }
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  }
  return { env: env as never, updates }
}

const okModel = (out: string): ModelPort => ({ chat: vi.fn(async () => out) })
const throwingModel = (msg: string): ModelPort => ({
  chat: vi.fn(async () => {
    throw new Error(msg)
  }),
})

describe('resolveTaskId', () => {
  it('reads a top-level task_id', () => {
    expect(resolveTaskId({ task_id: 't-9' })).toBe('t-9')
  })
  it('reads a task_id nested in a BusEvent payload', () => {
    expect(resolveTaskId({ payload: { task_id: 't-7' } })).toBe('t-7')
  })
  it('returns null when no task id is present', () => {
    expect(resolveTaskId({})).toBeNull()
    expect(resolveTaskId({ task_id: '' })).toBeNull()
    expect(resolveTaskId({ payload: { other: 1 } })).toBeNull()
  })
})

describe('capResult', () => {
  it('passes short output through untouched', () => {
    expect(capResult('hello')).toBe('hello')
  })
  it('caps runaway output at the ceiling', () => {
    const capped = capResult('x'.repeat(MAX_RESULT_CHARS + 500))
    expect(capped.length).toBe(MAX_RESULT_CHARS)
    expect(capped.endsWith('…')).toBe(true)
  })
})

describe('runTaskExecution — success', () => {
  it('marks in_progress, calls the model, persists done + result, emits task.completed', async () => {
    const { env, updates } = makeEnv({ task: makeTask(), charter: 'Be useful.' })
    const events: BusEvent[] = []
    const remembered: string[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model: okModel('Here is the finished intro.'),
      emit: async (e) => {
        events.push(e)
      },
      remember: async (_id, text) => {
        remembered.push(text)
        return 'engram-1'
      },
    })

    expect(r.ok).toBe(true)
    expect(r.task_status).toBe('done')

    // First UPDATE claims + flips to in_progress; the terminal UPDATE lands 'done'.
    expect(updates[0].sql).toContain("status = 'in_progress'")
    const terminal = updates[updates.length - 1]
    expect(terminal.sql).toContain('SET status = ?')
    expect(terminal.args[0]).toBe('done')
    expect(terminal.args[1]).toBe('Here is the finished intro.')
    expect(terminal.args[2]).not.toBeNull() // completed_at stamped

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('task.completed')
    expect(remembered).toHaveLength(1)
  })
})

describe('runTaskExecution — failure (NEVER stuck in_progress)', () => {
  it('on a model throw, lands the task in blocked with an error note + emits task.blocked', async () => {
    const { env, updates } = makeEnv({ task: makeTask() })
    const events: BusEvent[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model: throwingModel('provider 503'),
      emit: async (e) => {
        events.push(e)
      },
      remember: async () => 'noop',
    })

    expect(r.ok).toBe(false)
    expect(r.task_status).toBe('blocked')

    const terminal = updates[updates.length - 1]
    expect(terminal.args[0]).toBe('blocked')
    expect(String(terminal.args[1])).toContain('provider 503')
    expect(terminal.args[2]).not.toBeNull() // completed_at stamped on failure too

    // Crucially, the last write is NOT 'in_progress' — it is never left stuck.
    expect(terminal.args[0]).not.toBe('in_progress')
    expect(events[events.length - 1].type).toBe('task.blocked')
  })

  it('a failed bus emit does not flip the persisted result back', async () => {
    const { env, updates } = makeEnv({ task: makeTask() })
    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model: okModel('done work'),
      emit: async () => {
        throw new Error('queue down')
      },
      remember: async () => 'noop',
    })
    expect(r.ok).toBe(true)
    expect(r.task_status).toBe('done')
    expect(updates[updates.length - 1].args[0]).toBe('done')
  })
})

// K1: gated execution success lands 'review', not 'done'
describe('runTaskExecution — K1 gated task lands review', () => {
  it('success on a task with gate_owner lands status=review + emits task.review', async () => {
    const gatedTask = makeTask({ gate_owner: 'gate:outreach' })
    const { env, updates } = makeEnv({ task: gatedTask, charter: 'Ship safely.' })
    const events: BusEvent[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model: okModel('Work product here.'),
      emit: async (e) => { events.push(e) },
      remember: async () => 'engram-1',
    })

    expect(r.ok).toBe(true)
    // K1: gated success lands 'review', not 'done'
    expect(r.task_status).toBe('review')

    // The terminal UPDATE must write 'review'
    const terminal = updates[updates.length - 1]
    expect(terminal.args[0]).toBe('review')

    // Event type must be 'task.review' for gated task
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('task.review')
  })

  it('success on an ungated task still lands done (regression guard)', async () => {
    const ungatedTask = makeTask({ gate_owner: null })
    const { env, updates } = makeEnv({ task: ungatedTask })
    const events: BusEvent[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model: okModel('Done.'),
      emit: async (e) => { events.push(e) },
      remember: async () => 'x',
    })

    expect(r.ok).toBe(true)
    expect(r.task_status).toBe('done')
    expect(updates[updates.length - 1].args[0]).toBe('done')
    expect(events[0].type).toBe('task.completed')
  })
})

describe('runTaskExecution — fail-closed scope (RBAC boundary)', () => {
  it('returns task_not_found when the task is missing / not in this squad, with NO writes', async () => {
    const { env, updates } = makeEnv({ task: null })
    const model = okModel('should never run')

    const r = await runTaskExecution(env, AGENT, 'ghost', { model, emit: async () => {}, remember: async () => 'x' })

    expect(r.ok).toBe(false)
    expect(r.error).toBe('task_not_found')
    expect(model.chat).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0) // nothing persisted for an out-of-scope task
  })

  it('returns task_not_found with no effects when the task is assigned to another agent', async () => {
    const { env, updates } = makeEnv({ task: makeTask({ assignee_agent_id: 'agent-2' }) })
    const model = okModel('should never run')
    const emit = vi.fn()
    const remember = vi.fn()
    const checkAndReserve = vi.fn()
    const recordTokens = vi.fn()

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model,
      emit,
      remember,
      meter: { checkAndReserve, recordTokens },
    })

    expect(r).toMatchObject({ ok: false, task_id: 'task-1', error: 'task_not_found' })
    expect(updates).toHaveLength(0)
    expect(model.chat).not.toHaveBeenCalled()
    expect(checkAndReserve).not.toHaveBeenCalled()
    expect(recordTokens).not.toHaveBeenCalled()
    expect(remember).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('does not execute when assignment or status changes before the atomic claim', async () => {
    const { env, updates } = makeEnv({
      task: makeTask({ assignee_agent_id: AGENT.id }),
      updateChanges: [0],
    })
    const model = okModel('must not run')
    const emit = vi.fn()

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model,
      emit,
      remember: async () => 'x',
    })

    expect(r).toMatchObject({ ok: false, error: 'task_claim_lost' })
    expect(model.chat).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
    expect(updates).toHaveLength(1)
  })

  it('does not overwrite a task reassigned while the model was running', async () => {
    const { env, updates } = makeEnv({
      task: makeTask({ assignee_agent_id: AGENT.id }),
      updateChanges: [1, 0],
    })
    const model = okModel('stale result')
    const emit = vi.fn()
    const remember = vi.fn()

    const r = await runTaskExecution(env, AGENT, 'task-1', { model, emit, remember })

    expect(r).toMatchObject({ ok: false, error: 'task_claim_lost' })
    expect(model.chat).toHaveBeenCalledOnce()
    expect(emit).not.toHaveBeenCalled()
    expect(remember).not.toHaveBeenCalled()
    expect(updates).toHaveLength(2)
  })
})

describe('runTaskExecution — idempotency / K6 no-op gate statuses', () => {
  // K6: execute no-ops for statuses outside {open, in_progress, blocked, rejected}.
  // 'done', 'review', 'approved' must never re-enter the execution loop.
  const noOpStatuses: Task['status'][] = ['in_progress', 'done', 'review', 'approved']

  for (const status of noOpStatuses) {
    it(`no-ops on status=${status} without any writes`, async () => {
      const { env, updates } = makeEnv({ task: makeTask({ status }) })
      const model = okModel('would clobber')

      const r = await runTaskExecution(env, AGENT, 'task-1', {
        model,
        emit: async () => {},
        remember: async () => 'x',
      })

      expect(r.ok).toBe(true)
      expect(r.decided).toBe(`no_op:${status}`)
      expect(r.task_status).toBe(status)
      expect(model.chat).not.toHaveBeenCalled()
      expect(updates).toHaveLength(0)
    })
  }

  it('executes normally on rejected (rework authorised)', async () => {
    const { env, updates } = makeEnv({ task: makeTask({ status: 'rejected' }) })
    const r = await runTaskExecution(env, AGENT, 'task-1', {
      model: okModel('rework done'),
      emit: async () => {},
      remember: async () => 'x',
    })
    // rejected is workable — it should execute and land done (ungated task)
    expect(r.ok).toBe(true)
    expect(updates.length).toBeGreaterThan(0)
  })
})

describe('runTaskExecution — budget cap (#4)', () => {
  it('hard-blocks before any model call when the dollar cap is breached', async () => {
    const { env, updates } = makeEnv({ task: makeTask() })
    const model = okModel('should not run')
    const checkAndReserve = vi.fn(async () => ({
      ok: false as const,
      reason: 'budget_cap_exceeded' as const,
      windowKey: 'w',
      count: 0,
      tokens: 0,
      retryAfterSec: 100,
    }))
    const agent: Agent = { ...AGENT, budget_cap_cents: 10 } as Agent
    const r = await runTaskExecution(env, agent, 'task-1', {
      model,
      meter: { checkAndReserve, recordTokens: vi.fn() },
      emit: async () => {},
      remember: async () => 'x',
    })
    // The whole point: no spend happens when over budget.
    expect(model.chat).not.toHaveBeenCalled()
    expect(r.ok).toBe(false)
    expect(r.task_status).toBe('blocked')
    expect(r.error).toBe('budget_cap_exceeded')
    // task row was transitioned to blocked, never left in_progress.
    expect(updates.some((u) => String(u.args[0]) === 'blocked')).toBe(true)
  })
})
