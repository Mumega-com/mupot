// src/gates/lanes.ts — canonical gate lanes (gate_grants capabilities named
// `gate:<owner>`). One named constant per lane so a gate lane is a compile-time
// reference, not a string typed from memory at each call site.
//
// Flight-006 Slice 3: weaves the Synthetic Council gate (Athena) into the mupot
// gate substrate as a first-class lane. The routing machinery is generic over
// `gate:<owner>` (resolveSoleGateOwnerAgent → wakeGateOwnerOnReview →
// needs_you_list); once `gate:athena` is granted to the Athena agent principal
// (an org:admin action via grant_gate_capability), tasks/flights that set
// gate_owner='gate:athena' resolve and wake her automatically.

export const GATE_ATHENA = 'gate:athena'
export const GATE_KASRA_CORE = 'gate:kasra-core'
export const GATE_LOOPS = 'gate:loops'
export const GATE_AGENT_SELF_COMPLETION = 'gate:agent-self-completion'
export const GATE_CONTENT = 'gate:content'
export const GATE_OUTREACH = 'gate:outreach'
export const GATE_ROUTINES = 'gate:routines'
export const GATE_PROJECT_COMPLETION = 'gate:project-completion'
export const GATE_ESCALATION = 'gate:escalation'
export const GATE_ADDONS = 'gate:addons'

export interface CouncilGateLane {
  readonly lane: string
  readonly agentSlug: string
  readonly purpose: string
}

/**
 * Synthetic Council gate lanes currently tracked in this registry → the council
 * agent that owns the lane. This is NOT the full set of live gate:owner lanes:
 * system lanes such as gate:loops (src/loops/gate.ts) and gate:agent-self-completion
 * are intentionally omitted here because no single council agent owns them.
 */
export const COUNCIL_GATE_LANES = {
  athena: {
    lane: GATE_ATHENA,
    agentSlug: 'athena',
    purpose: 'correctness/security gate',
  },
  kasraCore: {
    lane: GATE_KASRA_CORE,
    agentSlug: 'kasra',
    purpose: 'build/runtime gate',
  },
} as const satisfies Record<string, CouncilGateLane>

export const COUNCIL_GATE_LANE_VALUES: readonly string[] = Object.values(COUNCIL_GATE_LANES).map(
  (x) => x.lane,
)

/** The canonical lane owned by a council agent slug, or null when none is declared. */
export function councilGateLaneFor(slug: string): string | null {
  for (const entry of Object.values(COUNCIL_GATE_LANES)) {
    if (entry.agentSlug === slug) return entry.lane
  }
  return null
}
