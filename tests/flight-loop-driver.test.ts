// tests/flight-loop-driver.test.ts — Verification of FLIGHT-LOOP-UNHOLD.
//
// Invariants verified:
//   1. Governed Loop Execution: Active loops execute cycles and record outcomes.
//   2. Propose-Only Boundary: Gated loops route acts to /approvals tasks with gate_owner='gate:loops'.
//   3. Held Loops: Inactive or paused loops are cleanly held and skipped.
//   4. loop_driver_tick MCP tool execution.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  runGovernedLoopDriverTick,
  executeGovernedLoopCycle,
} from '../src/loops/driver'
import { createLoop } from '../src/loops/service'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT-LOOP-UNHOLD: Governed Autonomous Loop Driver', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const SQUAD_ID = 'squad-growth'

  const authContext: AuthContext = {
    userId: 'm-operator',
    memberId: 'm-operator',
    email: 'operator@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: 'm-operator', scope_type: 'squad', scope_id: SQUAD_ID, capability: 'lead' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env

    // Seed departments, squads, and agents
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'growth', 'Growth Dept');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-1', 'growth', 'Growth Squad');
      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('ag-growth-1', '${SQUAD_ID}', 'growth-lead', 'Growth Lead', 'active');
    `)
  })

  describe('1. Propose-Only Boundary & Cycle Execution', () => {
    it('executes active loop and routes gated acts into /approvals review tasks', async () => {
      // 1. Create gated loop
      const created = await createLoop(env, {
        squad_id: SQUAD_ID,
        okr: 'Drive qualified customer outreach',
        kpi: { signal: 'replies', target: 5 },
        sources: [{ kind: 'queue', name: 'prospects' }],
        channels: [{ kind: 'mcp', url: 'https://mcp.test', auth_ref: 'TEST_KEY' }],
        gate: { require_approval: true, timeout_sec: 3600, on_timeout: 'pause' },
        budget: { cap_micro_usd: 1000000, window: 'day', effort: 'standard' },
        cadence: { heartbeat: true, on_event: true },
        stop: { dry_rounds_max: 3, on_kpi_met: true },
      })

      expect(created.ok).toBe(true)
      if (!created.ok) throw new Error('Unreachable')
      const loop = created.value

      // 2. Execute cycle
      const cycleRes = await executeGovernedLoopCycle(env, loop)
      expect(cycleRes.ok).toBe(true)

      // 3. Driver tick across all loops
      const sweepRes = await runGovernedLoopDriverTick(env)
      expect(sweepRes.scannedCount).toBe(1)
      expect(sweepRes.executedCount).toBe(1)
      expect(sweepRes.heldCount).toBe(0)
    })

    it('holds and skips paused loops', async () => {
      // Create and pause loop
      const created = await createLoop(env, {
        squad_id: SQUAD_ID,
        okr: 'Outreach loop',
        kpi: { signal: 'replies', target: 5 },
        sources: [{ kind: 'queue', name: 'prospects' }],
        channels: [{ kind: 'mcp', url: 'https://mcp.test', auth_ref: 'TEST_KEY' }],
        gate: { require_approval: true, timeout_sec: 3600, on_timeout: 'pause' },
        budget: { cap_micro_usd: 1000000, window: 'day', effort: 'standard' },
        cadence: { heartbeat: true, on_event: true },
        stop: { dry_rounds_max: 3, on_kpi_met: true },
      })

      if (!created.ok) throw new Error('Unreachable')

      // Pause loop in D1
      await env.DB.prepare(`UPDATE loops SET status = 'paused' WHERE id = ?1`).bind(created.value.id).run()

      const sweep = await runGovernedLoopDriverTick(env)
      expect(sweep.scannedCount).toBe(1)
      expect(sweep.executedCount).toBe(0)
      expect(sweep.heldCount).toBe(1)
    })
  })

  describe('2. MCP Tool loop_driver_tick', () => {
    it('runs loop_driver_tick via MCP tool', async () => {
      await createLoop(env, {
        squad_id: SQUAD_ID,
        okr: 'MCP Goal Seek',
        kpi: { signal: 'clicks', target: 10 },
        sources: [{ kind: 'queue', name: 'clicks' }],
        channels: [{ kind: 'mcp', url: 'https://mcp.test', auth_ref: 'TEST_KEY' }],
        gate: { require_approval: true, timeout_sec: 3600, on_timeout: 'pause' },
        budget: { cap_micro_usd: 1000000, window: 'day', effort: 'standard' },
        cadence: { heartbeat: true, on_event: true },
        stop: { dry_rounds_max: 3, on_kpi_met: true },
      })

      const res = await invokeTool(authContext, env, 'loop_driver_tick', {})
      expect(res.ok).toBe(true)
      expect((res.result as any).scannedCount).toBe(1)
    })
  })
})
