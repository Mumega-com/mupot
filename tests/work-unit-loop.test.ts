// tests/work-unit-loop.test.ts — goal-seeking loop (issue #27).
//
// Tests runGoalCycle and updateKpiProgress in full isolation using injected
// deps (no D1, no Vectorize, no model calls). Covers:
//   - no-goal no-op (agent has no okr)
//   - kpi-met no-op (kpi_progress >= 100)
//   - rate_limited path (meter blocks)
//   - effort=low → observe-only (no tasks, progress update attempted)
//   - each autonomy → correct task disposition (open / dispatched / gated)
//   - effort → task budget (how many tasks spawned)
//   - updateKpiProgress math (integer denominator + fractional + zero)
//   - updateKpiProgress with no denominator → no change

import { describe, it, expect, vi } from 'vitest'
import {
  runGoalCycle,
  updateKpiProgress,
  parseLeadingInt,
  EFFORT_TASK_BUDGET,
} from '../src/agents/loop'
import type { Env, Agent } from '../src/types'
import type { LoopDeps } from '../src/agents/loop'
import type { Task } from '../src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    squad_id: 'squad-1',
    slug: 'test-agent',
    name: 'Test Agent',
    role: 'engineer',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: 'Ship 10 features this quarter',
    kpi_target: '10 tasks',
    kpi_progress: 0,
    effort: 'standard',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// Minimal Env stub — loop.ts only touches env via injected deps (meter, createTask,
// etc.), but env is still passed to runGoalCycle for the non-mocked path. We keep
// it minimal: DB is used by updateKpiProgress (injected via writeProgress dep).
function makeEnv(dbStubs: {
  agentProgress?: number | null
  taskDoneCount?: number
  changes?: number
} = {}): { env: Env; dbCalls: { sql: string; binds: unknown[] }[] } {
  const dbCalls: { sql: string; binds: unknown[] }[] = []

  const env = {
    TENANT_SLUG: 'test',
    DB: {
      prepare(sql: string) {
        const call: { sql: string; binds: unknown[] } = { sql, binds: [] }
        dbCalls.push(call)
        const stmt = {
          bind(...args: unknown[]) {
            call.binds = args
            return stmt
          },
          async first<T>(): Promise<T | null> {
            if (sql.includes('kpi_progress') && sql.includes('SELECT')) {
              const v = dbStubs.agentProgress ?? 0
              return { kpi_progress: v } as unknown as T
            }
            if (sql.includes('COUNT(*)')) {
              return { cnt: dbStubs.taskDoneCount ?? 0 } as unknown as T
            }
            return null
          },
          async run() {
            return { meta: { changes: dbStubs.changes ?? 1 } }
          },
        }
        return stmt
      },
    },
  } as unknown as Env

  return { env, dbCalls }
}

function makeMeterOk(): LoopDeps['meterCheck'] {
  return vi.fn().mockResolvedValue({
    ok: true,
    windowKey: 'test:agent-1:2026-06-07',
    count: 1,
    tokens: 0,
  })
}

function makeMeterBlocked(): LoopDeps['meterCheck'] {
  return vi.fn().mockResolvedValue({
    ok: false,
    reason: 'rate_limited' as const,
    windowKey: 'test:agent-1:2026-06-07',
    count: 200,
    tokens: 0,
    retryAfterSec: 3600,
  })
}

function makeModel(tasks: { title: string; body: string }[] = []): LoopDeps['model'] {
  return {
    chat: vi.fn().mockResolvedValue(JSON.stringify({
      summary: 'plan next step',
      tasks,
    })),
  }
}

function makeRecall(): NonNullable<LoopDeps['recall']> {
  return vi.fn().mockResolvedValue([])
}

function makeCreateTask(): LoopDeps['createTask'] {
  return vi.fn().mockImplementation(
    async (_env: Env, input: { squad_id: string; title: string; body?: string; gate_owner?: string | null; assignee_agent_id?: string | null }) => ({
      id: 'task-' + Math.random().toString(36).slice(2),
      squad_id: input.squad_id,
      title: input.title,
      body: input.body ?? '',
      status: 'open' as const,
      assignee_agent_id: input.assignee_agent_id ?? null,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: input.gate_owner ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } satisfies Task),
  )
}

function makeDispatch(): NonNullable<LoopDeps['dispatch']> {
  return vi.fn().mockResolvedValue(undefined)
}

function makeWriteProgress(): NonNullable<LoopDeps['writeProgress']> {
  return vi.fn().mockResolvedValue(undefined)
}

// ── Guard paths ───────────────────────────────────────────────────────────────

describe('runGoalCycle — no-goal no-op', () => {
  it('returns decided=no-goal when agent has no okr', async () => {
    const agent = makeAgent({ okr: null })
    const { env } = makeEnv()
    const result = await runGoalCycle(env, agent, {})
    expect(result).toMatchObject({ ok: true, decided: 'no-goal', spawned: 0 })
  })

  it('returns decided=no-goal when okr is empty string', async () => {
    const agent = makeAgent({ okr: '' })
    const { env } = makeEnv()
    const result = await runGoalCycle(env, agent, {})
    expect(result).toMatchObject({ ok: true, decided: 'no-goal', spawned: 0 })
  })

  it('returns decided=no-goal when okr is whitespace-only', async () => {
    const agent = makeAgent({ okr: '   ' })
    const { env } = makeEnv()
    const result = await runGoalCycle(env, agent, {})
    expect(result).toMatchObject({ ok: true, decided: 'no-goal', spawned: 0 })
  })

  it('does NOT call the meter when there is no goal (no meter spend)', async () => {
    const agent = makeAgent({ okr: null })
    const { env } = makeEnv()
    const meter = makeMeterOk()
    await runGoalCycle(env, agent, { meterCheck: meter })
    expect(meter).not.toHaveBeenCalled()
  })
})

describe('runGoalCycle — kpi-met no-op', () => {
  it('returns decided=kpi-met when kpi_progress=100', async () => {
    const agent = makeAgent({ kpi_progress: 100 })
    const { env } = makeEnv()
    const meter = makeMeterOk()
    const result = await runGoalCycle(env, agent, { meterCheck: meter })
    expect(result).toMatchObject({ ok: true, decided: 'kpi-met', spawned: 0 })
  })

  it('returns decided=kpi-met when kpi_progress>100 (overshot)', async () => {
    const agent = makeAgent({ kpi_progress: 110 })
    const { env } = makeEnv()
    const result = await runGoalCycle(env, agent, {})
    expect(result).toMatchObject({ ok: true, decided: 'kpi-met', spawned: 0 })
  })

  it('does NOT call the meter when kpi is met', async () => {
    const agent = makeAgent({ kpi_progress: 100 })
    const { env } = makeEnv()
    const meter = makeMeterOk()
    await runGoalCycle(env, agent, { meterCheck: meter })
    expect(meter).not.toHaveBeenCalled()
  })
})

describe('runGoalCycle — rate_limited path', () => {
  it('returns decided=rate_limited when meter blocks', async () => {
    const agent = makeAgent()
    const { env } = makeEnv()
    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterBlocked(),
      model: makeModel([{ title: 'Proposal', body: 'body' }]),
      createTask: makeCreateTask(),
    })
    expect(result).toMatchObject({ ok: false, decided: 'rate_limited', spawned: 0 })
    expect(result.error).toBe('rate_limited')
  })

  it('does NOT create any tasks when rate_limited', async () => {
    const agent = makeAgent()
    const { env } = makeEnv()
    const ct = makeCreateTask()
    await runGoalCycle(env, agent, {
      meterCheck: makeMeterBlocked(),
      createTask: ct,
    })
    expect(ct).not.toHaveBeenCalled()
  })
})

// ── Effort → task budget ──────────────────────────────────────────────────────

describe('EFFORT_TASK_BUDGET map', () => {
  it('low=0, standard=1, high=2, sprint=3', () => {
    expect(EFFORT_TASK_BUDGET.low).toBe(0)
    expect(EFFORT_TASK_BUDGET.standard).toBe(1)
    expect(EFFORT_TASK_BUDGET.high).toBe(2)
    expect(EFFORT_TASK_BUDGET.sprint).toBe(3)
  })
})

describe('runGoalCycle — effort=low observe-only', () => {
  it('returns decided=observe-only, spawned=0', async () => {
    const agent = makeAgent({ effort: 'low' })
    const { env } = makeEnv()
    const ct = makeCreateTask()
    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      createTask: ct,
      writeProgress: makeWriteProgress(),
    })
    expect(result).toMatchObject({ ok: true, decided: 'observe-only', spawned: 0 })
    expect(ct).not.toHaveBeenCalled()
  })
})

describe('runGoalCycle — effort bounds task count', () => {
  const cases: Array<[string, number]> = [
    ['standard', 1],
    ['high', 2],
    ['sprint', 3],
  ]

  it.each(cases)('effort=%s spawns at most %i tasks from model proposals', async (effort, expected) => {
    const agent = makeAgent({ effort: effort as Agent['effort'], autonomy: 'draft' })
    const { env } = makeEnv()

    // Model returns more proposals than the budget allows; loop must cap.
    const tooManyProposals = Array.from({ length: 5 }, (_, i) => ({
      title: `Task ${i}`,
      body: `Body ${i}`,
    }))

    const ct = makeCreateTask()
    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      model: makeModel(tooManyProposals),
      recall: makeRecall(),
      createTask: ct,
      writeProgress: makeWriteProgress(),
    })

    expect(result.ok).toBe(true)
    expect(result.spawned).toBe(expected)
    expect(ct).toHaveBeenCalledTimes(expected)
  })
})

// ── Autonomy → task disposition ───────────────────────────────────────────────

describe('runGoalCycle — autonomy disposition table', () => {
  // suggest: open task, no gate, no dispatch
  it('suggest → open task, no gate_owner, no dispatch', async () => {
    const agent = makeAgent({ autonomy: 'suggest', effort: 'standard' })
    const { env } = makeEnv()
    const ct = makeCreateTask()
    const dispatch = makeDispatch()

    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Suggestion', body: 'a suggestion' }]),
      recall: makeRecall(),
      createTask: ct,
      dispatch,
      writeProgress: makeWriteProgress(),
    })

    expect(result.spawned).toBe(1)
    const callArgs = (ct as ReturnType<typeof vi.fn>).mock.calls[0]
    const input = callArgs[1] as { gate_owner: string | null; assignee_agent_id: string | null }
    expect(input.gate_owner).toBeNull()
    expect(input.assignee_agent_id).toBeNull()
    // dispatch is NOT called for suggest
    expect(dispatch).not.toHaveBeenCalled()
  })

  // draft: open task, no gate, no dispatch
  it('draft → open task, no gate_owner, no dispatch', async () => {
    const agent = makeAgent({ autonomy: 'draft', effort: 'standard' })
    const { env } = makeEnv()
    const ct = makeCreateTask()
    const dispatch = makeDispatch()

    await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Draft', body: 'a draft' }]),
      recall: makeRecall(),
      createTask: ct,
      dispatch,
      writeProgress: makeWriteProgress(),
    })

    const input = (ct as ReturnType<typeof vi.fn>).mock.calls[0][1] as { gate_owner: string | null; assignee_agent_id: string | null }
    expect(input.gate_owner).toBeNull()
    expect(input.assignee_agent_id).toBeNull()
    expect(dispatch).not.toHaveBeenCalled()
  })

  // execute: open task, no gate, self-assigned, dispatch called
  it('execute → open task, no gate_owner, self-assigned, dispatch called', async () => {
    const agent = makeAgent({ autonomy: 'execute', effort: 'standard' })
    const { env } = makeEnv()
    const ct = makeCreateTask()
    const dispatch = makeDispatch()

    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Exec Task', body: 'do the work' }]),
      recall: makeRecall(),
      createTask: ct,
      dispatch,
      writeProgress: makeWriteProgress(),
    })

    expect(result.spawned).toBe(1)
    const input = (ct as ReturnType<typeof vi.fn>).mock.calls[0][1] as { gate_owner: string | null; assignee_agent_id: string | null }
    expect(input.gate_owner).toBeNull()
    expect(input.assignee_agent_id).toBe('agent-1') // self-assigned
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  // execute_with_approval: gated task (gate_owner='lead'), self-assigned, dispatch called
  it('execute_with_approval → gated task, gate_owner set, self-assigned, dispatch called', async () => {
    const agent = makeAgent({ autonomy: 'execute_with_approval', effort: 'standard' })
    const { env } = makeEnv()
    const ct = makeCreateTask()
    const dispatch = makeDispatch()

    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Gated Task', body: 'needs approval' }]),
      recall: makeRecall(),
      createTask: ct,
      dispatch,
      writeProgress: makeWriteProgress(),
    })

    expect(result.spawned).toBe(1)
    const input = (ct as ReturnType<typeof vi.fn>).mock.calls[0][1] as { gate_owner: string | null; assignee_agent_id: string | null }
    expect(input.gate_owner).toBe('lead') // gate auto-set
    expect(input.assignee_agent_id).toBe('agent-1') // self-assigned
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})

// ── updateKpiProgress math ────────────────────────────────────────────────────

describe('updateKpiProgress', () => {
  it('returns updated=false when kpi_target is null (no denominator)', async () => {
    const { env } = makeEnv({ agentProgress: 20, taskDoneCount: 3 })
    const result = await updateKpiProgress(env, 'agent-1', null)
    expect(result).toMatchObject({ ok: true, updated: false, previous: 20, current: 20 })
  })

  it('returns updated=false when kpi_target has no leading integer', async () => {
    const { env } = makeEnv({ agentProgress: 5 })
    const result = await updateKpiProgress(env, 'agent-1', 'ship features continuously')
    expect(result).toMatchObject({ ok: true, updated: false, previous: 5, current: 5 })
  })

  it('computes progress = done / target * 100 for simple integer target', async () => {
    // 4 done / 10 target = 40%
    const { env } = makeEnv({ agentProgress: 0, taskDoneCount: 4 })
    const result = await updateKpiProgress(env, 'agent-1', '10 tasks')
    expect(result.ok).toBe(true)
    expect(result.updated).toBe(true)
    expect(result.current).toBe(40)
    expect(result.previous).toBe(0)
  })

  it('clamps progress to 100 when done_count exceeds target', async () => {
    const { env } = makeEnv({ agentProgress: 80, taskDoneCount: 15 })
    const result = await updateKpiProgress(env, 'agent-1', '10 tasks')
    expect(result.current).toBe(100)
  })

  it('returns 0% when no tasks are done', async () => {
    const { env } = makeEnv({ agentProgress: 0, taskDoneCount: 0 })
    const result = await updateKpiProgress(env, 'agent-1', '10')
    expect(result.current).toBe(0)
    // 0/10 = 0 — still "updated" because the DB write path runs
    expect(result.updated).toBe(true)
  })

  it('parses leading integer from kpi_target with trailing text', async () => {
    // "20 PRs/week" → denominator = 20
    const { env } = makeEnv({ agentProgress: 0, taskDoneCount: 5 })
    const result = await updateKpiProgress(env, 'agent-1', '20 PRs/week')
    expect(result.current).toBe(25) // 5/20 * 100
  })
})

// ── parseLeadingInt ───────────────────────────────────────────────────────────

describe('parseLeadingInt', () => {
  it.each([
    ['10 tasks', 10],
    ['20', 20],
    ['1 PR/week', 1],
    ['100 features', 100],
  ])('parses "%s" → %i', (input, expected) => {
    expect(parseLeadingInt(input)).toBe(expected)
  })

  it.each([
    ['ship features continuously', null],
    ['', null],
    [null, null],
    [undefined, null],
    ['abc 10', null],
    ['0 tasks', null],  // 0 is not a valid denominator
  ])('returns null for "%s"', (input, expected) => {
    expect(parseLeadingInt(input as string | null | undefined)).toBe(expected)
  })
})

// ── Smoke: model returns empty tasks array → spawned=0 ────────────────────────

describe('runGoalCycle — model returns no proposals', () => {
  it('spawned=0 when model returns empty tasks array', async () => {
    const agent = makeAgent({ autonomy: 'execute', effort: 'sprint' })
    const { env } = makeEnv()
    const ct = makeCreateTask()

    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      model: makeModel([]),
      recall: makeRecall(),
      createTask: ct,
      dispatch: makeDispatch(),
      writeProgress: makeWriteProgress(),
    })

    expect(result).toMatchObject({ ok: true, decided: 'spawned', spawned: 0 })
    expect(ct).not.toHaveBeenCalled()
  })
})

// ── Smoke: model returns malformed JSON → spawned=0 (defensive parse) ─────────

describe('runGoalCycle — model returns bad JSON', () => {
  it('spawned=0, ok=true when model output is not parseable', async () => {
    const agent = makeAgent({ effort: 'standard' })
    const { env } = makeEnv()
    const ct = makeCreateTask()

    const result = await runGoalCycle(env, agent, {
      meterCheck: makeMeterOk(),
      model: { chat: vi.fn().mockResolvedValue('definitely not json') },
      recall: makeRecall(),
      createTask: ct,
      writeProgress: makeWriteProgress(),
    })

    // parseProposals returns [] on bad JSON → spawned=0
    expect(result.spawned).toBe(0)
    expect(ct).not.toHaveBeenCalled()
  })
})
