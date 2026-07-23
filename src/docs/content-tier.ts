/**
 * Docs content-tier policy (keystone) — ONE enforcement point for human session
 * tokens and agent mupot tokens.
 *
 * Port of Inkwell's `workers/inkwell-api/src/middleware/content-tier.ts`, extended
 * so both principal kinds resolve through the same claim set + the same
 * `checkContentTier` function. Principal kind is never consulted by the gate:
 * an agent's entity_id / roles / capabilities are just another claim bag.
 *
 * Six tiers (public / squad / project / role / entity / private) plus the
 * optional `permitted_roles` allowlist and entity_id claim-match.
 *
 * Later docs slices (memory unification, docs view, editing) MUST call this
 * function — do not introduce a parallel agent-RBAC path.
 */

export type ContentTier = 'public' | 'squad' | 'project' | 'role' | 'entity' | 'private'

export interface ContentTierContext {
  /** The access tier of this content item */
  tier: ContentTier
  /** Required when tier = 'entity' — must match claims.entity_id */
  entity_id?: string
  /** Required when tier = 'private' — must match claims.user_id */
  created_by?: string
  /** Optional allowlist of roles that may access this item (all tiers) */
  permitted_roles?: string[]
}

/**
 * Normalized claim set. Produced from a human session OR an agent token.
 * `checkContentTier` only reads these fields — never principal kind.
 */
export interface TierClaims {
  /** Session user / agent id (used for 'private' tier) */
  user_id?: string
  /** Squad membership claim (used for 'squad' tier) */
  squad_id?: string
  /** Project membership claim (used for 'project' tier) */
  project_id?: string
  /** Entity association claim (used for 'entity' tier) */
  entity_id?: string
  /** Role string (used for 'role' tier + permitted_roles) */
  role?: string
  /** Capability strings carried by agent tokens; not consulted by the tier gate */
  capabilities?: readonly string[]
}

/** @deprecated Use TierClaims — kept as an alias for Inkwell parity. */
export type TierSession = TierClaims

export interface TierCheckResult {
  allowed: boolean
  reason?: string
}

/** Raw human session shape (Inkwell AuthSession-style + optional tier claims). */
export interface HumanSessionClaims {
  identityId?: string
  user_id?: string
  role?: string
  squad_id?: string
  project_id?: string
  entity_id?: string
}

/** Raw agent mupot token shape (bound agent + optional tier claims). */
export interface AgentTokenClaims {
  agent_id?: string
  user_id?: string
  role?: string
  squad_id?: string
  project_id?: string
  entity_id?: string
  capabilities?: readonly string[]
}

/**
 * Map a human session token's fields into the shared claim set.
 * Field aliases (identityId vs user_id) collapse here — not in the gate.
 */
export function claimsFromHumanSession(session: HumanSessionClaims): TierClaims {
  const user_id = session.user_id ?? session.identityId
  return {
    user_id: user_id,
    role: session.role,
    squad_id: session.squad_id,
    project_id: session.project_id,
    entity_id: session.entity_id,
  }
}

/**
 * Map an agent mupot token's fields into the shared claim set.
 * Same shape as human; principal kind is discarded before the gate.
 */
export function claimsFromAgentToken(token: AgentTokenClaims): TierClaims {
  const user_id = token.user_id ?? token.agent_id
  return {
    user_id: user_id,
    role: token.role,
    squad_id: token.squad_id,
    project_id: token.project_id,
    entity_id: token.entity_id,
    capabilities: token.capabilities,
  }
}

/**
 * Pure function: check if a claim set satisfies a content item's tier requirements.
 * Returns { allowed: true } or { allowed: false, reason: "..." }.
 *
 * Intentionally decoupled from Hono / AuthContext so human and agent callers
 * share one path. Pass null claims for unauthenticated.
 */
export function checkContentTier(
  ctx: ContentTierContext,
  claims: TierClaims | null,
): TierCheckResult {
  const { tier, entity_id, created_by, permitted_roles } = ctx

  // ── Tier gate ──────────────────────────────────────────────────────────────
  if (tier === 'public') {
    // Public content: skip tier check, fall through to role allowlist below
  } else {
    if (!claims) {
      return { allowed: false, reason: 'unauthenticated' }
    }

    switch (tier) {
      case 'squad':
        if (!claims.squad_id) {
          return { allowed: false, reason: 'missing_squad_membership' }
        }
        break

      case 'project':
        if (!claims.project_id) {
          return { allowed: false, reason: 'missing_project_membership' }
        }
        break

      case 'role':
        if (!claims.role) {
          return { allowed: false, reason: 'missing_role' }
        }
        break

      case 'entity':
        if (!entity_id) {
          return { allowed: false, reason: 'content_missing_entity_id' }
        }
        if (claims.entity_id !== entity_id) {
          return { allowed: false, reason: 'entity_id_mismatch' }
        }
        break

      case 'private':
        if (!created_by) {
          return { allowed: false, reason: 'content_missing_created_by' }
        }
        if (claims.user_id !== created_by) {
          return { allowed: false, reason: 'not_creator' }
        }
        break

      default: {
        const _exhaustive: never = tier
        return { allowed: false, reason: `unknown_tier:${_exhaustive}` }
      }
    }
  }

  // ── Role allowlist gate (applies to ALL tiers, including public) ───────────
  if (permitted_roles && permitted_roles.length > 0) {
    const callerRole = claims?.role
    if (!callerRole || !permitted_roles.includes(callerRole)) {
      return { allowed: false, reason: 'role_not_permitted' }
    }
  }

  return { allowed: true }
}
