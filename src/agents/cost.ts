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
