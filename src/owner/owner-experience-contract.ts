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
export const MIN_REQUIRED_WINS_PER_WIDEN = 3

export type KpiSourceId = 'task_counter' | 'github_prs'
export const KPI_SOURCE_IDS: readonly KpiSourceId[] = ['task_counter', 'github_prs']
export function isKpiSourceId(v: unknown): v is KpiSourceId {
  return typeof v === 'string' && (KPI_SOURCE_IDS as readonly string[]).includes(v)
}

/**
 * Rate/consumption story (named, not implied):
 * Successful widen returns consumeReceiptIds; those ids must be passed back in
 * consumedReceiptIds on later calls so the same three wins cannot walk the
 * full ladder. Audit trail + mandatory owner review remain the outer defense;
 * consumption is the in-function fence against reuse.
 */
export const WIN_CONSUMPTION_POLICY =
  'mark_consumed_after_successful_widen' as const

export type TalkRuntimeKind = 'tier1_persistent_mubot' | 'tier2_stateless_user_chat'

export type PermissionCallerKind = 'owner_or_admin_human' | 'mubot_or_agent' | 'other'

/** Record a real workflow_receipts resolver must return. Trust claim ≠ trust object. */
export interface WinReceiptRecord {
  receiptId: string
  projectId: string
  agentId: string
  polarity: 'win' | 'miss'
  resolvedAt: string
}

/**
 * Injected trust boundary (Port-4 InstinctChat pattern). Production wires
 * workflow_receipts; tests inject fakes. Callers never pass a self-describing tag.
 */
export type WinReceiptResolver = (receiptId: string) => WinReceiptRecord | null

/**
 * Opaque trust object — carries resolved content (polarity, scope, time).
 * Only `verifiedWinRefFromResolver` may construct it.
 */
export type VerifiedWinRef = {
  readonly _brand: 'VerifiedWinRef'
  readonly receiptId: string
  readonly projectId: string
  readonly agentId: string
  readonly polarity: 'win'
  readonly resolvedAt: string
}

export type WinRefResolution =
  | VerifiedWinRef
  | {
      ok: false
      reason:
        | 'unverified_win_label'
        | 'scope_mismatch'
        | 'not_a_win'
        | 'missing_receipt_id'
        | 'project_id_required'
        | 'agent_id_required'
    }

/**
 * Sole constructor for VerifiedWinRef. A plain
 * `{ verification: 'resolved_by_id' }` bag is not accepted — that was the
 * label pattern (mechanism-lock ≠ trust-lock).
 */
export function verifiedWinRefFromResolver(
  resolver: WinReceiptResolver,
  receiptId: string,
  scope: { projectId: string; agentId: string },
): WinRefResolution {
  const projectId = String(scope.projectId || '').trim()
  const agentId = String(scope.agentId || '').trim()
  if (!projectId) return { ok: false, reason: 'project_id_required' }
  if (!agentId) return { ok: false, reason: 'agent_id_required' }
  const id = String(receiptId || '').trim()
  if (!id) return { ok: false, reason: 'missing_receipt_id' }

  const record = resolver(id)
  if (!record) return { ok: false, reason: 'unverified_win_label' }
  if (String(record.receiptId).trim() !== id) {
    return { ok: false, reason: 'unverified_win_label' }
  }
  if (
    String(record.projectId).trim() !== projectId ||
    String(record.agentId).trim() !== agentId
  ) {
    return { ok: false, reason: 'scope_mismatch' }
  }
  if (record.polarity !== 'win') return { ok: false, reason: 'not_a_win' }
  const resolvedAt = String(record.resolvedAt || '').trim()
  if (!resolvedAt) return { ok: false, reason: 'unverified_win_label' }

  return {
    _brand: 'VerifiedWinRef',
    receiptId: id,
    projectId,
    agentId,
    polarity: 'win',
    resolvedAt,
  }
}

/** @deprecated Label-only shape — rejected by decideEarnedAutonomyWiden. */
export interface LabeledWinRef {
  receiptId: string
  verification: 'resolved_by_id' | 'unverified_label'
}

export interface EarnedAutonomyWidenInput {
  /** Project whose binding is being widened — required scope key. */
  projectId: string
  /** Agent whose autonomy is being widened — required scope key. */
  agentId: string
  current: Autonomy
  proposed: Autonomy
  actingPrincipalKind: PermissionCallerKind
  wins: readonly (VerifiedWinRef | LabeledWinRef)[]
  requiredWins: number
  /** Receipt ids already consumed by prior successful widens. */
  consumedReceiptIds: readonly string[]
}

export type EarnedAutonomyWidenDecision =
  | {
      ok: true
      from: Autonomy
      to: Autonomy
      verifiedWinCount: number
      /** Caller must persist these as consumed before the next widen. */
      consumeReceiptIds: readonly string[]
    }
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
        | 'project_id_required'
        | 'agent_id_required'
        | 'scope_mismatch'
        | 'not_a_win'
        | 'win_already_consumed'
    }

export type ProgressDisplay =
  | { kind: 'measured'; value: number; target: number; ratio: number }
  | { kind: 'unmeasured' }
  | { kind: 'unavailable'; reason: string }

export interface OutcomeMetricSpec {
  sourceId: KpiSourceId
  target: number
}

/** Structured north-star — not free-text projects.goal. */
export interface Outcome {
  statement: string
  metric: OutcomeMetricSpec | null
  /** v1: existing agent KPI sources cannot measure a project → unmeasured. */
  measurementMode: 'unmeasured_until_project_kpi' | 'measured'
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

/**
 * Mubot may propose wording; it may never write the Outcome.
 * CallerKind is required so a later slice has a real branch point (not a
 * zero-arg constant posing as a permission check).
 */
export function mayMubotRedefineGoal(callerKind: PermissionCallerKind): boolean {
  if (callerKind !== 'owner_or_admin_human' && callerKind !== 'mubot_or_agent' && callerKind !== 'other') {
    throw new Error('owner_experience_unknown_caller_kind')
  }
  return false
}

/**
 * Risky / irreversible acts wait for the owner — mubot never self-verdicts.
 * CallerKind required for the same reason as mayMubotRedefineGoal.
 */
export function mayMubotSelfVerdictGate(callerKind: PermissionCallerKind): boolean {
  if (callerKind !== 'owner_or_admin_human' && callerKind !== 'mubot_or_agent' && callerKind !== 'other') {
    throw new Error('owner_experience_unknown_caller_kind')
  }
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

function isBrandedWinRef(win: VerifiedWinRef | LabeledWinRef): win is VerifiedWinRef {
  return (
    typeof win === 'object' &&
    win !== null &&
    '_brand' in win &&
    (win as VerifiedWinRef)._brand === 'VerifiedWinRef'
  )
}

/**
 * One-step earned widen. Wins must be branded VerifiedWinRef from resolver
 * (not free-string labels). Scope keys on the input are required and checked
 * against each win. Decider must be an owner/admin human — never the mubot.
 * Consumed receipt ids cannot be reused to climb further steps.
 */
export function decideEarnedAutonomyWiden(
  input: EarnedAutonomyWidenInput,
): EarnedAutonomyWidenDecision {
  const projectId = String(input.projectId || '').trim()
  const agentId = String(input.agentId || '').trim()
  if (!projectId) return { ok: false, reason: 'project_id_required' }
  if (!agentId) return { ok: false, reason: 'agent_id_required' }

  if (input.actingPrincipalKind !== 'owner_or_admin_human') {
    return { ok: false, reason: 'mubot_cannot_self_widen' }
  }
  if (!isAutonomy(input.current) || !isAutonomy(input.proposed)) {
    return { ok: false, reason: 'invalid_autonomy' }
  }
  if (!Number.isInteger(input.requiredWins) || input.requiredWins < MIN_REQUIRED_WINS_PER_WIDEN) {
    return { ok: false, reason: 'required_wins_invalid' }
  }

  const fromLevel = trustLevelForAutonomy(input.current)
  const toLevel = trustLevelForAutonomy(input.proposed)
  if (toLevel <= fromLevel) return { ok: false, reason: 'not_a_widen' }
  if (toLevel !== fromLevel + 1) return { ok: false, reason: 'skip_not_allowed' }

  const consumed = new Set(
    (input.consumedReceiptIds || []).map((id) => String(id).trim()).filter(Boolean),
  )
  const accepted: VerifiedWinRef[] = []
  const seenIds = new Set<string>()

  for (const win of input.wins) {
    if (!isBrandedWinRef(win)) {
      return { ok: false, reason: 'unverified_win_label' }
    }
    if (!win.receiptId.trim()) {
      return { ok: false, reason: 'unverified_win_label' }
    }
    if (seenIds.has(win.receiptId)) {
      continue // dedup — one receipt counts once
    }
    if (win.projectId !== projectId || win.agentId !== agentId) {
      return { ok: false, reason: 'scope_mismatch' }
    }
    if (win.polarity !== 'win') {
      return { ok: false, reason: 'not_a_win' }
    }
    if (consumed.has(win.receiptId)) {
      return { ok: false, reason: 'win_already_consumed' }
    }
    seenIds.add(win.receiptId)
    accepted.push(win)
  }

  if (accepted.length < input.requiredWins) {
    return { ok: false, reason: 'insufficient_verified_wins' }
  }

  const consumeReceiptIds = accepted.slice(0, input.requiredWins).map((w) => w.receiptId)
  return {
    ok: true,
    from: input.current,
    to: input.proposed,
    verifiedWinCount: accepted.length,
    consumeReceiptIds,
  }
}

/**
 * Honest progress display. Unwired / missing / non-allowlisted metric ⇒ unmeasured.
 * Never invents a green measured bar from absent data.
 * Caller `sourceWired` boolean REMOVED — wired-ness derived from KpiSourceId allowlist.
 * v1 `unmeasured_until_project_kpi` always returns unmeasured (existing KPI sources
 * are agent-scoped, not project-owner UX — BLOCK-B).
 */
export function decideProgressDisplay(input: {
  outcome: Outcome
  signal:
    | { ok: true; value: number; sourceId: KpiSourceId }
    | { ok: false; reason: string }
    | null
}): ProgressDisplay {
  if (input.outcome.measurementMode === 'unmeasured_until_project_kpi') {
    return { kind: 'unmeasured' }
  }
  if (input.outcome.metric === null) return { kind: 'unmeasured' }
  if (!isKpiSourceId(input.outcome.metric.sourceId)) return { kind: 'unmeasured' }
  if (input.signal === null) {
    return { kind: 'unavailable', reason: 'signal_missing' }
  }
  if (!input.signal.ok) {
    return { kind: 'unavailable', reason: input.signal.reason }
  }
  if (input.signal.sourceId !== input.outcome.metric.sourceId) {
    return { kind: 'unavailable', reason: 'source_id_mismatch' }
  }
  const target = input.outcome.metric.target
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

/** Facets Know+Watch are required for v1 home; Talk is OPTIONAL until #505 is revived. */
export const OWNER_HOME_REQUIRED_FACETS = ['know', 'watch'] as const

/** Owner home must expose Know+Watch. Talk is optional while Tier-1 #505 is closed-unmerged. */
export function assertOwnerHomeFacets(facets: readonly string[]): void {
  for (const required of OWNER_HOME_REQUIRED_FACETS) {
    if (!facets.includes(required)) {
      throw new Error(`owner_experience_facet_missing: ${required}`)
    }
  }
}

/** Rank step must not gain new act verbs via this epic. */
export function brainRemainsRankNotAct(): boolean {
  return true
}
