// tests/execution-meter.test.ts — execution meter unit tests.
//
// Tests the meter (src/agents/meter.ts) in isolation using a hand-mocked D1.
// Covers: under cap → ok+increment; at dispatch cap → rate_limited;
// at token cap → budget_exhausted; window rollover (new UTC day → fresh window);
// recordTokens accumulates; env override of caps.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  checkAndReserve,
  recordTokens,
  MAX_DISPATCHES_PER_DAY,
  MAX_TOKENS_PER_DAY,
  MICRO_USD_PER_CENT,
} from '../src/agents/meter'
import type { Env } from '../src/types'

// ── D1 mock ──────────────────────────────────────────────────────────────────
//
// The meter issues three D1 statement patterns:
//   1. SELECT count, tokens FROM execution_meter WHERE window_key = ?
//   2. INSERT INTO execution_meter ... ON CONFLICT(window_key) DO UPDATE SET count = count + 1
//   3. INSERT INTO execution_meter ... ON CONFLICT(window_key) DO UPDATE SET tokens = tokens + ?
//
// We store the in-memory state in a Map<windowKey, {count, tokens}> and route
// the three patterns by inspecting the SQL string.

interface WindowState {
  count: number
  tokens: number
  cost_micro_usd?: number // #15 — optional so pre-cost fixtures stay valid
}

function makeMockDB(initial: Map<string, WindowState> = new Map()) {
  const state: Map<string, WindowState> = new Map(initial)
  const upserts: { sql: string; args: unknown[] }[] = []

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              // SELECT count, tokens FROM execution_meter WHERE window_key = ?
              if (sql.includes('SELECT count, tokens')) {
                const key = args[0] as string
                const row = state.get(key)
                if (!row) return null as unknown as T
                return {
                  count: row.count,
                  tokens: row.tokens,
                  cost_micro_usd: row.cost_micro_usd ?? 0,
                } as unknown as T
              }
              return null as unknown as T
            },
            async run(): Promise<{ meta: { changes: number } }> {
              upserts.push({ sql, args })
              // Simulate the UPSERT behaviour for count increment (checkAndReserve).
              if (sql.includes('DO UPDATE SET count = count + 1')) {
                const key = args[1] as string
                const existing = state.get(key)
                if (existing) {
                  state.set(key, { ...existing, count: existing.count + 1 })
                } else {
                  state.set(key, { count: 1, tokens: 0, cost_micro_usd: 0 })
                }
              }
              // Simulate the UPSERT for token + cost accumulation (recordTokens, #15).
              // The match is on a substring that survives the multi-line SET clause.
              if (sql.includes('tokens = tokens +')) {
                const key = args[1] as string
                // args order: id, window_key, tokens(insert), cost(insert),
                //             window_start, tokens(update), cost(update)
                const tokensToAdd = args[5] as number
                const costToAdd = args[6] as number
                const existing = state.get(key)
                if (existing) {
                  state.set(key, {
                    ...existing,
                    tokens: existing.tokens + tokensToAdd,
                    cost_micro_usd: (existing.cost_micro_usd ?? 0) + costToAdd,
                  })
                } else {
                  state.set(key, { count: 0, tokens: tokensToAdd, cost_micro_usd: costToAdd })
                }
              }
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }

  return { db, state, upserts }
}

function makeEnv(
  overrides: { EXEC_MAX_DISPATCH_DAY?: string; EXEC_MAX_TOKENS_DAY?: string } = {},
  initial: Map<string, WindowState> = new Map(),
) {
  const { db } = makeMockDB(initial)
  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: db,
    ...overrides,
  }
  return env as unknown as Env
}

// Build the expected window key for today UTC — mirrors meter.ts buildWindowKey.
function todayWindowKey(tenant: string, agentId: string): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${tenant}:${agentId}:${y}-${m}-${day}`
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('checkAndReserve — under cap → ok + increment', () => {
  it('returns ok:true and increments count when window is empty', async () => {
    const env = makeEnv()
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.count).toBe(1)
      expect(result.windowKey).toBe(todayWindowKey('test-tenant', 'agent-1'))
    }
  })

  it('returns ok:true and count=N+1 when window has prior dispatches under cap', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const env = makeEnv({}, new Map([[key, { count: 5, tokens: 1000 }]]))
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.count).toBe(6)
    }
  })
})

describe('checkAndReserve — dispatch cap → rate_limited', () => {
  it('returns ok:false with reason=rate_limited when count >= cap', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    // Set count exactly at the default cap
    const env = makeEnv({}, new Map([[key, { count: MAX_DISPATCHES_PER_DAY, tokens: 0 }]]))
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited')
      expect(result.retryAfterSec).toBeGreaterThan(0)
      expect(result.count).toBe(MAX_DISPATCHES_PER_DAY)
    }
  })

  it('respects env override EXEC_MAX_DISPATCH_DAY=3', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const env = makeEnv({ EXEC_MAX_DISPATCH_DAY: '3' }, new Map([[key, { count: 3, tokens: 0 }]]))
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('rate_limited')
    }
  })

  it('does not block when count is below env override cap', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const env = makeEnv({ EXEC_MAX_DISPATCH_DAY: '10' }, new Map([[key, { count: 9, tokens: 0 }]]))
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(true)
  })
})

describe('checkAndReserve — token cap → budget_exhausted', () => {
  it('returns ok:false with reason=budget_exhausted when tokens >= cap', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    // Count is under cap but tokens are at cap
    const env = makeEnv({}, new Map([[key, { count: 1, tokens: MAX_TOKENS_PER_DAY }]]))
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('budget_exhausted')
      expect(result.retryAfterSec).toBeGreaterThan(0)
    }
  })

  it('respects env override EXEC_MAX_TOKENS_DAY=5000', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const env = makeEnv({ EXEC_MAX_TOKENS_DAY: '5000' }, new Map([[key, { count: 0, tokens: 5000 }]]))
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('budget_exhausted')
    }
  })
})

describe('checkAndReserve — window rollover (new UTC day)', () => {
  it('treats a yesterday window key as absent → starts fresh', async () => {
    // Inject a row for yesterday's key at the cap — today's key is absent.
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - 1)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    const yesterdayKey = `test-tenant:agent-1:${y}-${m}-${day}`

    const env = makeEnv(
      {},
      new Map([[yesterdayKey, { count: MAX_DISPATCHES_PER_DAY, tokens: MAX_TOKENS_PER_DAY }]]),
    )
    // Today's window is empty → should succeed (new day = reset)
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.count).toBe(1)
      // window key must be today's, not yesterday's
      expect(result.windowKey).toBe(todayWindowKey('test-tenant', 'agent-1'))
    }
  })
})

describe('recordTokens — accumulates', () => {
  it('adds tokens to an existing window row', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const { db, state } = makeMockDB(new Map([[key, { count: 1, tokens: 1000 }]]))
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-1', 500)
    expect(state.get(key)?.tokens).toBe(1500)
  })

  it('creates the row if absent (no prior checkAndReserve)', async () => {
    const key = todayWindowKey('test-tenant', 'agent-2')
    const { db, state } = makeMockDB()
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-2', 2048)
    expect(state.get(key)?.tokens).toBe(2048)
  })

  it('is a no-op for tokens <= 0', async () => {
    const { db, state } = makeMockDB()
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-1', 0)
    await recordTokens(env, 'agent-1', -100)
    // Nothing written
    expect(state.size).toBe(0)
  })

  it('accumulates across multiple calls', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const { db, state } = makeMockDB(new Map([[key, { count: 3, tokens: 0 }]]))
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-1', 1000)
    await recordTokens(env, 'agent-1', 500)
    await recordTokens(env, 'agent-1', 250)
    expect(state.get(key)?.tokens).toBe(1750)
  })

  // ── #15: cost accumulation alongside tokens ─────────────────────────────────
  it('accumulates cost_micro_usd when a cost is passed', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const { db, state } = makeMockDB()
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-1', 2048, 1024)
    await recordTokens(env, 'agent-1', 2048, 1024)
    expect(state.get(key)?.tokens).toBe(4096)
    expect(state.get(key)?.cost_micro_usd).toBe(2048)
  })

  it('records cost even when tokens is 0 (cost-only write)', async () => {
    const key = todayWindowKey('test-tenant', 'agent-3')
    const { db, state } = makeMockDB()
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-3', 0, 500)
    expect(state.get(key)?.cost_micro_usd).toBe(500)
  })

  it('is a no-op when both tokens and cost are <= 0', async () => {
    const { db, state } = makeMockDB()
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-1', 0, 0)
    await recordTokens(env, 'agent-1', -100, -50)
    expect(state.size).toBe(0)
  })

  it('defaults cost to 0 when omitted (back-compat with token-only callers)', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const { db, state } = makeMockDB()
    const env = { TENANT_SLUG: 'test-tenant', DB: db } as unknown as Env

    await recordTokens(env, 'agent-1', 1000)
    expect(state.get(key)?.tokens).toBe(1000)
    expect(state.get(key)?.cost_micro_usd).toBe(0)
  })
})

describe('checkAndReserve — retryAfterSec', () => {
  it('retryAfterSec is positive and at most 86400 seconds (one day)', async () => {
    const key = todayWindowKey('test-tenant', 'agent-1')
    const env = makeEnv({}, new Map([[key, { count: MAX_DISPATCHES_PER_DAY, tokens: 0 }]]))
    const result = await checkAndReserve(env, 'agent-1')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.retryAfterSec).toBeGreaterThan(0)
      expect(result.retryAfterSec).toBeLessThanOrEqual(86400)
    }
  })
})

// Smoke: agent isolation — different agent IDs get separate window keys
describe('checkAndReserve — agent isolation', () => {
  it('caps are per-agent, not shared', async () => {
    const keyA = todayWindowKey('test-tenant', 'agent-A')
    // agent-A is at cap; agent-B is empty
    const env = makeEnv({}, new Map([[keyA, { count: MAX_DISPATCHES_PER_DAY, tokens: 0 }]]))

    const resultA = await checkAndReserve(env, 'agent-A')
    const resultB = await checkAndReserve(env, 'agent-B')

    expect(resultA.ok).toBe(false) // A is blocked
    expect(resultB.ok).toBe(true)  // B is free
  })
})

// Smoke: runTaskExecution integration — meter blocks model call
describe('meter integration with runTaskExecution', () => {
  it('blocks the model call and lands task=blocked when rate_limited', async () => {
    const { runTaskExecution } = await import('../src/agents/execute')

    // Self-contained env mock — mirrors the pattern in execute.test.ts.
    const updates: { sql: string; args: unknown[] }[] = []
    const execEnv = {
      TENANT_SLUG: 'test-tenant',
      DB: {
        prepare(sql: string) {
          return {
            bind(...args: unknown[]) {
              return {
                async first<T>() {
                  if (sql.includes('FROM tasks')) {
                    return {
                      id: 'task-1', squad_id: 'squad-1', title: 'Test', body: '',
                      status: 'open', assignee_agent_id: null, github_issue_url: null,
                      result: null, completed_at: null, gate_owner: null,
                      created_at: '2026-06-07T00:00:00Z', updated_at: '2026-06-07T00:00:00Z',
                    } as unknown as T
                  }
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
    } as unknown as Env

    const agent = {
      id: 'agent-1', squad_id: 'squad-1', slug: 'scout', name: 'Scout',
      role: 'researcher', model: '@cf/meta/llama-3.3', status: 'active' as const,
      created_at: '2026-06-07T00:00:00Z',
    }

    const modelSpy = vi.fn(async () => 'should not run')
    const blockedMeter = {
      checkAndReserve: vi.fn(async () => ({
        ok: false as const,
        reason: 'rate_limited' as const,
        windowKey: 'test-tenant:agent-1:2026-06-07',
        count: 200,
        tokens: 0,
        retryAfterSec: 3600,
      })),
      recordTokens: vi.fn(async () => {}),
    }

    const result = await runTaskExecution(execEnv, agent, 'task-1', {
      model: { chat: modelSpy },
      emit: async () => {},
      remember: async () => 'x',
      meter: blockedMeter,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('rate_limited')
    expect(result.task_status).toBe('blocked')
    // Model must NOT have been called
    expect(modelSpy).not.toHaveBeenCalled()
    // Task must be persisted as blocked (not stuck in_progress)
    const terminal = updates[updates.length - 1]
    expect(terminal.args[0]).toBe('blocked')
    expect(String(terminal.args[1])).toContain('rate_limited')
  })
})

describe('dollar-cap constants', () => {
  it('1 cent = 10_000 micro-USD', () => {
    expect(MICRO_USD_PER_CENT).toBe(10_000)
  })
})

describe('checkAndReserve — dollar cap (#4)', () => {
  const AGENT = 'a'

  function envWithCost(costMicroUsd: number, count = 0): Env {
    const key = todayWindowKey('test-tenant', AGENT)
    return makeEnv({}, new Map([[key, { count, tokens: 0, cost_micro_usd: costMicroUsd }]]))
  }

  it('no cap (budgetCapCents null) → not enforced, reserves normally', async () => {
    const env = envWithCost(9_999_999)
    const r = await checkAndReserve(env, AGENT, { estimateMicroUsd: 1_000_000, budgetCapCents: null })
    expect(r.ok).toBe(true)
  })

  it('under cap → reserves', async () => {
    // cap 100¢ = 1_000_000 micro-USD; spent 200_000; estimate 100_000 → 300_000 ≤ cap
    const env = envWithCost(200_000)
    const r = await checkAndReserve(env, AGENT, { estimateMicroUsd: 100_000, budgetCapCents: 100 })
    expect(r.ok).toBe(true)
  })

  it('estimate would breach → blocks budget_cap_exceeded, no reserve', async () => {
    // cap 1_000_000; spent 950_000; estimate 100_000 → 1_050_000 > cap → block
    const key = todayWindowKey('test-tenant', AGENT)
    const state = new Map([[key, { count: 5, tokens: 0, cost_micro_usd: 950_000 }]])
    const env = makeEnv({}, state)
    const r = await checkAndReserve(env, AGENT, { estimateMicroUsd: 100_000, budgetCapCents: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('budget_cap_exceeded')
    // count unchanged — reservation did NOT happen
    expect(state.get(key)!.count).toBe(5)
  })

  it('already at/over cap with zero estimate → still blocks', async () => {
    const env = envWithCost(1_000_000)
    const r = await checkAndReserve(env, AGENT, { estimateMicroUsd: 0, budgetCapCents: 100 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('budget_cap_exceeded')
  })

  it('exactly reaching the cap is allowed (reach but not exceed)', async () => {
    // spent 900_000 + estimate 100_000 = 1_000_000 == cap → allowed
    const env = envWithCost(900_000)
    const r = await checkAndReserve(env, AGENT, { estimateMicroUsd: 100_000, budgetCapCents: 100 })
    expect(r.ok).toBe(true)
  })
})
