// Port 4 — confidence-scored instinct memory (ECC continuous-learning-v2.1 port).
//
// Atomic instincts: one trigger, one action, confidence 0.3–0.9, project|global
// scope, evidence-backed. Promotion gate: ≥2 distinct projects AND avg confidence
// ≥0.8 (FRC no-silent-promotion, mechanical). Pure functions; persistence in
// instinct-service.ts.

export type InstinctScope = 'project' | 'global'

export interface Instinct {
  id: string
  trigger: string
  confidence: number
  domain: string
  scope: InstinctScope
  action: string
  evidence: string[]
  projectId: string | null
  agentId: string | null
  updatedAt: string
  createdAt: string
}

export interface InstinctCandidate {
  id: string
  trigger: string
  action: string
  confidence: number
  domain: string
  evidence: string[]
}

export interface InstinctInjectOpts {
  minConfidence: number
  maxInjected: number
}

export const INSTINCT_CONFIDENCE_MIN = 0.3
export const INSTINCT_CONFIDENCE_MAX = 0.9
export const INSTINCT_INJECT_THRESHOLD = 0.7
export const INSTINCT_INJECT_MAX = 6
export const INSTINCT_PROMOTE_CONFIDENCE = 0.8
export const INSTINCT_PROMOTE_MIN_PROJECTS = 2
/** Half-life for unread / unused confidence decay (days). */
export const INSTINCT_DECAY_HALF_LIFE_DAYS = 30
/** Reinforce step when the same instinct is re-distilled. */
export const INSTINCT_REINFORCE_STEP = 0.05
export const INSTINCT_DISTILL_MIN_OBSERVATIONS = 20

const INSTINCT_SCOPES: readonly InstinctScope[] = ['project', 'global']

export function isInstinctScope(v: unknown): v is InstinctScope {
  return typeof v === 'string' && (INSTINCT_SCOPES as readonly string[]).includes(v)
}

/** Clamp confidence into the ECC continuous-learning-v2 band [0.3, 0.9]. */
export function clampInstinctConfidence(raw: number): number {
  if (!Number.isFinite(raw)) {
    throw new Error('instinct: confidence must be a finite number')
  }
  if (raw < INSTINCT_CONFIDENCE_MIN) return INSTINCT_CONFIDENCE_MIN
  if (raw > INSTINCT_CONFIDENCE_MAX) return INSTINCT_CONFIDENCE_MAX
  return raw
}

export function validateInstinctId(id: string): string {
  const trimmed = id.trim()
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(trimmed)) {
    throw new Error('instinct: id must be kebab-case [a-z0-9-]{1,64}')
  }
  return trimmed
}

/**
 * Time-decay confidence toward the floor (half-life = INSTINCT_DECAY_HALF_LIFE_DAYS).
 * Never drops below INSTINCT_CONFIDENCE_MIN — pruning is a separate TTL path.
 */
export function decayInstinctConfidence(
  confidence: number,
  updatedAtIso: string,
  nowIso: string,
  halfLifeDays: number,
): number {
  const clamped = clampInstinctConfidence(confidence)
  if (!(halfLifeDays > 0)) {
    throw new Error('instinct: halfLifeDays must be > 0')
  }
  const updatedMs = Date.parse(updatedAtIso)
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) {
    throw new Error('instinct: updatedAt/now must be valid ISO timestamps')
  }
  const elapsedDays = Math.max(0, (nowMs - updatedMs) / (1000 * 60 * 60 * 24))
  if (elapsedDays === 0) return clamped
  const decayed = clamped * Math.pow(0.5, elapsedDays / halfLifeDays)
  return clampInstinctConfidence(decayed)
}

/** Re-observation reinforce: bump confidence toward the ceiling. */
export function reinforceInstinctConfidence(current: number, step: number): number {
  return clampInstinctConfidence(current + step)
}

/**
 * Instincts eligible for injection: confidence ≥ threshold after decay,
 * highest confidence first, capped.
 */
export function filterInstinctsForInject(
  instincts: readonly Instinct[],
  opts: InstinctInjectOpts,
  nowIso: string,
  halfLifeDays: number,
): Instinct[] {
  return instincts
    .map((instinct) => ({
      ...instinct,
      confidence: decayInstinctConfidence(
        instinct.confidence,
        instinct.updatedAt,
        nowIso,
        halfLifeDays,
      ),
    }))
    .filter((instinct) => instinct.confidence >= opts.minConfidence)
    .slice()
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, opts.maxInjected)
}

/** Project-scope shadows global same-id (ECC v2.1 scope-shadowing). */
export function resolveInstinctPrecedence(instincts: readonly Instinct[]): Instinct[] {
  const byId = new Map<string, Instinct>()
  for (const instinct of instincts) {
    const existing = byId.get(instinct.id)
    if (!existing) {
      byId.set(instinct.id, instinct)
      continue
    }
    const rank = (scope: InstinctScope): number => (scope === 'project' ? 2 : 1)
    if (rank(instinct.scope) > rank(existing.scope)) {
      byId.set(instinct.id, instinct)
    } else if (
      rank(instinct.scope) === rank(existing.scope)
      && instinct.confidence > existing.confidence
    ) {
      byId.set(instinct.id, instinct)
    }
  }
  return [...byId.values()]
}

/**
 * Auto-promote when the same instinct id appears in ≥2 distinct projects with
 * average confidence ≥ 0.8 (ECC promotion gate / FRC no-silent-promotion).
 */
export function shouldPromoteInstinct(instincts: readonly Instinct[]): boolean {
  const projectScoped = instincts.filter(
    (instinct) => instinct.scope === 'project' && instinct.projectId !== null,
  )
  if (projectScoped.length === 0) return false

  const projectIds = new Set(projectScoped.map((instinct) => instinct.projectId as string))
  if (projectIds.size < INSTINCT_PROMOTE_MIN_PROJECTS) return false

  const avg =
    projectScoped.reduce((sum, instinct) => sum + instinct.confidence, 0)
    / projectScoped.length
  return avg >= INSTINCT_PROMOTE_CONFIDENCE
}

export function summarizeInstinctsForInject(instincts: readonly Instinct[]): string {
  if (instincts.length === 0) return ''
  const lines = [
    '## Active instincts (confidence-weighted)',
    'Apply these only when their trigger matches the current work.',
    '',
  ]
  for (const instinct of instincts) {
    lines.push(
      `- **${instinct.id}** (conf ${instinct.confidence.toFixed(2)}, ${instinct.scope}`
        + `${instinct.domain ? `, ${instinct.domain}` : ''}): when ${instinct.trigger} → ${instinct.action}`,
    )
  }
  return lines.join('\n')
}

export function defaultInstinctInjectOpts(): InstinctInjectOpts {
  return {
    minConfidence: INSTINCT_INJECT_THRESHOLD,
    maxInjected: INSTINCT_INJECT_MAX,
  }
}

/**
 * Parse cheap-model distill output into candidates. Accepts a JSON array (preferred)
 * or fenced ```json blocks. Invalid entries are dropped; never invents fields.
 */
export function parseInstinctDistillOutput(raw: string): InstinctCandidate[] {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return []

  const jsonText = extractJsonArray(trimmed)
  if (jsonText === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const out: InstinctCandidate[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const row = item as Record<string, unknown>
    let id: string
    try {
      if (typeof row.id !== 'string') continue
      id = validateInstinctId(row.id)
    } catch {
      continue
    }
    const trigger = typeof row.trigger === 'string' ? row.trigger.trim() : ''
    const action = typeof row.action === 'string' ? row.action.trim() : ''
    if (trigger.length === 0 || action.length === 0) continue
    if (typeof row.confidence !== 'number') continue
    let confidence: number
    try {
      confidence = clampInstinctConfidence(row.confidence)
    } catch {
      continue
    }
    const domain = typeof row.domain === 'string' ? row.domain.trim().slice(0, 64) : ''
    const evidence = Array.isArray(row.evidence)
      ? row.evidence.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
        .map((e) => e.trim())
      : []
    out.push({ id, trigger, action, confidence, domain, evidence })
  }
  return out
}

function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : text
  const start = candidate.indexOf('[')
  const end = candidate.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  return candidate.slice(start, end + 1)
}
