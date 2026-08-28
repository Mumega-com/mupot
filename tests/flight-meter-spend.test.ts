// tests/flight-meter-spend.test.ts — Verification of FLIGHT-METER (F8).
//
// Invariants verified:
//   1. Pre-flight checkAndReserve stops before spend once budget cap would be exceeded.
//   2. Unified token and micro-USD recording into execution_meter.
//   3. getAgentSpendStatus returns accurate today/week metrics, caps, and remaining balances.
//   4. execution_meter_check & execution_meter_status MCP tools integration.

import { describe, it, expect, beforeEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  checkAndReserveExecution,
  recordExecutionSpend,
  getAgentSpendStatus,
} from '../src/metering/service'
import { invokeTool } from '../src/mcp/index'
import type { Env, AuthContext } from '../src/types'

describe('FLIGHT-METER (F8): Unified Execution & Spend Metering', () => {
  let harness: SqliteD1Harness
  let env: Env

  const TENANT = 'mumega'
  const AGENT_ID = 'ag-metered-1'

  const authContext: AuthContext = {
    userId: 'm-operator',
    memberId: 'm-operator',
    email: 'operator@mumega.com',
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    capabilities: [{ member_id: 'm-operator', scope_type: 'org', scope_id: null, capability: 'lead' }],
  }

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)

    env = {
      DB: harness.db,
      TENANT_SLUG: TENANT,
      PUBLIC_ORIGIN: 'https://mupot.example',
    } as unknown as Env

    // Seed test agent
    harness.sqlite.exec(`
      INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('dept-1', 'core', 'Core');
      INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'core', 'Core Squad');
      INSERT OR IGNORE INTO agents (id, squad_id, slug, name, status)
      VALUES ('${AGENT_ID}', 'squad-1', 'metered-agent', 'Metered Agent', 'active');
    `)
  })

  describe('1. Pre-Flight Reservation & Dollar Caps', () => {
    it('reserves execution slots and halts before spend once cap is reached', async () => {
      // 1. Initial reservation with $1.00 budget cap (100 cents = 1,000,000 micro-USD)
      const res1 = await checkAndReserveExecution(env, AGENT_ID, {
        estimateMicroUsd: 200_000,
        budgetCapCents: 100,
      })

      expect(res1.ok).toBe(true)
      if (!res1.ok) throw new Error('Unreachable')
      expect(res1.count).toBe(1)

      // 2. Record actual spend of $0.90 (900,000 micro-USD)
      await recordExecutionSpend(env, {
        agentId: AGENT_ID,
        tokens: 15_000,
        costMicroUsd: 900_000,
      })

      // 3. Next reservation with estimated 200_000 micro-USD will exceed $1.00 -> fails closed
      const res2 = await checkAndReserveExecution(env, AGENT_ID, {
        estimateMicroUsd: 200_000,
        budgetCapCents: 100,
      })

      expect(res2.ok).toBe(false)
      if (res2.ok) throw new Error('Unreachable')
      expect(res2.reason).toBe('budget_cap_exceeded')
    })
  })

  describe('2. Unified Status Query & Telemetry', () => {
    it('returns exact spend, token counts, and remaining balances', async () => {
      await recordExecutionSpend(env, {
        agentId: AGENT_ID,
        tokens: 25_000,
        costMicroUsd: 500_000, // $0.50
      })

      const status = await getAgentSpendStatus(env, AGENT_ID, {
        budgetCapCents: 200, // $2.00
      })

      expect(status.spendTodayMicroUsd).toBe(500_000)
      expect(status.spendTodayDollars).toBe(0.5)
      expect(status.tokensToday).toBe(25_000)
      expect(status.budgetRemainingMicroUsd).toBe(1_500_000)
      expect(status.isExhausted).toBe(false)
    })
  })

  describe('3. MCP Execution Meter Tools', () => {
    it('invokes execution_meter_check and execution_meter_status via MCP', async () => {
      const checkRes = await invokeTool(authContext, env, 'execution_meter_check', {
        agent_id: AGENT_ID,
        estimate_micro_usd: 100_000,
        budget_cap_cents: 500,
      })

      expect(checkRes.ok).toBe(true)

      const statusRes = await invokeTool(authContext, env, 'execution_meter_status', {
        agent_id: AGENT_ID,
        budget_cap_cents: 500,
      })

      expect(statusRes.ok).toBe(true)
      expect((statusRes.result as any).budgetCapDollars).toBe(5)
    })
  })
})
