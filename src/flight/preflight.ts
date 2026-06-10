// preflight — the flight go/no-go gate (Flight #60).
//
// Before an expensive flight (session) launches, a cheap check decides GO/NO-GO so
// zero expensive tokens burn on a flight that would wander or run cold. It is a
// READINESS score (0–1) + two hard checks, from signals the pot already has.
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
  // Soft signals + the two checks.
  recentProgress: number // 0..1 — recent useful progress (e.g. success rate)
  progressPerStep: number // 0..1 — expected useful progress per step
  wastePerStep: number // 0..1 — expected token-burn without progress per step
  stepSeconds: number // expected seconds per step (vs the cache window)
  // POT-OWNED history signals — measured from the flights table at dispatch
  // (dispatch.ts), NEVER parsed from the request body. The caller's optimism
  // cannot override the pot's own record of how this agent's flights end. This
  // is the trust-friction the architecture audit named as absent: an agent that
  // keeps crashing faces a rising bar on the pot's own runway. Absent (no
  // history yet) ⇒ neutral, not penalised.
  recentFailureRate?: number // 0..1 — failed / ended over the recent window
  endedFlightSample?: number // how many ended flights the rate is computed from
}

export interface PreflightOptions {
  scoreThreshold?: number // default 0.5
  cacheWindowSeconds?: number // default 300 (the ~5-min cache TTL)
  minProgressRatio?: number // default 1 (progress must at least equal waste)
  maxFailureRate?: number // default 0.5 — NO-GO above this (with enough sample)
  minFailureSample?: number // default 3 ended flights before the rate counts
}

export interface PreflightChecks {
  contextComplete: boolean
  toolsReachable: boolean
  budgetHeadroom: boolean
  progressBeatsWaste: boolean
  cacheStaysWarm: boolean
  agentReliable: boolean
}

export interface PreflightResult {
  go: boolean
  score: number // 0..1 readiness score (admission to launch — NOT the brain's C(t))
  checks: PreflightChecks
  reasons: string[] // why NO-GO (empty when go)
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const FLOOR = 1e-3 // keep factors > 0 so a single missing one tanks (not breaks) the score

// Combine the factors into one 0–1 readiness score via a weighted geometric mean:
// any critical factor near zero (no context, tools down) drags the whole score toward
// zero — fail-closed by construction, no factor can be "averaged away".
// The reliability factor from the pot's own flight history: 1 − failureRate, but only
// once the sample is big enough to mean anything. Below the sample bar it returns null
// and the factor is EXCLUDED from the mean entirely — a no-information factor must not
// dilute the others (a neutral 1 would lift tanked scores), and exclusion keeps every
// no-history score identical to the pre-friction gate.
function reliabilityFactor(s: FlightSignals, minSample: number): number | null {
  const sample = s.endedFlightSample ?? 0
  if (sample < minSample || s.recentFailureRate == null) return null
  return clamp01(1 - s.recentFailureRate)
}

export function readinessScore(s: FlightSignals, opts: PreflightOptions = {}): number {
  const window = opts.cacheWindowSeconds ?? 300
  const minSample = opts.minFailureSample ?? 3
  const factors: Array<{ v: number; w: number }> = [
    { v: s.contextComplete ? 1 : FLOOR, w: 2 },
    { v: s.toolsReachable ? 1 : FLOOR, w: 2 },
    { v: clamp01(s.budgetEstimateMicroUsd > 0 ? s.budgetRemainingMicroUsd / s.budgetEstimateMicroUsd : 1), w: 1 },
    { v: clamp01(s.progressPerStep / (s.progressPerStep + s.wastePerStep || 1)), w: 1.5 },
    { v: clamp01(s.recentProgress), w: 1 },
    { v: s.stepSeconds <= window ? 1 : clamp01(window / s.stepSeconds), w: 1 },
  ]
  const reliability = reliabilityFactor(s, minSample)
  if (reliability !== null) factors.push({ v: reliability, w: 1 })
  const wsum = factors.reduce((a, f) => a + f.w, 0)
  const lnsum = factors.reduce((a, f) => a + f.w * Math.log(Math.max(f.v, FLOOR)), 0)
  return clamp01(Math.exp(lnsum / wsum))
}

// The full gate: readiness score + the two checks + hard prerequisites.
export function preflightCheck(s: FlightSignals, opts: PreflightOptions = {}): PreflightResult {
  const scoreThreshold = opts.scoreThreshold ?? 0.5
  const cacheWindowSeconds = opts.cacheWindowSeconds ?? 300
  const minProgressRatio = opts.minProgressRatio ?? 1
  const maxFailureRate = opts.maxFailureRate ?? 0.5
  const minFailureSample = opts.minFailureSample ?? 3

  const checks: PreflightChecks = {
    contextComplete: s.contextComplete,
    toolsReachable: s.toolsReachable,
    budgetHeadroom: s.budgetRemainingMicroUsd >= s.budgetEstimateMicroUsd,
    // Check 1 — progress beats waste: else the flight wanders (busy, not closing).
    progressBeatsWaste: s.progressPerStep >= s.wastePerStep * minProgressRatio,
    // Check 2 — cache stays warm: each step must land inside the cache window, else
    // the next call ~doubles in cost.
    cacheStaysWarm: s.stepSeconds <= cacheWindowSeconds,
    // Check 3 — the agent's own record: with enough ended flights on the pot's books,
    // a failure rate past the bar grounds it (pot-measured; the caller can't vouch).
    agentReliable:
      (s.endedFlightSample ?? 0) < minFailureSample ||
      s.recentFailureRate == null ||
      s.recentFailureRate <= maxFailureRate,
  }

  const score = readinessScore(s, opts)
  const reasons: string[] = []
  if (!checks.contextComplete) reasons.push('context_incomplete')
  if (!checks.toolsReachable) reasons.push('tools_unreachable')
  if (!checks.budgetHeadroom) reasons.push('insufficient_budget')
  if (!checks.progressBeatsWaste) reasons.push('would_wander')
  if (!checks.cacheStaysWarm) reasons.push('cache_would_cool')
  if (!checks.agentReliable) reasons.push('agent_unreliable')
  if (score < scoreThreshold) reasons.push('low_readiness')

  return { go: reasons.length === 0, score, checks, reasons }
}
