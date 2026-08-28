// preflight — the flight go/no-go gate (Flight #60 / FLIGHT-10 / Issue #1234).
//
// Before an expensive flight (session) launches, a cheap check decides GO/NO-GO so
// zero expensive tokens burn on a flight that would wander, run cold, or exhaust context.
// It is a READINESS score (0–1) + hard checks (tools, budget, context headroom <70%, token margins).
//
// NOTE on vocabulary (coherence with the brain): this is READINESS — admission to
// launch — NOT coherence. "Coherence" is the brain's organ: C(t) = EMA(success-
// fraction), R = 1/(1+backlog), ARF = R·Psi·C, regime (SOS/sovereign/coherence.py).
// The brain owns coherence + whether-to-fly (chaos/stall+ARF = fly; flow+ARF≈0 = rest).
// The pot owns readiness + the flight record. One vocabulary, two layers — don't
// conflate them. See docs/flight-operations.md → "Relation to the brain".

export interface FlightSignals {
  // Hard prerequisites.
  contextComplete: boolean // goal/KPI/owner + plan + data all loaded
  toolsReachable: boolean // every tool/MCP the flight needs answers
  budgetRemainingMicroUsd: number // budget left in the window
  budgetEstimateMicroUsd: number // estimated cost of the whole flight
  // Soft signals + the checks.
  recentProgress: number // 0..1 — recent useful progress (e.g. success rate)
  progressPerStep: number // 0..1 — expected useful progress per step
  wastePerStep: number // 0..1 — expected token-burn without progress per step
  stepSeconds: number // expected seconds per step (vs the cache window)
  // Context & token margin telemetry (FLIGHT-10 / Issue #880 / #1234)
  contextPercent?: number // 0..100 — current agent context usage percentage
  tokenRemaining?: number // remaining tokens in plan/window
  tokenEstimate?: number // estimated token requirement for the flight
}

export interface PreflightOptions {
  scoreThreshold?: number // default 0.5
  cacheWindowSeconds?: number // default 300 (the ~5-min cache TTL)
  minProgressRatio?: number // default 1 (progress must at least equal waste)
  maxContextPercent?: number // default 70 (Hadi directive: reject at >70% to avoid context rot)
}

export interface PreflightChecks {
  contextComplete: boolean
  toolsReachable: boolean
  budgetHeadroom: boolean
  progressBeatsWaste: boolean
  cacheStaysWarm: boolean
  contextHeadroom: boolean // true if contextPercent <= maxContextPercent (default 70%)
  tokenMarginSufficient: boolean // true if tokenRemaining >= tokenEstimate
}

export interface PreflightResult {
  go: boolean
  score: number // 0..1 readiness score (admission to launch — NOT the brain's C(t))
  checks: PreflightChecks
  reasons: string[] // why NO-GO (empty when go)
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const FLOOR = 1e-3 // keep factors > 0 so a single missing one tanks (not breaks) the score

export const DEFAULT_MAX_CONTEXT_PERCENT = 70

// Combine the factors into one 0–1 readiness score via a weighted geometric mean:
// any critical factor near zero (no context, tools down, bloated context) drags the whole score toward
// zero — fail-closed by construction, no factor can be "averaged away".
export function readinessScore(s: FlightSignals, opts: PreflightOptions = {}): number {
  const window = opts.cacheWindowSeconds ?? 300
  const maxCtx = opts.maxContextPercent ?? DEFAULT_MAX_CONTEXT_PERCENT

  const factors: Array<{ v: number; w: number }> = [
    { v: s.contextComplete ? 1 : FLOOR, w: 2 },
    { v: s.toolsReachable ? 1 : FLOOR, w: 2 },
    { v: clamp01(s.budgetEstimateMicroUsd > 0 ? s.budgetRemainingMicroUsd / s.budgetEstimateMicroUsd : 1), w: 1 },
    { v: clamp01(s.progressPerStep / (s.progressPerStep + s.wastePerStep || 1)), w: 1.5 },
    { v: clamp01(s.recentProgress), w: 1 },
    { v: s.stepSeconds <= window ? 1 : clamp01(window / s.stepSeconds), w: 1 },
  ]

  if (typeof s.contextPercent === 'number') {
    const contextHeadroomFactor =
      s.contextPercent <= maxCtx
        ? 1
        : clamp01((100 - s.contextPercent) / (100 - maxCtx))
    factors.push({ v: contextHeadroomFactor, w: 1.5 })
  }

  if (typeof s.tokenRemaining === 'number' && typeof s.tokenEstimate === 'number' && s.tokenEstimate > 0) {
    const tokenMarginFactor = clamp01(s.tokenRemaining / s.tokenEstimate)
    factors.push({ v: tokenMarginFactor, w: 1 })
  }

  const wsum = factors.reduce((a, f) => a + f.w, 0)
  const lnsum = factors.reduce((a, f) => a + f.w * Math.log(Math.max(f.v, FLOOR)), 0)
  return clamp01(Math.exp(lnsum / wsum))
}

// The full gate: readiness score + hard checks (context headroom, token margin, budget, tools).
export function preflightCheck(s: FlightSignals, opts: PreflightOptions = {}): PreflightResult {
  const scoreThreshold = opts.scoreThreshold ?? 0.5
  const cacheWindowSeconds = opts.cacheWindowSeconds ?? 300
  const minProgressRatio = opts.minProgressRatio ?? 1
  const maxContextPercent = opts.maxContextPercent ?? DEFAULT_MAX_CONTEXT_PERCENT

  const contextHeadroom = typeof s.contextPercent === 'number' ? s.contextPercent <= maxContextPercent : true
  const tokenMarginSufficient =
    typeof s.tokenRemaining === 'number' && typeof s.tokenEstimate === 'number'
      ? s.tokenRemaining >= s.tokenEstimate
      : true

  const checks: PreflightChecks = {
    contextComplete: s.contextComplete,
    toolsReachable: s.toolsReachable,
    budgetHeadroom: s.budgetRemainingMicroUsd >= s.budgetEstimateMicroUsd,
    // Check 1 — progress beats waste: else the flight wanders (busy, not closing).
    progressBeatsWaste: s.progressPerStep >= s.wastePerStep * minProgressRatio,
    // Check 2 — cache stays warm: each step must land inside the cache window, else
    // the next call ~doubles in cost.
    cacheStaysWarm: s.stepSeconds <= cacheWindowSeconds,
    // Check 3 — context headroom (FLIGHT-10): reject at >70% context load to prevent context rot.
    contextHeadroom,
    // Check 4 — token margin (FLIGHT-10): verify sufficient tokens remain before takeoff.
    tokenMarginSufficient,
  }

  const score = readinessScore(s, opts)
  const reasons: string[] = []
  if (!checks.contextComplete) reasons.push('context_incomplete')
  if (!checks.toolsReachable) reasons.push('tools_unreachable')
  if (!checks.budgetHeadroom) reasons.push('insufficient_budget')
  if (!checks.progressBeatsWaste) reasons.push('would_wander')
  if (!checks.cacheStaysWarm) reasons.push('cache_would_cool')
  if (!checks.contextHeadroom) reasons.push('context_exceeds_headroom_limit')
  if (!checks.tokenMarginSufficient) reasons.push('insufficient_token_margin')
  if (score < scoreThreshold) reasons.push('low_readiness')

  return { go: reasons.length === 0, score, checks, reasons }
}
