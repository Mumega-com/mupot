// tests/sane-brain-s2.test.ts — S2 sane-brain anti-spam spine.
//
// Covers:
//  1. reserveDecision idempotency: 2nd identical fp → reserved:false → loop returns 'deduped', zero spawn.
//  2. fp changes when SENSORIUM_VERSION changes (preimage includes the version constant).
//  3. fp stable for identical state (same input → same hex string).
//  4. observer escalates ONCE, not repeatedly (last_escalated_at dedup).
//  5. cooldown triggers on consecutive no-ops (threshold hit).
//  6. tenant isolation: same fp, different tenant → both reserve successfully.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeDecisionFp, reserveDecision } from '../src/agents/dedup'
import { observe, NOOP_COOLDOWN_THRESHOLD, FAIL_ESCALATION_THRESHOLD } from '../src/agents/observer'
import { runGoalCycle } from '../src/agents/loop'
import { SENSORIUM_VERSION } from '../src/agents/sensorium'
import type { Sensorium } from '../src/agents/sensorium'
import type { Env, Agent } from '../src/types'
import type { LoopDeps } from '../src/agents/loop'
import type { Task } from '../src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    version: SENSORIUM_VERSION,
    clock: {
      now: '2026-06-22T10:00:00Z',
      agent_age_days: 10,
      cycles: 5,
      last_woke_at: null,
    },
    situation: {
      agent_name: 'test-agent',
      agent_role: 'engineer',
      autonomy: 'draft',
      effort: 'standard',
      wake_reason: null,
    },
    schedule: {
      counts: { open: 2, in_progress: 0, done: 5, blocked: 0 },
      overdue: 0,
      oldest_open_tasks: ['Task A', 'Task B'],
    },
    vitals: {
      kpi_progress: 50,
      kpi_target: '10 tasks',
      budget_remaining_micro_usd: null,
      budget_window: 'day',
    },
    delegations: [],
    tasks: ['Task A', 'Task B'],
    ...overrides,
  }
}

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
    kpi_progress: 50,
    effort: 'standard',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// ── D1 mock for dedup + observer ──────────────────────────────────────────────
//
// Simulates loop_decision_dedup (unique on tenant+agent_id+fp) and loop_observer
// (upsert on tenant+agent_id). Uses in-memory sets/maps.

function makeD1(opts: {
  decidedFps?: Set<string>          // loop_decision_dedup key = `${tenant}:${agentId}:${fp}`
  observerRows?: Map<string, {      // loop_observer key = `${tenant}:${agentId}`
    consecutive_noops: number
    consecutive_fails: number
    liveness_fails: number
    last_escalated_at: string | null
    cooldown_until: string | null
  }>
} = {}) {
  const decidedFps: Set<string> = opts.decidedFps ?? new Set()
  const observerRows = opts.observerRows ?? new Map()

  return {
    prepare(sql: string) {
      const isDecisionInsert = sql.includes('INSERT INTO loop_decision_dedup')
      const isObserverSelect = sql.includes('FROM loop_observer')
      const isObserverUpsert = sql.includes('INSERT INTO loop_observer')

      let boundArgs: unknown[] = []

      return {
        bind(...args: unknown[]) {
          boundArgs = args
          return this
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (isDecisionInsert) {
            // args: id, tenant, agentId, fp, created_at
            const [_id, tenant, agentId, fp] = boundArgs as string[]
            const key = `${tenant}:${agentId}:${fp}`
            if (decidedFps.has(key)) {
              return { meta: { changes: 0 } } // conflict → DO NOTHING
            }
            decidedFps.add(key)
            return { meta: { changes: 1 } } // inserted
          }
          if (isObserverUpsert) {
            // args: tenant, agentId, consecutive_noops, consecutive_fails, liveness_fails,
            //        last_escalated_at, cooldown_until, updated_at
            const [tenant, agentId, noops, fails, liveness, lastEsc, cooldown] = boundArgs as [string, string, number, number, number, string | null, string | null]
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
            const key = `${tenant}:${agentId}`
            const row = observerRows.get(key)
            if (!row) return null
            return row as unknown as T
          }
          return null
        },
      }
    },
  }
}

function makeEnv(db: ReturnType<typeof makeD1>, tenant = 'tenant-a'): Env {
  return {
    TENANT_SLUG: tenant,
    DB: db,
  } as unknown as Env
}

// ── Loop fixtures (mirrors work-unit-loop.test.ts pattern) ───────────────────

function makeMeterOk(): LoopDeps['meterCheck'] {
  return vi.fn().mockResolvedValue({ ok: true, windowKey: 'w', count: 1, tokens: 0 })
}

function makeModel(tasks: { title: string; body: string }[] = []): LoopDeps['model'] {
  return { chat: vi.fn().mockResolvedValue(JSON.stringify({ summary: 'plan', tasks })) }
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

// ── 1. fp stability ───────────────────────────────────────────────────────────

describe('computeDecisionFp — stability', () => {
  it('returns the same hex string for identical inputs', async () => {
    const agent = makeAgent()
    const s = makeSensorium()
    const proposals = [{ title: 'Task A' }, { title: 'Task B' }]

    const fp1 = await computeDecisionFp(agent, s, proposals)
    const fp2 = await computeDecisionFp(agent, s, proposals)

    expect(fp1).toBe(fp2)
    expect(fp1).toHaveLength(64) // SHA-256 hex
    expect(fp1).toMatch(/^[0-9a-f]+$/)
  })

  it('is stable regardless of proposal array order (titles are sorted)', async () => {
    const agent = makeAgent()
    const s = makeSensorium()

    const fp1 = await computeDecisionFp(agent, s, [{ title: 'Alpha' }, { title: 'Beta' }])
    const fp2 = await computeDecisionFp(agent, s, [{ title: 'Beta' }, { title: 'Alpha' }])

    expect(fp1).toBe(fp2)
  })

  it('differs when sensorium kpi_progress changes', async () => {
    const agent = makeAgent()
    const s1 = makeSensorium({ vitals: { ...makeSensorium().vitals, kpi_progress: 10 } })
    const s2 = makeSensorium({ vitals: { ...makeSensorium().vitals, kpi_progress: 20 } })
    const proposals = [{ title: 'Work' }]

    const fp1 = await computeDecisionFp(agent, s1, proposals)
    const fp2 = await computeDecisionFp(agent, s2, proposals)

    expect(fp1).not.toBe(fp2)
  })

  it('differs when proposal titles change', async () => {
    const agent = makeAgent()
    const s = makeSensorium()

    const fp1 = await computeDecisionFp(agent, s, [{ title: 'Work on A' }])
    const fp2 = await computeDecisionFp(agent, s, [{ title: 'Work on B' }])

    expect(fp1).not.toBe(fp2)
  })

  it('differs for different agent ids (same sensorium + proposals)', async () => {
    const agent1 = makeAgent({ id: 'agent-1' })
    const agent2 = makeAgent({ id: 'agent-2' })
    const s = makeSensorium()
    const proposals = [{ title: 'Task' }]

    const fp1 = await computeDecisionFp(agent1, s, proposals)
    const fp2 = await computeDecisionFp(agent2, s, proposals)

    expect(fp1).not.toBe(fp2)
  })
})

// ── 2. SENSORIUM_VERSION bump invalidates fp ──────────────────────────────────

describe('computeDecisionFp — SENSORIUM_VERSION in preimage', () => {
  it('produces a different fp when SENSORIUM_VERSION changes (simulated via override)', async () => {
    const agent = makeAgent()
    const proposals = [{ title: 'Anything' }]

    // Simulate the current version
    const sV1 = makeSensorium({ version: 'v1' as typeof SENSORIUM_VERSION })
    const fpV1 = await computeDecisionFp(agent, sV1, proposals)

    // Simulate a future version bump — we override the version field directly
    // to verify the preimage includes it without modifying the real constant.
    // (In production a real version bump to 'v2' would produce a different fp.)
    const sV2 = makeSensorium({ version: 'v2' as typeof SENSORIUM_VERSION })
    const fpV2 = await computeDecisionFp(agent, sV2, proposals)

    expect(fpV1).not.toBe(fpV2)
  })
})

// ── 3. reserveDecision idempotency ────────────────────────────────────────────

describe('reserveDecision — idempotency', () => {
  it('first call returns reserved:true', async () => {
    const db = makeD1()
    const env = makeEnv(db)

    const result = await reserveDecision(env, 'tenant-a', 'agent-1', 'deadbeef')
    expect(result.reserved).toBe(true)
  })

  it('second call with same fp returns reserved:false (conflict)', async () => {
    const db = makeD1()
    const env = makeEnv(db)

    await reserveDecision(env, 'tenant-a', 'agent-1', 'deadbeef')
    const result = await reserveDecision(env, 'tenant-a', 'agent-1', 'deadbeef')
    expect(result.reserved).toBe(false)
  })

  it('different fp for same agent → both reserve (reserved:true each)', async () => {
    const db = makeD1()
    const env = makeEnv(db)

    const r1 = await reserveDecision(env, 'tenant-a', 'agent-1', 'fp-aaa')
    const r2 = await reserveDecision(env, 'tenant-a', 'agent-1', 'fp-bbb')

    expect(r1.reserved).toBe(true)
    expect(r2.reserved).toBe(true)
  })
})

// ── 4. Tenant isolation ────────────────────────────────────────────────────────

describe('reserveDecision — tenant isolation', () => {
  it('same fp + different tenant → both reserve successfully', async () => {
    const db = makeD1()
    const envA = makeEnv(db, 'tenant-a')
    const envB = makeEnv(db, 'tenant-b')

    const fp = 'shared-fp-hash'

    const rA = await reserveDecision(envA, 'tenant-a', 'agent-1', fp)
    const rB = await reserveDecision(envB, 'tenant-b', 'agent-1', fp)

    expect(rA.reserved).toBe(true)
    expect(rB.reserved).toBe(true)
  })
})

// ── 5. Loop returns 'deduped' on second identical fp (zero spawn) ──────────────

describe('runGoalCycle — deduped path', () => {
  it('returns decided=deduped, spawned=0 when fp already reserved', async () => {
    const agent = makeAgent()
    const db = makeD1()
    const env = makeEnv(db)

    const sensoriumObj = makeSensorium()
    const ct = makeCreateTask()

    const sharedDeps: LoopDeps = {
      meterCheck: makeMeterOk(),
      model: makeModel([{ title: 'Work on thing', body: 'details' }]),
      recall: vi.fn().mockResolvedValue([]),
      createTask: ct,
      writeProgress: vi.fn().mockResolvedValue(undefined),
      // Inject fixed sensorium so fp is deterministic across both calls.
      buildSensorium: vi.fn().mockResolvedValue(sensoriumObj),
      // Use real dedup/reserve against mock DB.
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    }

    // First cycle: new fp → reserved → work spawned.
    const first = await runGoalCycle(env, agent, sharedDeps)
    expect(first.decided).toBe('spawned')
    expect(first.spawned).toBe(1)
    expect(ct).toHaveBeenCalledTimes(1)

    // Second cycle: same sensorium + same proposals → same fp → conflict → deduped.
    const second = await runGoalCycle(env, agent, { ...sharedDeps, createTask: ct })
    expect(second.decided).toBe('deduped')
    expect(second.spawned).toBe(0)
    // createTask must NOT be called again.
    expect(ct).toHaveBeenCalledTimes(1)
  })
})

// ── 6. Observer — cooldown on consecutive no-ops ───────────────────────────────

describe('observe — cooldown', () => {
  it(`cooldown=false when consecutive_noops < ${NOOP_COOLDOWN_THRESHOLD}`, async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    const result = await observe(env, agent, 'deduped', now)
    expect(result.cooldown).toBe(false)
  })

  it(`cooldown=true when consecutive_noops reaches ${NOOP_COOLDOWN_THRESHOLD}`, async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    // Run enough noop ticks to cross the threshold.
    let result = { cooldown: false, escalate: false }
    for (let i = 0; i < NOOP_COOLDOWN_THRESHOLD; i++) {
      result = await observe(env, agent, 'deduped', now)
    }

    expect(result.cooldown).toBe(true)
    expect(result.reason).toMatch(/cooldown/)
  })

  it('cooldown resets to false after a productive (spawned) tick', async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    // Build up noops past threshold.
    for (let i = 0; i < NOOP_COOLDOWN_THRESHOLD; i++) {
      await observe(env, agent, 'deduped', now)
    }

    // Productive tick → resets counters.
    const result = await observe(env, agent, 'spawned', now)
    expect(result.cooldown).toBe(false)
    expect(result.escalate).toBe(false)
  })
})

// ── 7. Observer — escalate ONCE (not repeatedly) ──────────────────────────────

describe('observe — escalation dedup', () => {
  it(`escalates on first tick when consecutive_fails reaches ${FAIL_ESCALATION_THRESHOLD}`, async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    let result = { cooldown: false, escalate: false }
    for (let i = 0; i < FAIL_ESCALATION_THRESHOLD; i++) {
      result = await observe(env, agent, 'error', now)
    }

    expect(result.escalate).toBe(true)
    expect(result.reason).toMatch(/escalate/)
  })

  it('does NOT escalate again within ESCALATION_COOLDOWN_MS after first escalation', async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const now = '2026-06-22T10:00:00Z'

    // Trigger escalation.
    for (let i = 0; i < FAIL_ESCALATION_THRESHOLD; i++) {
      await observe(env, agent, 'error', now)
    }

    // Additional ticks at the SAME timestamp → deduped (still within cooldown window).
    const second = await observe(env, agent, 'error', now)
    expect(second.escalate).toBe(false)
  })

  it('escalates again after ESCALATION_COOLDOWN_MS has passed', async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()
    const t0 = '2026-06-22T10:00:00Z'

    // Trigger escalation at t0.
    for (let i = 0; i < FAIL_ESCALATION_THRESHOLD; i++) {
      await observe(env, agent, 'error', t0)
    }

    // 2 hours later (well past 1h ESCALATION_COOLDOWN_MS).
    const t2h = '2026-06-22T12:00:00Z'
    const result = await observe(env, agent, 'error', t2h)
    expect(result.escalate).toBe(true)
  })
})

// ── 8. Observer — no-goal and kpi-met are no-ops ──────────────────────────────

describe('observe — terminal states are no-ops', () => {
  it('no-goal → cooldown=false, escalate=false, no DB write', async () => {
    const db = makeD1()
    // Spy on prepare to ensure it is NOT called for no-goal.
    const prepareSpy = vi.spyOn(db, 'prepare')
    const env = makeEnv(db)
    const agent = makeAgent()

    const result = await observe(env, agent, 'no-goal')
    expect(result.cooldown).toBe(false)
    expect(result.escalate).toBe(false)
    // prepare should not be called for a no-op outcome.
    expect(prepareSpy).not.toHaveBeenCalled()
  })

  it('kpi-met → cooldown=false, escalate=false', async () => {
    const db = makeD1()
    const env = makeEnv(db)
    const agent = makeAgent()

    const result = await observe(env, agent, 'kpi-met')
    expect(result.cooldown).toBe(false)
    expect(result.escalate).toBe(false)
  })
})
