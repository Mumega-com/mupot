// mupot — brain effort → idle harness router (pure).
//
// Config ladder + narrow action space (assign | skip | escalate). No restart/heal
// anywhere in this path — that is the #490 false-service-restart failure mode.
// Side-effect-free: callers (concierge work-router) supply online/load and apply
// the decision. Daily-pack cron is deferred out of v1.

/** Work role the router classifies toward. */
export type HarnessRole = 'research' | 'build' | 'review' | 'operate'

/** Effort band used for ladder selection (agent work-unit "sprint" maps to high). */
export type RouteEffort = 'low' | 'standard' | 'high'

/** Only legal actions from this router — never restart/heal. */
export type RouteAction = 'assign' | 'skip' | 'escalate'

/** Role capability tags declared on harnesses (agents.capabilities / presence). */
export const ROLE_CAPABILITY = {
  research: 'research',
  build: 'build',
  review: 'review',
} as const

export type RoleCapability = (typeof ROLE_CAPABILITY)[keyof typeof ROLE_CAPABILITY]

/**
 * Canonical role tags per harness slug. Known harnesses are AUTHORITATIVE —
 * presence cannot grant agy build/review. Unknown slugs fall through to the
 * caps they declared on the roster (backward-compatible for ad-hoc builders).
 *
 * Ladder (approved 2026-07-22, kasra GREEN + amendments):
 *   research low–std: agy → kayhermes → kasra
 *   research high:    kasra → agy
 *   build low–std:    cursor → kasra
 *   build high:       kasra → cursor
 *   review any:       codex → kasra   (agy stays research-only — NOT on review)
 *   operate / gates:  kasra only
 */
export const HARNESS_CAPABILITIES: Readonly<Record<string, readonly RoleCapability[]>> = {
  kasra: [ROLE_CAPABILITY.build, ROLE_CAPABILITY.research, ROLE_CAPABILITY.review],
  cursor: [ROLE_CAPABILITY.build],
  codex: [ROLE_CAPABILITY.review],
  agy: [ROLE_CAPABILITY.research],
  kayhermes: [ROLE_CAPABILITY.research],
}

const RESEARCH_LOW_STD: readonly string[] = ['agy', 'kayhermes', 'kasra']
const RESEARCH_HIGH: readonly string[] = ['kasra', 'agy']
const BUILD_LOW_STD: readonly string[] = ['cursor', 'kasra']
const BUILD_HIGH: readonly string[] = ['kasra', 'cursor']
const REVIEW_ANY: readonly string[] = ['codex', 'kasra']
const OPERATE_ANY: readonly string[] = ['kasra']

export interface OnlineHarness {
  slug: string
  /** Presence-declared caps (ignored for known harnesses — HARNESS_CAPABILITIES wins). */
  capabilities: readonly string[]
}

export interface RouteByEffortInput {
  role: HarnessRole
  effort: RouteEffort
  online: readonly OnlineHarness[]
  /** Open assigned load keyed by harness slug. */
  load: ReadonlyMap<string, number>
  maxLoadPerAgent: number
}

export interface RouteByEffortResult {
  action: RouteAction
  /** Chosen harness slug when action === 'assign'; otherwise null. */
  agentSlug: string | null
  /** Config ladder for this role+effort (before idle filtering). */
  ladder: readonly string[]
}

/** Effective caps: known harness map overrides presence (agy never gains build/review). */
export function effectiveHarnessCapabilities(
  slug: string,
  presenceCapabilities: readonly string[],
): readonly string[] {
  const known = HARNESS_CAPABILITIES[slug]
  if (known !== undefined) return known
  return presenceCapabilities
}

export function harnessHasRoleCapability(
  slug: string,
  presenceCapabilities: readonly string[],
  role: HarnessRole,
): boolean {
  if (role === 'operate') {
    // Operate/gates: kasra only — no capability tag required beyond ladder membership.
    return slug === 'kasra'
  }
  const needed = ROLE_CAPABILITY[role]
  return effectiveHarnessCapabilities(slug, presenceCapabilities).includes(needed)
}

/** Config ladder for role + effort. Review/operate ignore effort banding. */
export function effortLadder(role: HarnessRole, effort: RouteEffort): readonly string[] {
  if (role === 'operate') return OPERATE_ANY
  if (role === 'review') return REVIEW_ANY
  if (role === 'research') {
    return effort === 'high' ? RESEARCH_HIGH : RESEARCH_LOW_STD
  }
  // build
  return effort === 'high' ? BUILD_HIGH : BUILD_LOW_STD
}

function isIdle(
  slug: string,
  load: ReadonlyMap<string, number>,
  maxLoadPerAgent: number,
): boolean {
  return (load.get(slug) ?? 0) < maxLoadPerAgent
}

/**
 * routeByEffort — pick the preferred idle online harness for a role+effort.
 *
 * Action space (narrow, #490):
 *   assign   — first ladder (then fallback) candidate that is online, capable, idle
 *   skip     — nobody online at all (noop; try next tick)
 *   escalate — online harnesses exist but none are capable+idle for this role
 *
 * After the config ladder, remaining online agents that hold the role capability
 * are considered in input order (preserves ad-hoc builders not on the ladder).
 */
export function routeByEffort(input: RouteByEffortInput): RouteByEffortResult {
  const { role, effort, online, load, maxLoadPerAgent } = input
  const ladder = effortLadder(role, effort)

  if (online.length === 0) {
    return { action: 'skip', agentSlug: null, ladder }
  }

  const bySlug = new Map<string, OnlineHarness>()
  for (const agent of online) {
    if (!bySlug.has(agent.slug)) bySlug.set(agent.slug, agent)
  }

  const tryPick = (slug: string): string | null => {
    const agent = bySlug.get(slug)
    if (!agent) return null
    if (!harnessHasRoleCapability(slug, agent.capabilities, role)) return null
    if (!isIdle(slug, load, maxLoadPerAgent)) return null
    return slug
  }

  for (const slug of ladder) {
    const picked = tryPick(slug)
    if (picked !== null) {
      return { action: 'assign', agentSlug: picked, ladder }
    }
  }

  // Fallback: online agents not on the ladder (or ladder exhausted) that still
  // hold the role capability — e.g. a test/ad-hoc builder with presence build.
  const seen = new Set(ladder)
  for (const agent of online) {
    if (seen.has(agent.slug)) continue
    seen.add(agent.slug)
    const picked = tryPick(agent.slug)
    if (picked !== null) {
      return { action: 'assign', agentSlug: picked, ladder }
    }
  }

  return { action: 'escalate', agentSlug: null, ladder }
}

export interface ClassifyTaskInput {
  title: string
  body: string
}

/**
 * classifyTaskRoleEffort — cheap heuristic over title/body.
 * Explicit markers win: `[role:research]` / `[effort:high]`.
 * Default when unclassified: build + standard (the pre-router work-router default).
 */
export function classifyTaskRoleEffort(input: ClassifyTaskInput): {
  role: HarnessRole
  effort: RouteEffort
} {
  const text = `${input.title}\n${input.body}`

  const roleMarker = text.match(/\[role:\s*(research|build|review|operate)\s*\]/i)
  const effortMarker = text.match(/\[effort:\s*(low|standard|high)\s*\]/i)

  let role: HarnessRole = 'build'
  if (roleMarker) {
    role = roleMarker[1].toLowerCase() as HarnessRole
  } else if (/\b(code[\s-]?review|peer[\s-]?review|\breview\b)/i.test(text)) {
    role = 'review'
  } else if (/\b(research|investigate|recon)\b/i.test(text)) {
    role = 'research'
  } else if (/\b(operate|ops:|gate:|restart|heal)\b/i.test(text)) {
    role = 'operate'
  }

  let effort: RouteEffort = 'standard'
  if (effortMarker) {
    effort = effortMarker[1].toLowerCase() as RouteEffort
  } else if (/\b(high|urgent|critical|p0)\b/i.test(text)) {
    effort = 'high'
  } else if (/\b(low|trivial|chore)\b/i.test(text)) {
    effort = 'low'
  }

  return { role, effort }
}
