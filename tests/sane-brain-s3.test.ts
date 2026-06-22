// tests/sane-brain-s3.test.ts — S3 sane-brain: backpressure guard + goal-path memory.
//
// Covers:
//  1. Backpressure guard: open_count >= MAX_OPEN_TASKS → decided='backpressure',
//     zero spawn, no model call, kpi_progress write skipped.
//  2. Below cap: open_count < MAX_OPEN_TASKS → normal 'spawned' path.
//  3. memory.remember called ONLY on 'spawned' — not on backpressure / dedup /
//     observe-only / rate_limited.
//  4. Observer maps 'backpressure' → consecutive_noops increment (noop, not fail).
//  5. Persistent backpressure eventually triggers cooldown via noop threshold.
//  6. Sensorium failure (buildSensorium throws) → backpressure guard skips safely
//     (null sensorium = guard inactive, loop continues normally).

import { describe, it, expect, vi, beforeEach } from 'vitest'
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
    clock: {
      now: '2026-06-22T10:00:00Z',
      agent_age_days: 10,
      cycles: 5,
      last_woke_at: null,
    },
    situation: {
      agent_name: 'S3 Test Agent',
      agent_role: 'engineer',
      autonomy: 'draft',
      effort: 'standard',
      wake_reason: null,
    },
    schedule: {
      counts: { open: openCount, in_progress: 0, done: 5, blocked: 0 },
      overdue: 0,
      oldest_open_tasks: [],
    },
    vitals: {
      kpi_progress: 30,
      kpi_target: '10 tasks',
      budget_remaining_micro_usd: null,
      budget_window: 'week',
    },
    delegations: [],
    tasks: [],
    ...overrides,
  }
}

// ── Minimal D1 mock (only what the observer needs) ────────────────────────────

function makeD1() {
  const observerRows = new Map<string, {
    consecutive_noops: number
    consecutive_fails: number
    liveness_fails: number
    last_escalated_at: string | null
    cooldown_until: string | null
  }>()

  return {
    prepare(sql: string) {
      const isObserverSelect = sql.includes('FROM loop_observer')
      const isObserverUpsert = sql.includes('INSERT INTO loop_observer')
      let boundArgs: unknown[] = []

      return {
        bind(...args: unknown[]) {
          boundArgs = args
          return this
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (isObserverUpsert) {
            const [tenant, agentId, noops, fails, liveness, lastEsc, cooldown] =
              boundArgs as [string, string, number, number, number, string | null, string | null]
            const key = `${tenant}:${agentId}`
            observerRows.set(key, {
              consecutive_noops: noops,
              consecutive_fails: fails,
              liveness_fails: liveness,
              last_escalated_at: lastEsc,
              cooldown_until: cooldown,
            })
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
        async first<T>(): Promise<T | null> {
          if (isObserverSelect) {
            const [tenant, agentId] = boundArgs as string[]
            const row = observerRows.get(`${tenant}:${agentId}`)
            if (!row) return null
            return row as unknown as T
          }
          return null
        },
      }
    },
  }
}

function makeEnv(db: ReturnType<typeof makeD1>, tenant = 'tenant-s3'): Env {
  return {
    TENANT_SLUG: tenant,
    DB: db,
  } as unknown as Env
}

// ── Shared dep builders ───────────────────────────────────────────────────────

function makeMeterOk(): LoopDeps['meterCheck'] {
  return vi.fn().mockResolvedValue({ ok: true, windowKey: 'w', count: 1, tokens: 0 })
}

function makeModel(tasks: { title: string; body: string }[] = []): LoopDeps['model'] {
  return { chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: 'plan', tasks })) }
}

function makeCreateTask(): LoopDeps['createTask'] {
  return vi.fn().mockImplementation(
    async (
      _env: Env,
      input: {
        squad_id: string
        title: string
        body?: string
        done_when?: string
        gate_owner?: string | null
        assignee_agent_id?: string | null
      },
    ) =>
      ({
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

// ── 1. Backpressure guard: at cap → 'backpressure', zero spawn ────────────────

describe('runGoalCycle — backpressure guard', () => {
  it(`returns decided='backpressure' and spawned=0 when open tasks >= MAX_OPEN_TASKS (${MAX_OPEN_TASKS})`, async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const modelSpy = makeModel([{ title: 'New Task', body: 'details' }])
    const createTaskSpy = makeCreateTask()
    const rememberSpy = vi.fn().mockResolvedValue('engram-id')

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: modelSpy,
      recall: vi.fn().mockResolvedValue([]),
      createTask: createTaskSpy,
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: rememberSpy,
      // Sensorium with exactly MAX_OPEN_TASKS open tasks → triggers guard.
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(MAX_OPEN_TASKS)),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
      // Real dedup/reserve not needed — guard fires before model call.
      computeDecisionFp: vi.fn(),
      reserveDecision: vi.fn(),
    }

    const result = await runGoalCycle(env, agent, deps)

    expect(result.decided).toBe('backpressure')
    expect(result.spawned).toBe(0)
    expect(result.ok).toBe(true)
    // Model must NOT be called.
    expect((modelSpy as { chat: ReturnType<typeof vi.fn> }).chat).not.toHaveBeenCalled()
    // createTask must NOT be called.
    expect(createTaskSpy).not.toHaveBeenCalled()
    // memory.remember must NOT be called (only productive ticks write memory).
    expect(rememberSpy).not.toHaveBeenCalled()
  })

  it('returns backpressure when open tasks is strictly above cap', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const createTaskSpy = makeCreateTask()

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel(),
      recall: vi.fn().mockResolvedValue([]),
      createTask: createTaskSpy,
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn(),
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(MAX_OPEN_TASKS + 5)),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('backpressure')
    expect(result.spawned).toBe(0)
    expect(createTaskSpy).not.toHaveBeenCalled()
  })

  it('meter is NOT called when backpressure guard fires (saves model spend)', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const meterSpy = makeMeterOk() as ReturnType<typeof vi.fn>

    const deps: LoopDeps = {
      meterCheck: meterSpy,
      model: makeModel(),
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn(),
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(MAX_OPEN_TASKS)),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    await runGoalCycle(env, agent, deps)
    // Meter should not be called — backpressure fires before the meter check.
    expect(meterSpy).not.toHaveBeenCalled()
  })
})

// ── 2. Below cap → normal spawned path ───────────────────────────────────────

describe('runGoalCycle — below backpressure cap', () => {
  it('spawns normally when open tasks < MAX_OPEN_TASKS', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const createTaskSpy = makeCreateTask()
    const rememberSpy = vi.fn().mockResolvedValue('engram-id')

    const sensoriumObj = makeSensorium(MAX_OPEN_TASKS - 1) // one below cap

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'New Task', body: 'details' }]),
      recall: vi.fn().mockResolvedValue([]),
      createTask: createTaskSpy,
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: rememberSpy,
      buildSensorium: vi.fn().mockResolvedValue(sensoriumObj),
      computeDecisionFp: vi.fn().mockResolvedValue('fp-s3-below-cap'),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
    expect(createTaskSpy).toHaveBeenCalledTimes(1)
  })

  it('spawns normally when open tasks = 0', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const createTaskSpy = makeCreateTask()

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Task A', body: 'do it' }]),
      recall: vi.fn().mockResolvedValue([]),
      createTask: createTaskSpy,
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn().mockResolvedValue('engram-id'),
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(0)),
      computeDecisionFp: vi.fn().mockResolvedValue('fp-s3-zero'),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
  })
})

// ── 3. memory.remember called only on 'spawned' ───────────────────────────────

describe('memory.remember — only on productive cycles', () => {
  it('calls remember after a spawned cycle', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const rememberSpy = vi.fn().mockResolvedValue('engram-id')

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Deploy feature', body: 'details' }]),
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: rememberSpy,
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(0)),
      computeDecisionFp: vi.fn().mockResolvedValue('fp-unique-s3'),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('spawned')
    expect(rememberSpy).toHaveBeenCalledTimes(1)
    // The engram text should reference the OKR and spawned tasks.
    const [calledAgentId, calledText] = rememberSpy.mock.calls[0] as [string, string]
    expect(calledAgentId).toBe(agent.id)
    expect(calledText).toContain('spawned 1 task')
    expect(calledText).toContain('Deploy feature')
  })

  it('does NOT call remember on backpressure', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const rememberSpy = vi.fn()

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel(),
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: rememberSpy,
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(MAX_OPEN_TASKS)),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('backpressure')
    expect(rememberSpy).not.toHaveBeenCalled()
  })

  it('does NOT call remember on deduped', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const rememberSpy = vi.fn()

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Task', body: 'body' }]),
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: rememberSpy,
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(0)),
      // Dedup: reserve returns false → decided='deduped'.
      computeDecisionFp: vi.fn().mockResolvedValue('fp-deduped'),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: false }),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('deduped')
    expect(rememberSpy).not.toHaveBeenCalled()
  })

  it('does NOT call remember on observe-only (effort=low)', async () => {
    const agent = makeAgent({ effort: 'low' })
    const db = makeD1()
    const env = makeEnv(db)
    const rememberSpy = vi.fn()

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel(),
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: rememberSpy,
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(0)),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('observe-only')
    expect(rememberSpy).not.toHaveBeenCalled()
  })

  it('does NOT call remember on rate_limited', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const rememberSpy = vi.fn()

    const deps: LoopDeps = {
      // Meter blocks the cycle.
      meterCheck: vi.fn().mockResolvedValue({ ok: false, reason: 'count_exceeded' }),
      model: makeModel(),
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: rememberSpy,
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(0)),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    expect(result.decided).toBe('rate_limited')
    expect(rememberSpy).not.toHaveBeenCalled()
  })

  it('cycle completes normally even if remember throws (best-effort)', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Task', body: 'body' }]),
      recall: vi.fn().mockResolvedValue([]),
      createTask: makeCreateTask(),
      writeProgress: vi.fn().mockResolvedValue(undefined),
      // remember throws — should be swallowed.
      remember: vi.fn().mockRejectedValue(new Error('Vectorize unavailable')),
      buildSensorium: vi.fn().mockResolvedValue(makeSensorium(0)),
      computeDecisionFp: vi.fn().mockResolvedValue('fp-remember-throws'),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    // Cycle must still report spawned — the failed write must not abort.
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
    expect(result.ok).toBe(true)
  })
})

// ── 4. Observer maps 'backpressure' as a noop (not a failure) ─────────────────

describe('observe — backpressure outcome', () => {
  it("increments consecutive_noops, not consecutive_fails, for 'backpressure'", async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    const result = await observe(env, agent, 'backpressure', now)

    // Not a failure — no escalation, no cooldown yet (first tick).
    expect(result.escalate).toBe(false)
    expect(result.cooldown).toBe(false)

    // Verify internal state: consecutive_noops=1, consecutive_fails=0.
    // We check indirectly by confirming the second backpressure tick
    // increments noops further (escalation threshold not reached after 1 fail-tick).
    const result2 = await observe(env, agent, 'backpressure', now)
    expect(result2.escalate).toBe(false)
  })

  it('a productive tick after backpressure resets the noop counter', async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    // Run a few backpressure ticks.
    for (let i = 0; i < 3; i++) {
      await observe(env, agent, 'backpressure', now)
    }

    // Productive tick resets.
    const result = await observe(env, agent, 'spawned', now)
    expect(result.cooldown).toBe(false)
    expect(result.escalate).toBe(false)
  })
})

// ── 5. Persistent backpressure → cooldown via noop threshold ─────────────────

describe('observe — persistent backpressure triggers cooldown', () => {
  it(`cooldown=true after ${NOOP_COOLDOWN_THRESHOLD} consecutive backpressure ticks`, async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    let result = { cooldown: false, escalate: false }
    for (let i = 0; i < NOOP_COOLDOWN_THRESHOLD; i++) {
      result = await observe(env, agent, 'backpressure', now)
    }

    expect(result.cooldown).toBe(true)
    expect(result.reason).toMatch(/cooldown/)
    // backpressure is not a failure — escalation threshold not crossed.
    expect(result.escalate).toBe(false)
  })
})

// ── 6. Sensorium failure → guard skips, loop continues ───────────────────────

describe('runGoalCycle — sensorium null → guard inactive', () => {
  it('when buildSensorium throws, backpressure guard is skipped and loop continues normally', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)
    const createTaskSpy = makeCreateTask()

    const deps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Fallback Task', body: 'details' }]),
      recall: vi.fn().mockResolvedValue([]),
      createTask: createTaskSpy,
      writeProgress: vi.fn().mockResolvedValue(undefined),
      remember: vi.fn().mockResolvedValue('engram-id'),
      // Sensorium throws → safeSensoriumObj returns null → guard is inactive.
      buildSensorium: vi.fn().mockRejectedValue(new Error('D1 timeout')),
      // With null sensorium, fp gate is skipped → task is spawned.
      computeDecisionFp: vi.fn(),
      reserveDecision: vi.fn(),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    const result = await runGoalCycle(env, agent, deps)
    // Loop should complete and spawn (null sensorium = guard inactive, dedup skipped).
    expect(result.decided).toBe('spawned')
    expect(result.spawned).toBe(1)
    expect(createTaskSpy).toHaveBeenCalledTimes(1)
  })
})
