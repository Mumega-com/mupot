// tests/tasks-completion-gate.test.ts — Door 5: completion gate.
//
// A task may NOT be marked DONE while its done_when is a placeholder sentinel.
// Presence was enforced at creation (Door 3). This gate closes the loop:
// the predicate must be real and checkable at COMPLETION time too.
//
// Coverage:
//  (a) assertCompletableDoneWhen rejects each known sentinel
//  (b) assertCompletableDoneWhen rejects blank / null / undefined
//  (c) assertCompletableDoneWhen accepts a real predicate
//  (d) isPlaceholderDoneWhen correctly identifies sentinels
//  (e) execute path: ungated task with placeholder done_when → blocked (not done)
//  (f) execute path: ungated task with real done_when → review, not done (BLOCK-2
//      close, 2026-07-20 re-gate on PR #417 — self-completion never writes done)
//  (g) execute path: gated task with placeholder done_when → review (gate goes first; not blocked by Door 5)
//
// Tests (a)–(d) are pure unit tests (no env needed).
// Tests (e)–(g) use the execute.test.ts stub pattern.

import { describe, expect, it, vi } from 'vitest'
import {
  assertCompletableDoneWhen,
  isPlaceholderDoneWhen,
  isDoneWhenValid,
} from '../src/tasks/service'
import { runTaskExecution } from '../src/agents/execute'
import type { Agent, Task, ModelPort } from '../src/types'
import type { Env } from '../src/types'

// ── Pure guard unit tests ─────────────────────────────────────────────────────

describe('isPlaceholderDoneWhen', () => {
  it('identifies the DB migration default sentinel', () => {
    expect(isPlaceholderDoneWhen('(backfill required)')).toBe(true)
  })

  it('identifies the IM/channel inbound sentinel', () => {
    expect(isPlaceholderDoneWhen('(set via task update)')).toBe(true)
  })

  it('identifies the agent-do model-fallback sentinel', () => {
    expect(isPlaceholderDoneWhen('(agent-generated — set via task update)')).toBe(true)
  })

  it('matches sentinel with leading/trailing whitespace', () => {
    expect(isPlaceholderDoneWhen('  (backfill required)  ')).toBe(true)
  })

  it('does NOT flag a real predicate as a sentinel', () => {
    expect(isPlaceholderDoneWhen('GET /health returns 200')).toBe(false)
  })

  it('does NOT flag a GitHub predicate as a sentinel', () => {
    expect(isPlaceholderDoneWhen('GitHub issue #42 closed')).toBe(false)
  })

  it('does NOT flag a loop-gate predicate as a sentinel', () => {
    expect(isPlaceholderDoneWhen('Loop act "send_email" approved and applied')).toBe(false)
  })
})

describe('assertCompletableDoneWhen', () => {
  // (b) blank / null / undefined
  it('throws done_when_placeholder for an empty string', () => {
    expect(() => assertCompletableDoneWhen('')).toThrow('done_when_placeholder')
  })

  it('throws done_when_placeholder for whitespace-only', () => {
    expect(() => assertCompletableDoneWhen('   ')).toThrow('done_when_placeholder')
  })

  it('throws done_when_placeholder for null', () => {
    expect(() => assertCompletableDoneWhen(null)).toThrow('done_when_placeholder')
  })

  it('throws done_when_placeholder for undefined', () => {
    expect(() => assertCompletableDoneWhen(undefined)).toThrow('done_when_placeholder')
  })

  // (a) known sentinels
  it('throws done_when_placeholder for the DB migration sentinel', () => {
    expect(() => assertCompletableDoneWhen('(backfill required)')).toThrow('done_when_placeholder')
  })

  it('throws done_when_placeholder for the IM/channel sentinel', () => {
    expect(() => assertCompletableDoneWhen('(set via task update)')).toThrow('done_when_placeholder')
  })

  it('throws done_when_placeholder for the agent-do model-fallback sentinel', () => {
    expect(() => assertCompletableDoneWhen('(agent-generated — set via task update)')).toThrow('done_when_placeholder')
  })

  // (c) real predicates — must NOT throw
  it('accepts a real checkable predicate without throwing', () => {
    expect(() => assertCompletableDoneWhen('GET /health returns 200')).not.toThrow()
  })

  it('accepts a GitHub-derived predicate without throwing', () => {
    expect(() => assertCompletableDoneWhen('GitHub issue #99 closed')).not.toThrow()
  })

  it('accepts a short but valid predicate without throwing', () => {
    expect(() => assertCompletableDoneWhen('tests pass')).not.toThrow()
  })

  it('thrown error carries code done_when_placeholder', () => {
    try {
      assertCompletableDoneWhen('(backfill required)')
      expect.fail('should have thrown')
    } catch (err) {
      expect((err as Error & { code?: string }).code).toBe('done_when_placeholder')
    }
  })
})

// ── Execute path (Door 5 enforcement) ────────────────────────────────────────

const AGENT: Agent = {
  id: 'agent-exec',
  squad_id: 'squad-1',
  slug: 'exec',
  name: 'Executor',
  role: 'executor',
  model: '@cf/meta/llama-3.3',
  status: 'active',
  created_at: '2026-06-13T00:00:00.000Z',
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 'task-d5',
    squad_id: 'squad-1',
    title: 'Do a thing',
    body: 'details here',
    done_when: 'task verified by automated check',  // default: real predicate
    status: 'open',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    created_at: '2026-06-13T00:00:00.000Z',
    updated_at: '2026-06-13T00:00:00.000Z',
    ...over,
  }
}

function makeEnv(opts: { task: Task | null }) {
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
                if (sql.includes('FROM squads')) return ({ charter: null } as unknown as T)
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
  return { env: env as never as Env, updates }
}

const okModel: ModelPort = { chat: vi.fn(async () => 'Here is the completed work.') }

// Meter stub: always permits execution (checkAndReserve ok), recordTokens no-op.
const permissiveMeter = {
  checkAndReserve: vi.fn(async () => ({
    ok: true as const,
    reason: '',
    windowKey: '',
    retryAfterSec: 0,
  })),
  recordTokens: vi.fn(async () => {}),
}

// (e) ungated task with placeholder done_when → BLOCKED (not done)
describe('execute — Door 5 completion gate', () => {
  it('(e) blocks an ungated task whose done_when is a placeholder sentinel', async () => {
    const task = makeTask({
      done_when: '(set via task update)',  // placeholder sentinel
      status: 'open',
      gate_owner: null,
    })
    const { env, updates } = makeEnv({ task })

    const result = await runTaskExecution(env, AGENT, task.id, {
      model: okModel,
      emit: vi.fn(async () => {}),
      remember: vi.fn(async () => {}),
      meter: permissiveMeter,
    })

    // Door 5 blocks completion — task must land 'blocked', not 'done'
    expect(result.ok).toBe(false)
    expect(result.error).toBe('done_when_placeholder')
    expect(result.task_status).toBe('blocked')

    // An UPDATE to 'blocked' must have been written, not to 'done'
    const doneUpdates = updates.filter(u => (u.args as unknown[]).includes('done'))
    expect(doneUpdates).toHaveLength(0)
    const blockedUpdates = updates.filter(u => (u.args as unknown[]).includes('blocked'))
    expect(blockedUpdates.length).toBeGreaterThan(0)
  })

  it('(e) blocks when done_when is the agent-generated sentinel', async () => {
    const task = makeTask({
      done_when: '(agent-generated — set via task update)',
      status: 'open',
      gate_owner: null,
    })
    const { env } = makeEnv({ task })

    const result = await runTaskExecution(env, AGENT, task.id, {
      model: okModel,
      emit: vi.fn(async () => {}),
      remember: vi.fn(async () => {}),
      meter: permissiveMeter,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('done_when_placeholder')
  })

  it('(e) blocks when done_when is the DB backfill sentinel', async () => {
    const task = makeTask({
      done_when: '(backfill required)',
      status: 'open',
      gate_owner: null,
    })
    const { env } = makeEnv({ task })

    const result = await runTaskExecution(env, AGENT, task.id, {
      model: okModel,
      emit: vi.fn(async () => {}),
      remember: vi.fn(async () => {}),
      meter: permissiveMeter,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('done_when_placeholder')
  })

  // (f) ungated task with real done_when → review, not done (BLOCK-2 close,
  // 2026-07-20 re-gate on PR #417: an agent's own dispatch-completion never
  // writes 'done' directly anymore, gated or not — Door 5's placeholder check
  // still fires the same as before, it just now guards a 'review' proposal
  // instead of a direct 'done' write).
  it('(f) proposes review (not done) for an ungated task whose done_when is a real predicate', async () => {
    const task = makeTask({
      done_when: 'GET /api/health returns { ok: true }',
      status: 'open',
      gate_owner: null,
    })
    const { env, updates } = makeEnv({ task })

    const result = await runTaskExecution(env, AGENT, task.id, {
      model: okModel,
      emit: vi.fn(async () => {}),
      remember: vi.fn(async () => {}),
      meter: permissiveMeter,
    })

    expect(result.ok).toBe(true)
    expect(result.task_status).toBe('review')

    const doneUpdates = updates.filter(u => (u.args as unknown[]).includes('done'))
    expect(doneUpdates).toHaveLength(0)
    const reviewUpdates = updates.filter(u => (u.args as unknown[]).includes('review'))
    expect(reviewUpdates.length).toBeGreaterThan(0)
  })

  // (g) gated task with placeholder done_when → review (gate path; Door 5 not reached)
  it('(g) gated task with placeholder done_when lands review — Door 5 is never reached on gated path', async () => {
    const task = makeTask({
      done_when: '(set via task update)',  // placeholder
      status: 'open',
      gate_owner: 'gate:outreach',         // gated → successStatus = 'review', not 'done'
    })
    const { env, updates } = makeEnv({ task })

    const result = await runTaskExecution(env, AGENT, task.id, {
      model: okModel,
      emit: vi.fn(async () => {}),
      remember: vi.fn(async () => {}),
      meter: permissiveMeter,
    })

    // Gated tasks land 'review', not 'done' — Door 5 guard only fires on the direct-done path
    expect(result.ok).toBe(true)
    expect(result.task_status).toBe('review')

    const reviewUpdates = updates.filter(u => (u.args as unknown[]).includes('review'))
    expect(reviewUpdates.length).toBeGreaterThan(0)
  })
})

// Quick assertion: isDoneWhenValid is unchanged from Door 3 (sentinel check is separate)
describe('isDoneWhenValid — unchanged by Door 5', () => {
  it('still accepts a sentinel (presence check only — sentinel detection is isPlaceholderDoneWhen)', () => {
    // isDoneWhenValid is a presence check; placeholder detection is the separate guard
    expect(isDoneWhenValid('(set via task update)')).toBe(true)
  })

  it('still rejects empty string', () => {
    expect(isDoneWhenValid('')).toBe(false)
  })
})
