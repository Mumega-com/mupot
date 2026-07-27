// mupot — Owner-experience unified surface contract (pure).
//
// Design: docs/superpowers/specs/2026-07-27-owner-experience-unified-surface-design.md
// Machine contract: docs/owner-experience-v1.json
//
// Design/spec commit only — no HTTP route, no D1 migration, no UI.
// Locks: owner owns goal+gate, honest receipts-by-id, earned autonomy,
// no fake-green progress, Talk v1 = Tier-1 only, instinct Adapt blocked
// until Port-4 is an explicit prerequisite.

import type { Autonomy } from '../types'
import { isAutonomy } from '../types'

/** Facets of the single owner relationship (not three apps). */
export const OWNER_EXPERIENCE_FACETS = ['talk', 'know', 'watch'] as const

export type OwnerExperienceFacet = (typeof OWNER_EXPERIENCE_FACETS)[number]

/** Closed loop the mubot drives; owner holds goal + gate. */
export const OWNER_EXPERIENCE_LOOP = [
  'goal',
  'sense',
  'rank',
  'act',
  'receipt',
  'learn',
  'adapt',
  'gate',
] as const

export type OwnerExperienceLoopStep = (typeof OWNER_EXPERIENCE_LOOP)[number]

export const OWNER_EXPERIENCE_PRINCIPLES = [
  'one-face',
  'goals-not-tasks',
  'honest-by-construction',
  'earned-autonomy',
  'visible-learning',
  'owner-owns-goals-and-gates',
] as const

/** Autonomy ladder used as earned-trust levels (no parallel enum). */
export const OWNER_TRUST_LADDER: readonly Autonomy[] = [
  'suggest',
  'draft',
  'execute_with_approval',
  'execute',
]

export const DEFAULT_REQUIRED_WINS_PER_WIDEN = 3

export type TalkRuntimeKind = 'tier1_persistent_mubot' | 'tier2_stateless_user_chat'

export type WinVerification = 'resolved_by_id' | 'unverified_label'

export interface VerifiedWinRef {
  receiptId: string
  verification: WinVerification
}

export interface EarnedAutonomyWidenInput {
  current: Autonomy
  proposed: Autonomy
  actingPrincipalKind: 'owner_or_admin_human' | 'mubot_or_agent' | 'other'
  wins: readonly VerifiedWinRef[]
  requiredWins: number
}

export type EarnedAutonomyWidenDecision =
  | { ok: true; from: Autonomy; to: Autonomy; verifiedWinCount: number }
  | {
      ok: false
      reason:
        | 'mubot_cannot_self_widen'
        | 'invalid_autonomy'
        | 'skip_not_allowed'
        | 'not_a_widen'
        | 'insufficient_verified_wins'
        | 'unverified_win_label'
        | 'required_wins_invalid'
    }

export type ProgressDisplay =
  | { kind: 'measured'; value: number; target: number; ratio: number }
  | { kind: 'unmeasured' }
  | { kind: 'unavailable'; reason: string }

export interface OutcomeMetricSpec {
  sourceId: string
  target: number
}

export interface LessonDraft {
  receiptId: string
  polarity: 'win' | 'miss'
  summary: string
  sourceSchema: string
}

export type LessonValidation =
  | { ok: true; lesson: LessonDraft }
  | {
      ok: false
      reason: 'receipt_id_required' | 'summary_required' | 'source_schema_required' | 'polarity_invalid'
    }

export type InstinctAdaptEligibility =
  | { ok: true }
  | {
      ok: false
      reason: 'port4_not_live' | 'learning_ranker_not_passed' | 'prerequisite_missing'
    }

/** Mubot may propose wording; it may never write the Outcome. */
export function mayMubotRedefineGoal(): boolean {
  return false
}

/** Risky / irreversible acts wait for the owner — mubot never self-verdicts. */
export function mayMubotSelfVerdictGate(): boolean {
  return false
}

/** Talk facet v1 is Tier-1 only while Tier-2 remains dyad-gate blocked. */
export function isTalkV1Runtime(kind: TalkRuntimeKind): boolean {
  return kind === 'tier1_persistent_mubot'
}

export function assertTalkV1Runtime(kind: TalkRuntimeKind): void {
  if (!isTalkV1Runtime(kind)) {
    throw new Error('owner_experience_talk_v1_tier1_only')
  }
}

export function trustLevelForAutonomy(autonomy: Autonomy): number {
  const idx = OWNER_TRUST_LADDER.indexOf(autonomy)
  if (idx < 0) throw new Error('owner_experience_unknown_autonomy')
  return idx
}

export function autonomyForTrustLevel(level: number): Autonomy {
  if (!Number.isInteger(level) || level < 0 || level >= OWNER_TRUST_LADDER.length) {
    throw new Error('owner_experience_trust_level_out_of_range')
  }
  return OWNER_TRUST_LADDER[level] as Autonomy
}

/**
 * One-step earned widen. Wins must be resolved_by_id (not free-string labels).
 * Decider must be an owner/admin human — never the mubot.
 */
export function decideEarnedAutonomyWiden(
  input: EarnedAutonomyWidenInput,
): EarnedAutonomyWidenDecision {
  if (input.actingPrincipalKind !== 'owner_or_admin_human') {
    return { ok: false, reason: 'mubot_cannot_self_widen' }
  }
  if (!isAutonomy(input.current) || !isAutonomy(input.proposed)) {
    return { ok: false, reason: 'invalid_autonomy' }
  }
  if (!Number.isInteger(input.requiredWins) || input.requiredWins < 1) {
    return { ok: false, reason: 'required_wins_invalid' }
  }

  const fromLevel = trustLevelForAutonomy(input.current)
  const toLevel = trustLevelForAutonomy(input.proposed)
  if (toLevel <= fromLevel) return { ok: false, reason: 'not_a_widen' }
  if (toLevel !== fromLevel + 1) return { ok: false, reason: 'skip_not_allowed' }

  for (const win of input.wins) {
    if (win.verification !== 'resolved_by_id') {
      return { ok: false, reason: 'unverified_win_label' }
    }
    if (win.receiptId.trim().length === 0) {
      return { ok: false, reason: 'unverified_win_label' }
    }
  }

  const verifiedWinCount = input.wins.filter(
    (win) => win.verification === 'resolved_by_id' && win.receiptId.trim().length > 0,
  ).length
  if (verifiedWinCount < input.requiredWins) {
    return { ok: false, reason: 'insufficient_verified_wins' }
  }

  return {
    ok: true,
    from: input.current,
    to: input.proposed,
    verifiedWinCount,
  }
}

/**
 * Honest progress display. Unwired / missing metric ⇒ unmeasured.
 * Never invents a green measured bar from absent data.
 */
export function decideProgressDisplay(input: {
  metric: OutcomeMetricSpec | null
  sourceWired: boolean
  signal: { ok: true; value: number } | { ok: false; reason: string } | null
}): ProgressDisplay {
  if (input.metric === null || !input.sourceWired) return { kind: 'unmeasured' }
  if (input.signal === null) {
    return { kind: 'unavailable', reason: 'signal_missing' }
  }
  if (!input.signal.ok) {
    return { kind: 'unavailable', reason: input.signal.reason }
  }
  const target = input.metric.target
  if (!(target > 0)) {
    return { kind: 'unavailable', reason: 'invalid_target' }
  }
  const value = input.signal.value
  const ratio = Math.min(1, Math.max(0, value / target))
  return { kind: 'measured', value, target, ratio }
}

/** Lessons are visible learning — receipt id is mandatory. */
export function validateLessonDraft(draft: {
  receiptId: string
  polarity: string
  summary: string
  sourceSchema: string
}): LessonValidation {
  const receiptId = draft.receiptId.trim()
  if (!receiptId) return { ok: false, reason: 'receipt_id_required' }
  const summary = draft.summary.trim()
  if (!summary) return { ok: false, reason: 'summary_required' }
  const sourceSchema = draft.sourceSchema.trim()
  if (!sourceSchema) return { ok: false, reason: 'source_schema_required' }
  if (draft.polarity !== 'win' && draft.polarity !== 'miss') {
    return { ok: false, reason: 'polarity_invalid' }
  }
  return {
    ok: true,
    lesson: {
      receiptId,
      polarity: draft.polarity,
      summary,
      sourceSchema,
    },
  }
}

/**
 * Instinct-biased Adapt is illegal until Port-4 is live AND the learning
 * ranker has passed its dyad-gate. Naming the prerequisite beats citing a
 * dormant branch as reuse.
 */
export function mayEnableInstinctAdapt(prereq: {
  port4LiveOnMain: boolean
  learningRankerDyadPassed: boolean
}): InstinctAdaptEligibility {
  if (!prereq.port4LiveOnMain) return { ok: false, reason: 'port4_not_live' }
  if (!prereq.learningRankerDyadPassed) {
    return { ok: false, reason: 'learning_ranker_not_passed' }
  }
  return { ok: true }
}

/** Owner home must expose all three facets for a coherent experience. */
export function assertOwnerHomeFacets(facets: readonly string[]): void {
  for (const required of OWNER_EXPERIENCE_FACETS) {
    if (!facets.includes(required)) {
      throw new Error(`owner_experience_facet_missing: ${required}`)
    }
  }
}

/** Rank step must not gain new act verbs via this epic. */
export function brainRemainsRankNotAct(): boolean {
  return true
}
