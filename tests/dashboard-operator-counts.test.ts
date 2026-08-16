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

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
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

// Real D1 (node:sqlite + the FULL migration chain — tests/helpers, the #684 ratchet
// enforced by scripts/check-test-schema-source.mjs). No hand-written prepare() stand-in:
// a fake that string-matches SQL and returns canned rows cannot be contradicted by a
// query naming a column that doesn't exist — see tests/helpers/migrations.ts's header.
describe('loadTaskStatusCounts (real D1)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let env: Env

  beforeAll(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept1', 'ops', 'Ops', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad1', 'dept1', 'core', 'Core', datetime('now'));
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('a1', 'squad1', 'a1', 'A1', 'builder', 'test-model', 'active', datetime('now'));

      INSERT INTO tasks (id, squad_id, title, status, created_at, updated_at) VALUES
        ('t-open-1', 'squad1', 'Open 1', 'open', datetime('now'), datetime('now')),
        ('t-open-2', 'squad1', 'Open 2', 'open', datetime('now'), datetime('now')),
        ('t-open-3', 'squad1', 'Open 3', 'open', datetime('now'), datetime('now')),
        ('t-blocked-1', 'squad1', 'Blocked 1', 'blocked', datetime('now'), datetime('now'));
    `)
    env = { TENANT_SLUG: 'test', DB: harness.db } as unknown as Env
  })

  afterAll(() => { harness.close() })

  it('returns a real status -> count map from the grouped query against actual rows', async () => {
    const map = await loadTaskStatusCounts(env)
    expect(map.get('open')).toBe(3)
    expect(map.get('blocked')).toBe(1)
    expect(map.has('review')).toBe(false) // no review rows seeded — must not fabricate a zero-vs-absent distinction
  })
})

describe('loadOperatorCounts — thin D1 wiring (real D1)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let env: Env
  const AUTH: AuthContext = { userId: 'owner-1', email: 'owner@test', role: 'owner', tenant: 'wiring-test' }
  const NOW = new Date('2026-08-16T12:00:00.000Z').getTime()
  const RECENT = '2026-08-16T11:58:00.000Z'

  beforeAll(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept1', 'ops', 'Ops', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad1', 'dept1', 'core', 'Core', datetime('now'));

      -- One active agent with a live runtime, one paused agent with no runtime attach.
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('a-live', 'squad1', 'live', 'Live', 'builder', 'test-model', 'active', datetime('now')),
        ('a-paused', 'squad1', 'paused', 'Paused', 'builder', 'test-model', 'paused', datetime('now'));

      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('m-live', 'wiring-test', 'Live Key Owner', NULL, 'active', datetime('now'));

      INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES
        ('wiring-test', 'a-live', 'pk-live', 'm-live', unixepoch());

      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, status, last_reported_at, updated_at) VALUES
        ('a-live', 'wiring-test', 'Live', 'claude-code', 'running', '${RECENT}', '${RECENT}');

      -- One task this owner can verdict (needs decision), one blocked task.
      INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id, gate_owner, created_at, updated_at) VALUES
        ('t-review-1', 'squad1', 'Ship it', 'review', 'a-live', 'gate:content', datetime('now'), datetime('now')),
        ('t-blocked-1', 'squad1', 'Blocked work', 'blocked', 'a-live', NULL, datetime('now'), datetime('now'));
    `)
    env = { TENANT_SLUG: 'wiring-test', DB: harness.db } as unknown as Env
  })

  afterAll(() => { harness.close() })

  it('wires the real agents/stats/runtimeStates/approvals/taskStatusCounts loaders into computeOperatorCounts', async () => {
    const counts = await loadOperatorCounts(env, AUTH, NOW)
    expect(counts.agentsTotal).toBe(2)
    expect(counts.agentsActive).toBe(1)
    expect(counts.agentsPaused).toBe(1)
    expect(counts.liveRuntimeCount).toBe(1)
    expect(counts.needsDecisionCount).toBe(1)
    expect(counts.blockedOrRejectedCount).toBe(1)
    expect(counts.generatedAtMs).toBe(NOW)
  })
})
