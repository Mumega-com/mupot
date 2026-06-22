// tests/sane-brain-s3.test.ts — S3 sane-brain: backpressure guard + goal-path memory.
//
// Covers (post gate-RED fixes):
//  1. Backpressure guard counts the agent's OWN open backlog via a dedicated D1
//     COUNT (assignee=agent OR unassigned-in-squad) — NOT the sensorium's
//     assignee-only count. >= MAX_OPEN_TASKS → decided='backpressure', zero spawn,
//     no model call, meter untouched.
//  2. The backlog query captures suggest/draft UNASSIGNED tasks in the squad.
//  3. Below cap → normal 'spawned' path.
//  4. Empty proposals (spawned=0) → decided='observe-only', NO memory write.
//  5. memory.remember called ONLY on a productive ('spawned') cycle.
//  6. Observer maps 'backpressure' → noop → cooldown after threshold.
//  7. Backlog-count DB failure fails OPEN (guard inactive, loop continues).

import { describe, it, expect, vi } from 'vitest'
import { runGoalCycle, MAX_OPEN_TASKS } from '../src/agents/loop'
import { observe, NOOP_COOLDOWN_THRESHOLD } from '../src/agents/observer'
import type { LoopDeps } from '../src/agents/loop'
import type { Env, Agent } from '../src/types'
import type { Sensorium } from '../src/agents/sensorium'
import { SENSORIUM_VERSION } from '../src/agents/sensorium'
import type { Task } from '../src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-s3',
    squad_id: 'squad-1',
    slug: 'agent-s3',
    name: 'S3 Test Agent',
    role: 'engineer',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: 'Ship 10 features this quarter',
    kpi_target: '10 tasks',
    kpi_progress: 30,
    effort: 'standard',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeSensorium(openCount: number, overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    version: SENSORIUM_VERSION,
    clock: { now: '2026-06-22T10:00:00Z', agent_age_days: 10, cycles: 5, last_woke_at: null },
    situation: { agent_name: 'S3 Test Agent', agent_role: 'engineer', autonomy: 'draft', effort: 'standard', wake_reason: null },
    schedule: { counts: { open: openCount, in_progress: 0, done: 5, blocked: 0 }, overdue: 0, oldest_open_tasks: [] },
    vitals: { kpi_progress: 30, kpi_target: '10 tasks', budget_remaining_micro_usd: null, budget_window: 'week' },
    delegations: [],
    tasks: [],
    ...overrides,
  }
}

// ── D1 mock: observer rows + the S3 backlog COUNT query ───────────────────────

interface D1Opts {
  backlogCount?: number    // value returned by the tasks backlog COUNT
  backlogThrows?: boolean  // simulate a DB hiccup on the backlog count
  sqlLog?: string[]        // capture prepared SQL (for shape assertions)
}

function makeD1(opts: D1Opts = {}) {
  const observerRows = new Map<string, {
    consecutive_noops: number; consecutive_fails: number; liveness_fails: number
    last_escalated_at: string | null; cooldown_until: string | null
  }>()

  return {
    prepare(sql: string) {
      if (opts.sqlLog) opts.sqlLog.push(sql)
      const isObserverSelect = sql.includes('FROM loop_observer')
      const isObserverUpsert = sql.includes('INSERT INTO loop_observer')
      const isBacklogCount = sql.includes('FROM tasks') && sql.includes('COUNT(*)')
      let boundArgs: unknown[] = []

      return {
        bind(...args: unknown[]) { boundArgs = args; return this },
        async run(): Promise<{ meta: { changes: number } }> {
          if (isObserverUpsert) {
            const [tenant, agentId, noops, fails, liveness, lastEsc, cooldown] =
              boundArgs as [string, string, number, number, number, string | null, string | null]
            observerRows.set(`${tenant}:${agentId}`, {
              consecutive_noops: noops, consecutive_fails: fails, liveness_fails: liveness,
              last_escalated_at: lastEsc, cooldown_until: cooldown,
            })
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
        async first<T>(): Promise<T | null> {
          if (isBacklogCount) {
            if (opts.backlogThrows) throw new Error('D1 down')
            return { cnt: opts.backlogCount ?? 0 } as unknown as T
          }
          if (isObserverSelect) {
            const [tenant, agentId] = boundArgs as string[]
            const row = observerRows.get(`${tenant}:${agentId}`)
            return (row ?? null) as unknown as T
          }
          return null
        },
      }
    },
  }
}

function makeEnv(db: ReturnType<typeof makeD1>, tenant = 'tenant-s3'): Env {
  return { TENANT_SLUG: tenant, DB: db } as unknown as Env
}

// ── Shared dep builders ───────────────────────────────────────────────────────

function makeMeterOk(): LoopDeps['meterCheck'] {
  return vi.fn().mockResolvedValue({ ok: true, windowKey: 'w', count: 1, tokens: 0 })
}
function makeModel(tasks: { title: string; body: string }[] = []): LoopDeps['model'] {
  return { chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: 'plan', tasks })) }
}
function makeCreateTask(): LoopDeps['createTask'] {
  return vi.fn().mockImplementation(async (_env: Env, input: { squad_id: string; title: string; body?: string; assignee_agent_id?: string | null; gate_owner?: string | null; done_when?: string }) =>
    ({
      id: 'task-' + Math.random().toString(36).slice(2), squad_id: input.squad_id, title: input.title,
      body: input.body ?? '', done_when: input.done_when ?? '(set via task update)', status: 'open' as const,
      assignee_agent_id: input.assignee_agent_id ?? null, github_issue_url: null, result: null, completed_at: null,
      gate_owner: input.gate_owner ?? null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } satisfies Task))
}
function baseDeps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    meterCheck: makeMeterOk(),
    model: makeModel([{ title: 'New Task', body: 'details' }]),
    recall: vi.fn().mockResolvedValue([]),
    createTask: makeCreateTask(),
    writeProgress: vi.fn().mockResolvedValue(undefined),
    remember: vi.fn().mockResolvedValue('engram-id'),
    buildSensorium: vi.fn().mockResolvedValue(makeSensorium(0)),
    computeDecisionFp: vi.fn().mockResolvedValue('fp-' + Math.random().toString(36).slice(2)),
    reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
    observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    ...over,
  }
}

// ── 1. Backpressure guard fires on the DEDICATED backlog count ────────────────

describe('runGoalCycle — backpressure guard (dedicated backlog count)', () => {
  it(`decided='backpressure', zero spawn, model+meter untouched when backlog >= ${MAX_OPEN_TASKS}`, async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: MAX_OPEN_TASKS }))
    const model = makeModel([{ title: 'x', body: 'y' }])
    const meter = makeMeterOk() as ReturnType<typeof vi.fn>
    const createTask = makeCreateTask()
    const remember = vi.fn()
    const result = await runGoalCycle(env, agent, baseDeps({ model, meterCheck: meter, createTask, remember }))

    expect(result.decided).toBe('backpressure')
    expect(result.spawned).toBe(0)
    expect((model as { chat: ReturnType<typeof vi.fn> }).chat).not.toHaveBeenCalled()
    expect(meter).not.toHaveBeenCalled()
    expect(createTask).not.toHaveBeenCalled()
    expect(remember).not.toHaveBeenCalled()
  })

  it('the backlog COUNT query includes BOTH self-assigned AND unassigned-in-squad (suggest/draft)', async () => {
    const sqlLog: string[] = []
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: MAX_OPEN_TASKS, sqlLog }))
    await runGoalCycle(env, agent, baseDeps())
    const backlogSql = sqlLog.find((s) => s.includes('FROM tasks') && s.includes('COUNT(*)'))
    expect(backlogSql).toBeDefined()
    // Must capture suggest/draft unassigned backlog in the squad, not just assignee.
    expect(backlogSql).toMatch(/assignee_agent_id\s*=\s*\?/)
    expect(backlogSql).toMatch(/assignee_agent_id\s+IS\s+NULL/i)
    expect(backlogSql).toMatch(/squad_id\s*=\s*\?/)
    expect(backlogSql).toMatch(/status\s*=\s*'open'/)
  })

  it('does NOT fire below cap → normal spawned path', async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: MAX_OPEN_TASKS - 1 }))
    const createTask = makeCreateTask()
    const result = await runGoalCycle(env, agent, baseDeps({ createTask, model: makeModel([{ title: 'T', body: 'b' }]) }))
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
    expect(createTask).toHaveBeenCalledTimes(1)
  })

  it('backlog-count DB failure fails OPEN (guard inactive, loop continues)', async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogThrows: true }))
    const result = await runGoalCycle(env, agent, baseDeps({ model: makeModel([{ title: 'T', body: 'b' }]) }))
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
  })
})

// ── 2. Empty proposals (spawned=0) → observe-only no-op, NO memory ────────────

describe('runGoalCycle — empty proposals are a no-op (gate-RED fix)', () => {
  it("model proposes nothing → decided='observe-only', spawned=0, remember NOT called", async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: 0 }))
    const remember = vi.fn()
    const result = await runGoalCycle(env, agent, baseDeps({
      model: makeModel([]), // empty proposals
      remember,
    }))
    expect(result.decided).toBe('observe-only')
    expect(result.spawned).toBe(0)
    expect(remember).not.toHaveBeenCalled()
  })
})

// ── 3. memory.remember only on productive cycles ──────────────────────────────

describe('memory.remember — only on productive cycles', () => {
  it('calls remember after a spawned cycle with a bounded OKR/title summary', async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: 0 }))
    const remember = vi.fn().mockResolvedValue('engram-id')
    const result = await runGoalCycle(env, agent, baseDeps({ model: makeModel([{ title: 'Deploy feature', body: 'd' }]), remember }))
    expect(result.decided).toBe('spawned')
    expect(remember).toHaveBeenCalledTimes(1)
    const [id, text] = remember.mock.calls[0] as [string, string]
    expect(id).toBe(agent.id)
    expect(text).toContain('spawned 1 task')
    expect(text).toContain('Deploy feature')
    expect(text.length).toBeLessThanOrEqual(300)
  })

  it('does NOT call remember on deduped', async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: 0 }))
    const remember = vi.fn()
    const result = await runGoalCycle(env, agent, baseDeps({
      model: makeModel([{ title: 'T', body: 'b' }]),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: false }),
      remember,
    }))
    expect(result.decided).toBe('deduped')
    expect(remember).not.toHaveBeenCalled()
  })

  it('does NOT call remember on observe-only (effort=low)', async () => {
    const agent = makeAgent({ effort: 'low' })
    const env = makeEnv(makeD1({ backlogCount: 0 }))
    const remember = vi.fn()
    const result = await runGoalCycle(env, agent, baseDeps({ remember }))
    expect(result.decided).toBe('observe-only')
    expect(remember).not.toHaveBeenCalled()
  })

  it('does NOT call remember on rate_limited', async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: 0 }))
    const remember = vi.fn()
    const result = await runGoalCycle(env, agent, baseDeps({
      meterCheck: vi.fn().mockResolvedValue({ ok: false, reason: 'count_exceeded' }),
      remember,
    }))
    expect(result.decided).toBe('rate_limited')
    expect(remember).not.toHaveBeenCalled()
  })

  it('cycle still reports spawned if remember throws (best-effort)', async () => {
    const agent = makeAgent()
    const env = makeEnv(makeD1({ backlogCount: 0 }))
    const result = await runGoalCycle(env, agent, baseDeps({
      model: makeModel([{ title: 'T', body: 'b' }]),
      remember: vi.fn().mockRejectedValue(new Error('Vectorize down')),
    }))
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
    expect(result.ok).toBe(true)
  })
})

// ── 4. Observer maps 'backpressure' as a noop ─────────────────────────────────

describe('observe — backpressure outcome', () => {
  it("increments noops not fails; no escalation", async () => {
    const env = makeEnv(makeD1())
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'
    const r1 = await observe(env, agent, 'backpressure', now)
    expect(r1.escalate).toBe(false)
    expect(r1.cooldown).toBe(false)
    const r2 = await observe(env, agent, 'backpressure', now)
    expect(r2.escalate).toBe(false)
  })

  it(`cooldown=true after ${NOOP_COOLDOWN_THRESHOLD} consecutive backpressure ticks`, async () => {
    const env = makeEnv(makeD1())
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'
    let r = { cooldown: false, escalate: false }
    for (let i = 0; i < NOOP_COOLDOWN_THRESHOLD; i++) r = await observe(env, agent, 'backpressure', now)
    expect(r.cooldown).toBe(true)
    expect(r.escalate).toBe(false)
  })

  it('a productive tick resets the noop counter', async () => {
    const env = makeEnv(makeD1())
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'
    for (let i = 0; i < 3; i++) await observe(env, agent, 'backpressure', now)
    const r = await observe(env, agent, 'spawned', now)
    expect(r.cooldown).toBe(false)
  })
})
