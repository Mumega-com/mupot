/**
 * Model price table — the ONLY place a token count becomes money.
 *
 * WHY THIS FILE EXISTS
 *
 * mupot recorded no real cost anywhere. `landControlFlight` (routines/actions.ts) hardcoded
 * cost_micro_usd: 0, routine_runs.cost_micro_usd is computed as SUM(flights.cost_micro_usd)
 * — so it summed zeroes — and meter.ts's recordTokens(), the only function that would have
 * accumulated a real figure, has zero callers. Meanwhile routines/dispatch.ts inserted the
 * CONSTANTS promptTokens=1250 / completionTokens=380 at dispatch time, before any work ran,
 * and dashboard/motherboard.ts rendered them as measured usage. See #896.
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
  'deepseek-v4-flash': {
    inputMicroUsdPerMTok: 0.24 * USD_PER_MTOK,
    outputMicroUsdPerMTok: 0.24 * USD_PER_MTOK,
    blended: true,
    source: 'commit cd9be86 (fleet roster change that provisioned Asha)',
  },
  // dashboard/economy.ts already prices Claude Code spend at these list rates.
  'claude-opus-4': {
    inputMicroUsdPerMTok: 15 * USD_PER_MTOK,
    outputMicroUsdPerMTok: 75 * USD_PER_MTOK,
    source: 'Anthropic list price, as already used in src/dashboard/economy.ts',
  },
  'claude-sonnet-4.6': {
    inputMicroUsdPerMTok: 3 * USD_PER_MTOK,
    outputMicroUsdPerMTok: 15 * USD_PER_MTOK,
    source: 'Anthropic list price, as already used in src/dashboard/economy.ts',
  },
}

export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

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
