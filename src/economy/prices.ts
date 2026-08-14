import type { TokenUsage } from '../types'
/**
 * Model price table — the ONLY place a token count becomes money.
 *
 * WHY THIS FILE EXISTS
 *
 * The ROUTINE FLIGHT PATH recorded no real cost. `landControlFlight` (routines/actions.ts)
 * hardcoded cost_micro_usd: 0, and routine_runs.cost_micro_usd is computed as
 * SUM(flights.cost_micro_usd) — so it summed zeroes. Meanwhile routines/dispatch.ts inserted
 * the CONSTANTS promptTokens=1250 / completionTokens=380 at dispatch time, before any work
 * ran, and dashboard/motherboard.ts rendered them as measured usage. See #896.
 *
 * Scope correction (Athena, gating this PR): meter.ts's recordTokens() is NOT uncalled — the
 * agent-execute path uses it live via recordTokensSafe (agents/execute.ts:290, :301), covered
 * by tests/execution-meter.test.ts. An earlier draft of this header claimed "zero callers",
 * which came from grepping `recordTokens(` and missing the call sites that pass it as a value.
 * The accurate and sufficient statement is the one above: the ROUTINE path never reaches it.
 *
 * RULES, both learned from that failure:
 *
 *  1. An unknown model returns null. NEVER a default rate. A guessed price is the same
 *     failure class as a guessed token count — it looks like data and is not.
 *  2. Rates are cited. Every entry names where the number came from. A rate nobody can
 *     trace is a rate nobody can correct.
 */

export interface ModelPrice {
  /** micro-USD per million input tokens. */
  readonly inputMicroUsdPerMTok: number
  /** micro-USD per million output tokens. */
  readonly outputMicroUsdPerMTok: number
  /** micro-USD per million cache-read tokens. Omitted = billed as input. */
  readonly cacheReadMicroUsdPerMTok?: number
  /** micro-USD per million cache-write tokens. Omitted = billed as input. */
  readonly cacheWriteMicroUsdPerMTok?: number
  /**
   * True when the source figure is a single blended rate rather than split input/output.
   * Recorded rather than hidden: applying a blended rate through a split-rate code path
   * silently overstates output and understates input, and the reader deserves to know.
   */
  readonly blended?: boolean
  /** Where the number came from. Required. */
  readonly source: string
}

const USD_PER_MTOK = 1_000_000 // micro-USD in one USD

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  // Commit cd9be86, "retire tech-grok and replace with Asha Tech Worker (DeepSeek v4 @
  // $0.24/M tokens)". A single blended figure — the team recorded one number, not a split.
  // DeepSeek V4 split rates — verified LIVE by River 2026-08-14 (running
  // deepseek-v4-pro) and cross-checked against BenchLM published pricing (synced
  // 2026-07-31): cache-hit input falls to $0.003625 (pro) / $0.0028 (flash).
  // Aug 16 the vendor moves to peak/off-peak (off-peak = half peak; peak windows
  // 01:00-04:00 + 06:00-10:00 UTC) — flip this table then; it is the ONE home.
  // The old blended 0.24/M (commit cd9be86) billed cache hits at full input rate,
  // overstating loop cost ~100x and making the budget meter block early.
  'deepseek-v4-flash': {
    inputMicroUsdPerMTok: 0.14 * USD_PER_MTOK,
    outputMicroUsdPerMTok: 0.28 * USD_PER_MTOK,
    cacheReadMicroUsdPerMTok: 0.0028 * USD_PER_MTOK,
    source: 'River live verify 2026-08-14 + BenchLM DeepSeek API pricing (synced 2026-07-31)',
  },
  'deepseek-v4-pro': {
    inputMicroUsdPerMTok: 0.435 * USD_PER_MTOK,
    outputMicroUsdPerMTok: 0.87 * USD_PER_MTOK,
    cacheReadMicroUsdPerMTok: 0.003625 * USD_PER_MTOK,
    source: 'River live verify 2026-08-14 + BenchLM DeepSeek API pricing (synced 2026-07-31)',
  },
  // src/dashboard/economy.ts:248 states these rates in its footer ("priced at Anthropic
  // list rates (Opus $15/$75 per MTok in/out)") — a display string, not a rate map. This
  // file is the first machine-readable copy; economy.ts is corroboration, not the source.
  'claude-opus-4': {
    inputMicroUsdPerMTok: 15 * USD_PER_MTOK,
    outputMicroUsdPerMTok: 75 * USD_PER_MTOK,
    source: 'Anthropic list price; corroborated by the footer at src/dashboard/economy.ts:248',
  },
  // NOT corroborated anywhere in this repo — economy.ts names Opus rates only, and $3/$15
  // appears nowhere else. Recorded as an external claim so the next reader can challenge it
  // rather than inherit it. Confirm against a bill before trusting a sonnet-priced total.
  'claude-sonnet-4.6': {
    inputMicroUsdPerMTok: 3 * USD_PER_MTOK,
    outputMicroUsdPerMTok: 15 * USD_PER_MTOK,
    source: 'Anthropic public list price (UNCORROBORATED in-repo — verify before relying on it)',
  },
}

// TokenUsage now lives in src/types.ts (the shared contract) — imported below.

/**
 * Price one usage record. Returns null for an unknown model or a negative/non-finite count —
 * the caller must treat null as "not priceable" and record nothing, never zero.
 *
 * Zero is a legitimate PRICE (a free model, or a genuinely empty turn). It is not a
 * legitimate stand-in for "we could not work it out" — conflating those is precisely how
 * cost_micro_usd:0 came to mean four different things at once.
 */
export function priceUsage(model: string | null | undefined, usage: TokenUsage): number | null {
  if (typeof model !== 'string') return null
  const price = MODEL_PRICES[model]
  if (!price) return null

  const counts = [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0]
  if (counts.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return null

  const cacheReadRate = price.cacheReadMicroUsdPerMTok ?? price.inputMicroUsdPerMTok
  const cacheWriteRate = price.cacheWriteMicroUsdPerMTok ?? price.inputMicroUsdPerMTok

  const total =
    (usage.input * price.inputMicroUsdPerMTok
      + usage.output * price.outputMicroUsdPerMTok
      + (usage.cacheRead ?? 0) * cacheReadRate
      + (usage.cacheWrite ?? 0) * cacheWriteRate) / 1_000_000

  return Math.round(total)
}
