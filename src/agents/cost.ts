// mupot — cost model (issue #15: cost metering / the Burn gauge).
//
// Pure, side-effect-free functions that turn a token count into a dollar cost and
// a token-spend window into a burn rate ($/hr). No env, no Date.now() inside the
// math — callers pass `nowMs` so the functions are deterministic under test.
//
// ── What "cost" means here ─────────────────────────────────────────────────────
// We do NOT have real per-call usage yet (ModelPort.chat returns only text — see
// src/model/index.ts). execute.ts records the conservative EXECUTE_MAX_TOKENS
// bound per cycle. So the cost is an honest ORDER-OF-MAGNITUDE estimate: a blended
// per-model USD-per-1M-token rate × the token estimate. It is a burn signal for
// the operator, not an invoice. When the model port surfaces real input/output
// usage, only the token figure passed in needs to change — this table stays.
//
// ── Unit: micro-USD ────────────────────────────────────────────────────────────
// Cost is carried as micro-USD (millionths of a dollar), an integer. A single
// small Workers-AI call costs a fraction of a cent; integer cents would round to
// zero every cycle. micro-USD keeps sub-cent resolution while staying integer in
// D1. Because the rate is "USD per 1,000,000 tokens", tokens × rate is already in
// micro-USD — no extra scaling, and the arithmetic is exact for integer rates.
//
//   dollars = microUsd / 1_000_000
//   costMicroUsd(model, tokens) = round(tokens × rateUsdPerMillion(model))

// ── Blended per-model rates (USD per 1,000,000 tokens) ─────────────────────────
//
// Blended = a single rate standing in for mixed input/output, since we only carry
// one token figure. Conservative, current-generation estimates (early 2026). Keys
// match the model ids used in src/model/index.ts. Unknown models fall back to
// FALLBACK_RATE_USD_PER_M.
//
// These are deliberately easy to tune in one place and intentionally NOT read from
// per-tenant config — a tenant must not be able to understate its own burn gauge.
export const MODEL_RATE_USD_PER_M: Readonly<Record<string, number>> = {
  // Workers AI (the pot's own CF account — the default fallback model).
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 0.5,
  // Gateway providers (the wizard's connect-your-model choices).
  'claude-sonnet-4-5': 9.0,
  'gpt-4o-mini': 0.4,
  'gemini-2.5-flash': 0.3,
}

// Per-FAMILY ceiling rates (USD per 1M tokens) for model ids not in the exact
// table — e.g. a pinned/dated/vanity variant like 'claude-sonnet-4-5-20260101' or
// a premium 'claude-opus-…' the operator routes through their gateway. We price an
// unknown family member at that family's PREMIUM (most expensive) member, so the
// burn gauge can only ever over-state, never read low. Adversarial gate (#15):
// without this, an off-table premium model fell to the flat fallback and the gauge
// read ~30× low. Order matters only in that exact-id matches win first.
const FAMILY_CEILING_USD_PER_M: ReadonlyArray<readonly [prefix: string, rate: number]> = [
  ['claude-opus', 30.0],   // Opus-class blended ceiling
  ['claude-', 15.0],       // any other Claude (sonnet/haiku variants) ceiling
  ['gpt-4', 10.0],         // GPT-4-class ceiling
  ['gpt-', 5.0],           // any other GPT ceiling
  ['gemini-', 5.0],        // Gemini-class ceiling
]

// Conservative flat fallback for a model id matching NO family prefix. Set to a
// premium ceiling (not a cheap rate) so a wholly-unknown model over-estimates
// rather than under-estimates — the gauge never quietly reads low.
export const FALLBACK_RATE_USD_PER_M = 15.0

/**
 * Resolve the blended USD-per-1M-token rate for a model id.
 *
 * Precedence: exact table match → family-prefix ceiling → flat fallback. Unknown
 * ids resolve to a CEILING, never a floor, so burn cannot be understated by
 * naming a model the table does not list (adversarial gate finding, #15).
 */
export function rateUsdPerMillion(model: string | null | undefined): number {
  if (!model) return FALLBACK_RATE_USD_PER_M
  const exact = MODEL_RATE_USD_PER_M[model]
  if (exact !== undefined) return exact
  for (const [prefix, rate] of FAMILY_CEILING_USD_PER_M) {
    if (model.startsWith(prefix)) return rate
  }
  return FALLBACK_RATE_USD_PER_M
}

/**
 * costMicroUsd(model, tokens) — cost of `tokens` tokens on `model`, in micro-USD.
 *
 * tokens × (USD per 1M tokens) is already micro-USD. Rounded to an integer.
 * Non-positive or non-finite token counts cost 0.
 */
export function costMicroUsd(model: string | null | undefined, tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.round(tokens * rateUsdPerMillion(model))
}

/** micro-USD → dollars (number). */
export function microUsdToDollars(microUsd: number): number {
  if (!Number.isFinite(microUsd) || microUsd <= 0) return 0
  return microUsd / 1_000_000
}

/**
 * formatUsd(microUsd) — a compact dollar string.
 *
 * Sub-cent amounts show 4 dp ($0.0010) so a single small cycle is still visible;
 * a cent or more shows 2 dp ($1.23). Zero renders as "$0.00".
 */
export function formatUsd(microUsd: number): string {
  const d = microUsdToDollars(microUsd)
  if (d === 0) return '$0.00'
  if (d < 0.01) return `$${d.toFixed(4)}`
  return `$${d.toFixed(2)}`
}

// ── Burn rate ──────────────────────────────────────────────────────────────────
//
// The execution_meter window is per UTC calendar day, so today's spend divided by
// the hours elapsed since UTC midnight is the unit's current burn rate. Early in
// the day the denominator is small, which can make the rate look spiky — we clamp
// the elapsed time to a 1-minute floor so a fresh window never divides by ~zero.

/** Hours elapsed since the most recent UTC midnight, floored at 1 minute. */
export function hoursSinceUtcMidnight(nowMs: number): number {
  const d = new Date(nowMs)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  const elapsedMs = Math.max(nowMs - midnight, 60_000) // 1-minute floor
  return elapsedMs / 3_600_000
}

/**
 * burnUsdPerHour(spendTodayMicroUsd, nowMs) — current burn rate in dollars/hour.
 *
 * = (today's spend in dollars) / (hours elapsed since UTC midnight).
 */
export function burnUsdPerHour(spendTodayMicroUsd: number, nowMs: number): number {
  const dollars = microUsdToDollars(spendTodayMicroUsd)
  if (dollars === 0) return 0
  return dollars / hoursSinceUtcMidnight(nowMs)
}

/** "$X.XX/hr" — the Burn gauge string. Zero spend renders "$0.00/hr". */
export function formatBurn(spendTodayMicroUsd: number, nowMs: number): string {
  const perHr = burnUsdPerHour(spendTodayMicroUsd, nowMs)
  if (perHr === 0) return '$0.00/hr'
  if (perHr < 0.01) return `$${perHr.toFixed(4)}/hr`
  return `$${perHr.toFixed(2)}/hr`
}


// ── Cache-aware rates (DeepSeek V4) ───────────────────────────────────────────
//
// River verified these LIVE on 2026-08-14 (running deepseek-v4-pro); cross-checked
// against BenchLM's published DeepSeek API pricing (synced 2026-07-31):
//   v4-pro:   cache-hit $0.003625/M · miss $0.435/M · output $0.87/M
//   v4-flash: cache-hit $0.0028/M   · miss $0.14/M  · output $0.28/M
//
// Why the split matters: the previous blended rate (0.24/M, commit cd9be86) billed
// cache-hit tokens at the full input rate, overstating loop cost by ~100× and
// making the budget meter block early. DeepSeek's whole economics is the cache:
// at a 98% hit rate the EFFECTIVE input price is ~0.8% of the miss price.
//
// Aug 16 the vendor switches to peak/off-peak (off-peak = half peak; peak windows
// 01:00–04:00 and 06:00–10:00 UTC). The switch must be a CONFIG EDIT to the table
// below, not a code change — keep all rates in this ONE structure.
export interface DeepSeekRates {
  readonly cacheHitUsdPerMTok: number
  readonly cacheMissUsdPerMTok: number
  readonly outputUsdPerMTok: number
  readonly peakWindowsUtc?: ReadonlyArray<readonly [startHour: number, endHour: number]>
}

export const DEEPSEEK_RATES_USD_PER_M: Readonly<Record<string, DeepSeekRates>> = {
  'deepseek-v4-pro': {
    cacheHitUsdPerMTok: 0.003625,
    cacheMissUsdPerMTok: 0.435,
    outputUsdPerMTok: 0.87,
    // Peak/off-peak arrives 2026-08-16; off-peak = half peak. TODO: flip when live.
    peakWindowsUtc: [[1, 4], [6, 10]],
  },
  'deepseek-v4-flash': {
    cacheHitUsdPerMTok: 0.0028,
    cacheMissUsdPerMTok: 0.14,
    outputUsdPerMTok: 0.28,
    peakWindowsUtc: [[1, 4], [6, 10]],
  },
}

/**
 * costUsageMicroUsd(model, usage) — cost of a REAL usage record, cache-aware.
 *
 * Cache-hit tokens bill at the hit rate; cache-miss + non-cache input at the miss
 * rate; output at the output rate. Unknown models / missing usage → null (caller
 * decides: estimate or refuse — never invent).
 *
 * This is the function recordTokens/execute should use once ModelPort surfaces
 * real usage; it replaces the blended estimate for POST-call metering.
 */
export function costUsageMicroUsd(
  model: string | null | undefined,
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
): number | null {
  if (typeof model !== 'string') return null
  const rates = DEEPSEEK_RATES_USD_PER_M[model]
  if (!rates) return null // no split table → caller falls back to blended estimate

  const input = usage.input
  const output = usage.output
  const cacheRead = usage.cacheRead ?? 0
  const cacheMiss = Math.max(input - cacheRead, 0) // cacheWrite billed as miss when uncached
  if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return null

  const usd =
    cacheRead * (rates.cacheHitUsdPerMTok / 1_000_000) +
    cacheMiss * (rates.cacheMissUsdPerMTok / 1_000_000) +
    output * (rates.outputUsdPerMTok / 1_000_000)
  return Math.round(usd * 1_000_000) // dollars → micro-USD
}

/**
 * cacheHitRatio(cacheRead, cacheMiss) — rolling cache-hit ratio for telemetry.
 * 0 when there is nothing to measure; never NaN.
 */
export function cacheHitRatio(cacheRead: number, cacheMiss: number): number {
  const read = cacheRead > 0 ? cacheRead : 0
  const miss = cacheMiss > 0 ? cacheMiss : 0
  if (read + miss === 0) return 0
  return read / (read + miss)
}
