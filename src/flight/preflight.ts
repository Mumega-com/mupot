// preflight — the flight go/no-go gate (Flight #60).
//
// Before an expensive flight (session) launches, a cheap check decides GO/NO-GO so
// zero expensive tokens burn on a flight that would wander or run cold. It is a
// coherence score (0–1) + two hard checks, from signals the pot already has. Plain
// numbers, no new machinery. See docs/flight-operations.md → "The control law".

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
}

export interface PreflightOptions {
  scoreThreshold?: number // default 0.5
  cacheWindowSeconds?: number // default 300 (the ~5-min cache TTL)
  minProgressRatio?: number // default 1 (progress must at least equal waste)
}

export interface PreflightChecks {
  contextComplete: boolean
  toolsReachable: boolean
  budgetHeadroom: boolean
  progressBeatsWaste: boolean
  cacheStaysWarm: boolean
}

export interface PreflightResult {
  go: boolean
  score: number // 0..1 coherence score
  checks: PreflightChecks
  reasons: string[] // why NO-GO (empty when go)
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const FLOOR = 1e-3 // keep factors > 0 so a single missing one tanks (not breaks) the score

// Combine the factors into one 0–1 coherence score via a weighted geometric mean:
// any critical factor near zero (no context, tools down) drags the whole score toward
// zero — fail-closed by construction, no factor can be "averaged away".
export function coherenceScore(s: FlightSignals, opts: PreflightOptions = {}): number {
  const window = opts.cacheWindowSeconds ?? 300
  const factors: Array<{ v: number; w: number }> = [
    { v: s.contextComplete ? 1 : FLOOR, w: 2 },
    { v: s.toolsReachable ? 1 : FLOOR, w: 2 },
    { v: clamp01(s.budgetEstimateMicroUsd > 0 ? s.budgetRemainingMicroUsd / s.budgetEstimateMicroUsd : 1), w: 1 },
    { v: clamp01(s.progressPerStep / (s.progressPerStep + s.wastePerStep || 1)), w: 1.5 },
    { v: clamp01(s.recentProgress), w: 1 },
    { v: s.stepSeconds <= window ? 1 : clamp01(window / s.stepSeconds), w: 1 },
  ]
  const wsum = factors.reduce((a, f) => a + f.w, 0)
  const lnsum = factors.reduce((a, f) => a + f.w * Math.log(Math.max(f.v, FLOOR)), 0)
  return clamp01(Math.exp(lnsum / wsum))
}

// The full gate: coherence score + the two checks + hard prerequisites.
export function preflightCheck(s: FlightSignals, opts: PreflightOptions = {}): PreflightResult {
  const scoreThreshold = opts.scoreThreshold ?? 0.5
  const cacheWindowSeconds = opts.cacheWindowSeconds ?? 300
  const minProgressRatio = opts.minProgressRatio ?? 1

  const checks: PreflightChecks = {
    contextComplete: s.contextComplete,
    toolsReachable: s.toolsReachable,
    budgetHeadroom: s.budgetRemainingMicroUsd >= s.budgetEstimateMicroUsd,
    // Check 1 — progress beats waste: else the flight wanders (busy, not closing).
    progressBeatsWaste: s.progressPerStep >= s.wastePerStep * minProgressRatio,
    // Check 2 — cache stays warm: each step must land inside the cache window, else
    // the next call ~doubles in cost.
    cacheStaysWarm: s.stepSeconds <= cacheWindowSeconds,
  }

  const score = coherenceScore(s, opts)
  const reasons: string[] = []
  if (!checks.contextComplete) reasons.push('context_incomplete')
  if (!checks.toolsReachable) reasons.push('tools_unreachable')
  if (!checks.budgetHeadroom) reasons.push('insufficient_budget')
  if (!checks.progressBeatsWaste) reasons.push('would_wander')
  if (!checks.cacheStaysWarm) reasons.push('cache_would_cool')
  if (score < scoreThreshold) reasons.push('low_coherence')

  return { go: reasons.length === 0, score, checks, reasons }
}
