import { describe, expect, it, vi } from 'vitest'
import {
  chatWithModelFallback,
  isCreditOutReason,
  isDeathConditionMet,
  isProviderFailure,
  markDormant,
  parseDeathCondition,
  reactivateAgent,
  runLifecycleTick,
  softRetireAgent,
} from '../src/agents/lifecycle'
import type { Env, ModelPort } from '../src/types'

describe('parseDeathCondition', () => {
  it('accepts the Port 1.3 policy shape', () => {
    expect(parseDeathCondition(JSON.stringify({ idle_ttl_hours: 168, policy: 'no_instance_no_activity' }))).toEqual({
      idle_ttl_hours: 168,
      policy: 'no_instance_no_activity',
    })
  })

  it('rejects null / invalid / unknown policy', () => {
    expect(parseDeathCondition(null)).toBeNull()
    expect(parseDeathCondition('[]')).toBeNull()
    expect(parseDeathCondition(JSON.stringify({ idle_ttl_hours: 24, policy: 'other' }))).toBeNull()
    expect(parseDeathCondition(JSON.stringify({ idle_ttl_hours: 0, policy: 'no_instance_no_activity' }))).toBeNull()
  })
})

describe('isDeathConditionMet', () => {
  const policy = { idle_ttl_hours: 24, policy: 'no_instance_no_activity' as const }
  const nowMs = Date.parse('2026-07-22T12:00:00Z')
  const old = nowMs - 48 * 3_600_000
  const recent = nowMs - 1 * 3_600_000

  it('soft-retires only when created + instance + activity are all past TTL', () => {
    expect(
      isDeathConditionMet({
        nowMs,
        createdAtMs: old,
        lastInstanceMs: null,
        lastActivityMs: null,
        policy,
      }),
    ).toBe(true)
    expect(
      isDeathConditionMet({
        nowMs,
        createdAtMs: old,
        lastInstanceMs: recent,
        lastActivityMs: null,
        policy,
      }),
    ).toBe(false)
    expect(
      isDeathConditionMet({
        nowMs,
        createdAtMs: recent,
        lastInstanceMs: null,
        lastActivityMs: null,
        policy,
      }),
    ).toBe(false)
  })
})

describe('isProviderFailure / isCreditOutReason', () => {
  it('classifies gateway/provider failures', () => {
    expect(isProviderFailure(new Error('model: AI Gateway anthropic request failed (503): unavailable'))).toBe(true)
    expect(isProviderFailure(new Error('quota exceeded'))).toBe(true)
    expect(isProviderFailure(new Error('invalid JSON from model'))).toBe(false)
  })

  it('treats budget reasons as credit-out, not rate_limited', () => {
    expect(isCreditOutReason('budget_exhausted')).toBe(true)
    expect(isCreditOutReason('budget_cap_exceeded')).toBe(true)
    expect(isCreditOutReason('rate_limited')).toBe(false)
  })
})

describe('chatWithModelFallback', () => {
  it('uses preferred model when it succeeds', async () => {
    const chat = vi.fn(async (_m: unknown, opts: { model?: string }) => `ok:${opts.model}`)
    const model = { chat } as unknown as ModelPort
    const r = await chatWithModelFallback(
      model,
      { model: 'preferred', model_fallback: 'fallback' },
      [{ role: 'user', content: 'hi' }],
      {},
    )
    expect(r).toEqual({ text: 'ok:preferred', modelUsed: 'preferred', usedFallback: false })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('fails over to model_fallback on provider failure', async () => {
    const chat = vi.fn(async (_m: unknown, opts: { model?: string }) => {
      if (opts.model === 'preferred') throw new Error('AI Gateway 503 provider unavailable')
      return `ok:${opts.model}`
    })
    const model = { chat } as unknown as ModelPort
    const r = await chatWithModelFallback(
      model,
      { model: 'preferred', model_fallback: 'fallback' },
      [{ role: 'user', content: 'hi' }],
      {},
    )
    expect(r).toEqual({ text: 'ok:fallback', modelUsed: 'fallback', usedFallback: true })
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('does not fall over on non-provider errors', async () => {
    const chat = vi.fn(async () => {
      throw new Error('invalid JSON from model')
    })
    const model = { chat } as unknown as ModelPort
    await expect(
      chatWithModelFallback(
        model,
        { model: 'preferred', model_fallback: 'fallback' },
        [{ role: 'user', content: 'hi' }],
        {},
      ),
    ).rejects.toThrow(/invalid JSON/)
    expect(chat).toHaveBeenCalledTimes(1)
  })
})

function makeLifecycleEnv(opts: {
  agents?: Array<Record<string, unknown>>
  updates?: Array<{ sql: string; args: unknown[] }>
  events?: unknown[]
}): Env {
  const agents = opts.agents ?? []
  const updates = opts.updates ?? []
  const events = opts.events ?? []

  return {
    TENANT_SLUG: 'test',
    FLEET_CONSUMER_AGENT: 'fleet-consumer',
    FLEET_OPS_AGENT: 'fleet-ops',
    DB: {
      prepare(sql: string) {
        const handle = {
          bind(...args: unknown[]) {
            return {
              async first() {
                if (sql.includes('FROM presence')) return { ts: null }
                if (sql.includes('FROM fleet_agents')) return { ts: null }
                if (sql.includes('FROM module_registry')) return { ts: null }
                if (sql.includes('FROM tasks')) return { ts: null }
                if (sql.includes('FROM execution_meter')) {
                  if (sql.includes('SUM')) return { c: 0 }
                  if (sql.includes('MAX(window_start)')) return { ts: null }
                  return { count: 0, tokens: 0, cost_micro_usd: 0 }
                }
                return null
              },
              async all() {
                return handle.all()
              },
              async run() {
                updates.push({ sql, args })
                if (sql.includes("status = 'inactive'")) {
                  const id = args[0]
                  const row = agents.find((a) => a.id === id)
                  // Dormancy wins: soft-retire refuses rows with dormant_reason set.
                  if (!row || row.status === 'inactive' || row.dormant_reason != null) {
                    return { meta: { changes: 0 } }
                  }
                  row.status = 'inactive'
                  row.dormant_reason = null
                  return { meta: { changes: 1 } }
                }
                if (sql.includes('dormant_reason = ?1') || sql.includes('dormant_reason = ?')) {
                  const reason = args[0]
                  const id = args[1]
                  const row = agents.find((a) => a.id === id)
                  if (!row || row.status !== 'active') return { meta: { changes: 0 } }
                  row.status = 'paused'
                  row.dormant_reason = reason
                  return { meta: { changes: 1 } }
                }
                if (sql.includes("status = 'active'") && sql.includes('dormant_reason = NULL')) {
                  const id = args[0]
                  const row = agents.find((a) => a.id === id)
                  if (!row) return { meta: { changes: 0 } }
                  row.status = 'active'
                  row.dormant_reason = null
                  return { meta: { changes: 1 } }
                }
                return { meta: { changes: 1 } }
              },
            }
          },
          async all() {
            if (sql.includes('death_condition IS NOT NULL')) {
              return {
                results: agents.filter(
                  (a) =>
                    a.death_condition != null &&
                    a.status !== 'inactive' &&
                    a.dormant_reason == null,
                ),
              }
            }
            if (sql.includes('dormant_reason IS NOT NULL')) {
              return {
                results: agents.filter((a) => a.dormant_reason != null && a.status === 'paused'),
              }
            }
            return { results: [] }
          },
          async first() {
            return handle.bind().first()
          },
          async run() {
            return handle.bind().run()
          },
        }
        return handle
      },
    },
    BUS: {
      async send(_batch: unknown) {
        events.push(_batch)
      },
    },
  } as unknown as Env
}

describe('softRetire / dormant / reactivate', () => {
  it('soft-retires to inactive and audits', async () => {
    const agents = [{ id: 'a1', slug: 'bot', status: 'active', dormant_reason: null }]
    const updates: Array<{ sql: string; args: unknown[] }> = []
    const env = makeLifecycleEnv({ agents, updates })
    const r = await softRetireAgent(env, { id: 'a1', slug: 'bot' }, 'idle')
    expect(r).toEqual({ ok: true, changed: true })
    expect(agents[0]?.status).toBe('inactive')
    expect(updates.some((u) => u.sql.includes("status = 'inactive'"))).toBe(true)
  })

  it('refuses to soft-retire the fleet consumer', async () => {
    const env = makeLifecycleEnv({
      agents: [{ id: 'fleet-consumer', slug: 'fleet-consumer', status: 'active' }],
    })
    const r = await softRetireAgent(env, { id: 'fleet-consumer', slug: 'fleet-consumer' }, 'idle')
    expect(r).toEqual({ ok: false, error: 'protected_agent' })
  })

  it('marks credit-out dormant without deleting identity', async () => {
    const agents = [{ id: 'a1', slug: 'bot', status: 'active', dormant_reason: null }]
    const env = makeLifecycleEnv({ agents })
    const r = await markDormant(env, { id: 'a1', slug: 'bot' }, 'credit_out', 'budget_cap_exceeded')
    expect(r).toEqual({ ok: true, changed: true })
    expect(agents[0]).toMatchObject({ status: 'paused', dormant_reason: 'credit_out' })
  })

  it('softRetireAgent refuses to wipe a dormant agent', async () => {
    const agents = [{ id: 'a1', slug: 'bot', status: 'paused', dormant_reason: 'credit_out' }]
    const env = makeLifecycleEnv({ agents })
    const r = await softRetireAgent(env, { id: 'a1', slug: 'bot' }, 'idle')
    expect(r).toEqual({ ok: true, changed: false })
    expect(agents[0]).toMatchObject({ status: 'paused', dormant_reason: 'credit_out' })
  })

  it('reactivates cleanly', async () => {
    const agents = [{ id: 'a1', slug: 'bot', status: 'paused', dormant_reason: 'provider_down' }]
    const env = makeLifecycleEnv({ agents })
    const r = await reactivateAgent(env, 'a1', 'provider_restored', 'ok')
    expect(r).toEqual({ ok: true, changed: true })
    expect(agents[0]).toMatchObject({ status: 'active', dormant_reason: null })
  })
})

describe('runLifecycleTick', () => {
  it('soft-retires an idle agent past TTL and reactivates credit-out when meter allows', async () => {
    const old = '2026-07-01T00:00:00Z'
    const agents = [
      {
        id: 'idle-1',
        slug: 'sprawl',
        status: 'active',
        created_at: old,
        death_condition: JSON.stringify({ idle_ttl_hours: 24, policy: 'no_instance_no_activity' }),
        dormant_reason: null,
        model: 'm',
        model_fallback: null,
        budget_cap_cents: null,
        budget_window: 'day',
      },
      {
        id: 'broke-1',
        slug: 'broke',
        status: 'paused',
        created_at: old,
        death_condition: null,
        dormant_reason: 'credit_out',
        model: 'm',
        model_fallback: null,
        budget_cap_cents: null,
        budget_window: 'day',
      },
    ]
    const env = makeLifecycleEnv({ agents })
    const tick = await runLifecycleTick(env, Date.parse('2026-07-22T12:00:00Z'))
    expect(tick.ok).toBe(true)
    expect(tick.soft_retired).toBe(1)
    expect(tick.reactivated).toBe(1)
    expect(agents[0]?.status).toBe('inactive')
    expect(agents[1]).toMatchObject({ status: 'active', dormant_reason: null })
  })

  it('does not crash-loop provider_down when probe still fails', async () => {
    const agents = [
      {
        id: 'down-1',
        slug: 'down',
        status: 'paused',
        created_at: '2026-07-01T00:00:00Z',
        death_condition: null,
        dormant_reason: 'provider_down',
        model: 'preferred',
        model_fallback: 'fallback',
        budget_cap_cents: null,
        budget_window: 'day',
      },
    ]
    const env = makeLifecycleEnv({ agents })
    const model: ModelPort = {
      chat: async () => {
        throw new Error('AI Gateway 503 unavailable')
      },
    }
    const tick = await runLifecycleTick(env, Date.now(), { model })
    expect(tick.ok).toBe(true)
    expect(tick.reactivated).toBe(0)
    expect(agents[0]).toMatchObject({ status: 'paused', dormant_reason: 'provider_down' })
  })

  it('dormancy wins over idle-TTL: provider_down + past TTL keeps dormant_reason', async () => {
    const old = '2026-07-01T00:00:00Z'
    const agents = [
      {
        id: 'broke-idle',
        slug: 'broke-idle',
        status: 'paused',
        created_at: old,
        death_condition: JSON.stringify({ idle_ttl_hours: 24, policy: 'no_instance_no_activity' }),
        dormant_reason: 'provider_down',
        model: 'preferred',
        model_fallback: null,
        budget_cap_cents: null,
        budget_window: 'day',
      },
    ]
    const env = makeLifecycleEnv({ agents })
    const model: ModelPort = {
      chat: async () => {
        throw new Error('AI Gateway 503 unavailable')
      },
    }
    const tick = await runLifecycleTick(env, Date.parse('2026-07-22T12:00:00Z'), { model })
    expect(tick.ok).toBe(true)
    expect(tick.soft_retired).toBe(0)
    expect(tick.reactivated).toBe(0)
    expect(agents[0]).toMatchObject({ status: 'paused', dormant_reason: 'provider_down' })
  })

  it('scanned counts each agent once across soft-retire and reactivation passes', async () => {
    const old = '2026-07-01T00:00:00Z'
    const agents = [
      {
        id: 'idle-1',
        slug: 'sprawl',
        status: 'active',
        created_at: old,
        death_condition: JSON.stringify({ idle_ttl_hours: 24, policy: 'no_instance_no_activity' }),
        dormant_reason: null,
        model: 'm',
        model_fallback: null,
        budget_cap_cents: null,
        budget_window: 'day',
      },
      {
        id: 'dormant-with-ttl',
        slug: 'dormant-ttl',
        status: 'paused',
        created_at: old,
        death_condition: JSON.stringify({ idle_ttl_hours: 24, policy: 'no_instance_no_activity' }),
        dormant_reason: 'provider_down',
        model: 'preferred',
        model_fallback: null,
        budget_cap_cents: null,
        budget_window: 'day',
      },
    ]
    const env = makeLifecycleEnv({ agents })
    const model: ModelPort = {
      chat: async () => {
        throw new Error('AI Gateway 503 unavailable')
      },
    }
    const tick = await runLifecycleTick(env, Date.parse('2026-07-22T12:00:00Z'), { model })
    expect(tick.ok).toBe(true)
    expect(tick.soft_retired).toBe(1)
    expect(tick.reactivated).toBe(0)
    // Unique agents: idle-1 (retire) + dormant-with-ttl (reactivate) = 2, not 3
    expect(tick.scanned).toBe(2)
    expect(agents[1]).toMatchObject({ status: 'paused', dormant_reason: 'provider_down' })
  })
})
