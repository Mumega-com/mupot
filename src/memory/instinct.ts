// Port 4 — confidence-scored instinct memory (ECC continuous-learning-v2 port).
//
// Atomic instincts: one trigger, one action, confidence 0.3–0.9, project|global
// scope, evidence-backed. Promotion gate: ≥2 distinct projects AND avg confidence
// ≥0.8 (FRC no-silent-promotion, mechanical). Pure functions; persistence in
// instinct-service.ts.

export type InstinctScope = 'project' | 'global' | 'agent'

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

const INSTINCT_SCOPES: readonly InstinctScope[] = ['project', 'global', 'agent']

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
 * Instincts eligible for SessionStart injection: confidence ≥ threshold,
 * highest confidence first, capped.
 */
export function filterInstinctsForInject(
  instincts: readonly Instinct[],
  opts: InstinctInjectOpts,
): Instinct[] {
  return instincts
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
    const rank = (scope: InstinctScope): number => {
      if (scope === 'project') return 3
      if (scope === 'agent') return 2
      return 1
    }
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
