// mupot — fleet agent lifecycle: death-condition soft-retire + credit/provider dormancy.
//
// Port 1.x death condition (docs/architecture/mupot-agent-identity-memory-lifecycle.md §2.4):
//   idle + no live instance + no activity past TTL → soft-retire (status=inactive).
//   Zero field precedent — soft-delete + audit; identity/memory preserved.
//
// Credit-out / provider-down → dormant (status=paused + dormant_reason) → reactivate
// when credit/provider returns. model_fallback is tried BEFORE dormancy on provider
// failure so a single dead preferred model never crash-loops the fleet.

import type { Env, Agent, ModelMessage, ModelPort, BusEvent } from '../types'
import { createBus } from '../bus'
import {
  MAX_DISPATCHES_PER_DAY,
  MAX_TOKENS_PER_DAY,
  MICRO_USD_PER_CENT,
} from './meter'
import { costMicroUsd } from './cost'

export type DormantReason = 'credit_out' | 'provider_down'

export type DeathConditionPolicy = {
  idle_ttl_hours: number
  policy: 'no_instance_no_activity'
}

export type LifecycleTransition =
  | 'soft_retired'
  | 'dormant'
  | 'reactivated'

export type LifecycleAudit = {
  transition: LifecycleTransition
  agent_id: string
  reason: string
  detail?: string
}

export const DORMANT_REASONS: readonly DormantReason[] = ['credit_out', 'provider_down']

export function isDormantReason(v: unknown): v is DormantReason {
  return typeof v === 'string' && (DORMANT_REASONS as readonly string[]).includes(v)
}

/** Parse agents.death_condition JSON. null/invalid → null (never auto-retire). */
export function parseDeathCondition(raw: string | null): DeathConditionPolicy | null {
  if (raw === null || raw.trim() === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    const hours = obj.idle_ttl_hours
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
      return null
    }
    if (obj.policy !== 'no_instance_no_activity') return null
    return { idle_ttl_hours: hours, policy: 'no_instance_no_activity' }
  } catch {
    return null
  }
}

export interface DeathEligibilityInput {
  nowMs: number
  createdAtMs: number
  lastInstanceMs: number | null
  lastActivityMs: number | null
  policy: DeathConditionPolicy
}

/**
 * Pure death-condition predicate. Soft-retire only when BOTH instance and activity
 * are older than the TTL (or never observed), and the agent itself is older than TTL.
 */
export function isDeathConditionMet(input: DeathEligibilityInput): boolean {
  const cutoff = input.nowMs - input.policy.idle_ttl_hours * 3_600_000
  if (input.createdAtMs > cutoff) return false
  const instanceDead = input.lastInstanceMs === null || input.lastInstanceMs < cutoff
  const activityDead = input.lastActivityMs === null || input.lastActivityMs < cutoff
  return instanceDead && activityDead
}

/** Provider/model failures that should fail over or dormancy — not application bugs. */
export function isProviderFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const m = err.message.toLowerCase()
  return (
    /\b(429|502|503|504|500)\b/.test(m) ||
    /timed?\s*out|timeout|econnreset|enotfound|eai_again/.test(m) ||
    /provider|unavailable|overloaded|capacity|quota|billing|credit|rate.?limit/.test(m) ||
    /model:\s*ai gateway/.test(m)
  )
}

export function isCreditOutReason(
  reason: 'rate_limited' | 'budget_exhausted' | 'budget_cap_exceeded',
): boolean {
  return reason === 'budget_exhausted' || reason === 'budget_cap_exceeded'
}

export interface ChatFallbackResult {
  text: string
  modelUsed: string
  usedFallback: boolean
}

/**
 * Preferred model first; on provider failure try model_fallback once.
 * Both failing → throw the fallback error (caller marks provider_down dormant).
 */
export async function chatWithModelFallback(
  model: ModelPort,
  agent: Pick<Agent, 'model' | 'model_fallback'>,
  messages: ModelMessage[],
  opts: { maxTokens?: number },
): Promise<ChatFallbackResult> {
  try {
    const text = await model.chat(messages, {
      model: agent.model,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    })
    return { text, modelUsed: agent.model, usedFallback: false }
  } catch (preferredErr) {
    const fallback = agent.model_fallback?.trim()
    if (!fallback || !isProviderFailure(preferredErr)) throw preferredErr
    const text = await model.chat(messages, {
      model: fallback,
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    })
    return { text, modelUsed: fallback, usedFallback: true }
  }
}

async function emitLifecycle(env: Env, audit: LifecycleAudit): Promise<void> {
  const event: BusEvent<{
    transition: LifecycleTransition
    reason: string
    detail?: string
  }> = {
    type: 'agent.lifecycle',
    tenant: env.TENANT_SLUG,
    agent_id: audit.agent_id,
    payload: {
      transition: audit.transition,
      reason: audit.reason,
      ...(audit.detail ? { detail: audit.detail } : {}),
    },
    ts: new Date().toISOString(),
  }
  try {
    await createBus(env).emit(event)
  } catch {
    console.error('lifecycle: agent.lifecycle emit failed (non-fatal)', {
      tenant: env.TENANT_SLUG,
      agent_id: audit.agent_id,
      transition: audit.transition,
    })
  }
}

function isProtectedFleetAgent(env: Env, agent: { id: string; slug: string }): boolean {
  const consumer = env.FLEET_CONSUMER_AGENT?.trim()
  if (consumer && (consumer === agent.id || consumer === agent.slug)) return true
  const ops = env.FLEET_OPS_AGENT?.trim()
  if (ops && (ops === agent.id || ops === agent.slug)) return true
  return false
}

function sqliteUtcToMs(s: string | null | undefined): number | null {
  if (!s) return null
  const normalized = s.includes('T') ? s : s.replace(' ', 'T') + (s.endsWith('Z') ? '' : 'Z')
  const ms = Date.parse(normalized)
  return Number.isNaN(ms) ? null : ms
}

export type LifecycleWriteResult =
  | { ok: true; changed: boolean }
  | { ok: false; error: string }

/** Soft-retire: status→inactive. Keys/tokens/memory untouched (reversible, audited). */
export async function softRetireAgent(
  env: Env,
  agent: Pick<Agent, 'id' | 'slug'>,
  detail: string,
): Promise<LifecycleWriteResult> {
  if (isProtectedFleetAgent(env, agent)) {
    return { ok: false, error: 'protected_agent' }
  }
  const result = await env.DB.prepare(
    `UPDATE agents
        SET status = 'inactive', dormant_reason = NULL
      WHERE id = ?1 AND status != 'inactive'`,
  )
    .bind(agent.id)
    .run()
  const changed = (result.meta.changes ?? 0) > 0
  if (changed) {
    await emitLifecycle(env, {
      transition: 'soft_retired',
      agent_id: agent.id,
      reason: 'death_condition',
      detail,
    })
  }
  return { ok: true, changed }
}

/** Credit-out / provider-down sleep. Identity + memory + keys persist. */
export async function markDormant(
  env: Env,
  agent: Pick<Agent, 'id' | 'slug'>,
  reason: DormantReason,
  detail: string,
): Promise<LifecycleWriteResult> {
  if (isProtectedFleetAgent(env, agent)) {
    return { ok: false, error: 'protected_agent' }
  }
  const result = await env.DB.prepare(
    `UPDATE agents
        SET status = 'paused', dormant_reason = ?1
      WHERE id = ?2 AND status = 'active'`,
  )
    .bind(reason, agent.id)
    .run()
  const changed = (result.meta.changes ?? 0) > 0
  if (changed) {
    await emitLifecycle(env, {
      transition: 'dormant',
      agent_id: agent.id,
      reason,
      detail,
    })
  }
  return { ok: true, changed }
}

/** Clear dormancy (or admin soft-retire undo) back to active. */
export async function reactivateAgent(
  env: Env,
  agentId: string,
  reason: string,
  detail: string,
): Promise<LifecycleWriteResult> {
  const result = await env.DB.prepare(
    `UPDATE agents
        SET status = 'active', dormant_reason = NULL
      WHERE id = ?1 AND (status IN ('paused', 'inactive') OR dormant_reason IS NOT NULL)`,
  )
    .bind(agentId)
    .run()
  const changed = (result.meta.changes ?? 0) > 0
  if (changed) {
    await emitLifecycle(env, {
      transition: 'reactivated',
      agent_id: agentId,
      reason,
      detail,
    })
  }
  return { ok: true, changed }
}

interface SweepCandidate {
  id: string
  slug: string
  created_at: string
  death_condition: string | null
}

async function lastInstanceMs(env: Env, agentId: string, slug: string): Promise<number | null> {
  const presence = await env.DB.prepare(
    `SELECT MAX(last_seen_at) AS ts FROM presence WHERE tenant = ?1 AND agent_id = ?2`,
  )
    .bind(env.TENANT_SLUG, agentId)
    .first<{ ts: string | null }>()
  const fleet = await env.DB.prepare(
    `SELECT MAX(last_reported_at) AS ts FROM fleet_agents
      WHERE tenant = ?1 AND agent_id IN (?2, ?3)`,
  )
    .bind(env.TENANT_SLUG, agentId, slug)
    .first<{ ts: string | null }>()
  const mod = await env.DB.prepare(
    `SELECT MAX(last_heartbeat) AS ts FROM module_registry
      WHERE tenant = ?1 AND identity IN (?2, ?3)`,
  )
    .bind(env.TENANT_SLUG, agentId, slug)
    .first<{ ts: string | null }>()
  const times = [presence?.ts, fleet?.ts, mod?.ts].map(sqliteUtcToMs).filter((n): n is number => n !== null)
  return times.length === 0 ? null : Math.max(...times)
}

async function lastActivityMs(env: Env, agentId: string): Promise<number | null> {
  const task = await env.DB.prepare(
    `SELECT MAX(COALESCE(completed_at, created_at)) AS ts
       FROM tasks WHERE assignee_agent_id = ?1`,
  )
    .bind(agentId)
    .first<{ ts: string | null }>()
  // execution_meter window_key = '<tenant>:<agent_id>:<YYYY-MM-DD>'; window_start is the stamp.
  const meter = await env.DB.prepare(
    `SELECT MAX(window_start) AS ts FROM execution_meter WHERE window_key LIKE ?1`,
  )
    .bind(`${env.TENANT_SLUG}:${agentId}:%`)
    .first<{ ts: string | null }>()
  const times = [task?.ts, meter?.ts].map(sqliteUtcToMs).filter((n): n is number => n !== null)
  return times.length === 0 ? null : Math.max(...times)
}

async function peekCreditAvailable(
  env: Env,
  agent: {
    id: string
    model: string
    budget_cap_cents: number | null
    budget_window: string
  },
): Promise<boolean> {
  const today = new Date()
  const y = today.getUTCFullYear()
  const m = String(today.getUTCMonth() + 1).padStart(2, '0')
  const d = String(today.getUTCDate()).padStart(2, '0')
  const windowKey = `${env.TENANT_SLUG}:${agent.id}:${y}-${m}-${d}`
  const existing = await env.DB.prepare(
    `SELECT count, tokens, cost_micro_usd FROM execution_meter WHERE window_key = ? LIMIT 1`,
  )
    .bind(windowKey)
    .first<{ count: number; tokens: number; cost_micro_usd: number }>()
  const count = existing?.count ?? 0
  const tokens = existing?.tokens ?? 0
  const currentCost = existing?.cost_micro_usd ?? 0
  if (count >= MAX_DISPATCHES_PER_DAY || tokens >= MAX_TOKENS_PER_DAY) return false

  const capCents = agent.budget_cap_cents
  if (typeof capCents === 'number' && capCents > 0) {
    const capMicro = capCents * MICRO_USD_PER_CENT
    let spanCost = currentCost
    if (agent.budget_window === 'week') {
      const start = new Date(today)
      start.setUTCDate(start.getUTCDate() - 6)
      const sy = start.getUTCFullYear()
      const sm = String(start.getUTCMonth() + 1).padStart(2, '0')
      const sd = String(start.getUTCDate()).padStart(2, '0')
      const lo = `${env.TENANT_SLUG}:${agent.id}:${sy}-${sm}-${sd}`
      const hi = windowKey
      const row = await env.DB.prepare(
        `SELECT COALESCE(SUM(cost_micro_usd), 0) AS c FROM execution_meter
           WHERE window_key >= ? AND window_key <= ?`,
      )
        .bind(lo, hi)
        .first<{ c: number }>()
      spanCost = row?.c ?? 0
    }
    const estimate = costMicroUsd(agent.model, 1)
    if (spanCost >= capMicro || spanCost + estimate > capMicro) return false
  }
  return true
}

export interface LifecycleTickResult {
  ok: boolean
  scanned: number
  soft_retired: number
  reactivated: number
  errors: number
}

/**
 * Cron tick: enforce death_condition soft-retire, then try to reactivate dormant agents.
 * Fail-soft per agent — never aborts the rest of the scheduled handler.
 */
export async function runLifecycleTick(
  env: Env,
  nowMs: number,
  deps: {
    model?: ModelPort
  } = {},
): Promise<LifecycleTickResult> {
  let scanned = 0
  let softRetired = 0
  let reactivated = 0
  let errors = 0

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, slug, created_at, death_condition
         FROM agents
        WHERE status IN ('active', 'paused')
          AND death_condition IS NOT NULL`,
    ).all<SweepCandidate>()

    for (const row of results ?? []) {
      scanned++
      const policy = parseDeathCondition(row.death_condition)
      if (!policy) continue
      try {
        const createdAtMs = sqliteUtcToMs(row.created_at)
        if (createdAtMs === null) continue
        const met = isDeathConditionMet({
          nowMs,
          createdAtMs,
          lastInstanceMs: await lastInstanceMs(env, row.id, row.slug),
          lastActivityMs: await lastActivityMs(env, row.id),
          policy,
        })
        if (!met) continue
        const r = await softRetireAgent(env, row, `idle_ttl_hours=${policy.idle_ttl_hours}`)
        if (r.ok && r.changed) softRetired++
      } catch {
        errors++
      }
    }
  } catch {
    return { ok: false, scanned, soft_retired: softRetired, reactivated, errors: errors + 1 }
  }

  try {
    const { results } = await env.DB.prepare(
      `SELECT id, slug, model, model_fallback, dormant_reason, budget_cap_cents, budget_window
         FROM agents
        WHERE dormant_reason IS NOT NULL AND status = 'paused'`,
    ).all<{
      id: string
      slug: string
      model: string
      model_fallback: string | null
      dormant_reason: string
      budget_cap_cents: number | null
      budget_window: string
    }>()

    for (const row of results ?? []) {
      scanned++
      if (!isDormantReason(row.dormant_reason)) continue
      try {
        if (row.dormant_reason === 'credit_out') {
          const ok = await peekCreditAvailable(env, row)
          if (!ok) continue
          const r = await reactivateAgent(env, row.id, 'credit_restored', 'meter_allows')
          if (r.ok && r.changed) reactivated++
          continue
        }

        // provider_down — probe preferred then fallback; success → reactivate.
        const model = deps.model
        if (!model) continue
        const probe: ModelMessage[] = [{ role: 'user', content: 'ping' }]
        try {
          await chatWithModelFallback(
            model,
            { model: row.model, model_fallback: row.model_fallback },
            probe,
            { maxTokens: 1 },
          )
        } catch {
          continue
        }
        const r = await reactivateAgent(env, row.id, 'provider_restored', row.model)
        if (r.ok && r.changed) reactivated++
      } catch {
        errors++
      }
    }
  } catch {
    errors++
  }

  return { ok: true, scanned, soft_retired: softRetired, reactivated, errors }
}
