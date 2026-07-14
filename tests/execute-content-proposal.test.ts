// tests/execute-content-proposal.test.ts — runTaskExecution's content-intent
// branch (finishContentProposal, src/agents/execute.ts). Same hand-mocked-D1
// convention as tests/execute.test.ts (the file this branch lives in): the stub
// records every UPDATE tasks so the test can assert the exact transition, and
// answers SELECTs deterministically. gate.propose()'s INSERT INTO
// department_proposals falls through the stub's generic `run()` (changes:1),
// same as every non-'UPDATE tasks' write in the existing suite's convention.
//
// The cross-table propose→approve→execute→done chain (the genuinely novel,
// multi-table part) is proven against REAL SQLite in
// tests/content-proposal-loop-sqlite.test.ts — this file covers runTaskExecution's
// own branch logic and its failure modes in isolation.

import { describe, expect, it, vi } from 'vitest'
// Partial mock (same pattern as tests/s4-live-wiring.test.ts): pass every real
// export through except getRegistered, which starts as a real passthrough spy so
// most tests exercise the genuine registry, but one test below can force a single
// "not registered" return without disturbing the production singleton or any
// other test's state.
vi.mock('../src/departments/registry', async (orig) => {
  const real = await orig<typeof import('../src/departments/registry')>()
  return { ...real, getRegistered: vi.fn(real.getRegistered) }
})

import { runTaskExecution, CONTENT_GATE_OWNER } from '../src/agents/execute'
import type { Agent, Task, BusEvent } from '../src/types'
// Side-effect import: registers GrowthModule (the only department declaring the
// 'content-publish' work-type) in this test file's module registry. Mirrors the
// convention in tests/department-proposals-durability.test.ts.
import '../src/departments/modules/growth'
import { getRegistered } from '../src/departments/registry'

const mockGetRegistered = vi.mocked(getRegistered)

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
    title: 'publish: Why drafts, not posts',
    body: 'Inkwell always writes a draft first.',
    done_when: 'Article approved and live',
    status: 'open',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
    ...over,
  }
}

function makeEnv(opts: { task: Task | null; updateChanges?: number[] }) {
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
                if (sql.includes('FROM squads')) return ({ charter: null } as unknown as T)
                return null as unknown as T
              },
              async run() {
                if (sql.includes('UPDATE tasks')) {
                  updates.push({ sql, args })
                  return { meta: { changes: updateChanges.shift() ?? 1 } }
                }
                // department_proposals INSERT and any other write: succeed inertly.
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

const noopModel = { chat: vi.fn(async () => 'SHOULD NOT BE CALLED') }

describe('runTaskExecution — content-intent short-circuit', () => {
  it('a "publish:" task never calls the model and lands review, gated + gate_owner stamped', async () => {
    const { env, updates } = makeEnv({ task: makeTask() })
    const events: BusEvent[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      executionReceiptId: 'dispatch-receipt-1',
      model: noopModel,
      emit: async (e) => {
        events.push(e)
      },
    })

    expect(r.ok).toBe(true)
    expect(r.task_status).toBe('review')
    expect(noopModel.chat).not.toHaveBeenCalled()

    // First UPDATE claims + flips to in_progress (unchanged path).
    expect(updates[0].sql).toContain("status = 'in_progress'")

    // Terminal UPDATE is the content-proposal write, not finishTask's generic one:
    // status forced to 'review', gate_owner stamped, scoped to the SAME claim.
    const terminal = updates[updates.length - 1]
    expect(terminal.sql).toContain("SET status = 'review'")
    expect(terminal.sql).toContain('gate_owner = COALESCE(gate_owner, ?)')
    expect(terminal.args).toContain(CONTENT_GATE_OWNER)
    expect(terminal.args).toContain('dispatch-receipt-1')

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('task.review')
  })

  it('gateId equals the task id — the idGen trick (proposal readable via department_proposals under task.id)', async () => {
    // Prove the load-bearing property directly: mint the SAME ctx shape
    // finishContentProposal uses and confirm gate.propose's gateId === task.id.
    const module = getRegistered('growth')
    expect(module).toBeDefined()
    const { kernelMintCtx } = await import('../src/departments/kernel')
    const inserted: unknown[][] = []
    const db = {
      prepare(sql: string) {
        return {
          bind: (...a: unknown[]) => ({
            run: async () => {
              if (sql.includes('department_proposals')) inserted.push(a)
              return { meta: { changes: 1 } }
            },
            first: async () => null,
          }),
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any

    const ctx = kernelMintCtx(
      { db },
      {
        tenantId: 'test-tenant',
        departmentKey: 'growth',
        module: module!,
        capabilities: ['lead'],
        idGen: () => 'task-1',
      },
    )
    const { gateId } = await ctx.gate.propose({
      action: 'content-publish',
      payload: { executor: 'inkwell-content', title: 'X', content: 'Y', status: 'draft' },
    })
    expect(gateId).toBe('task-1')
    expect(inserted[0][0]).toBe('task-1') // gate_id column, positional bind #1
  })

  it('an ordinary (non-"publish:") task is unaffected — falls through to the model path', async () => {
    const { env } = makeEnv({ task: makeTask({ title: 'Draft the Q3 summary', body: 'notes' }) })
    const events: BusEvent[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      executionReceiptId: 'dispatch-receipt-2',
      model: { chat: vi.fn(async () => 'A normal LLM answer.') },
      emit: async (e) => {
        events.push(e)
      },
    })

    expect(r.ok).toBe(true)
    expect(r.task_status).toBe('done') // ungated task, model path, unchanged behavior
    expect(events[0].type).toBe('task.completed')
  })

  it('department not registered → blocked with a clear reason, never stuck in_progress (fail-closed)', async () => {
    mockGetRegistered.mockReturnValueOnce(undefined)
    const { env, updates } = makeEnv({ task: makeTask() })
    const events: BusEvent[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      executionReceiptId: 'dispatch-receipt-3',
      model: noopModel,
      emit: async (e) => {
        events.push(e)
      },
    })

    expect(r.ok).toBe(false)
    expect(r.task_status).toBe('blocked')
    expect(r.error).toBe('department_not_registered')
    const terminal = updates[updates.length - 1]
    expect(terminal.args[0]).toBe('blocked')
    expect(String(terminal.args[1])).toContain('content_proposal_failed')
    expect(events[0].type).toBe('task.blocked')
  })

  it('a capability the work-type rejects (simulated via an unregistered action) blocks, not crashes', async () => {
    // Point getRegistered at a real-shaped but empty-channels module so
    // ctx.gate.propose('content-publish', ...) hits the kernel's own
    // 'work_type_not_declared' fail-closed check — proving finishContentProposal's
    // catch block absorbs a genuine CtxError from the kernel (not just a
    // registry-lookup miss) and still lands the task 'blocked', never throwing
    // out of runTaskExecution.
    const real = getRegistered('growth')
    expect(real).toBeDefined()
    mockGetRegistered.mockReturnValueOnce({ ...real!, channels: [] })
    const { env, updates } = makeEnv({ task: makeTask() })
    const events: BusEvent[] = []

    const r = await runTaskExecution(env, AGENT, 'task-1', {
      executionReceiptId: 'dispatch-receipt-4',
      model: noopModel,
      emit: async (e) => {
        events.push(e)
      },
    })

    expect(r.ok).toBe(false)
    expect(r.task_status).toBe('blocked')
    expect(r.error).toBe('work_type_not_declared')
    expect(events[0].type).toBe('task.blocked')
  })
})
