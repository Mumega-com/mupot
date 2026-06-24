// tests/sane-brain-s4b.test.ts — S4b: pluggable KPI signal sources.
//
// Covers:
//  1. parseKpiSource: no tag → 'task_counter'; '[github_prs]' tag → 'github_prs';
//     unknown tag → 'task_counter' (safe default).
//  2. parseKpiTarget: leading integer extraction.
//  3. taskCounterSource: done-task count → progress (math + zero + no-target).
//  4. githubPrsSource: merged-PR count in window → progress; window boundary.
//  5. computeKpiSignal: dispatches to the right source; injectable seams.
//  6. recordMergedPr: INSERT OR IGNORE semantics; id derivation.
//  7. loop.ts integration: kpiSignal seam overrides progress for 'spawned' and
//     'observe-only' paths.
//  8. Graceful degradation: kpiSignal throws → cycle still completes; progress unchanged.
//  9. Backward-compat: agent with plain kpi_target (no tag) → uses task_counter.
// 10. github_prs window boundary: PR at windowStart - 1 ms is excluded.

import { describe, it, expect, vi } from 'vitest'
import {
  parseKpiSource,
  parseKpiTarget,
  taskCounterSource,
  githubPrsSource,
  computeKpiSignal,
  recordMergedPr,
  GITHUB_PRS_WINDOW_MS,
} from '../src/agents/kpi-sources'
import type { KpiSignalResult } from '../src/agents/kpi-sources'
import { runGoalCycle } from '../src/agents/loop'
import type { LoopDeps } from '../src/agents/loop'
import type { Env, Agent } from '../src/types'
import type { Task } from '../src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-s4b',
    squad_id: 'squad-s4b',
    slug: 'agent-s4b',
    name: 'S4b Test Agent',
    role: 'engineer',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: 'Ship 10 PRs this month',
    kpi_target: '10 [github_prs]',
    kpi_progress: 30,
    effort: 'standard',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** Minimal Env stub. dbFn(sql, binds) → stubbed return value. */
function makeEnv(
  dbFn?: (sql: string, binds: unknown[]) => unknown,
): { env: Env; calls: { sql: string; binds: unknown[] }[] } {
  const calls: { sql: string; binds: unknown[] }[] = []
  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: {
      prepare(sql: string) {
        const call: { sql: string; binds: unknown[] } = { sql, binds: [] }
        calls.push(call)
        const stmt = {
          bind(...args: unknown[]) {
            call.binds = args
            return stmt
          },
          async first<T>(): Promise<T | null> {
            if (!dbFn) return null
            return dbFn(sql, call.binds) as T | null
          },
          async run() {
            if (!dbFn) return { meta: { changes: 1 } }
            return dbFn(sql, call.binds) as { meta: { changes: number } }
          },
        }
        return stmt
      },
    },
  } as unknown as Env
  return { env, calls }
}

// ── 1. parseKpiSource ─────────────────────────────────────────────────────────

describe('parseKpiSource', () => {
  it('returns task_counter when kpi_target is null', () => {
    expect(parseKpiSource(null)).toBe('task_counter')
  })

  it('returns task_counter when kpi_target has no tag', () => {
    expect(parseKpiSource('10 tasks/week')).toBe('task_counter')
    expect(parseKpiSource('20')).toBe('task_counter')
    expect(parseKpiSource('')).toBe('task_counter')
  })

  it('returns github_prs when tag is [github_prs]', () => {
    expect(parseKpiSource('10 [github_prs]')).toBe('github_prs')
    expect(parseKpiSource('10 prs/month [github_prs]')).toBe('github_prs')
    expect(parseKpiSource('[github_prs]')).toBe('github_prs')
  })

  it('returns task_counter for unknown tag (safe default)', () => {
    expect(parseKpiSource('10 [unknown_source]')).toBe('task_counter')
  })
})

// ── 2. parseKpiTarget ────────────────────────────────────────────────────────

describe('parseKpiTarget', () => {
  it('parses a leading integer', () => {
    expect(parseKpiTarget('10 tasks')).toBe(10)
    expect(parseKpiTarget('20 [github_prs]')).toBe(20)
    expect(parseKpiTarget('5')).toBe(5)
  })

  it('returns null when no leading integer', () => {
    expect(parseKpiTarget(null)).toBeNull()
    expect(parseKpiTarget('')).toBeNull()
    expect(parseKpiTarget('ship features')).toBeNull()
  })

  it('returns null for zero', () => {
    // 0 is not a valid positive denominator
    expect(parseKpiTarget('0 tasks')).toBeNull()
  })
})

// ── 3. taskCounterSource ─────────────────────────────────────────────────────

describe('taskCounterSource', () => {
  it('computes progress from done-task count', async () => {
    const { env } = makeEnv((sql) => {
      if (sql.includes('COUNT(*)')) return { cnt: 3 }
      return null
    })
    const agent = makeAgent({ kpi_target: '10 tasks', kpi_progress: 0 })
    const result = await taskCounterSource(env, agent)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.count).toBe(3)
    expect(result.target).toBe(10)
    expect(result.progress).toBe(30) // 3/10 * 100
    expect(result.source).toBe('task_counter')
  })

  it('returns progress 100 when done >= target', async () => {
    const { env } = makeEnv(() => ({ cnt: 15 }))
    const agent = makeAgent({ kpi_target: '10 tasks', kpi_progress: 0 })
    const result = await taskCounterSource(env, agent)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.progress).toBe(100)
  })

  it('returns ok:false when no target', async () => {
    const { env } = makeEnv()
    const agent = makeAgent({ kpi_target: null, kpi_progress: 0 })
    const result = await taskCounterSource(env, agent)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('no_target')
    expect(result.source).toBe('task_counter')
  })

  it('returns 0% when no done tasks', async () => {
    const { env } = makeEnv(() => ({ cnt: 0 }))
    const agent = makeAgent({ kpi_target: '10 tasks', kpi_progress: 50 })
    const result = await taskCounterSource(env, agent)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.progress).toBe(0)
  })
})

// ── 4. githubPrsSource ───────────────────────────────────────────────────────

describe('githubPrsSource', () => {
  it('computes progress from merged-PR count', async () => {
    const { env, calls } = makeEnv((sql) => {
      if (sql.includes('github_prs_merged')) return { cnt: 5 }
      return null
    })
    const agent = makeAgent({ kpi_target: '10 [github_prs]', kpi_progress: 0 })
    const nowMs = 1_700_000_000_000
    const result = await githubPrsSource(env, agent, { nowMs })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.count).toBe(5)
    expect(result.target).toBe(10)
    expect(result.progress).toBe(50)
    expect(result.source).toBe('github_prs')
    // Verify the window bound was passed correctly
    const prCall = calls.find((c) => c.sql.includes('github_prs_merged'))
    expect(prCall?.binds[0]).toBe('test-tenant')
    expect(prCall?.binds[1]).toBe(nowMs - GITHUB_PRS_WINDOW_MS)
  })

  it('returns ok:false when no target', async () => {
    const { env } = makeEnv()
    const agent = makeAgent({ kpi_target: null, kpi_progress: 0 })
    const result = await githubPrsSource(env, agent)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toBe('no_target')
    expect(result.source).toBe('github_prs')
  })

  it('excludes PRs before the window', async () => {
    // windowStart = nowMs - WINDOW_MS; a PR at windowStart - 1 is excluded
    const nowMs = 1_700_000_000_000
    const windowStart = nowMs - GITHUB_PRS_WINDOW_MS
    // Only PRs with merged_at >= windowStart are counted.
    // We verify the SQL bind matches — the stub just returns 0.
    const { env, calls } = makeEnv(() => ({ cnt: 0 }))
    const agent = makeAgent({ kpi_target: '10 [github_prs]' })
    await githubPrsSource(env, agent, { nowMs })
    const prCall = calls.find((c) => c.sql.includes('github_prs_merged'))
    expect(prCall?.binds[1]).toBe(windowStart)
  })

  it('returns 100 when count exceeds target', async () => {
    const { env } = makeEnv(() => ({ cnt: 99 }))
    const agent = makeAgent({ kpi_target: '10 [github_prs]' })
    const result = await githubPrsSource(env, agent, { nowMs: Date.now() })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.progress).toBe(100)
  })
})

// ── 5. computeKpiSignal dispatch ─────────────────────────────────────────────

describe('computeKpiSignal', () => {
  it('dispatches to task_counter for untagged kpi_target', async () => {
    const { env } = makeEnv()
    const agent = makeAgent({ kpi_target: '10 tasks' })
    const taskCounterFn = vi.fn().mockResolvedValue({ ok: true, count: 5, target: 10, progress: 50, source: 'task_counter' } satisfies KpiSignalResult)
    const result = await computeKpiSignal(env, agent, { taskCounter: taskCounterFn })
    expect(taskCounterFn).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source).toBe('task_counter')
  })

  it('dispatches to github_prs for [github_prs] tag', async () => {
    const { env } = makeEnv()
    const agent = makeAgent({ kpi_target: '10 [github_prs]' })
    const githubFn = vi.fn().mockResolvedValue({ ok: true, count: 7, target: 10, progress: 70, source: 'github_prs' } satisfies KpiSignalResult)
    const result = await computeKpiSignal(env, agent, { githubPrs: githubFn })
    expect(githubFn).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.source).toBe('github_prs')
  })

  it('passes nowMs to github_prs source', async () => {
    const { env } = makeEnv()
    const agent = makeAgent({ kpi_target: '10 [github_prs]' })
    const githubFn = vi.fn().mockResolvedValue({ ok: true, count: 0, target: 10, progress: 0, source: 'github_prs' } satisfies KpiSignalResult)
    const fixedNow = 1_720_000_000_000
    await computeKpiSignal(env, agent, { githubPrs: githubFn, nowMs: fixedNow })
    expect(githubFn).toHaveBeenCalledWith(env, agent, { nowMs: fixedNow })
  })
})

// ── 6. recordMergedPr ─────────────────────────────────────────────────────────

describe('recordMergedPr', () => {
  it('inserts a row and returns inserted:true', async () => {
    const { env, calls } = makeEnv(() => ({ meta: { changes: 1 } }))
    const result = await recordMergedPr(env, {
      repo: 'Mumega-com/mupot',
      prNumber: 42,
      title: 'feat: add KPI sources',
      nowMs: 1_700_000_000_000,
    })
    expect(result.ok).toBe(true)
    expect(result.inserted).toBe(true)
    const insertCall = calls.find((c) => c.sql.includes('INSERT OR IGNORE'))
    expect(insertCall).toBeDefined()
    expect(insertCall?.binds[1]).toBe('test-tenant')
    expect(insertCall?.binds[2]).toBe('Mumega-com/mupot')
    expect(insertCall?.binds[3]).toBe(42)
    expect(insertCall?.binds[4]).toBe('feat: add KPI sources')
  })

  it('returns inserted:false on duplicate (changes=0)', async () => {
    const { env } = makeEnv(() => ({ meta: { changes: 0 } }))
    const result = await recordMergedPr(env, {
      repo: 'Mumega-com/mupot',
      prNumber: 42,
      title: null,
      nowMs: 1_700_000_000_000,
    })
    expect(result.ok).toBe(true)
    expect(result.inserted).toBe(false)
  })

  it('accepts null title', async () => {
    const { env, calls } = makeEnv(() => ({ meta: { changes: 1 } }))
    await recordMergedPr(env, { repo: 'org/repo', prNumber: 1, title: null })
    const insertCall = calls.find((c) => c.sql.includes('INSERT OR IGNORE'))
    expect(insertCall?.binds[4]).toBeNull()
  })

  it('never throws — returns {ok:false} on DB error (contract matches comment)', async () => {
    // DB stub that throws on INSERT
    const env = {
      TENANT_SLUG: 'test-tenant',
      DB: {
        prepare(_sql: string) {
          return {
            bind() { return this },
            async run() { throw new Error('D1 explosion') },
          }
        },
      },
    } as unknown as Env

    // Must NOT throw — the webhook handler calls this and always 200s GitHub
    const result = await recordMergedPr(env, {
      repo: 'Mumega-com/mupot',
      prNumber: 99,
      title: 'test',
      nowMs: 1_700_000_000_000,
    })
    expect(result.ok).toBe(false)
    expect(result.inserted).toBe(false)
  })
})

// ── 7. loop.ts integration — kpiSignal seam ──────────────────────────────────

describe('runGoalCycle kpiSignal integration', () => {
  function makeLoopEnv(): Env {
    return {
      TENANT_SLUG: 'test',
      DB: {
        prepare(sql: string) {
          const stmt = {
            bind() { return stmt },
            async first<T>(): Promise<T | null> {
              // Backlog count: return 0 (no backpressure)
              if (sql.includes('COUNT(*)') && sql.includes('open')) return { cnt: 0 } as unknown as T
              // kpi_progress SELECT: current value
              if (sql.includes('kpi_progress') && sql.includes('SELECT')) return { kpi_progress: 40 } as unknown as T
              return null
            },
            async run() { return { meta: { changes: 1 } } },
          }
          return stmt
        },
      },
    } as unknown as Env
  }

  function makeTask(): Task {
    return {
      id: 'task-1',
      squad_id: 'squad-s4b',
      title: 'Test task',
      body: '',
      status: 'open',
      assignee_agent_id: null,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: null,
      done_when: 'test done',
      workflow_instance_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
  }

  it('calls kpiSignal seam and writes progress on spawned path', async () => {
    const env = makeLoopEnv()
    const kpiSignalFn = vi.fn().mockResolvedValue({
      ok: true, count: 7, target: 10, progress: 70, source: 'github_prs',
    } satisfies KpiSignalResult)
    const writtenProgress: number[] = []

    const deps: LoopDeps = {
      kpiSignal: kpiSignalFn,
      writeProgress: async (_env, _id, p) => { writtenProgress.push(p) },
      meterCheck: vi.fn().mockResolvedValue({ ok: true, windowKey: 'k', count: 1, tokens: 0 }),
      model: { chat: vi.fn().mockResolvedValue('{"summary":"s","tasks":[{"title":"T","body":"B"}]}') },
      createTask: vi.fn().mockResolvedValue(makeTask()),
      computeDecisionFp: vi.fn().mockResolvedValue('fp-unique'),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
      buildSensorium: vi.fn().mockResolvedValue(null),
      observe: vi.fn().mockResolvedValue({ escalate: false, reason: null, consecutiveNoops: 0 }),
      recordEpisode: vi.fn().mockResolvedValue(undefined),
      recentEpisodes: vi.fn().mockResolvedValue([]),
      recall: vi.fn().mockResolvedValue([]),
      recordTokens: vi.fn().mockResolvedValue(undefined),
    }

    const agent = makeAgent()
    const result = await runGoalCycle(env, agent, deps)

    expect(result.ok).toBe(true)
    expect(result.decided).toBe('spawned')
    expect(kpiSignalFn).toHaveBeenCalledOnce()
    expect(writtenProgress).toEqual([70])
  })

  it('calls kpiSignal seam on observe-only path (effort=low)', async () => {
    const env = makeLoopEnv()
    const kpiSignalFn = vi.fn().mockResolvedValue({
      ok: true, count: 3, target: 10, progress: 30, source: 'github_prs',
    } satisfies KpiSignalResult)
    const writtenProgress: number[] = []

    const deps: LoopDeps = {
      kpiSignal: kpiSignalFn,
      writeProgress: async (_env, _id, p) => { writtenProgress.push(p) },
      buildSensorium: vi.fn().mockResolvedValue(null),
      observe: vi.fn().mockResolvedValue({ escalate: false, reason: null, consecutiveNoops: 0 }),
      recordEpisode: vi.fn().mockResolvedValue(undefined),
      recentEpisodes: vi.fn().mockResolvedValue([]),
    }

    const agent = makeAgent({ effort: 'low' })
    const result = await runGoalCycle(env, agent, deps)

    expect(result.decided).toBe('observe-only')
    expect(kpiSignalFn).toHaveBeenCalledOnce()
    expect(writtenProgress).toEqual([30])
  })

  it('degrades gracefully when kpiSignal throws — cycle still completes', async () => {
    const env = makeLoopEnv()
    const kpiSignalFn = vi.fn().mockRejectedValue(new Error('DB exploded'))
    const writtenProgress: number[] = []

    const deps: LoopDeps = {
      kpiSignal: kpiSignalFn,
      writeProgress: async (_env, _id, p) => { writtenProgress.push(p) },
      buildSensorium: vi.fn().mockResolvedValue(null),
      observe: vi.fn().mockResolvedValue({ escalate: false, reason: null, consecutiveNoops: 0 }),
      recordEpisode: vi.fn().mockResolvedValue(undefined),
      recentEpisodes: vi.fn().mockResolvedValue([]),
    }

    const agent = makeAgent({ effort: 'low' })
    const result = await runGoalCycle(env, agent, deps)

    // Cycle completes — the error is swallowed
    expect(result.ok).toBe(true)
    expect(result.decided).toBe('observe-only')
    // Progress write was skipped (signal threw) — writtenProgress stays empty
    expect(writtenProgress).toHaveLength(0)
  })

  // ── 11. S1 determinism regression (Codex blocker) ────────────────────────────
  // The live goal-cycle path must thread the loop's injected nowMs into the
  // github_prs KPI source — it must NEVER fall back to Date.now() internally.
  //
  // Proof: inject a fixed nowMs far in the past (1970-01-02). The production
  // computeKpiSignal would use Date.now() ≈ 2026 if the seam is broken — the
  // window boundary would be ~56 years later, so a DB returning cnt=1 would show
  // non-zero progress. With the correct seam the kpiSignal receives the exact
  // injected nowMs; we assert by capturing what the seam was called with.
  it('[S1 regression] runGoalCycle threads injected nowMs into github_prs source — no Date.now() fallback', async () => {
    const env = makeLoopEnv()
    const FIXED_NOW_MS = 86_400_000 // 1970-01-02T00:00:00.000Z — far in the past

    // Capture the nowMs argument the kpiSignal seam receives.
    const capturedNowMs: number[] = []
    const kpiSignalFn = vi.fn().mockImplementation(
      async (_e: Env, _a: Agent, receivedNowMs: number) => {
        capturedNowMs.push(receivedNowMs)
        return { ok: true, count: 1, target: 10, progress: 10, source: 'github_prs' } satisfies KpiSignalResult
      },
    )
    const writtenProgress: number[] = []

    const deps: LoopDeps = {
      nowMs: FIXED_NOW_MS, // ← single loop clock injected here
      kpiSignal: kpiSignalFn,
      writeProgress: async (_env, _id, p) => { writtenProgress.push(p) },
      buildSensorium: vi.fn().mockResolvedValue(null),
      observe: vi.fn().mockResolvedValue({ escalate: false, reason: null, consecutiveNoops: 0 }),
      recordEpisode: vi.fn().mockResolvedValue(undefined),
      recentEpisodes: vi.fn().mockResolvedValue([]),
    }

    const agent = makeAgent({ kpi_target: '10 [github_prs]', effort: 'low' })
    const result = await runGoalCycle(env, agent, deps)

    expect(result.decided).toBe('observe-only')

    // kpiSignal was called exactly once
    expect(kpiSignalFn).toHaveBeenCalledOnce()

    // The nowMs received by the seam MUST be the injected fixed value.
    // If Date.now() leaked in, this would be ~1.7e12 (year 2026), not 86_400_000.
    expect(capturedNowMs).toHaveLength(1)
    expect(capturedNowMs[0]).toBe(FIXED_NOW_MS)

    // Progress was written from the signal result
    expect(writtenProgress).toEqual([10])
  })

  it('backward-compat: untagged kpi_target uses task_counter (no kpiSignal override)', async () => {
    // When no kpiSignal seam is injected and kpi_target has no tag, computeKpiSignal
    // selects 'task_counter'. We verify by checking the env stub responds to the
    // task-counter SQL (COUNT(*) on tasks) and progress is written.
    // This test validates no regression for existing agents.
    const dbCalls: string[] = []
    const env = {
      TENANT_SLUG: 'test',
      DB: {
        prepare(sql: string) {
          dbCalls.push(sql)
          const stmt = {
            bind() { return stmt },
            async first<T>(): Promise<T | null> {
              if (sql.includes('COUNT(*)') && sql.includes('tasks') && sql.includes('done')) return { cnt: 2 } as unknown as T
              if (sql.includes('COUNT(*)') && sql.includes('open')) return { cnt: 0 } as unknown as T
              if (sql.includes('kpi_progress') && sql.includes('SELECT')) return { kpi_progress: 20 } as unknown as T
              return null
            },
            async run() { return { meta: { changes: 1 } } },
          }
          return stmt
        },
      },
    } as unknown as Env

    const writtenProgress: number[] = []
    const deps: LoopDeps = {
      writeProgress: async (_env, _id, p) => { writtenProgress.push(p) },
      buildSensorium: vi.fn().mockResolvedValue(null),
      observe: vi.fn().mockResolvedValue({ escalate: false, reason: null, consecutiveNoops: 0 }),
      recordEpisode: vi.fn().mockResolvedValue(undefined),
      recentEpisodes: vi.fn().mockResolvedValue([]),
    }

    // Agent with plain untagged target — should use task_counter
    const agent = makeAgent({ kpi_target: '10 tasks', effort: 'low' })
    await runGoalCycle(env, agent, deps)

    // A COUNT(*) on tasks table was issued (task-counter path)
    expect(dbCalls.some((s) => s.includes('tasks') && s.includes('done'))).toBe(true)
    // Progress written = 2/10 * 100 = 20
    expect(writtenProgress).toEqual([20])
  })
})
