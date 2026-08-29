// mupot — execution meter: per-(tenant, agent, day) dispatch + token governor.
//
// Enforces soft daily caps on execute-mode model calls (issue #4).
// Prevents economic DoS from looped dispatch before self-serve tenants land.
//
// Design
// ──────
// Window key: '<tenant>:<agent_id>:<YYYY-MM-DD>' (UTC).
//   A new calendar day automatically resets the window — no background job needed.
//   The UPSERT in checkAndReserve handles first-use initialisation and mid-window
//   increments in one statement.
//
// Race note (D1 limitation):
//   D1 does not offer serialisable transactions across Worker requests. Two
//   concurrent dispatches may both read count=N below the cap and both succeed,
//   letting up to (concurrency - 1) extra cycles through at the exact boundary.
//   This is acceptable: the cap is an economic soft governor, not a hard security
//   gate. The DO alarm path is naturally serialised (one DO at a time). HTTP
//   dispatch concurrency is bounded by the member RBAC gate that sits above this.
//
// Cap sources (resolved server-side before reservation):
//   dispatch count : env.EXEC_MAX_DISPATCH_DAY ?? MAX_DISPATCHES_PER_DAY (200)
//   token spend    : env.EXEC_MAX_TOKENS_DAY   ?? MAX_TOKENS_PER_DAY     (200_000)
//   dollar budget  : agents.budget_cap_cents (migration 0009), converted to
//                    micro-USD and enforced over agents.budget_window. Public
//                    callers never supply an agent, cap, window, or estimate.
//
// The dollar cap (issue #4) IS enforced here as an ENFORCEMENT-LAYER pre-call gate:
// checkAndReserve blocks BEFORE any model spend once the window's recorded
// cost_micro_usd plus a conservative estimate would breach the cap. The cap may be
// REACHED but not EXCEEDED. This is a sensitive surface (eligibility/veto) — do NOT
// change the cap logic without a matching adversarial gate pass.

import { authorizeExecutionScope } from '../auth/execution-scope'
import type { Agent, AuthContext, Env } from '../types'
import type { ToolOutcome } from '../mcp/index'

// ── Default caps (overridable via env vars) ───────────────────────────────────

/** Maximum execute-mode dispatches per agent per day (rolling UTC calendar day). */
export const MAX_DISPATCHES_PER_DAY = 200

/** Maximum tokens an agent may spend per day across all execute cycles. */
export const MAX_TOKENS_PER_DAY = 200_000

// ── Public surface ────────────────────────────────────────────────────────────

export interface MeterCheckResult {
  ok: true
  windowKey: string
  count: number   // count AFTER reservation (i.e. current window count)
  tokens: number
}

export interface MeterBlockResult {
  ok: false
  reason: 'rate_limited' | 'budget_exhausted' | 'budget_cap_exceeded'
  windowKey: string
  count: number
  tokens: number
  retryAfterSec: number // seconds until the next UTC midnight (window reset)
}

export type MeterResult = MeterCheckResult | MeterBlockResult

/** 1 cent = $0.01 = 10,000 micro-USD. Used to convert budget_cap_cents → micro-USD. */
export const MICRO_USD_PER_CENT = 10_000

/**
 * Internal reservation authority. Every field is derived by an already-authorized
 * server orchestrator; no MCP or REST input schema accepts this shape.
 */
export interface AuthorizedExecution {
  tenant: string
  meterSubjectId: string
  squadId: string
  projectId: string | null
  maxDispatchDay: number
  maxTokensDay: number
  maxCostMicroUsd: number
  costWindow: 'day' | 'week'
  estimateMicroUsd: number
}

export interface AuthorizedMeterPolicy {
  meterSubjectId: string
  squadId: string
  projectId: string | null
  maxCostMicroUsd: number
  costWindow: 'day' | 'week'
  estimateMicroUsd: number
}

/** Add server-owned tenant and dispatch/token ceilings to a resolved meter subject. */
export function buildAuthorizedMeterExecution(
  env: Env,
  policy: AuthorizedMeterPolicy,
): AuthorizedExecution {
  return {
    tenant: env.TENANT_SLUG,
    meterSubjectId: policy.meterSubjectId,
    squadId: policy.squadId,
    projectId: policy.projectId,
    maxDispatchDay: parseCap(env, 'EXEC_MAX_DISPATCH_DAY', MAX_DISPATCHES_PER_DAY),
    maxTokensDay: parseCap(env, 'EXEC_MAX_TOKENS_DAY', MAX_TOKENS_PER_DAY),
    maxCostMicroUsd: policy.maxCostMicroUsd,
    costWindow: policy.costWindow,
    estimateMicroUsd:
      Number.isFinite(policy.estimateMicroUsd) && policy.estimateMicroUsd > 0
        ? Math.round(policy.estimateMicroUsd)
        : 0,
  }
}

/**
 * Build internal meter authority from the canonical agent row and server policy.
 * The estimate is produced by the execution/loop cost model, never request JSON.
 */
export function buildAuthorizedExecution(
  env: Env,
  agent: Pick<Agent, 'id' | 'squad_id' | 'budget_cap_cents' | 'budget_window'>,
  projectId: string | null,
  estimateMicroUsd: number,
): AuthorizedExecution {
  return buildAuthorizedMeterExecution(env, {
    meterSubjectId: agent.id,
    squadId: agent.squad_id,
    projectId,
    maxCostMicroUsd: isEnforceableCap(agent.budget_cap_cents)
      ? agent.budget_cap_cents * MICRO_USD_PER_CENT
      : 0,
    costWindow: agent.budget_window === 'week' ? 'week' : 'day',
    estimateMicroUsd,
  })
}

/**
 * isEnforceableCap — THE single predicate for "is this budget cap real?".
 *
 * Exported and shared on purpose. This condition previously existed as two copies:
 * here (enforcement) and inline in src/mcp/index.ts (admission, deciding what gets
 * reported in `budget_uncapped`). They drifted, and #1179 gate R6 caught it — the
 * admission copy carried Number.isSafeInteger and this one did not, so three classes
 * of value were reported as UNCAPPED while being enforced as caps:
 *
 *     10.5                     admission=false  meter=true   -> enforced as $10.50
 *     Infinity                 admission=false  meter=true
 *     MAX_SAFE_INTEGER + 2     admission=false  meter=true
 *
 * A flight would be admitted as unlimited, told so in telemetry, and then hit
 * budget_cap_exceeded mid-execution.
 *
 * Syncing the two copies would have fixed today's drift and left the mechanism that
 * produced it. One exported predicate, two call sites, is the fix — the copies cannot
 * disagree if there is only one.
 *
 * Behaviour is deliberately UNCHANGED from the prior enforcement condition. Do not add
 * an isFinite() or isSafeInteger() guard here to make it look safer: enforcement is the
 * ground truth that admission reports, and tightening it turns a malformed stored value
 * into unlimited spend. If a value should never reach the column, reject it at the write
 * path (org/service.ts already validates Number.isInteger) — not by teaching the enforcer
 * to ignore it.
 */
export function isEnforceableCap(cap: number | null | undefined): cap is number {
  return typeof cap === 'number' && cap > 0
}

/**
 * checkAndReserve — call BEFORE the model call.
 *
 * Reads the current window counters and, if under cap, atomically increments
 * the dispatch count by 1 (reserving the slot). Returns {ok:false} with a
 * reason + retryAfterSec when either cap is exceeded.
 *
 * The D1 UPSERT is a single round-trip: initialise-on-first-use + increment
 * are one statement, which minimises the window for the documented race.
 */
export async function checkAndReserve(
  env: Env,
  execution: AuthorizedExecution,
): Promise<MeterResult> {
  if (execution.tenant !== env.TENANT_SLUG) {
    throw new Error('authorized_execution_tenant_mismatch')
  }

  const windowKey = buildWindowKey(execution.tenant, execution.meterSubjectId)
  const now = new Date().toISOString()

  // Read current state before the increment to check caps. We read first so
  // we can block before spending the write round-trip budget.
  const existing = await env.DB.prepare(
    `SELECT count, tokens, cost_micro_usd FROM execution_meter WHERE window_key = ? LIMIT 1`,
  )
    .bind(windowKey)
    .first<{ count: number; tokens: number; cost_micro_usd: number }>()

  const currentCount = existing?.count ?? 0
  const currentTokens = existing?.tokens ?? 0
  const currentCost = existing?.cost_micro_usd ?? 0

  const maxDispatches = execution.maxDispatchDay
  const maxTokens = execution.maxTokensDay

  if (currentCount >= maxDispatches) {
    return {
      ok: false,
      reason: 'rate_limited',
      windowKey,
      count: currentCount,
      tokens: currentTokens,
      retryAfterSec: secondsUntilNextUtcMidnight(),
    }
  }

  if (currentTokens >= maxTokens) {
    return {
      ok: false,
      reason: 'budget_exhausted',
      windowKey,
      count: currentCount,
      tokens: currentTokens,
      retryAfterSec: secondsUntilNextUtcMidnight(),
    }
  }

  // ── Dollar cap (issue #4): enforcement-layer HARD stop, BEFORE any spend. ──
  // The estimate is a CONSERVATIVE upper bound (cost.ts over-estimates unknown models,
  // #15), so we never under-count. Block if already at/over the cap, or if the next
  // cycle could breach it. The cap may be REACHED but not EXCEEDED.
  const capMicroUsd = isEnforceableCap(execution.maxCostMicroUsd)
    ? execution.maxCostMicroUsd
    : null
  if (capMicroUsd !== null) {
    const estimate = execution.estimateMicroUsd
    // Enforce over the agent's budget_window: 'day' → today's cost row; 'week' →
    // trailing-7-day sum (so a weekly cap is not silently enforced as ~7 daily caps).
    const spanCost =
      execution.costWindow === 'week'
        ? await sumWeekCostMicroUsd(env, execution.tenant, execution.meterSubjectId)
        : currentCost
    if (spanCost >= capMicroUsd || spanCost + estimate > capMicroUsd) {
      return {
        ok: false,
        reason: 'budget_cap_exceeded',
        windowKey,
        count: currentCount,
        tokens: currentTokens,
        retryAfterSec: secondsUntilNextUtcMidnight(),
      }
    }
  }

  // Reserve the slot: UPSERT → create on first use or increment count.
  // Intentionally does NOT touch `tokens` here — recordTokens updates it post-cycle.
  await env.DB.prepare(
    `INSERT INTO execution_meter (id, window_key, count, tokens, window_start)
       VALUES (?, ?, 1, 0, ?)
       ON CONFLICT(window_key) DO UPDATE SET count = count + 1`,
  )
    .bind(crypto.randomUUID(), windowKey, now)
    .run()

  // Read back the post-increment state for the caller's telemetry.
  // We do a second read rather than rely on SQLite's returning clause
  // (not supported in D1 via the Workers API).
  const post = await env.DB.prepare(
    `SELECT count, tokens FROM execution_meter WHERE window_key = ? LIMIT 1`,
  )
    .bind(windowKey)
    .first<{ count: number; tokens: number }>()

  return {
    ok: true,
    windowKey,
    count: post?.count ?? currentCount + 1,
    tokens: post?.tokens ?? 0,
  }
}

/**
 * Public read-only meter status. Authorization is resolved before the first
 * execution_meter query, so denied callers cannot learn spend or counts.
 */
export async function getAuthorizedMeterStatus(
  env: Env,
  auth: AuthContext,
  agentId?: string,
): Promise<ToolOutcome> {
  const targetAgentId = agentId ?? auth.boundAgentId ?? null
  if (!targetAgentId) return { ok: false, status: 403, error: 'forbidden' }

  try {
    const decision = await authorizeExecutionScope(env, auth, {
      action: 'meter:read',
      agentId: targetAgentId,
    })
    if (!decision.ok) return decision
    if (!decision.agentId) return { ok: false, status: 503, error: 'service_unavailable' }

    const windowKey = buildWindowKey(decision.tenant, decision.agentId)
    const current = await env.DB.prepare(
      `SELECT count, tokens, cost_micro_usd
         FROM execution_meter
        WHERE window_key = ?1
        LIMIT 1`,
    ).bind(windowKey).first<{ count: number; tokens: number; cost_micro_usd: number }>()
    const weekCost = await sumWeekCostMicroUsd(env, decision.tenant, decision.agentId)

    return {
      ok: true,
      result: {
        agent_id: decision.agentId,
        squad_id: decision.squadId,
        window_key: windowKey,
        dispatches_day: current?.count ?? 0,
        tokens_day: current?.tokens ?? 0,
        cost_micro_usd_day: current?.cost_micro_usd ?? 0,
        cost_micro_usd_week: weekCost,
      },
    }
  } catch {
    return { ok: false, status: 503, error: 'service_unavailable' }
  }
}

/**
 * recordTokens — call AFTER the model call (best-effort; never blocks the result).
 *
 * Accumulates the tokens spent by the cycle into the window row, and (issue #15)
 * the dollar cost of those tokens in micro-USD. costMicroUsd defaults to 0 so
 * existing callers/tests that only track tokens keep working unchanged.
 *
 * If the window row does not exist (e.g., checkAndReserve was bypassed in tests),
 * creates it with count=0 so token + cost tracking still work.
 *
 * NOTE: this records spend — it does NOT enforce a dollar cap. The dollar GATE
 * (blocking on budget_cap_cents) is intentionally deferred and must land with its
 * own adversarial gate pass (see the module header). Tracking ≠ enforcing.
 */
export interface RecordTokensUsage {
  /** Total input tokens (cache-read + cache-miss combined), when known. */
  input?: number
  /** Output tokens, when known. */
  output?: number
  /** Cache-read tokens (the cheap half of the bill), when the provider reports them. */
  cacheRead?: number
  /** Cache-write tokens, when reported. */
  cacheWrite?: number
}

export async function recordTokens(
  env: Env,
  agentId: string,
  tokens: number,
  costMicroUsd = 0,
  usage?: RecordTokensUsage,
): Promise<void> {
  const tok = tokens > 0 ? tokens : 0
  const cost = costMicroUsd > 0 ? Math.round(costMicroUsd) : 0
  const cacheRead = usage?.cacheRead && usage.cacheRead > 0 ? Math.round(usage.cacheRead) : 0
  const cacheMiss =
    usage?.input && usage.input > 0
      ? Math.max(Math.round(usage.input) - cacheRead, 0)
      : 0
  const output = usage?.output && usage.output > 0 ? Math.round(usage.output) : 0
  if (tok === 0 && cost === 0 && cacheRead === 0 && output === 0) return
  const windowKey = buildWindowKey(env.TENANT_SLUG, agentId)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO execution_meter
       (id, window_key, count, tokens, cost_micro_usd, cache_read_tokens, cache_miss_tokens, output_tokens, window_start)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(window_key) DO UPDATE SET
         tokens = tokens + ?,
         cost_micro_usd = cost_micro_usd + ?,
         cache_read_tokens = cache_read_tokens + ?,
         cache_miss_tokens = cache_miss_tokens + ?,
         output_tokens = output_tokens + ?`,
  )
    .bind(
      crypto.randomUUID(), windowKey, tok, cost,
      cacheRead, cacheMiss, output, now,
      tok, cost, cacheRead, cacheMiss, output,
    )
    .run()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** '<tenant>:<agent_id>:<YYYY-MM-DD>' UTC. */
function buildWindowKey(tenant: string, agentId: string): string {
  return `${tenant}:${agentId}:${isoDateUtc(new Date())}`
}

/** YYYY-MM-DD (UTC) for a Date. */
function isoDateUtc(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Sum cost_micro_usd over the trailing 7 UTC days (today inclusive) for one agent.
 * Used for the 'week' budget_window. The per-day window rows share the fixed
 * '<tenant>:<agentId>:' prefix and a zero-padded ISO-date suffix, so a lexical
 * BETWEEN range over the date suffix selects exactly this agent's last-7-days rows
 * (ISO dates sort lexically across month/year boundaries).
 */
async function sumWeekCostMicroUsd(env: Env, tenant: string, agentId: string): Promise<number> {
  const today = new Date()
  const start = new Date(today)
  start.setUTCDate(start.getUTCDate() - 6)
  const lo = `${tenant}:${agentId}:${isoDateUtc(start)}`
  const hi = `${tenant}:${agentId}:${isoDateUtc(today)}`
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(cost_micro_usd), 0) AS c FROM execution_meter
       WHERE window_key >= ? AND window_key <= ?`,
  )
    .bind(lo, hi)
    .first<{ c: number }>()
  return row?.c ?? 0
}

/** Seconds until the next UTC midnight — how long until the window resets. */
function secondsUntilNextUtcMidnight(): number {
  const now = Date.now()
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  return Math.max(1, Math.floor((tomorrow.getTime() - now) / 1000))
}

/** Read a numeric cap from env (string var) or fall back to the default const. */
function parseCap(env: Env, varName: keyof Env, defaultVal: number): number {
  const raw = env[varName]
  if (typeof raw === 'string') {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return n
  }
  return defaultVal
}
