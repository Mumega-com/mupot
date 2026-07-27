// mupot — Brain = learning ranker contract (design-lock, pure).
//
// Locks the Port-4 instinct → RECALL-at-rank seam WITHOUT claiming BrainPort is
// implemented: BrainPort is a SEALED type-only decision record until slice
// `brainport-default-adapter` lands. No I/O. No LLM on the hot path.
// Spec: docs/superpowers/specs/2026-07-27-brain-learning-ranker-design.md
// Machine contract: docs/brain-learning-ranker-v1.json
// Gate: _gate-verdicts/brain-ranker-8ceebb5d-dyad-gate.md (BLOCK → amendment)

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

/** Must match BrainProposal.kind in src/types.ts. */
export const ALLOWED_BRAIN_PROPOSAL_KINDS = ['spawn_task', 'wake_agent', 'noop'] as const

export type BrainProposalKind = (typeof ALLOWED_BRAIN_PROPOSAL_KINDS)[number]

/**
 * Motor verbs forbidden as proposal *kinds* / action verbs — NOT as audit-trail
 * summary prose (BLOCK-C). Prose screening is warn-only via warnForbiddenProseVerbs.
 */
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

/** experience.py analogue — absolute cap on total learning priority adjustment. */
export const MAX_LEARN_DELTA = 15

/** Anti-selection-bias (b): force-promote after this many consecutive suppressions. */
export const STALENESS_ESCALATION_TICKS = 5

/** Anti-selection-bias (c): extra confidence penalty when suppressions lack confirming receipts. */
export const UNEXERCISED_SUPPRESSION_PENALTY = 0.1

/** Corroboration required before ANY project-scope inject (not only global promote). */
export const INJECT_MIN_CORROBORATING_RECEIPTS = 2

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
  /** Receipt IDs resolved against Port-4 / FRC store — never free-string labels alone. */
  corroboratingReceiptIds: readonly string[]
  /** Consecutive ticks this instinct suppressed work without confirming receipts. */
  suppressionTicksWithoutConfirm?: number
}

/**
 * Must match BrainProposal (types.ts) including agentId — BLOCK-B.
 * doneWhen uses optional undefined (not null) to assign both directions.
 */
export interface RankProposal {
  kind: BrainProposalKind
  agentId?: string
  summary: string
  doneWhen?: string
  priority: number
}

export interface InstinctGateOpts {
  /** Required — fail closed if missing/empty (M-1). */
  projectId: string
  minConfidence: number
  maxInjected: number
  halfLifeDays: number
  nowIso: string
  allowedDomains: readonly string[]
  /** When true, require corroboratingReceiptIds length ≥ INJECT_MIN_CORROBORATING_RECEIPTS. */
  requireCorroboration: boolean
}

export type InstinctGateResult =
  | { ok: true; instincts: RankInstinct[] }
  | { ok: false; reason: string }

export type DistillEligibility =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'forbidden_source'
        | 'unknown_source'
        | 'missing_receipt_id'
        | 'unverified_receipt'
        | 'insufficient_corroboration'
        | 'unknown_store'
        | 'source_kind_mismatch'
    }

/**
 * Opaque trust object — cannot be built by setting a boolean on a plain bag.
 * Only `verifiedReceiptRefFromStoreLookup` may construct it.
 */
export type VerifiedReceiptRef = {
  readonly _brand: 'VerifiedReceiptRef'
  readonly receiptId: string
  readonly sourceKind: DistillSource
  readonly corroboratingReceiptIds: readonly string[]
  readonly store: 'gate_driver' | 'frc'
}

/** Result shape a real Port-4 / FRC lookup must return before distill is allowed. */
export interface ReceiptStoreLookupHit {
  found: true
  receiptId: string
  sourceKind: string
  store: 'gate_driver' | 'frc'
  /** Additional receipt IDs that corroborate (may include self). */
  corroboratingReceiptIds: readonly string[]
}

export type ReceiptStoreLookupMiss = { found: false; receiptId: string }

export type ReceiptStoreLookup = ReceiptStoreLookupHit | ReceiptStoreLookupMiss

/**
 * Sole constructor for VerifiedReceiptRef. A plain `{verifiedAgainstStore:true}`
 * bag is not accepted anywhere — that was rename-not-fix.
 */
export function verifiedReceiptRefFromStoreLookup(
  lookup: ReceiptStoreLookup,
): VerifiedReceiptRef | DistillEligibility {
  if (!lookup.found) {
    return { ok: false, reason: 'unverified_receipt' }
  }
  if (!lookup.receiptId || !String(lookup.receiptId).trim()) {
    return { ok: false, reason: 'missing_receipt_id' }
  }
  if (lookup.store !== 'gate_driver' && lookup.store !== 'frc') {
    return { ok: false, reason: 'unknown_store' }
  }
  const kindGate = mayDistillFromSource(lookup.sourceKind)
  if (!kindGate.ok) return kindGate
  if (!(DISTILL_ALLOWED_SOURCES as readonly string[]).includes(lookup.sourceKind)) {
    return { ok: false, reason: 'source_kind_mismatch' }
  }
  const ids = new Set(
    [lookup.receiptId, ...lookup.corroboratingReceiptIds]
      .map((id) => String(id).trim())
      .filter(Boolean),
  )
  if (ids.size < INJECT_MIN_CORROBORATING_RECEIPTS) {
    return { ok: false, reason: 'insufficient_corroboration' }
  }
  return {
    _brand: 'VerifiedReceiptRef',
    receiptId: String(lookup.receiptId).trim(),
    sourceKind: lookup.sourceKind as DistillSource,
    corroboratingReceiptIds: [...ids],
    store: lookup.store,
  }
}

/** @deprecated Mechanism-lock label check — keep for inventory honesty; use VerifiedReceiptRef path. */
export interface DistillReceiptRef {
  receiptId: string
  sourceKind: string
  /** @deprecated Caller boolean — rejected by mayDistillFromReceiptRef. */
  verifiedAgainstStore: boolean
  corroboratingReceiptIds: readonly string[]
}

export interface BiasApplicationResult {
  proposals: RankProposal[]
  /** Audit: which instincts moved which proposals (H-5). */
  applied: ReadonlyArray<{ proposalSummary: string; instinctIds: readonly string[]; delta: number }>
  proseWarnings: readonly string[]
}

/**
 * Taxonomy helper only — NOT an authorization guard.
 * Prefer: if (role === 'learning_ranker') for seals.
 */
export function brainMayAct(role: BrainRuntimeRole): boolean {
  return role === 'learning_actor'
}

export function isLearningRankerRole(role: BrainRuntimeRole): boolean {
  return role === 'learning_ranker'
}

export function hotPathAllowsLlm(): boolean {
  return false
}

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

/**
 * Anti-fabrication taxonomy check alone (mechanism-lock).
 * Prefer mayDistillFromReceiptRef for trust-lock.
 */
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
 * Trust-lock: only branded VerifiedReceiptRef (from store lookup) may distill.
 * Plain bags with verifiedAgainstStore boolean are rejected as unverified_receipt.
 */
export function mayDistillFromReceiptRef(
  ref: VerifiedReceiptRef | DistillReceiptRef,
): DistillEligibility {
  if (!ref || typeof ref !== 'object') {
    return { ok: false, reason: 'unverified_receipt' }
  }
  if (!('_brand' in ref) || ref._brand !== 'VerifiedReceiptRef') {
    return { ok: false, reason: 'unverified_receipt' }
  }
  const branded = ref as VerifiedReceiptRef
  if (!branded.receiptId || !String(branded.receiptId).trim()) {
    return { ok: false, reason: 'missing_receipt_id' }
  }
  const kindGate = mayDistillFromSource(branded.sourceKind)
  if (!kindGate.ok) return kindGate
  const ids = new Set(
    branded.corroboratingReceiptIds.map((id) => String(id).trim()).filter(Boolean),
  )
  ids.add(String(branded.receiptId).trim())
  if (ids.size < INJECT_MIN_CORROBORATING_RECEIPTS) {
    return { ok: false, reason: 'insufficient_corroboration' }
  }
  return { ok: true }
}

/** Distill domains must be in RANK_INSTINCT_DOMAINS or the inject loop is a no-op (H-1). */
export function mapDistillDomainToAllowlist(rawDomain: string): RankInstinctDomain | null {
  const trimmed = String(rawDomain || '').trim().toLowerCase()
  if ((RANK_INSTINCT_DOMAINS as readonly string[]).includes(trimmed)) {
    return trimmed as RankInstinctDomain
  }
  return null
}

/**
 * Strip instruction-shaped lines from receipt free text before cheap-model distill.
 */
export function sanitizeReceiptContentForDistill(raw: string): string {
  return String(raw || '')
    .split('\n')
    .filter((line) => {
      const t = line.trim().toLowerCase()
      if (!t) return true
      if (t.startsWith('create instinct')) return false
      if (t.startsWith('prefer noop for')) return false
      if (t.includes('confidence:') && t.includes('domain')) return false
      if (/^system\s*:/.test(t) || /^assistant\s*:/.test(t)) return false
      return true
    })
    .join('\n')
}

/**
 * Gate instincts: project scope → corroboration → decay → domain → threshold → inject cap.
 */
export function gateInstinctsForRank(
  instincts: readonly RankInstinct[],
  opts: InstinctGateOpts,
): InstinctGateResult {
  if (!opts.projectId || !String(opts.projectId).trim()) {
    return { ok: false, reason: 'project_id_required' }
  }
  if (opts.allowedDomains.length === 0) {
    return { ok: false, reason: 'domain_allowlist_empty' }
  }
  if (!(opts.maxInjected > 0)) {
    return { ok: false, reason: 'max_injected_invalid' }
  }

  const projectId = String(opts.projectId).trim()
  const scoped = instincts.filter((instinct) => {
    if (instinct.projectId === null) return false
    return instinct.projectId === projectId
  })

  const eligible = scoped.filter((instinct) => {
    if (!opts.requireCorroboration) return true
    const n = new Set(
      (instinct.corroboratingReceiptIds || []).map((id) => String(id).trim()).filter(Boolean),
    ).size
    return n >= INJECT_MIN_CORROBORATING_RECEIPTS
  })

  const gated = eligible
    .map((instinct) => {
      let confidence = decayInstinctConfidence(
        instinct.confidence,
        instinct.updatedAt,
        opts.nowIso,
        opts.halfLifeDays,
      )
      confidence = applyUnexercisedSuppressionDecay(confidence, instinct.suppressionTicksWithoutConfirm || 0)
      return { ...instinct, confidence }
    })
    .filter((instinct) => opts.allowedDomains.includes(instinct.domain))
    .filter((instinct) => instinct.confidence >= opts.minConfidence)
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, opts.maxInjected)

  return { ok: true, instincts: gated }
}

export function defaultInstinctGateOpts(nowIso: string, projectId: string): InstinctGateOpts {
  return {
    projectId,
    minConfidence: INSTINCT_INJECT_THRESHOLD,
    maxInjected: INSTINCT_INJECT_MAX,
    halfLifeDays: INSTINCT_DECAY_HALF_LIFE_DAYS,
    nowIso,
    allowedDomains: RANK_INSTINCT_DOMAINS,
    requireCorroboration: true,
  }
}

/**
 * Anti-selection-bias (c): suppressing without confirming receipts costs confidence.
 */
export function applyUnexercisedSuppressionDecay(
  confidence: number,
  suppressionTicksWithoutConfirm: number,
): number {
  if (!(suppressionTicksWithoutConfirm > 0)) return clampInstinctConfidence(confidence)
  const penalized =
    clampInstinctConfidence(confidence)
    - UNEXERCISED_SUPPRESSION_PENALTY * suppressionTicksWithoutConfirm
  return clampInstinctConfidence(Math.max(INSTINCT_CONFIDENCE_MIN, penalized))
}

/**
 * Anti-selection-bias (b): deterministic staleness escalation — force-include
 * suppressed proposal indices after N consecutive suppressions.
 */
export function selectStalenessEscalationIndices(
  consecutiveSuppressionTicks: readonly number[],
  threshold: number,
): number[] {
  const t = threshold > 0 ? threshold : STALENESS_ESCALATION_TICKS
  const out: number[] = []
  for (let i = 0; i < consecutiveSuppressionTicks.length; i += 1) {
    if (consecutiveSuppressionTicks[i] >= t) out.push(i)
  }
  return out
}

/**
 * Detect forbidden verbs in prose after stripping non-alpha (W-1).
 * Catches "re-start" / "re start" via compact form. Warn-only — never throw the batch.
 */
export function textContainsForbiddenAction(text: string): boolean {
  const spaced = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  if (!spaced) return false
  const compact = spaced.replace(/\s+/g, '')
  const tokens = new Set(spaced.split(/\s+/).filter(Boolean))
  for (const verb of FORBIDDEN_BRAIN_ACTION_VERBS) {
    if (tokens.has(verb)) return true
    if (compact.includes(verb)) return true
  }
  return false
}

export function warnForbiddenProseVerbs(summary: string): string | null {
  if (!textContainsForbiddenAction(summary)) return null
  return `prose_contains_motor_verb_token: ${summary.slice(0, 80)}`
}

export function assertProposalKindAllowed(kind: string): void {
  if (!isAllowedProposalKind(kind)) {
    throw new Error(`learning_ranker_forbidden_proposal_kind: ${kind}`)
  }
}

function clampLearnDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0
  if (delta > MAX_LEARN_DELTA) return MAX_LEARN_DELTA
  if (delta < -MAX_LEARN_DELTA) return -MAX_LEARN_DELTA
  return delta
}

/**
 * Pure bias with MAX_LEARN_DELTA, audit trail, stable priority sort preserving
 * input order on ties (does not alphabetize away brain order — H-4).
 */
export function applyInstinctBiasToProposals(
  proposals: readonly RankProposal[],
  gatedInstincts: readonly RankInstinct[],
): BiasApplicationResult {
  const proseWarnings: string[] = []
  const applied: Array<{ proposalSummary: string; instinctIds: string[]; delta: number }> = []

  for (const proposal of proposals) {
    assertProposalKindAllowed(proposal.kind)
    const warn = warnForbiddenProseVerbs(proposal.summary)
    if (warn) proseWarnings.push(warn)
  }

  const indexed = proposals.map((proposal, index) => ({ proposal, index }))
  const biased = indexed.map(({ proposal, index }) => {
    const matching = gatedInstincts.filter((instinct) =>
      proposalMatchesTrigger(proposal.summary, instinct.trigger),
    )
    if (matching.length === 0) {
      return { proposal: { ...proposal }, index, instinctIds: [] as string[], delta: 0 }
    }

    const prefersNoop = matching.some((instinct) => actionPrefersNoop(instinct.action))
    if (!prefersNoop) {
      const delta = clampLearnDelta(-matching.length)
      const next = {
        ...proposal,
        priority: proposal.priority + delta,
      }
      applied.push({
        proposalSummary: proposal.summary,
        instinctIds: matching.map((m) => m.id),
        delta,
      })
      return { proposal: next, index, instinctIds: matching.map((m) => m.id), delta }
    }

    const next: RankProposal = {
      kind: 'noop',
      agentId: proposal.agentId,
      summary: `instinct:${matching[0].id} blocked act-on-match — ${proposal.summary}`,
      doneWhen: proposal.doneWhen,
      priority: Math.min(proposal.priority, 0),
    }
    applied.push({
      proposalSummary: proposal.summary,
      instinctIds: matching.map((m) => m.id),
      delta: next.priority - proposal.priority,
    })
    return { proposal: next, index, instinctIds: matching.map((m) => m.id), delta: next.priority - proposal.priority }
  })

  biased.sort((a, b) => {
    if (a.proposal.priority !== b.proposal.priority) {
      return b.proposal.priority - a.proposal.priority
    }
    return a.index - b.index
  })

  return {
    proposals: biased.map((row) => row.proposal),
    applied,
    proseWarnings,
  }
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
  // Prefer specific tokens (≥6 chars) to reduce "stale/backlog" false demotes (W-2).
  const specific = tokens.filter((t) => t.length >= 6)
  const use = specific.length >= 2 ? specific : tokens
  const hits = use.filter((t) => hay.includes(t)).length
  return hits >= Math.min(2, use.length)
}

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
    corroboratingReceiptIds: ['receipt-gate-1', 'receipt-human-2'],
  }
}
