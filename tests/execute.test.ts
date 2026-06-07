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
    status: 'open',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
    ...over,
  }
}

// A hand-mocked DB: returns a seeded task for the scoped SELECT, a seeded charter
// for the squad SELECT, and records every UPDATE so the test can assert the row
// transitions (in_progress → done|blocked) and never gets stuck.
function makeEnv(opts: { task: Task | null; charter?: string | null }) {
  const updates: { sql: string; args: unknown[] }[] = []
  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('FROM tasks')) return (opts.task as unknown as T) ?? null
                if (sql.includes('FROM squads')) return ({ charter: opts.charter ?? null } as unknown as T)
                return null as unknown as T
              },
              async run() {
                if (sql.includes('UPDATE tasks')) updates.push({ sql, args })
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
})

describe('runTaskExecution — idempotency', () => {
  it('leaves an already-done task untouched (the bus may redeliver)', async () => {
    const { env, updates } = makeEnv({ task: makeTask({ status: 'done', result: 'prior' }) })
    const model = okModel('would clobber')

    const r = await runTaskExecution(env, AGENT, 'task-1', { model, emit: async () => {}, remember: async () => 'x' })

    expect(r.ok).toBe(true)
    expect(r.decided).toBe('already_done')
    expect(model.chat).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0) // no re-run, no clobber
  })
})
