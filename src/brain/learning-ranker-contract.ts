// mupot — Brain = learning ranker contract (design-lock, pure).
//
// Locks the Port-4 instinct → RECALL-at-rank seam WITHOUT changing BrainPort's
// role: rank / propose only. No I/O. No LLM. Build slices wire persistence later.
// Spec: docs/superpowers/specs/2026-07-27-brain-learning-ranker-design.md
// Machine contract: docs/brain-learning-ranker-v1.json

export const BRAIN_LEARNING_RANKER_CONTRACT_ID = 'brain-learning-ranker/v1' as const

export const LEARNING_RANKER_PIPELINE = [
  'loadBoardContext',
  'recallInstincts',
  'gateInstincts',
  'decide',
  'applyInstinctBias',
  'emitDecision',
] as const

export type LearningRankerStep = (typeof LEARNING_RANKER_PIPELINE)[number]

export const ALLOWED_BRAIN_PROPOSAL_KINDS = ['spawn_task', 'wake_agent', 'noop'] as const

export type BrainProposalKind = (typeof ALLOWED_BRAIN_PROPOSAL_KINDS)[number]

export const FORBIDDEN_BRAIN_ACTION_VERBS = [
  'restart',
  'heal',
  'merge',
  'deploy',
  'publish',
  'verdict',
  'mint_token',
  'fleet_control',
] as const

export type ForbiddenBrainActionVerb = (typeof FORBIDDEN_BRAIN_ACTION_VERBS)[number]

export const RANK_INSTINCT_DOMAINS = [
  'rank-discipline',
  'routing',
  'citation',
  'lifecycle',
] as const

export type RankInstinctDomain = (typeof RANK_INSTINCT_DOMAINS)[number]

export const DISTILL_ALLOWED_SOURCES = [
  'gate_fail_receipt',
  'fabrication_receipt',
  'human_correction_receipt',
] as const

export type DistillSource = (typeof DISTILL_ALLOWED_SOURCES)[number]

export const DISTILL_FORBIDDEN_SOURCES = [
  'raw_agent_self_report',
  'unverified_board_diff',
  'model_speculation',
] as const

export type DistillForbiddenSource = (typeof DISTILL_FORBIDDEN_SOURCES)[number]

/** Mirrors Port-4 / ECC continuous-learning-v2 confidence band. */
export const INSTINCT_CONFIDENCE_MIN = 0.3
export const INSTINCT_CONFIDENCE_MAX = 0.9
export const INSTINCT_INJECT_THRESHOLD = 0.7
export const INSTINCT_DECAY_HALF_LIFE_DAYS = 30
export const INSTINCT_INJECT_MAX = 6
export const INSTINCT_PROMOTE_MIN_PROJECTS = 2
export const INSTINCT_PROMOTE_MIN_CONFIDENCE = 0.8

export const EXAMPLE_FABRICATION_INSTINCT_ID = 'no-act-on-fabrication'

export type BrainRuntimeRole = 'learning_ranker' | 'learning_actor'

export interface RankInstinct {
  id: string
  trigger: string
  confidence: number
  domain: string
  action: string
  updatedAt: string
  projectId: string | null
}

export interface RankProposal {
  kind: string
  summary: string
  priority: number
  doneWhen: string | null
}

export interface InstinctGateOpts {
  minConfidence: number
  maxInjected: number
  halfLifeDays: number
  nowIso: string
  allowedDomains: readonly string[]
}

export type InstinctGateResult =
  | { ok: true; instincts: RankInstinct[] }
  | { ok: false; reason: string }

export type DistillEligibility =
  | { ok: true }
  | { ok: false; reason: 'forbidden_source' | 'unknown_source' }

/**
 * Brain may never act. Only the learning_ranker role is legal for this contract.
 */
export function brainMayAct(role: BrainRuntimeRole): boolean {
  return role === 'learning_actor'
}

export function isLearningRankerRole(role: BrainRuntimeRole): boolean {
  return role === 'learning_ranker'
}

/** Hot rank path forbids LLM distill / frontier calls. */
export function hotPathAllowsLlm(): boolean {
  return false
}

/**
 * Hermes may host the brain process; it is not the learning mechanism and does
 * not authorize acting.
 */
export function hermesIsLearningMechanism(): boolean {
  return false
}

export function hermesMayAuthorizeBrainAction(): boolean {
  return false
}

export function isAllowedProposalKind(kind: string): boolean {
  return (ALLOWED_BRAIN_PROPOSAL_KINDS as readonly string[]).includes(kind)
}

export function isForbiddenActionVerb(verb: string): boolean {
  return (FORBIDDEN_BRAIN_ACTION_VERBS as readonly string[]).includes(verb)
}

export function isRankInstinctDomain(domain: string): boolean {
  return (RANK_INSTINCT_DOMAINS as readonly string[]).includes(domain)
}

export function clampInstinctConfidence(raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new Error('learning_ranker: confidence must be a finite number')
  }
  if (raw < INSTINCT_CONFIDENCE_MIN) return INSTINCT_CONFIDENCE_MIN
  if (raw > INSTINCT_CONFIDENCE_MAX) return INSTINCT_CONFIDENCE_MAX
  return raw
}

/**
 * Exponential half-life decay toward the confidence floor. Never below min —
 * pruning is a separate path (Port-4).
 */
export function decayInstinctConfidence(
  confidence: number,
  updatedAtIso: string,
  nowIso: string,
  halfLifeDays: number,
): number {
  const clamped = clampInstinctConfidence(confidence)
  if (!(halfLifeDays > 0)) {
    throw new Error('learning_ranker: halfLifeDays must be > 0')
  }
  const updatedMs = Date.parse(updatedAtIso)
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) {
    throw new Error('learning_ranker: updatedAt/now must be valid ISO timestamps')
  }
  const elapsedDays = Math.max(0, (nowMs - updatedMs) / (1000 * 60 * 60 * 24))
  if (elapsedDays === 0) return clamped
  const decayed = clamped * Math.pow(0.5, elapsedDays / halfLifeDays)
  return clampInstinctConfidence(decayed)
}

export function mayDistillFromSource(source: string): DistillEligibility {
  if ((DISTILL_FORBIDDEN_SOURCES as readonly string[]).includes(source)) {
    return { ok: false, reason: 'forbidden_source' }
  }
  if ((DISTILL_ALLOWED_SOURCES as readonly string[]).includes(source)) {
    return { ok: true }
  }
  return { ok: false, reason: 'unknown_source' }
}

/**
 * Gate instincts before they may bias rank: decay → domain allowlist →
 * confidence threshold → inject cap. Fail closed on empty allowlist misuse.
 */
export function gateInstinctsForRank(
  instincts: readonly RankInstinct[],
  opts: InstinctGateOpts,
): InstinctGateResult {
  if (opts.allowedDomains.length === 0) {
    return { ok: false, reason: 'domain_allowlist_empty' }
  }
  if (!(opts.maxInjected > 0)) {
    return { ok: false, reason: 'max_injected_invalid' }
  }

  const gated = instincts
    .map((instinct) => ({
      ...instinct,
      confidence: decayInstinctConfidence(
        instinct.confidence,
        instinct.updatedAt,
        opts.nowIso,
        opts.halfLifeDays,
      ),
    }))
    .filter((instinct) => opts.allowedDomains.includes(instinct.domain))
    .filter((instinct) => instinct.confidence >= opts.minConfidence)
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, opts.maxInjected)

  return { ok: true, instincts: gated }
}

export function defaultInstinctGateOpts(nowIso: string): InstinctGateOpts {
  return {
    minConfidence: INSTINCT_INJECT_THRESHOLD,
    maxInjected: INSTINCT_INJECT_MAX,
    halfLifeDays: INSTINCT_DECAY_HALF_LIFE_DAYS,
    nowIso,
    allowedDomains: RANK_INSTINCT_DOMAINS,
  }
}

/**
 * Detect forbidden action verbs in free text (summary / action / doneWhen).
 * Word-boundary style: substring match on normalized tokens.
 */
export function textContainsForbiddenAction(text: string): boolean {
  const normalized = text.toLowerCase()
  for (const verb of FORBIDDEN_BRAIN_ACTION_VERBS) {
    const re = new RegExp(`(^|[^a-z0-9])${verb}([^a-z0-9]|$)`)
    if (re.test(normalized)) return true
  }
  return false
}

export function assertProposalKindAllowed(kind: string): void {
  if (!isAllowedProposalKind(kind)) {
    throw new Error(`learning_ranker_forbidden_proposal_kind: ${kind}`)
  }
}

/**
 * Pure bias: if a gated instinct's trigger tokens appear in a proposal summary
 * and the instinct action prefers noop / escalate, demote to noop with lowered
 * priority. Never invents forbidden verbs. Stable sort by priority desc, then
 * kind, then summary.
 */
export function applyInstinctBiasToProposals(
  proposals: readonly RankProposal[],
  gatedInstincts: readonly RankInstinct[],
): RankProposal[] {
  for (const proposal of proposals) {
    assertProposalKindAllowed(proposal.kind)
    if (textContainsForbiddenAction(proposal.summary)) {
      throw new Error(`learning_ranker_forbidden_action_in_summary: ${proposal.kind}`)
    }
  }

  const biased = proposals.map((proposal) => {
    const matching = gatedInstincts.filter((instinct) =>
      proposalMatchesTrigger(proposal.summary, instinct.trigger),
    )
    if (matching.length === 0) return { ...proposal }

    const prefersNoop = matching.some((instinct) => actionPrefersNoop(instinct.action))
    if (!prefersNoop) {
      return {
        ...proposal,
        priority: proposal.priority - matching.length,
      }
    }
    return {
      kind: 'noop',
      summary: `instinct:${matching[0].id} blocked act-on-match — ${proposal.summary}`,
      priority: Math.min(proposal.priority, 0),
      doneWhen: null,
    }
  })

  return biased.slice().sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
    return a.summary.localeCompare(b.summary)
  })
}

function actionPrefersNoop(action: string): boolean {
  const lower = action.toLowerCase()
  return (
    lower.includes('noop')
    || lower.includes('escalate')
    || lower.includes('never propose')
    || lower.includes('do not act')
    || lower.includes("don't act")
  )
}

function proposalMatchesTrigger(summary: string, trigger: string): boolean {
  const hay = summary.toLowerCase()
  const tokens = trigger
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
  if (tokens.length === 0) return false
  const hits = tokens.filter((t) => hay.includes(t)).length
  return hits >= Math.min(2, tokens.length)
}

/**
 * Pipeline order lock: applyInstinctBias requires gateInstincts + decide first;
 * distill must not appear on the hot path.
 */
export function mayApplyInstinctBias(completedSteps: readonly LearningRankerStep[]): boolean {
  return (
    completedSteps.includes('gateInstincts')
    && completedSteps.includes('decide')
    && !completedSteps.includes('applyInstinctBias')
  )
}

export function mayRunHotPathDistill(): boolean {
  return false
}

/** Auto-promote only when ≥2 projects and avg confidence meets floor (Port-4). */
export function shouldPromoteInstinct(projectConfidences: readonly number[]): boolean {
  if (projectConfidences.length < INSTINCT_PROMOTE_MIN_PROJECTS) return false
  const avg =
    projectConfidences.reduce((sum, c) => sum + clampInstinctConfidence(c), 0)
    / projectConfidences.length
  return avg >= INSTINCT_PROMOTE_MIN_CONFIDENCE
}

/** Canonical #490-class instinct shape used in contract tests. */
export function fabricationInstinctExample(nowIso: string): RankInstinct {
  return {
    id: EXAMPLE_FABRICATION_INSTINCT_ID,
    trigger:
      'when evidence for an outage or empty backlog is missing, stale, or fabricated',
    confidence: 0.85,
    domain: 'rank-discipline',
    action:
      'Prefer noop or escalate; never propose restart, heal, or invent work from the fabrication.',
    updatedAt: nowIso,
    projectId: 'proj-example',
  }
}
