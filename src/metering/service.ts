// src/metering/service.ts — Unified Execution & Spend Metering (FLIGHT-METER / F8).
//
// Unifies execution metering, routine runs, loop drivers, and MCP tools under one
// real-time spend ledger and checkAndReserve pre-flight hard stops:
// 1. checkAndReserve: checks current window spend against dollar/token cap BEFORE execution.
// 2. recordExecutionSpend: persists token counts and micro-USD cost into execution_meter.
// 3. getAgentSpendStatus: queries current window spend, token counts, and remaining budget.

import type { Env } from '../types'
import {
  checkAndReserve,
  recordTokens,
  buildWindowKey,
  sumWeekCostMicroUsd,
  MICRO_USD_PER_CENT,
  isEnforceableCap,
  type MeterResult,
  type RecordTokensUsage,
} from '../agents/meter'

export interface UnifiedSpendStatus {
  agentId: string
  windowKey: string
  spendTodayMicroUsd: number
  spendTodayDollars: number
  tokensToday: number
  dispatchCount: number
  budgetCapMicroUsd: number | null
  budgetCapDollars: number | null
  budgetRemainingMicroUsd: number | null
  isExhausted: boolean
}

export interface RecordExecutionSpendInput {
  agentId: string
  tokens: number
  costMicroUsd: number
  usage?: RecordTokensUsage
  routineRunId?: string
  taskId?: string
  flightId?: string
}

/**
 * Check and reserve unified execution slot with pre-flight hard budget stop.
 */
export async function checkAndReserveExecution(
  env: Env,
  agentId: string,
  options: {
    estimateMicroUsd?: number
    budgetCapCents?: number | null
    budgetCapMicroUsd?: number | null
    budgetWindow?: 'day' | 'week'
  } = {},
): Promise<MeterResult> {
  return checkAndReserve(env, agentId, options)
}

/**
 * Record real execution spend into execution_meter and emit spend telemetry.
 */
export async function recordExecutionSpend(
  env: Env,
  input: RecordExecutionSpendInput,
): Promise<void> {
  await recordTokens(
    env,
    input.agentId,
    input.tokens,
    input.costMicroUsd,
    input.usage,
  )
}

/**
 * Get comprehensive unified spend status for an agent.
 */
export async function getAgentSpendStatus(
  env: Env,
  agentId: string,
  options: { budgetCapCents?: number | null; budgetCapMicroUsd?: number | null; budgetWindow?: 'day' | 'week' } = {},
): Promise<UnifiedSpendStatus> {
  const windowKey = buildWindowKey(env.TENANT_SLUG, agentId)

  const row = await env.DB.prepare(
    `SELECT count, tokens, cost_micro_usd FROM execution_meter WHERE window_key = ?1 LIMIT 1`,
  )
    .bind(windowKey)
    .first<{ count: number; tokens: number; cost_micro_usd: number }>()

  const count = row?.count ?? 0
  const tokens = row?.tokens ?? 0
  const currentCost = row?.cost_micro_usd ?? 0

  const capMicroUsd =
    isEnforceableCap(options.budgetCapMicroUsd)
      ? options.budgetCapMicroUsd
      : isEnforceableCap(options.budgetCapCents)
        ? options.budgetCapCents * MICRO_USD_PER_CENT
        : null

  const effectiveSpend =
    options.budgetWindow === 'week'
      ? await sumWeekCostMicroUsd(env, env.TENANT_SLUG, agentId)
      : currentCost

  const remaining = capMicroUsd !== null ? Math.max(0, capMicroUsd - effectiveSpend) : null
  const isExhausted = capMicroUsd !== null ? effectiveSpend >= capMicroUsd : false

  return {
    agentId,
    windowKey,
    spendTodayMicroUsd: effectiveSpend,
    spendTodayDollars: effectiveSpend / 1_000_000,
    tokensToday: tokens,
    dispatchCount: count,
    budgetCapMicroUsd: capMicroUsd,
    budgetCapDollars: capMicroUsd !== null ? capMicroUsd / 1_000_000 : null,
    budgetRemainingMicroUsd: remaining,
    isExhausted,
  }
}
