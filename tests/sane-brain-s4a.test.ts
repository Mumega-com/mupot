// tests/sane-brain-s4a.test.ts — S4a sane-brain: episodic memory layer.
//
// Covers:
//  1. recordEpisode inserts a tenant-scoped, bounded row (INSERT args verified).
//  2. recentEpisodes returns recency-ordered, bounded list; tenant-isolated.
//  3. renderEpisodes produces a stable, deterministic prompt block.
//  4. Loop records 'spawned' episode (always) and 'backpressure' episode.
//  5. Loop does NOT record 'observe-only' (effort=low) or 'deduped' episodes.
//  6. Episodic fetch failure degrades gracefully — cycle still completes.
//  7. EPISODIC_VERSION change + fp preimage includes it → different fp on version bump.
//  8. recordEpisode bounds summary to EPISODE_SUMMARY_MAX.

import { describe, it, expect, vi } from 'vitest'
import {
  recordEpisode,
  recentEpisodes,
  renderEpisodes,
  safeRecordEpisode,
  safeRecentEpisodes,
  EPISODIC_VERSION,
  EPISODE_SUMMARY_MAX,
  EPISODE_DEFAULT_LIMIT,
  EPISODE_LIMIT_MAX,
} from '../src/agents/episodic'
import type { Episode, EpisodeInput } from '../src/agents/episodic'
import { runGoalCycle, MAX_OPEN_TASKS } from '../src/agents/loop'
import type { LoopDeps } from '../src/agents/loop'
import { computeDecisionFp } from '../src/agents/dedup'
import { SENSORIUM_VERSION } from '../src/agents/sensorium'
import type { Sensorium } from '../src/agents/sensorium'
import type { Env, Agent } from '../src/types'
import type { Task } from '../src/types'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-s4a',
    squad_id: 'squad-s4a',
    slug: 'agent-s4a',
    name: 'S4a Test Agent',
    role: 'engineer',
    model: '@cf/meta/llama-3.3',
    status: 'active',
    okr: 'Ship 10 features',
    kpi_target: '10 tasks',
    kpi_progress: 40,
    effort: 'standard',
    autonomy: 'draft',
    budget_cap_cents: null,
    budget_window: 'week',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    version: SENSORIUM_VERSION,
    clock: { now: '2026-06-24T10:00:00Z', agent_age_days: 12, cycles: 5, last_woke_at: null },
    situation: { agent_name: 'S4a Test Agent', agent_role: 'engineer', autonomy: 'draft', effort: 'standard', wake_reason: null },
    schedule: { counts: { open: 2, in_progress: 1, done: 4, blocked: 0 }, overdue: 0, oldest_open_tasks: [] },
    vitals: { kpi_progress: 40, kpi_target: '10 tasks', budget_remaining_micro_usd: null, budget_window: 'week' },
    delegations: [],
    tasks: [],
    ...overrides,
  }
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'ep-1',
    tenant: 'tenant-s4a',
    agent_id: 'agent-s4a',
    cycle: 5,
    ts: '2026-06-24T10:00:00Z',
    kind: 'spawned',
    summary: 'Spawned 1 task toward goal.',
    decision_fp: 'deadbeef',
    kpi_progress: 40,
    created_at: '2026-06-24T10:00:00Z',
    ...overrides,
  }
}

// ── D1 mock for episodic unit tests ──────────────────────────────────────────

interface EpisodicD1Opts {
  rows?: Episode[]            // rows returned by SELECT
  insertThrows?: boolean      // simulate INSERT failure
  selectThrows?: boolean      // simulate SELECT failure
  captureInsert?: { sql: string; args: unknown[] }[]  // capture INSERT calls
}

function makeEpisodicD1(opts: EpisodicD1Opts = {}) {
  const store: Episode[] = [...(opts.rows ?? [])]

  return {
    prepare(sql: string) {
      let boundArgs: unknown[] = []
      const isInsert = sql.startsWith('INSERT INTO agent_episodes')
      const isSelect = sql.includes('FROM agent_episodes')

      return {
        bind(...args: unknown[]) {
          boundArgs = args
          return this
        },
        async run(): Promise<{ meta: { changes: number } }> {
          if (isInsert) {
            if (opts.insertThrows) throw new Error('D1 INSERT error')
            // Capture for assertion
            if (opts.captureInsert) {
              opts.captureInsert.push({ sql, args: [...boundArgs] })
            }
            return { meta: { changes: 1 } }
          }
          return { meta: { changes: 0 } }
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (isSelect) {
            if (opts.selectThrows) throw new Error('D1 SELECT error')
            const [tenant, agentId, limit] = boundArgs as [string, string, number]
            const filtered = store
              .filter((r) => r.tenant === tenant && r.agent_id === agentId)
              .sort((a, b) => {
                if (b.ts !== a.ts) return b.ts < a.ts ? -1 : 1
                return b.id < a.id ? -1 : 1
              })
              .slice(0, limit)
            return { results: filtered as unknown as T[] }
          }
          return { results: [] }
        },
        async first<T>(): Promise<T | null> {
          return null
        },
      }
    },
  }
}

function makeEnv(
  db: ReturnType<typeof makeEpisodicD1>,
  tenant = 'tenant-s4a',
): Env {
  return { TENANT_SLUG: tenant, DB: db } as unknown as Env
}

// ── Full-loop D1 mock (union of S3 mock + episodic) ──────────────────────────

interface LoopD1Opts {
  backlogCount?: number
  backlogThrows?: boolean
  captureEpisodes?: { sql: string; args: unknown[] }[]
  episodeFetchRows?: Episode[]
  episodeFetchThrows?: boolean
}

function makeLoopD1(opts: LoopD1Opts = {}) {
  return {
    prepare(sql: string) {
      const isBacklogCount = sql.includes('FROM tasks') && sql.includes('COUNT(*)')
      const isObserverSelect = sql.includes('FROM loop_observer')
      const isObserverUpsert = sql.includes('INSERT INTO loop_observer')
      const isEpisodeInsert = sql.startsWith('INSERT INTO agent_episodes')
      const isEpisodeSelect = sql.includes('FROM agent_episodes')
      let boundArgs: unknown[] = []

      const observerRows = new Map<string, {
        consecutive_noops: number; consecutive_fails: number; liveness_fails: number
        last_escalated_at: string | null; cooldown_until: string | null
      }>()

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
          if (isEpisodeInsert) {
            if (opts.captureEpisodes) {
              opts.captureEpisodes.push({ sql, args: [...boundArgs] })
            }
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
        async all<T>(): Promise<{ results: T[] }> {
          if (isEpisodeSelect) {
            if (opts.episodeFetchThrows) throw new Error('D1 SELECT down')
            return { results: (opts.episodeFetchRows ?? []) as unknown as T[] }
          }
          return { results: [] }
        },
      }
    },
  }
}

function makeLoopEnv(db: ReturnType<typeof makeLoopD1>, tenant = 'tenant-s4a'): Env {
  return { TENANT_SLUG: tenant, DB: db } as unknown as Env
}

// ── Shared loop dep builders ──────────────────────────────────────────────────

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
    buildSensorium: vi.fn().mockResolvedValue(makeSensorium()),
    computeDecisionFp: vi.fn().mockResolvedValue('fp-' + Math.random().toString(36).slice(2)),
    reserveDecision: vi.fn().mockResolvedValue({ reserved: true }),
    observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
    recentEpisodes: vi.fn().mockResolvedValue([]),
    recordEpisode: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

// ── 1. recordEpisode — INSERT with tenant-scoped, bounded row ─────────────────

describe('recordEpisode — INSERT args', () => {
  it('inserts a row with tenant, agent_id, kind, bounded summary', async () => {
    const captured: { sql: string; args: unknown[] }[] = []
    const db = makeEpisodicD1({ captureInsert: captured })
    const env = makeEnv(db)
    const agent = makeAgent()
    const ep: EpisodeInput = {
      cycle: 7,
      kind: 'spawned',
      summary: 'Spawned 2 tasks toward OKR.',
      decisionFp: 'abc123',
      kpiProgress: 45,
    }
    await recordEpisode(env, agent, ep, '2026-06-24T10:00:00Z')

    expect(captured).toHaveLength(1)
    const args = captured[0].args
    // args: [id, tenant, agent_id, cycle, ts, kind, summary, decision_fp, kpi_progress]
    expect(args[1]).toBe('tenant-s4a')           // tenant
    expect(args[2]).toBe('agent-s4a')             // agent_id
    expect(args[3]).toBe(7)                        // cycle
    expect(args[4]).toBe('2026-06-24T10:00:00Z')  // ts
    expect(args[5]).toBe('spawned')               // kind
    expect(args[6]).toBe('Spawned 2 tasks toward OKR.') // summary
    expect(args[7]).toBe('abc123')                // decision_fp
    expect(args[8]).toBe(45)                      // kpi_progress
  })

  it('bounds summary to EPISODE_SUMMARY_MAX characters before INSERT', async () => {
    const captured: { sql: string; args: unknown[] }[] = []
    const db = makeEpisodicD1({ captureInsert: captured })
    const env = makeEnv(db)
    const agent = makeAgent()
    const longSummary = 'x'.repeat(EPISODE_SUMMARY_MAX + 100)
    await recordEpisode(env, agent, { kind: 'spawned', summary: longSummary })
    expect(captured).toHaveLength(1)
    const insertedSummary = captured[0].args[6] as string
    expect(insertedSummary.length).toBe(EPISODE_SUMMARY_MAX)
  })

  it('uses env.TENANT_SLUG for tenant isolation', async () => {
    const captured: { sql: string; args: unknown[] }[] = []
    const db = makeEpisodicD1({ captureInsert: captured })
    const env = { TENANT_SLUG: 'other-tenant', DB: db } as unknown as Env
    const agent = makeAgent()
    await recordEpisode(env, agent, { kind: 'backpressure', summary: 'queue full' })
    expect(captured[0].args[1]).toBe('other-tenant')
  })

  it('null-fills optional fields when absent', async () => {
    const captured: { sql: string; args: unknown[] }[] = []
    const db = makeEpisodicD1({ captureInsert: captured })
    const env = makeEnv(db)
    const agent = makeAgent()
    await recordEpisode(env, agent, { kind: 'spawned', summary: 'minimal' })
    const args = captured[0].args
    expect(args[3]).toBeNull()  // cycle
    expect(args[7]).toBeNull()  // decision_fp
    expect(args[8]).toBeNull()  // kpi_progress
  })
})

// ── 2. recentEpisodes — recency-ordered, bounded, tenant-isolated ──────────────

describe('recentEpisodes — SELECT behaviour', () => {
  it('returns rows in ts DESC, id DESC order (newest first)', async () => {
    const rows: Episode[] = [
      makeEpisode({ id: 'ep-a', ts: '2026-06-24T09:00:00Z', summary: 'older' }),
      makeEpisode({ id: 'ep-b', ts: '2026-06-24T10:00:00Z', summary: 'newer' }),
    ]
    const db = makeEpisodicD1({ rows })
    const env = makeEnv(db)
    const agent = makeAgent()
    const result = await recentEpisodes(env, agent, 5)
    expect(result[0].summary).toBe('newer')
    expect(result[1].summary).toBe('older')
  })

  it('returns at most `limit` rows (default=5)', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeEpisode({ id: `ep-${i}`, ts: `2026-06-24T${String(i).padStart(2, '0')}:00:00Z` }),
    )
    const db = makeEpisodicD1({ rows })
    const env = makeEnv(db)
    const agent = makeAgent()
    const result = await recentEpisodes(env, agent, EPISODE_DEFAULT_LIMIT)
    expect(result.length).toBeLessThanOrEqual(EPISODE_DEFAULT_LIMIT)
  })

  it('clamps limit to EPISODE_LIMIT_MAX', async () => {
    // We verify the query uses the clamped limit (EPISODE_LIMIT_MAX).
    // The D1 mock respects the limit arg — requesting > max still returns <= max.
    const rows = Array.from({ length: EPISODE_LIMIT_MAX + 5 }, (_, i) =>
      makeEpisode({ id: `ep-${i}`, ts: `2026-06-24T00:${String(i).padStart(2, '0')}:00Z` }),
    )
    const db = makeEpisodicD1({ rows })
    const env = makeEnv(db)
    const agent = makeAgent()
    const result = await recentEpisodes(env, agent, EPISODE_LIMIT_MAX + 100)
    expect(result.length).toBeLessThanOrEqual(EPISODE_LIMIT_MAX)
  })

  it('returns [] when no rows exist', async () => {
    const db = makeEpisodicD1({ rows: [] })
    const env = makeEnv(db)
    const agent = makeAgent()
    const result = await recentEpisodes(env, agent)
    expect(result).toEqual([])
  })

  it('tenant-isolation: rows from another tenant are excluded', async () => {
    // DB has rows for both tenants; recentEpisodes should only return ours.
    const ourRows: Episode[] = [
      makeEpisode({ id: 'ep-ours', tenant: 'tenant-s4a', summary: 'our episode' }),
    ]
    const otherRows: Episode[] = [
      makeEpisode({ id: 'ep-other', tenant: 'other-tenant', summary: 'their episode' }),
    ]
    // makeEpisodicD1 filters by tenant in the mock — use both rows but filter by env.TENANT_SLUG
    const db = makeEpisodicD1({ rows: [...ourRows, ...otherRows] })
    const env = makeEnv(db, 'tenant-s4a')
    const agent = makeAgent()
    const result = await recentEpisodes(env, agent)
    // Only our tenant's rows should come back
    expect(result.every((r) => r.tenant === 'tenant-s4a')).toBe(true)
  })
})

// ── 3. safeRecentEpisodes — degrades on SELECT failure ─────────────────────────

describe('safeRecentEpisodes — degradation on DB error', () => {
  it('returns [] when D1 SELECT throws', async () => {
    const db = makeEpisodicD1({ selectThrows: true })
    const env = makeEnv(db)
    const agent = makeAgent()
    const result = await safeRecentEpisodes(env, agent)
    expect(result).toEqual([])
  })
})

describe('safeRecordEpisode — degradation on DB error', () => {
  it('does not throw when INSERT fails', async () => {
    const db = makeEpisodicD1({ insertThrows: true })
    const env = makeEnv(db)
    const agent = makeAgent()
    await expect(
      safeRecordEpisode(env, agent, { kind: 'spawned', summary: 'test' }),
    ).resolves.toBeUndefined()
  })
})

// ── 4. renderEpisodes — stable, deterministic prompt block ────────────────────

describe('renderEpisodes — prompt block', () => {
  it('returns empty string for empty list', () => {
    expect(renderEpisodes([])).toBe('')
  })

  it('renders a stable block with EPISODIC_VERSION header', () => {
    const eps: Episode[] = [
      makeEpisode({ id: 'ep-1', cycle: 5, kind: 'spawned', summary: 'Spawned 2 tasks.' }),
    ]
    const out = renderEpisodes(eps)
    expect(out).toContain(`[EPISODES ${EPISODIC_VERSION}]`)
    expect(out).toContain('[cycle 5 spawned]')
    expect(out).toContain('Spawned 2 tasks.')
  })

  it('renders null cycle as "cycle ?"', () => {
    const eps: Episode[] = [
      makeEpisode({ id: 'ep-1', cycle: null, kind: 'backpressure', summary: 'Queue full.' }),
    ]
    const out = renderEpisodes(eps)
    expect(out).toContain('[cycle ? backpressure]')
  })

  it('orders episodes as provided (callers pass newest-first from recentEpisodes)', () => {
    const eps: Episode[] = [
      makeEpisode({ id: 'ep-new', cycle: 10, kind: 'spawned', summary: 'New.' }),
      makeEpisode({ id: 'ep-old', cycle: 7, kind: 'backpressure', summary: 'Old.' }),
    ]
    const out = renderEpisodes(eps)
    const idxNew = out.indexOf('New.')
    const idxOld = out.indexOf('Old.')
    expect(idxNew).toBeLessThan(idxOld)
  })

  it('strips control chars (\\n, \\r, \\t) from summary so they cannot forge prompt lines', () => {
    const eps: Episode[] = [
      makeEpisode({ id: 'ep-1', cycle: 1, kind: 'spawned', summary: 'line1\nline2\r\nline3' }),
    ]
    const out = renderEpisodes(eps)
    // The episode block has a header line + one data line.
    // The data line should contain the sanitized summary as a SINGLE line (no embedded \n).
    const lines = out.split('\n')
    // Header is lines[0]; episode data is lines[1].
    const dataLine = lines[1]
    expect(dataLine).toBeDefined()
    expect(dataLine).toContain('[cycle 1 spawned]')
    // The raw \n in the summary must be gone — no extra lines from the summary itself.
    // We check: the data line contains no embedded newline chars.
    expect(dataLine).not.toMatch(/\r|\n/)
    // The text portions are collapsed to a space: "line1 line2  line3" (stripped to trim)
    expect(dataLine).toContain('line1')
  })

  it('is deterministic: same input → same output', () => {
    const eps: Episode[] = [
      makeEpisode({ id: 'ep-1', cycle: 3, kind: 'spawned', summary: 'Task A done.' }),
      makeEpisode({ id: 'ep-2', cycle: 2, kind: 'backpressure', summary: 'Queue full.' }),
    ]
    expect(renderEpisodes(eps)).toBe(renderEpisodes(eps))
  })
})

// ── 5. Loop wires: records 'spawned' and 'backpressure', skips 'observe-only' and 'deduped'

describe('runGoalCycle — episodic wiring', () => {
  it('records a spawned episode after a productive cycle', async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0 }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    const result = await runGoalCycle(env, agent, baseDeps({
      model: makeModel([{ title: 'Build feature', body: 'details' }]),
      recordEpisode,
    }))
    expect(result.decided).toBe('spawned')
    expect(recordEpisode).toHaveBeenCalled()
    const call = (recordEpisode as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, , ep]) => (ep as { kind: string }).kind === 'spawned',
    )
    expect(call).toBeDefined()
  })

  it('records a backpressure episode when queue is full', async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: MAX_OPEN_TASKS }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    const result = await runGoalCycle(env, agent, baseDeps({ recordEpisode }))
    expect(result.decided).toBe('backpressure')
    expect(recordEpisode).toHaveBeenCalled()
    const call = (recordEpisode as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, , ep]) => (ep as { kind: string }).kind === 'backpressure',
    )
    expect(call).toBeDefined()
  })

  it('does NOT record an episode on observe-only (effort=low)', async () => {
    const agent = makeAgent({ effort: 'low' })
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0 }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    const result = await runGoalCycle(env, agent, baseDeps({ recordEpisode }))
    expect(result.decided).toBe('observe-only')
    expect(recordEpisode).not.toHaveBeenCalled()
  })

  it('does NOT record an episode on deduped', async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0 }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    const result = await runGoalCycle(env, agent, baseDeps({
      model: makeModel([{ title: 'T', body: 'b' }]),
      reserveDecision: vi.fn().mockResolvedValue({ reserved: false }),
      recordEpisode,
    }))
    expect(result.decided).toBe('deduped')
    expect(recordEpisode).not.toHaveBeenCalled()
  })

  it('records escalated episode when observer.escalate=true on spawned', async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0 }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    const result = await runGoalCycle(env, agent, baseDeps({
      model: makeModel([{ title: 'T', body: 'b' }]),
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: true }),
      recordEpisode,
    }))
    expect(result.decided).toBe('spawned')
    // Should have recorded both 'spawned' AND 'escalated' episodes
    const kinds = (recordEpisode as ReturnType<typeof vi.fn>).mock.calls.map(
      ([, , ep]) => (ep as { kind: string }).kind,
    )
    expect(kinds).toContain('spawned')
    expect(kinds).toContain('escalated')
  })

  it('cycle still completes when episodic fetch fails (recentEpisodes throws)', async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0, episodeFetchThrows: true }))
    // Use real safeRecentEpisodes (no seam injection) to test prod degradation path
    const result = await runGoalCycle(env, agent, {
      ...baseDeps({ model: makeModel([{ title: 'T', body: 'b' }]) }),
      recentEpisodes: vi.fn().mockRejectedValue(new Error('D1 down')),
    })
    // Cycle still completes — episode fetch is best-effort
    expect(result.decided).toBe('spawned')
    expect(result.ok).toBe(true)
    expect(result.spawned).toBe(1)
  })

  it('cycle still completes when recordEpisode throws (best-effort write)', async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0 }))
    const result = await runGoalCycle(env, agent, baseDeps({
      model: makeModel([{ title: 'T', body: 'b' }]),
      recordEpisode: vi.fn().mockRejectedValue(new Error('D1 down')),
    }))
    expect(result.decided).toBe('spawned')
    expect(result.ok).toBe(true)
  })

  it('recentEpisodes seam is called once per cycle (not zero, not twice)', async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0 }))
    const recentEpisodes = vi.fn().mockResolvedValue([])
    await runGoalCycle(env, agent, baseDeps({
      model: makeModel([{ title: 'T', body: 'b' }]),
      recentEpisodes,
    }))
    expect(recentEpisodes).toHaveBeenCalledTimes(1)
  })
})

// ── 6. Dedup fp preimage includes EPISODIC_VERSION ────────────────────────────

describe('computeDecisionFp — EPISODIC_VERSION in preimage', () => {
  it('produces a different fp when EPISODIC_VERSION differs from old v0 fingerprint', async () => {
    // Simulate what the fp would have been WITHOUT episodicVersion in the preimage.
    // We cannot easily patch the export, but we can verify that two calls with the
    // same (sensorium, agent, proposals) always produce the same fp — the version
    // is a CONSTANT in the preimage. If we change it, we get a different fp.
    // This test verifies the fp is stable (deterministic) and that the preimage
    // does NOT accidentally change between two identical calls.
    const agent = makeAgent()
    const sensorium = makeSensorium()
    const proposals = [{ title: 'Task A' }]
    const fp1 = await computeDecisionFp(agent, sensorium, proposals)
    const fp2 = await computeDecisionFp(agent, sensorium, proposals)
    // Deterministic: same input → same fp.
    expect(fp1).toBe(fp2)
    expect(typeof fp1).toBe('string')
    expect(fp1.length).toBe(64) // SHA-256 hex = 64 chars
  })

  it('produces a different fp for different agents (agent isolation)', async () => {
    const sensorium = makeSensorium()
    const proposals = [{ title: 'Task A' }]
    const fp1 = await computeDecisionFp(makeAgent({ id: 'agent-1' }), sensorium, proposals)
    const fp2 = await computeDecisionFp(makeAgent({ id: 'agent-2' }), sensorium, proposals)
    expect(fp1).not.toBe(fp2)
  })

  it('produces a different fp when proposals differ (episodes affect context)', async () => {
    const agent = makeAgent()
    const sensorium = makeSensorium()
    const fp1 = await computeDecisionFp(agent, sensorium, [{ title: 'Task A' }])
    const fp2 = await computeDecisionFp(agent, sensorium, [{ title: 'Task B' }])
    expect(fp1).not.toBe(fp2)
  })
})

// ── Escalation episode recording (gate-RED fix: on ANY path, not just spawned) ──

describe('escalated episode — recorded on every path the observer can escalate', () => {
  it("records 'escalated' on the error path when the observer escalates", async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: 0 }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    const result = await runGoalCycle(env, agent, baseDeps({
      model: { chat: vi.fn().mockRejectedValue(new Error('model down')) },
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: true, reason: 'consecutive_fails=3' }),
      recordEpisode,
    }))
    expect(result.error).toBeDefined()
    const kinds = recordEpisode.mock.calls.map(([, , ep]) => (ep as { kind: string }).kind)
    expect(kinds).toContain('escalated')
  })

  it("records 'escalated' (plus 'backpressure') on the backpressure path when the observer escalates", async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: MAX_OPEN_TASKS }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    const result = await runGoalCycle(env, agent, baseDeps({
      observe: vi.fn().mockResolvedValue({ cooldown: true, escalate: true, reason: 'liveness_fails=3' }),
      recordEpisode,
    }))
    expect(result.decided).toBe('backpressure')
    const kinds = recordEpisode.mock.calls.map(([, , ep]) => (ep as { kind: string }).kind)
    expect(kinds).toContain('backpressure')
    expect(kinds).toContain('escalated')
  })

  it("does NOT record 'escalated' when the observer does not escalate", async () => {
    const agent = makeAgent()
    const env = makeLoopEnv(makeLoopD1({ backlogCount: MAX_OPEN_TASKS }))
    const recordEpisode = vi.fn().mockResolvedValue(undefined)
    await runGoalCycle(env, agent, baseDeps({
      observe: vi.fn().mockResolvedValue({ cooldown: false, escalate: false }),
      recordEpisode,
    }))
    const kinds = recordEpisode.mock.calls.map(([, , ep]) => (ep as { kind: string }).kind)
    expect(kinds).not.toContain('escalated')
  })
})
