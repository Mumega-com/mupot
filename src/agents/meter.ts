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
// Cap sources (precedence: env var → default const):
//   dispatch count : env.EXEC_MAX_DISPATCH_DAY ?? MAX_DISPATCHES_PER_DAY (200)
//   token spend    : env.EXEC_MAX_TOKENS_DAY   ?? MAX_TOKENS_PER_DAY     (200_000)
//   dollar budget  : agents.budget_cap_cents (from migration 0009) — read
//                    defensively; column may be absent on older rows.
//
// The dollar cap is intentionally NOT implemented here — issue #25 (budget_cap_cents
// schema) landed in 0009 but the billing/cost-tracking layer is not wired yet.
// A future sprint wires cost → recordTokens and unlocks the dollar gate. Until then
// only count + token caps are enforced. Do NOT add billing logic here without a
// matching adversarial gate pass.

import type { Env } from '../types'

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
  reason: 'rate_limited' | 'budget_exhausted'
  windowKey: string
  count: number
  tokens: number
  retryAfterSec: number // seconds until the next UTC midnight (window reset)
}

export type MeterResult = MeterCheckResult | MeterBlockResult

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
  agentId: string,
): Promise<MeterResult> {
  const windowKey = buildWindowKey(env.TENANT_SLUG, agentId)
  const now = new Date().toISOString()

  // Read current state before the increment to check caps. We read first so
  // we can block before spending the write round-trip budget.
  const existing = await env.DB.prepare(
    `SELECT count, tokens FROM execution_meter WHERE window_key = ? LIMIT 1`,
  )
    .bind(windowKey)
    .first<{ count: number; tokens: number }>()

  const currentCount = existing?.count ?? 0
  const currentTokens = existing?.tokens ?? 0

  const maxDispatches = parseCap(env, 'EXEC_MAX_DISPATCH_DAY', MAX_DISPATCHES_PER_DAY)
  const maxTokens = parseCap(env, 'EXEC_MAX_TOKENS_DAY', MAX_TOKENS_PER_DAY)

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
export async function recordTokens(
  env: Env,
  agentId: string,
  tokens: number,
  costMicroUsd = 0,
): Promise<void> {
  const tok = tokens > 0 ? tokens : 0
  const cost = costMicroUsd > 0 ? Math.round(costMicroUsd) : 0
  if (tok === 0 && cost === 0) return
  const windowKey = buildWindowKey(env.TENANT_SLUG, agentId)
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO execution_meter (id, window_key, count, tokens, cost_micro_usd, window_start)
       VALUES (?, ?, 0, ?, ?, ?)
       ON CONFLICT(window_key) DO UPDATE SET
         tokens = tokens + ?,
         cost_micro_usd = cost_micro_usd + ?`,
  )
    .bind(crypto.randomUUID(), windowKey, tok, cost, now, tok, cost)
    .run()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** '<tenant>:<agent_id>:<YYYY-MM-DD>' UTC. */
function buildWindowKey(tenant: string, agentId: string): string {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${tenant}:${agentId}:${y}-${m}-${day}`
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
