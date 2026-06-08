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
//   dollar budget  : agents.budget_cap_cents (from migration 0009), passed by the
//                    caller as ReserveOpts.budgetCapCents; enforced over the
//                    agent's budget_window ('day' → today's cost row; 'week' →
//                    trailing-7-day sum of cost_micro_usd). null/≤0 ⇒ unlimited.
//
// The dollar cap (issue #4) IS enforced here as an ENFORCEMENT-LAYER pre-call gate:
// checkAndReserve blocks BEFORE any model spend once the window's recorded
// cost_micro_usd plus a conservative estimate would breach the cap. The cap may be
// REACHED but not EXCEEDED. This is a sensitive surface (eligibility/veto) — do NOT
// change the cap logic without a matching adversarial gate pass.

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
 * Options for the dollar-cap enforcement (issue #4). Both are supplied by the
 * trusted caller from the already-loaded agent row:
 *   estimateMicroUsd — a CONSERVATIVE upper bound on this cycle's spend (cost.ts).
 *   budgetCapCents   — agents.budget_cap_cents; null/≤0 ⇒ no dollar cap (unlimited).
 * Omitting opts entirely preserves the pre-#4 behaviour (count + token caps only).
 */
export interface ReserveOpts {
  estimateMicroUsd?: number
  /** Dollar cap in CENTS (agents.budget_cap_cents). Converted to micro-USD internally. */
  budgetCapCents?: number | null
  /**
   * Dollar cap in MICRO-USD, taken VERBATIM (no lossy cents rounding). Preferred when
   * the caller already has a micro-USD cap (the Loop manifest). When both are given,
   * this wins. A positive value here can never collapse to "unlimited".
   */
  budgetCapMicroUsd?: number | null
  /** agents.budget_window — the span the dollar cap covers. Default 'day'. */
  budgetWindow?: 'day' | 'week'
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
  agentId: string,
  opts: ReserveOpts = {},
): Promise<MeterResult> {
  const windowKey = buildWindowKey(env.TENANT_SLUG, agentId)
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

  // ── Dollar cap (issue #4): enforcement-layer HARD stop, BEFORE any spend. ──
  // The estimate is a CONSERVATIVE upper bound (cost.ts over-estimates unknown models,
  // #15), so we never under-count. Block if already at/over the cap, or if the next
  // cycle could breach it. The cap may be REACHED but not EXCEEDED.
  // Resolve the cap to micro-USD. A verbatim micro cap (the Loop manifest) is used as
  // given — never rounded — so an intentful sub-cent cap can never collapse to unlimited.
  // Otherwise fall back to the cents cap (agents.budget_cap_cents).
  const capMicroUsd =
    typeof opts.budgetCapMicroUsd === 'number' && opts.budgetCapMicroUsd > 0
      ? opts.budgetCapMicroUsd
      : typeof opts.budgetCapCents === 'number' && opts.budgetCapCents > 0
        ? opts.budgetCapCents * MICRO_USD_PER_CENT
        : null
  if (capMicroUsd !== null) {
    const estimate =
      opts.estimateMicroUsd && opts.estimateMicroUsd > 0 ? Math.round(opts.estimateMicroUsd) : 0
    // Enforce over the agent's budget_window: 'day' → today's cost row; 'week' →
    // trailing-7-day sum (so a weekly cap is not silently enforced as ~7 daily caps).
    const spanCost =
      opts.budgetWindow === 'week'
        ? await sumWeekCostMicroUsd(env, env.TENANT_SLUG, agentId)
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
