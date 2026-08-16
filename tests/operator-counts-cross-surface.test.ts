// tests/operator-counts-cross-surface.test.ts — Flight-008 Slice 1 (mupot#1060)
// done_when #1: "the same question returns the SAME number on every surface (Home ==
// Health == Fleet == Projects), seeded fixture -> identical count."
//
// Real D1 (node:sqlite + the FULL migration chain — tests/helpers, the #684 ratchet;
// no hand-written schema, no mocked rows). One seeded fixture, read by THREE
// independent surface entry points:
//   - Home:   loadObservatory + loadApprovals + loadTaskStatusCounts -> computeOperatorCounts
//             (exactly what dashboard/index.ts's `/` route does)
//   - Health: loadOpsHealth (dashboard/health.ts's `/ops` route)
//   - Fleet:  loadFleetRadar (dashboard/radar.ts's `/radar?tab=fleet|radar` route)
//
// Both assert (a) parity on the seeded fixture, and (b) that MUTATING the fixture (one
// agent's heartbeat goes stale) moves all three numbers together — proving the helper is
// the actual source of truth, not a value copied into each caller (gate bar 2).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { loadObservatory } from '../src/dashboard/observatory'
import { loadApprovals } from '../src/dashboard/approvals'
import { computeOperatorCounts, loadTaskStatusCounts } from '../src/dashboard/operator-counts'
import { loadOpsHealth } from '../src/dashboard/health'
import { loadFleetRadar } from '../src/dashboard/radar'
import type { AuthContext, Env } from '../src/types'

const NOW = new Date('2026-08-16T12:00:00.000Z').getTime()
const RECENT = '2026-08-16T11:58:00.000Z' // 2 min ago — within every liveness TTL used here
const STALE = '2026-08-14T12:00:00.000Z' // 2 days ago — stale under every liveness TTL used here

const OWNER: AuthContext = { userId: 'owner-1', email: 'owner@test', role: 'owner', tenant: 'flight008' }

describe('operator-counts cross-surface parity (real D1, seeded fixture)', () => {
  let harness: ReturnType<typeof createSqliteD1>
  let env: Env

  beforeAll(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name, created_at) VALUES ('dept1', 'ops', 'Ops', datetime('now'));
      INSERT INTO squads (id, department_id, slug, name, created_at) VALUES ('squad1', 'dept1', 'core', 'Core', datetime('now'));

      -- Three agents: two with a genuinely live runtime (signing key bound + a fresh
      -- fleet_agents heartbeat), one configured but never attached (unattached).
      INSERT INTO agents (id, squad_id, slug, name, role, model, status, created_at) VALUES
        ('a-loom', 'squad1', 'loom', 'Loom', 'weaver', 'test-model', 'active', datetime('now')),
        ('a-kasra', 'squad1', 'kasra', 'Kasra', 'builder', 'test-model', 'active', datetime('now')),
        ('a-idle', 'squad1', 'idle', 'Idle', 'builder', 'test-model', 'paused', datetime('now'));

      INSERT INTO members (id, tenant, display_name, email, status, created_at) VALUES
        ('m-loom', 'flight008', 'Loom Key Owner', NULL, 'active', datetime('now')),
        ('m-kasra', 'flight008', 'Kasra Key Owner', NULL, 'active', datetime('now'));

      INSERT INTO agent_keys (tenant, agent_id, pubkey, member_id, created_at) VALUES
        ('flight008', 'a-loom', 'pk-loom', 'm-loom', unixepoch()),
        ('flight008', 'a-kasra', 'pk-kasra', 'm-kasra', unixepoch());

      INSERT INTO fleet_agents (agent_id, tenant, display, runtime, status, last_reported_at, updated_at) VALUES
        ('a-loom', 'flight008', 'Loom', 'claude-code', 'running', '${RECENT}', '${RECENT}'),
        ('a-kasra', 'flight008', 'Kasra', 'claude-code', 'running', '${RECENT}', '${RECENT}');

      -- Gate queue: two tasks a gate_owner-holding owner can verdict (the "needs your
      -- decision" question), one blocked task (a different question), one done task
      -- (neither).
      INSERT INTO tasks (id, squad_id, title, status, assignee_agent_id, gate_owner, created_at, updated_at) VALUES
        ('t-review-1', 'squad1', 'Ship the thing', 'review', 'a-loom', 'gate:content', datetime('now'), datetime('now')),
        ('t-review-2', 'squad1', 'Ship the other thing', 'review', 'a-kasra', 'gate:content', datetime('now'), datetime('now')),
        ('t-blocked-1', 'squad1', 'Blocked work', 'blocked', 'a-loom', NULL, datetime('now'), datetime('now')),
        ('t-done-1', 'squad1', 'Done work', 'done', 'a-loom', NULL, datetime('now'), datetime('now'));
    `)
    env = { TENANT_SLUG: 'flight008', DB: harness.db } as unknown as Env
  })

  afterAll(() => { harness.close() })

  async function homeCounts() {
    const [obsData, approvals, taskStatusCounts] = await Promise.all([
      loadObservatory(env),
      loadApprovals(env, OWNER),
      loadTaskStatusCounts(env),
    ])
    return computeOperatorCounts({
      nowMs: NOW,
      agents: obsData.agents,
      stats: obsData.stats,
      runtimeStates: obsData.runtimeStates,
      approvals,
      taskStatusCounts,
    })
  }

  it('Home, Health, and Fleet agree on "how many agents have a live runtime" for the seeded fixture', async () => {
    const home = await homeCounts()
    const health = await loadOpsHealth(env, OWNER, NOW)
    const radar = await loadFleetRadar(env, NOW, null)

    // Sanity: the fixture actually has a mix (2 live, 1 unattached) — a test that
    // passes with everyone reporting 0 would prove nothing.
    expect(home.liveRuntimeCount).toBe(2)

    expect(health.kpis.runtimeOnline).toBe(home.liveRuntimeCount)
    expect(radar.summary.live).toBe(home.liveRuntimeCount)
  })

  it('Home and Health agree on "how many agents are configured/active"', async () => {
    const home = await homeCounts()
    const health = await loadOpsHealth(env, OWNER, NOW)

    expect(home.agentsTotal).toBe(3)
    expect(home.agentsActive).toBe(2) // a-idle is 'paused'
    expect(health.kpis.activeAgents).toBe(home.agentsActive)
  })

  it('Home and Health agree on "how many need my decision" — the RBAC + gate_owner-scoped gate queue', async () => {
    const home = await homeCounts()
    const health = await loadOpsHealth(env, OWNER, NOW)

    // Sanity: exactly the two 'review' + gate_owner-set tasks, not the blocked one.
    expect(home.needsDecisionCount).toBe(2)
    expect(health.kpis.needsDecision).toBe(home.needsDecisionCount)
  })

  it('mutating the underlying signal (one agent goes stale) moves ALL three surfaces together — proves the helper is the source, not a copy', async () => {
    const before = await homeCounts()
    expect(before.liveRuntimeCount).toBe(2)

    // a-kasra's heartbeat decays past every liveness TTL this suite uses.
    harness.sqlite.exec(`UPDATE fleet_agents SET last_reported_at = '${STALE}', updated_at = '${STALE}' WHERE agent_id = 'a-kasra'`)

    const home = await homeCounts()
    const health = await loadOpsHealth(env, OWNER, NOW)
    const radar = await loadFleetRadar(env, NOW, null)

    expect(home.liveRuntimeCount).toBe(1)
    expect(health.kpis.runtimeOnline).toBe(1)
    expect(radar.summary.live).toBe(1)
    // All three still agree with each other post-mutation, not just individually correct.
    expect(health.kpis.runtimeOnline).toBe(home.liveRuntimeCount)
    expect(radar.summary.live).toBe(home.liveRuntimeCount)

    // Restore for any test that runs after this one in the same file.
    harness.sqlite.exec(`UPDATE fleet_agents SET last_reported_at = '${RECENT}', updated_at = '${RECENT}' WHERE agent_id = 'a-kasra'`)
  })
})
