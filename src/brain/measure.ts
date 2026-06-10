// brain/measure — the pot's MINIMAL coherence measure (the hybrid fallback, v0.20).
//
// The real coherence organ is the mind (SOS/sovereign coherence.py): C(t), R, Psi,
// ARF, the full regime physics. This module is the pot's deliberately small local
// approximation so a pot with NO connected mind still closes the measure→correct loop:
//
//   C        = EMA of the success fraction over the agent's recent ended flights
//              (same definition the brain docs give for C(t), seeded neutral at 0.5)
//   R        = 1/(1+backlog) — backlog relief from the agent's open tasks
//   regime   = flow | chaos | stall  (coercion needs Psi, which only the mind has —
//              the fallback NEVER claims it)
//   defect   = regime !== flow  (chaos: the work keeps failing; stall: work exists
//              but nothing has moved)
//
// Rules of the hybrid: this measure only runs when the mind is asleep (no fresh
// 'mind' push — see brain/fallback.ts), writes are provenance-marked
// (agent_field.source='pot_fallback') and never overwrite a fresh mind row. If you
// extend this file toward the full physics, you are forking the brain — don't; wire
// the mind instead. All pure; the tick in fallback.ts does the I/O.

export const EMA_ALPHA = 0.3 // recency weight: ~last 5–6 flights dominate
export const EMA_SEED = 0.5 // neutral prior before any evidence
export const CHAOS_BELOW_C = 0.4 // C under this (with sample) = the work keeps failing
export const CHAOS_MIN_SAMPLE = 3 // ended flights before chaos can be claimed
export const STALL_AFTER_MS = 24 * 60 * 60 * 1000 // backlog untouched this long = stall

export type FallbackRegime = 'flow' | 'chaos' | 'stall'

export interface OutcomeSample {
  status: 'landed' | 'failed'
}

/** C — EMA of success fraction over ended flights, OLDEST→NEWEST. Pure. */
export function coherenceFromOutcomes(
  outcomes: OutcomeSample[],
  alpha = EMA_ALPHA,
  seed = EMA_SEED,
): number {
  let c = seed
  for (const o of outcomes) c = alpha * (o.status === 'landed' ? 1 : 0) + (1 - alpha) * c
  return c
}

/** R — backlog relief, 1/(1+open tasks). Pure. */
export function backlogRelief(openTasks: number): number {
  return 1 / (1 + Math.max(0, openTasks))
}

export interface ClassifyInput {
  coherence: number // C from coherenceFromOutcomes
  endedSample: number // how many ended flights C was computed from
  backlog: number // open/in_progress/blocked tasks assigned to the agent
  lastActivityAt: number | null // newest task update or flight end (Unix ms), null = never
  nowMs: number
  stallAfterMs?: number
}

export interface AgentReading {
  regime: FallbackRegime
  defect: boolean
  reason: string | null // why the defect (feeds the flight goal + the skip log)
}

/**
 * Classify the agent's regime from the pot's own books. Defect precedence: chaos
 * (the work keeps FAILING — more alarming than not moving) over stall over flow.
 */
export function classifyRegime(i: ClassifyInput): AgentReading {
  const stallAfter = i.stallAfterMs ?? STALL_AFTER_MS
  if (i.endedSample >= CHAOS_MIN_SAMPLE && i.coherence < CHAOS_BELOW_C) {
    return { regime: 'chaos', defect: true, reason: 'work_keeps_failing' }
  }
  const idle = i.lastActivityAt == null || i.nowMs - i.lastActivityAt > stallAfter
  if (i.backlog > 0 && idle) {
    return { regime: 'stall', defect: true, reason: 'backlog_untouched' }
  }
  return { regime: 'flow', defect: false, reason: null }
}
