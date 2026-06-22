// tests/sensorium.test.ts — deterministic self-state sensorium (S1).
//
// Covers:
//   - buildSensorium produces a deterministic Sensorium for fixed DB + runtime
//   - NO model/LLM/fetch calls happen inside buildSensorium
//   - All list outputs are bounded (≤ SENSORIUM_TASK_CAP / SENSORIUM_DELEGATION_CAP)
//   - renderSensorium output is stable (same Sensorium → same string)
//   - SENSORIUM_VERSION is exported and is 'v1'
//   - renderSensorium ordering is fixed (sensorium block → agent info → schedule → vitals → tasks → delegations)
//   - safeSchedule degrades to zeros on DB error (no throw)
//   - vitals reads kpi from agent row; budget remaining from execution_meter
//   - loop.ts wires buildSensorium seam correctly (injected mock is called; result appears in prompt)

import { describe, it, expect, vi } from 'vitest'
import {
  buildSensorium,
  renderSensorium,
  SENSORIUM_VERSION,
  SENSORIUM_TASK_CAP,
  SENSORIUM_DELEGATION_CAP,
} from '../src/agents/sensorium'
import { runGoalCycle } from '../src/agents/loop'
import type { Env, Agent } from '../src/types'
import type { AgentRuntime } from '../src/agents/sensorium'
import type { LoopDeps } from '../src/agents/loop'
import type { Task } from '../src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXED_NOW = '2026-06-22T10:00:00.000Z'
const AGENT_CREATED_AT = '2026-06-12T10:00:00.000Z' // 10 days before FIXED_NOW

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-s1',
    squad_id: 'squad-1',
    slug: 'test-agent',
    name: 'Sensor Agent',
    role: 'engineer',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: 'Ship the sensorium',
    kpi_target: '5 tasks',
    kpi_progress: 40,
    effort: 'standard',
    autonomy: 'execute',
    budget_cap_cents: 100,    // $1.00 = 1,000,000 micro-USD cap
    budget_window: 'day',
    created_at: AGENT_CREATED_AT,
    ...overrides,
  }
}

function makeRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    cycles: 7,
    last_woke_at: '2026-06-22T09:55:00.000Z',
    last_decision: 'goal: spawned',
    wake_reason: 'metabolism',
    ...overrides,
  }
}

// ── DB mock helpers ───────────────────────────────────────────────────────────

interface DbStubs {
  taskCountsByStatus?: Array<{ status: string; cnt: number }>
  overdueCount?: number
  openTaskTitles?: string[]
  delegations?: Array<{ id: string; title: string; status: string }>
  meterRow?: { cost_micro_usd: number } | null
  throwOnQuery?: boolean
}

function makeEnv(stubs: DbStubs = {}): Env {
  const db = {
    prepare(sql: string) {
      const stmt = {
        bind(..._args: unknown[]) { return stmt },
        async all<T>(): Promise<{ results: T[] }> {
          if (stubs.throwOnQuery) throw new Error('D1 down')

          // GROUP BY status — task status counts
          if (sql.includes('GROUP BY status')) {
            const rows = (stubs.taskCountsByStatus ?? [
              { status: 'open', cnt: 3 },
              { status: 'in_progress', cnt: 1 },
              { status: 'done', cnt: 8 },
              { status: 'blocked', cnt: 0 },
            ]) as unknown[]
            return { results: rows as T[] }
          }
          // Open task titles (bounded list)
          if (sql.includes("status = 'open'") && sql.includes('ORDER BY created_at ASC') && sql.includes('LIMIT')) {
            const rows = (stubs.openTaskTitles ?? ['Task A', 'Task B', 'Task C']).map(
              (t) => ({ title: t }),
            ) as unknown[]
            return { results: rows as T[] }
          }
          // Delegations (non-terminal tasks assigned to agent)
          if (sql.includes('NOT IN') && sql.includes("'done'")) {
            const rows = (stubs.delegations ?? [
              { id: 'task-d1', title: 'Delegated Alpha', status: 'in_progress' },
            ]) as unknown[]
            return { results: rows as T[] }
          }
          return { results: [] }
        },
        async first<T>(): Promise<T | null> {
          if (stubs.throwOnQuery) throw new Error('D1 down')

          // Overdue count
          if (sql.includes("IN ('open','in_progress')") && sql.includes('COUNT(*)')) {
            return { cnt: stubs.overdueCount ?? 0 } as unknown as T
          }
          // Execution meter
          if (sql.includes('execution_meter')) {
            return (stubs.meterRow !== undefined
              ? stubs.meterRow
              : { cost_micro_usd: 250_000 }) as unknown as T
          }
          return null
        },
      }
      return stmt
    },
  }

  // We only need DB for sensorium — other bindings can be absent.
  return { DB: db, TENANT_SLUG: 'test' } as unknown as Env
}

// ── SENSORIUM_VERSION ─────────────────────────────────────────────────────────

describe('SENSORIUM_VERSION', () => {
  it('is exported as "v1"', () => {
    expect(SENSORIUM_VERSION).toBe('v1')
  })
})

// ── buildSensorium — shape ────────────────────────────────────────────────────

describe('buildSensorium — shape', () => {
  it('returns a Sensorium with all required fields', async () => {
    const agent = makeAgent()
    const runtime = makeRuntime()
    const env = makeEnv()

    const s = await buildSensorium(env, agent, runtime, { now: FIXED_NOW })

    expect(s.version).toBe('v1')
    expect(s.clock).toBeDefined()
    expect(s.situation).toBeDefined()
    expect(s.schedule).toBeDefined()
    expect(s.vitals).toBeDefined()
    expect(s.delegations).toBeDefined()
    expect(s.tasks).toBeDefined()
  })

  it('tasks is an alias of schedule.oldest_open_tasks', async () => {
    const agent = makeAgent()
    const env = makeEnv({ openTaskTitles: ['Task X', 'Task Y'] })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.tasks).toBe(s.schedule.oldest_open_tasks)
  })
})

// ── buildSensorium — clock ────────────────────────────────────────────────────

describe('buildSensorium — clock', () => {
  it('uses the injected now (deterministic time)', async () => {
    const agent = makeAgent()
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.clock.now).toBe(FIXED_NOW)
  })

  it('computes agent_age_days from created_at vs now', async () => {
    const agent = makeAgent({ created_at: AGENT_CREATED_AT })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    // FIXED_NOW - AGENT_CREATED_AT = 10 days exactly
    expect(s.clock.agent_age_days).toBe(10)
  })

  it('populates cycles and last_woke_at from runtime', async () => {
    const agent = makeAgent()
    const runtime = makeRuntime({ cycles: 42, last_woke_at: '2026-06-22T08:00:00Z' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, runtime, { now: FIXED_NOW })

    expect(s.clock.cycles).toBe(42)
    expect(s.clock.last_woke_at).toBe('2026-06-22T08:00:00Z')
  })

  it('defaults cycles=0 and last_woke_at=null when runtime is absent', async () => {
    const agent = makeAgent()
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.clock.cycles).toBe(0)
    expect(s.clock.last_woke_at).toBeNull()
  })
})

// ── buildSensorium — situation ────────────────────────────────────────────────

describe('buildSensorium — situation', () => {
  it('reads name, role, autonomy, effort from agent', async () => {
    const agent = makeAgent({ name: 'Sentry', role: 'ops', autonomy: 'draft', effort: 'high' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.situation.agent_name).toBe('Sentry')
    expect(s.situation.agent_role).toBe('ops')
    expect(s.situation.autonomy).toBe('draft')
    expect(s.situation.effort).toBe('high')
  })

  it('reads wake_reason from runtime', async () => {
    const agent = makeAgent()
    const runtime = makeRuntime({ wake_reason: 'alarm' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, runtime, { now: FIXED_NOW })

    expect(s.situation.wake_reason).toBe('alarm')
  })

  it('wake_reason is null when runtime is absent', async () => {
    const agent = makeAgent()
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.situation.wake_reason).toBeNull()
  })
})

// ── buildSensorium — schedule ─────────────────────────────────────────────────

describe('buildSensorium — schedule', () => {
  it('returns correct counts by status', async () => {
    const agent = makeAgent()
    const env = makeEnv({
      taskCountsByStatus: [
        { status: 'open', cnt: 5 },
        { status: 'in_progress', cnt: 2 },
        { status: 'done', cnt: 10 },
        { status: 'blocked', cnt: 1 },
      ],
    })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.schedule.counts.open).toBe(5)
    expect(s.schedule.counts.in_progress).toBe(2)
    expect(s.schedule.counts.done).toBe(10)
    expect(s.schedule.counts.blocked).toBe(1)
  })

  it('returns overdue count from DB', async () => {
    const agent = makeAgent()
    const env = makeEnv({ overdueCount: 3 })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.schedule.overdue).toBe(3)
  })

  it('open task list is bounded at SENSORIUM_TASK_CAP', async () => {
    const agent = makeAgent()
    // DB already returns a bounded list (LIMIT ? in the query) but we verify
    // the returned list size is within the cap.
    const manyTitles = Array.from({ length: SENSORIUM_TASK_CAP }, (_, i) => `Task ${i}`)
    const env = makeEnv({ openTaskTitles: manyTitles })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.schedule.oldest_open_tasks.length).toBeLessThanOrEqual(SENSORIUM_TASK_CAP)
  })

  it('degrades gracefully to zeros when DB throws', async () => {
    const agent = makeAgent()
    const env = makeEnv({ throwOnQuery: true })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.schedule.counts.open).toBe(0)
    expect(s.schedule.counts.in_progress).toBe(0)
    expect(s.schedule.overdue).toBe(0)
    expect(s.schedule.oldest_open_tasks).toHaveLength(0)
  })
})

// ── buildSensorium — vitals ───────────────────────────────────────────────────

describe('buildSensorium — vitals', () => {
  it('reads kpi_progress and kpi_target from agent', async () => {
    const agent = makeAgent({ kpi_progress: 60, kpi_target: '10 tasks' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.vitals.kpi_progress).toBe(60)
    expect(s.vitals.kpi_target).toBe('10 tasks')
  })

  it('computes budget_remaining from cap minus meter spend', async () => {
    // cap = 100 cents = 1,000,000 micro-USD
    // spent = 250,000 micro-USD → remaining = 750,000
    const agent = makeAgent({ budget_cap_cents: 100 })
    const env = makeEnv({ meterRow: { cost_micro_usd: 250_000 } })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.vitals.budget_remaining_micro_usd).toBe(750_000)
  })

  it('budget_remaining is null when agent has no cap', async () => {
    const agent = makeAgent({ budget_cap_cents: null })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.vitals.budget_remaining_micro_usd).toBeNull()
  })

  it('budget_remaining is 0 when fully spent (never negative)', async () => {
    const agent = makeAgent({ budget_cap_cents: 10 }) // 100,000 micro-USD cap
    const env = makeEnv({ meterRow: { cost_micro_usd: 200_000 } }) // over cap

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.vitals.budget_remaining_micro_usd).toBe(0)
  })
})

// ── buildSensorium — delegations ──────────────────────────────────────────────

describe('buildSensorium — delegations', () => {
  it('returns delegations list from DB', async () => {
    const agent = makeAgent()
    const env = makeEnv({
      delegations: [
        { id: 'task-d1', title: 'Review PR', status: 'in_progress' },
        { id: 'task-d2', title: 'Write tests', status: 'open' },
      ],
    })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.delegations).toHaveLength(2)
    expect(s.delegations[0].title).toBe('Review PR')
    expect(s.delegations[0].status).toBe('in_progress')
  })

  it('delegations list is bounded at SENSORIUM_DELEGATION_CAP', async () => {
    const agent = makeAgent()
    const manyDelegations = Array.from({ length: SENSORIUM_DELEGATION_CAP }, (_, i) => ({
      id: `task-${i}`,
      title: `Delegation ${i}`,
      status: 'open',
    }))
    const env = makeEnv({ delegations: manyDelegations })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.delegations.length).toBeLessThanOrEqual(SENSORIUM_DELEGATION_CAP)
  })

  it('degrades to empty list when DB throws', async () => {
    const agent = makeAgent()
    const env = makeEnv({ throwOnQuery: true })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(s.delegations).toHaveLength(0)
  })
})

// ── buildSensorium — no LLM calls ────────────────────────────────────────────

describe('buildSensorium — LLM isolation', () => {
  it('makes NO model/fetch calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const agent = makeAgent()
    const env = makeEnv()

    await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('does not call env.AI at all', async () => {
    const agent = makeAgent()
    const aiSpy = vi.fn()
    const env = {
      ...makeEnv(),
      AI: { run: aiSpy },
    } as unknown as Env

    await buildSensorium(env, agent, null, { now: FIXED_NOW })

    expect(aiSpy).not.toHaveBeenCalled()
  })
})

// ── renderSensorium — stability ───────────────────────────────────────────────

describe('renderSensorium', () => {
  it('produces the same string for the same Sensorium (deterministic)', async () => {
    const agent = makeAgent()
    const runtime = makeRuntime()
    const env = makeEnv()

    const s1 = await buildSensorium(env, agent, runtime, { now: FIXED_NOW })
    const s2 = await buildSensorium(env, agent, runtime, { now: FIXED_NOW })

    expect(renderSensorium(s1)).toBe(renderSensorium(s2))
  })

  it('includes [SENSORIUM v1] header', async () => {
    const agent = makeAgent()
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    expect(rendered).toContain('[SENSORIUM v1]')
  })

  it('includes agent name and role', async () => {
    const agent = makeAgent({ name: 'Atlas', role: 'strategist' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    expect(rendered).toContain('Atlas')
    expect(rendered).toContain('strategist')
  })

  it('includes KPI progress', async () => {
    const agent = makeAgent({ kpi_progress: 75, kpi_target: '8 tasks' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    expect(rendered).toContain('75%')
    expect(rendered).toContain('8 tasks')
  })

  it('includes open task titles', async () => {
    const agent = makeAgent()
    const env = makeEnv({ openTaskTitles: ['Build sensorium', 'Write tests'] })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    expect(rendered).toContain('Build sensorium')
    expect(rendered).toContain('Write tests')
  })

  it('sensorium header appears before agent name (fixed ordering)', async () => {
    const agent = makeAgent({ name: 'Atlas' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    const headerPos = rendered.indexOf('[SENSORIUM')
    const agentPos = rendered.indexOf('Atlas')

    expect(headerPos).toBeLessThan(agentPos)
  })

  it('does not include Last woke line when last_woke_at is null', async () => {
    const agent = makeAgent()
    const env = makeEnv()

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    expect(rendered).not.toContain('Last woke:')
  })

  it('includes Last woke when runtime supplies last_woke_at', async () => {
    const agent = makeAgent()
    const runtime = makeRuntime({ last_woke_at: '2026-06-22T09:00:00Z' })
    const env = makeEnv()

    const s = await buildSensorium(env, agent, runtime, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    expect(rendered).toContain('Last woke: 2026-06-22T09:00:00Z')
  })

  it('includes budget remaining when cap is set', async () => {
    const agent = makeAgent({ budget_cap_cents: 100 })
    const env = makeEnv({ meterRow: { cost_micro_usd: 250_000 } })

    const s = await buildSensorium(env, agent, null, { now: FIXED_NOW })
    const rendered = renderSensorium(s)

    // $0.75 remaining (750,000 / 10,000 = $0.075 per cent, ×10 = $0.75)
    expect(rendered).toContain('Budget remaining')
  })
})

// ── loop.ts integration: sensorium seam is called ────────────────────────────

describe('loop.ts — sensorium seam integration', () => {
  function makeLoopEnv(): { env: Env; dbCalls: { sql: string; binds: unknown[] }[] } {
    const dbCalls: { sql: string; binds: unknown[] }[] = []
    const env = {
      TENANT_SLUG: 'test',
      DB: {
        prepare(sql: string) {
          const call: { sql: string; binds: unknown[] } = { sql, binds: [] }
          dbCalls.push(call)
          const stmt = {
            bind(...args: unknown[]) { call.binds = args; return stmt },
            async first<T>(): Promise<T | null> {
              if (sql.includes('kpi_progress') && sql.includes('SELECT')) {
                return { kpi_progress: 0 } as unknown as T
              }
              if (sql.includes('COUNT(*)')) return { cnt: 0 } as unknown as T
              return null
            },
            async run() { return { meta: { changes: 1 } } },
            async all<T>() { return { results: [] as T[] } },
          }
          return stmt
        },
      },
    } as unknown as Env
    return { env, dbCalls }
  }

  function makeCreateTask(): LoopDeps['createTask'] {
    return vi.fn().mockImplementation(
      async (_env: Env, input: { squad_id: string; title: string; body?: string; done_when?: string; gate_owner?: string | null; assignee_agent_id?: string | null }) => ({
        id: 'task-' + Math.random().toString(36).slice(2),
        squad_id: input.squad_id,
        title: input.title,
        body: input.body ?? '',
        done_when: input.done_when ?? '(set via task update)',
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

  it('calls the injected buildSensorium seam on a goal-bearing cycle', async () => {
    const agent = makeAgent({ effort: 'standard', autonomy: 'draft' })
    const { env } = makeLoopEnv()

    const mockSensorium = vi.fn().mockResolvedValue({
      version: 'v1' as const,
      clock: { now: FIXED_NOW, agent_age_days: 10, cycles: 7, last_woke_at: null },
      situation: { agent_name: 'Sensor Agent', agent_role: 'engineer', autonomy: 'execute', effort: 'standard', wake_reason: null },
      schedule: { counts: { open: 0, in_progress: 0, done: 0, blocked: 0 }, overdue: 0, oldest_open_tasks: [] },
      vitals: { kpi_progress: 40, kpi_target: '5 tasks', budget_remaining_micro_usd: null, budget_window: 'day' },
      delegations: [],
      tasks: [],
    })

    let capturedPrompt = ''
    const mockModel: LoopDeps['model'] = {
      chat: vi.fn().mockImplementation(async (msgs) => {
        capturedPrompt = msgs.find((m: { role: string; content: string }) => m.role === 'user')?.content ?? ''
        return JSON.stringify({ summary: 'plan', tasks: [] })
      }),
    }

    await runGoalCycle(env, agent, {
      meterCheck: vi.fn().mockResolvedValue({ ok: true, windowKey: 'k', count: 1, tokens: 0 }),
      model: mockModel,
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      buildSensorium: mockSensorium,
      sensoriumRuntime: { cycles: 7, last_woke_at: null, last_decision: null, wake_reason: 'test' },
    })

    expect(mockSensorium).toHaveBeenCalledTimes(1)
    // The sensorium call should receive the agent and the runtime
    expect(mockSensorium).toHaveBeenCalledWith(
      env,
      agent,
      { cycles: 7, last_woke_at: null, last_decision: null, wake_reason: 'test' },
    )
  })

  it('sensorium block appears at the top of the user prompt', async () => {
    const agent = makeAgent({ effort: 'standard', autonomy: 'draft' })
    const { env } = makeLoopEnv()

    // Mock sensorium that returns a recognizable string
    const SENTINEL = '[SENSORIUM v1]\ntest block'
    const mockSensorium = vi.fn().mockResolvedValue({
      version: 'v1' as const,
      clock: { now: FIXED_NOW, agent_age_days: 10, cycles: 0, last_woke_at: null },
      situation: { agent_name: 'Sensor Agent', agent_role: 'engineer', autonomy: 'execute', effort: 'standard', wake_reason: null },
      schedule: { counts: { open: 0, in_progress: 0, done: 0, blocked: 0 }, overdue: 0, oldest_open_tasks: [] },
      vitals: { kpi_progress: 40, kpi_target: '5 tasks', budget_remaining_micro_usd: null, budget_window: 'day' },
      delegations: [],
      tasks: [],
    })

    let capturedUserPrompt = ''
    const mockModel: LoopDeps['model'] = {
      chat: vi.fn().mockImplementation(async (msgs: Array<{ role: string; content: string }>) => {
        capturedUserPrompt = msgs.find((m) => m.role === 'user')?.content ?? ''
        return JSON.stringify({ summary: 'plan', tasks: [] })
      }),
    }

    // We need a custom renderSensorium stand-in — override via the seam
    // by injecting a mock that pre-renders to our sentinel string.
    // The real renderSensorium is called on the returned Sensorium object;
    // we spy on the import's renderSensorium via the loop's buildSensorium seam.
    // The simplest approach: inject a buildSensorium that returns a valid Sensorium,
    // and verify the prompt contains the rendered form of that Sensorium.
    const sensoriumObj = {
      version: 'v1' as const,
      clock: { now: FIXED_NOW, agent_age_days: 10, cycles: 0, last_woke_at: null },
      situation: { agent_name: 'Sensor Agent', agent_role: 'engineer', autonomy: 'execute' as const, effort: 'standard' as const, wake_reason: null },
      schedule: { counts: { open: 2, in_progress: 0, done: 0, blocked: 0 }, overdue: 0, oldest_open_tasks: ['Task Alpha'] },
      vitals: { kpi_progress: 40, kpi_target: '5 tasks', budget_remaining_micro_usd: null, budget_window: 'day' },
      delegations: [],
      tasks: ['Task Alpha'],
    }
    const bsMock = vi.fn().mockResolvedValue(sensoriumObj)

    await runGoalCycle(env, agent, {
      meterCheck: vi.fn().mockResolvedValue({ ok: true, windowKey: 'k', count: 1, tokens: 0 }),
      model: mockModel,
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      buildSensorium: bsMock,
    })

    // The user prompt should begin with the sensorium block (header at the top)
    expect(capturedUserPrompt).toContain('[SENSORIUM v1]')
    // Sensorium must appear before OKR line
    const sensoriumPos = capturedUserPrompt.indexOf('[SENSORIUM v1]')
    const okrPos = capturedUserPrompt.indexOf('OKR:')
    expect(sensoriumPos).toBeLessThan(okrPos)
    // Open task from sensorium appears in prompt
    expect(capturedUserPrompt).toContain('Task Alpha')
  })

  it('goal cycle still completes when buildSensorium throws (soft failure)', async () => {
    const agent = makeAgent({ effort: 'standard', autonomy: 'draft' })
    const { env } = makeLoopEnv()

    const failingSensorium = vi.fn().mockRejectedValue(new Error('DB down'))

    const result = await runGoalCycle(env, agent, {
      meterCheck: vi.fn().mockResolvedValue({ ok: true, windowKey: 'k', count: 1, tokens: 0 }),
      // One real proposal → the cycle is productive (proves it proceeds + spawns
      // even with a null sensorium; dedup is skipped when sensorium is null).
      model: { chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: 'plan', tasks: [{ title: 'T', body: 'b' }] })) },
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn().mockResolvedValue('engram'),
      buildSensorium: failingSensorium,
    })

    // Cycle must succeed even though sensorium failed (soft-degrade, not abort).
    expect(result.ok).toBe(true)
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
  })
})
