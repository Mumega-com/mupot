// tests/dashboard-operator-counts.test.ts — unit tests for the Flight-008 Slice 1
// (mupot#1060) canonical "how many" helper: src/dashboard/operator-counts.ts.
//
// computeOperatorCounts is the ONE pure function every hero-KPI surface (Home, Health,
// and — by construction, since it already shared observatory.ts's loaders before this
// slice — Fleet's radar summary) must derive its numbers from. These tests prove:
//   1. Basic arithmetic correctness for each field.
//   2. Mutating an input (an agent's runtime state, the approvals list, the task-status
//      map) changes the SAME field the same way regardless of which "surface" the
//      caller represents — because there is only one function computing it.
//
// tests/operator-counts-cross-surface.test.ts covers the real-D1, seeded-fixture,
// cross-surface (Home vs Health vs Fleet) parity assertion done_when #1 asks for.

import { describe, it, expect } from 'vitest'
import {
  computeOperatorCounts,
  loadTaskStatusCounts,
  loadOperatorCounts,
  type OperatorCountsInputs,
} from '../src/dashboard/operator-counts'
import type { AgentStat, AgentRuntimeState } from '../src/dashboard/observatory'
import type { ApprovalItem } from '../src/dashboard/approvals'
import type { Agent, AuthContext, Env } from '../src/types'

function agent(id: string, status: Agent['status'] = 'active'): Pick<Agent, 'id' | 'status'> {
  return { id, status }
}

function stat(over: Partial<AgentStat> = {}): AgentStat {
  return { agent_id: 'a', task_count: 0, done_count: 0, success_pct: 0, in_flight: 0, spend_micro_usd: 0, ...over }
}

function approval(id: string): ApprovalItem {
  return {
    id,
    squad_id: 'sq-1',
    squad_name: 'Squad',
    title: `Task ${id}`,
    body: '',
    gate_owner: 'gate:content',
    assignee_agent_id: null,
    agent_name: null,
    result: null,
    completed_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
  }
}

function baseInputs(over: Partial<OperatorCountsInputs> = {}): OperatorCountsInputs {
  return {
    nowMs: 1_000,
    agents: [],
    stats: new Map(),
    runtimeStates: new Map(),
    approvals: [],
    taskStatusCounts: new Map(),
    ...over,
  }
}

describe('computeOperatorCounts — arithmetic', () => {
  it('counts agents by status and totals them from ONE agents array', () => {
    const out = computeOperatorCounts(baseInputs({
      agents: [agent('a1', 'active'), agent('a2', 'active'), agent('a3', 'paused')],
    }))
    expect(out.agentsTotal).toBe(3)
    expect(out.agentsActive).toBe(2)
    expect(out.agentsPaused).toBe(1)
  })

  it('sums in_flight and spend from the stats map, skipping agents with no stat row', () => {
    const out = computeOperatorCounts(baseInputs({
      agents: [agent('a1'), agent('a2'), agent('a3')],
      stats: new Map([
        ['a1', stat({ in_flight: 2, spend_micro_usd: 500 })],
        ['a2', stat({ in_flight: 1, spend_micro_usd: 100 })],
        // a3 has no stat row — must not throw, must not count.
      ]),
    }))
    expect(out.inFlightTotal).toBe(3)
    expect(out.spendMicroUsdTotal).toBe(600)
  })

  it('needsDecisionCount is exactly approvals.length — never a second predicate', () => {
    const out = computeOperatorCounts(baseInputs({ approvals: [approval('t1'), approval('t2')] }))
    expect(out.needsDecisionCount).toBe(2)
  })

  it('blockedOrRejectedCount sums the blocked and rejected buckets of the shared map', () => {
    const out = computeOperatorCounts(baseInputs({
      taskStatusCounts: new Map([['open', 5], ['blocked', 2], ['rejected', 1], ['done', 9]]),
    }))
    expect(out.blockedOrRejectedCount).toBe(3)
  })

  it('missing status buckets default to zero, not undefined/NaN', () => {
    const out = computeOperatorCounts(baseInputs({ taskStatusCounts: new Map() }))
    expect(out.blockedOrRejectedCount).toBe(0)
  })
})

describe('computeOperatorCounts — single source of truth (mutate the input, everything downstream moves)', () => {
  it('flipping one agent from live to stale changes liveRuntimeCount for every caller of this same function', () => {
    const agents = [agent('a1'), agent('a2')]
    const runtimeStatesLive = new Map<string, AgentRuntimeState>([['a1', 'live'], ['a2', 'live']])
    const runtimeStatesOneStale = new Map<string, AgentRuntimeState>([['a1', 'live'], ['a2', 'stale']])

    // Two "callers" (stand-ins for Home and Health) computing from the SAME function.
    const homeBefore = computeOperatorCounts(baseInputs({ agents, runtimeStates: runtimeStatesLive }))
    const healthBefore = computeOperatorCounts(baseInputs({ agents, runtimeStates: runtimeStatesLive }))
    expect(homeBefore.liveRuntimeCount).toBe(healthBefore.liveRuntimeCount)
    expect(homeBefore.liveRuntimeCount).toBe(2)

    const homeAfter = computeOperatorCounts(baseInputs({ agents, runtimeStates: runtimeStatesOneStale }))
    const healthAfter = computeOperatorCounts(baseInputs({ agents, runtimeStates: runtimeStatesOneStale }))
    // Both "surfaces" moved together, by the same amount, because there is nowhere
    // else the live/stale classification could be re-derived.
    expect(homeAfter.liveRuntimeCount).toBe(1)
    expect(healthAfter.liveRuntimeCount).toBe(1)
    expect(homeAfter.liveRuntimeCount).toBe(healthAfter.liveRuntimeCount)
  })

  it('an agent counted as unattached/offline/stale never counts as live — no silent fallback to true', () => {
    const agents = [agent('a1'), agent('a2'), agent('a3')]
    const runtimeStates = new Map<string, AgentRuntimeState>([
      ['a1', 'live'],
      ['a2', 'offline'],
      ['a3', 'unattached'],
    ])
    const out = computeOperatorCounts(baseInputs({ agents, runtimeStates }))
    expect(out.liveRuntimeCount).toBe(1)
  })
})

describe('loadTaskStatusCounts', () => {
  function makeEnv(rows: unknown[]) {
    const calls: { sql: string; binds: unknown[] }[] = []
    const env = {
      DB: {
        prepare(sql: string) {
          calls.push({ sql, binds: [] })
          return {
            bind(...args: unknown[]) { calls[calls.length - 1].binds = args; return this },
            async all() { return { results: rows } },
          }
        },
      },
    } as unknown as Env
    return { env, calls }
  }

  it('returns a status -> count map from the grouped query, coercing string counts', async () => {
    const { env, calls } = makeEnv([
      { status: 'open', count: 3 },
      { status: 'blocked', count: '1' },
    ])
    const map = await loadTaskStatusCounts(env)
    expect(map.get('open')).toBe(3)
    expect(map.get('blocked')).toBe(1)
    expect(calls[0].sql).toContain('GROUP BY status')
    expect(calls[0].sql).toContain('FROM tasks')
  })
})

describe('loadOperatorCounts — thin D1 wiring', () => {
  it('wires agents/stats/runtimeStates/approvals/taskStatusCounts into computeOperatorCounts', async () => {
    const sqlLog: string[] = []
    const env = {
      TENANT_SLUG: 'test',
      DB: {
        prepare(sql: string) {
          sqlLog.push(sql)
          const rowsFor = (): unknown[] => {
            if (sql.includes('SELECT id, status FROM agents')) return [{ id: 'a1', status: 'active' }]
            if (sql.includes('AS task_count')) return []
            if (sql.includes('key_member_id')) return []
            if (sql.includes('t.gate_owner')) return []
            if (sql.includes('GROUP BY status')) return [{ status: 'blocked', count: 1 }]
            return []
          }
          return {
            bind() { return this },
            async all() { return { results: rowsFor() } },
          }
        },
      },
    } as unknown as Env
    const auth = { userId: 'owner-1', email: null, role: 'owner', tenant: 'test' } as AuthContext

    const counts = await loadOperatorCounts(env, auth, 5_000)
    expect(counts.agentsTotal).toBe(1)
    expect(counts.agentsActive).toBe(1)
    expect(counts.blockedOrRejectedCount).toBe(1)
    expect(counts.generatedAtMs).toBe(5_000)
    // Confirms it actually issued all five underlying queries, not a cached/short-circuited subset.
    expect(sqlLog.some((s) => s.includes('SELECT id, status FROM agents'))).toBe(true)
    expect(sqlLog.some((s) => s.includes('key_member_id'))).toBe(true)
    expect(sqlLog.some((s) => s.includes('t.gate_owner'))).toBe(true)
  })
})
