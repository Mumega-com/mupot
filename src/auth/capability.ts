// mupot — capability-core (SENSITIVE). The fine-grained, per-scope RBAC that makes
// the `capabilities` table real instead of decorative.
//
// Sovereign-core principle (same as src/auth): AuthZ is OURS. Identity is always
// server-derived — the caller's `memberId` comes from the session/token, never
// from message text or the request body. A capability check NEVER trusts a scope
// id supplied by the caller as proof of grant; it loads the member's own grant
// rows from D1 and evaluates them against the route's target scope.
//
// Exports (the FROZEN contract — peers build against these signatures):
//   - resolveCapabilities(env, memberId): Promise<CapabilityGrant[]>
//   - hasCapability(grants, scopeType, scopeId, min, squadDepartmentId?): boolean
//   - isOrgAdmin(auth): boolean                          — coarse owner|admin role
//   - requireCapability(scope, min): MiddlewareHandler   — per-route gate
//   - requireOrgCapability(min): MiddlewareHandler       — convenience over org scope
//
// Capability ladder (rank): owner(5) > admin(4) > lead(3) > member(2) > observer(1).
// Scope inheritance: an `org` grant covers every scope; a `department` grant covers
// its squads (when the squad's department id is supplied); a `squad` grant covers
// only itself. Grants never bubble UP (a squad/department grant is not an org grant).

import type { Context, MiddlewareHandler } from 'hono'
import type { Env, AuthContext, Capability, CapabilityGrant, CapabilityScopeType } from '../types'

// ── ladder ────────────────────────────────────────────────────────────────────

const RANK: Record<Capability, number> = {
  observer: 1,
  member: 2,
  lead: 3,
  admin: 4,
  owner: 5,
}

function meets(have: Capability, min: Capability): boolean {
  return RANK[have] >= RANK[min]
}

/**
 * Coarse org-role check: true when auth.role is owner or admin.
 * Shared by dashboard/API surfaces that gate on the legacy org role (not fine-grained grants).
 */
export function isOrgAdmin(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin'
}

// ── resolve (load grants, fail-closed) ─────────────────────────────────────────

/**
 * Load every capability grant for a member from D1. Returns [] (fail-closed) for
 * an unknown or grantless member — absence of grants is never a grant.
 */
export async function resolveCapabilities(env: Env, memberId: string): Promise<CapabilityGrant[]> {
  const rows = await env.DB.prepare(
    `SELECT member_id, scope_type, scope_id, capability
       FROM capabilities
      WHERE member_id = ?1
     UNION ALL
     SELECT member_id, 'squad' AS scope_type, squad_id AS scope_id, capability
       FROM channel_capability_grants
      WHERE member_id = ?1`,
  )
    .bind(memberId)
    .all<CapabilityGrant>()
  return rows.results ?? []
}

// ── pure check ──────────────────────────────────────────────────────────────────

/**
 * hasCapability — pure ladder + scope-inheritance check. No DB access.
 *
 * @param grants            the member's grant rows (from resolveCapabilities)
 * @param scopeType         the scope the route targets ('org' | 'department' | 'squad')
 * @param scopeId           the id of that scope (null for org)
 * @param min               the minimum capability required
 * @param squadDepartmentId OPTIONAL — when checking a 'squad' scope, the squad's
 *                          department_id, so a department grant can inherit down.
 *                          Omit it and the check is the safe subset (org + exact
 *                          scope), never over-granting.
 *
 * An 'org' grant covers ALL scopes. A 'department' grant covers its own squads
 * (only when squadDepartmentId names that department). A 'squad' grant covers
 * only itself. Grants never bubble UP.
 */
export function hasCapability(
  grants: CapabilityGrant[],
  scopeType: CapabilityScopeType,
  scopeId: string | null,
  min: Capability,
  squadDepartmentId?: string | null,
): boolean {
  for (const g of grants) {
    // An org-wide grant covers every scope.
    if (g.scope_type === 'org' && meets(g.capability, min)) return true

    // Exact-scope match (same type + same id).
    if (g.scope_type === scopeType && g.scope_id === scopeId && meets(g.capability, min)) {
      return true
    }

    // Department → squad inheritance: a grant on the squad's department covers it.
    if (
      scopeType === 'squad' &&
      g.scope_type === 'department' &&
      squadDepartmentId != null &&
      g.scope_id === squadDepartmentId &&
      meets(g.capability, min)
    ) {
      return true
    }
  }
  return false
}

// ── capability floor (deny-by-default chokepoint, #183 AAGATE) ──────────────────

/**
 * holdsCapabilityFloor — scope-AGNOSTIC capability floor for the MCP dispatch
 * chokepoint (#183). Returns true iff the principal holds `min`-or-higher on SOME
 * scope. Enforced centrally in `invokeTool` BEFORE a tool handler runs, so a tool
 * that declares `min` can never fail-open if its handler omits the inline scope
 * check: a caller who holds `min` on NO scope is rejected at the chokepoint.
 *
 * This is a FLOOR, not full authz. The handler's precise per-scope check (which
 * squad? department inheritance?) remains authoritative via hasCapability — the
 * floor closes the grantless / under-privileged case, NOT cross-scope confusion
 * (a member on squad A still passes the floor for a tool targeting squad B; the
 * handler's own check is what stops that). Defense-in-depth, not a replacement.
 *
 * Honors the same legacy-role escape as requireCapability: a pure web-login
 * owner/admin (no fine-grained `capabilities` array) satisfies the floor when
 * their org role ranks at/above `min` — so a dashboard owner is never locked out.
 */
export function holdsCapabilityFloor(auth: AuthContext, min: Capability): boolean {
  // Legacy web-login owner/admin: no fine-grained grants → judge by org role.
  if (auth.capabilities === undefined) {
    return legacyRoleSatisfies(auth.role, min)
  }
  return auth.capabilities.some((g) => meets(g.capability, min))
}

// ── scope extractor type (frozen) ──────────────────────────────────────────────

/** A route declares the scope it targets as a function of the request context. */
export type CapabilityScope = (c: Context) => { type: CapabilityScopeType; id: string | null }

// ── D1: resolve a squad's department for inheritance ───────────────────────────

async function resolveSquadDepartment(env: Env, squadId: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT department_id FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string }>()
  return r?.department_id ?? null
}

/**
 * canOnSquad — squad-scope capability check with department inheritance resolved from D1.
 * The canonical "can this member act on this squad" primitive (grants + department
 * inheritance, same ladder as hasCapability). Exported here — rather than only living as
 * mcp/index.ts's local `memberCanOnSquad` — so non-MCP callers (e.g. the agent-message send
 * call-path, src/agents/messages.ts) can reuse the SAME check without importing mcp/index.ts,
 * which would create a circular import (mcp/index.ts already imports agents/messages.ts).
 * mcp/index.ts's `memberCanOnSquad` delegates to this so there is exactly one implementation.
 */
export async function canOnSquad(
  env: Env,
  grants: CapabilityGrant[],
  squadId: string,
  min: Capability,
): Promise<boolean> {
  const deptId = await resolveSquadDepartment(env, squadId)
  return hasCapability(grants, 'squad', squadId, min, deptId)
}

// ── middleware ──────────────────────────────────────────────────────────────────

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

/**
 * requireCapability(scope, min) — gate a route on a fine-grained capability.
 *
 * Order of operations:
 *  1. Require an authenticated principal (401 if c.get('auth') is absent — the
 *     upstream requireAuth/member-authn must have run).
 *  2. Require a memberId — fine-grained capability is a MEMBER concept. (See the
 *     legacy-role escape below for pure dashboard owner/admin logins.)
 *  3. Load the member's grants (preferring auth.capabilities if already resolved
 *     by the authn layer, else resolveCapabilities).
 *  4. For a squad scope, resolve its department_id so department grants inherit.
 *  5. Allow → next(); deny → 403 { error: 'forbidden', need: min }.
 *
 * Legacy-role escape (do NOT lock owners out): a pure web-login owner/admin has an
 * org role but no `capabilities` array and no memberId. For ORG-scope checks only,
 * such a principal satisfies the check when their org role (owner/admin) ranks at
 * or above `min`. This is capability OR legacy-role — it never WIDENS a member's
 * grants, only preserves the existing dashboard-owner path.
 */
export function requireCapability(scope: CapabilityScope, min: Capability): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth')
    if (!auth) return c.json({ error: 'unauthenticated' }, 401)

    const target = scope(c)

    // Legacy-role escape — only for org-scope checks, only for a pure web login
    // (no fine-grained capabilities present). Org role owner/admin satisfies an
    // org-scope capability check so a dashboard owner is never locked out.
    if (target.type === 'org' && auth.capabilities === undefined) {
      if (legacyRoleSatisfies(auth.role, min)) {
        await next()
        return
      }
      return c.json({ error: 'forbidden', need: min }, 403)
    }

    // Fine-grained RBAC is a member concept: a principal acting on a non-org scope
    // (or carrying resolved capabilities) must be a member.
    if (!auth.memberId) {
      // A web-login owner/admin may still act on org-scope via the escape above;
      // reaching here means a department/squad scope with no member identity.
      if (target.type === 'org' && legacyRoleSatisfies(auth.role, min)) {
        await next()
        return
      }
      return c.json({ error: 'forbidden', need: min }, 403)
    }

    const grants = auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId))

    let squadDepartmentId: string | null = null
    if (target.type === 'squad' && target.id !== null) {
      squadDepartmentId = await resolveSquadDepartment(c.env, target.id)
    }

    if (hasCapability(grants, target.type, target.id, min, squadDepartmentId)) {
      await next()
      return
    }

    return c.json({ error: 'forbidden', need: min }, 403)
  }
}

/** requireOrgCapability(min) — convenience over the fixed org scope. */
export function requireOrgCapability(min: Capability): MiddlewareHandler<AppEnv> {
  return requireCapability(() => ({ type: 'org', id: null }), min)
}

// A pure web-login owner/admin (no capabilities array) satisfies ORG-scope checks
// when their coarse org role ranks at/above the required capability. owner→owner,
// admin→admin on the same ladder. A plain 'member' org role grants nothing here —
// members must carry real capability grants.
function legacyRoleSatisfies(role: AuthContext['role'], min: Capability): boolean {
  if (role === 'owner') return meets('owner', min)
  if (role === 'admin') return meets('admin', min)
  return false
}

// ── grant ceiling ─────────────────────────────────────────────────────────────
// You cannot grant (or invite at) a capability ABOVE your own effective level on
// the target scope. Without this, a department-admin could invite an 'owner' on
// their own department, or an org-admin could grant org 'owner' — vertical
// privilege escalation (P0/P1 from the member-network review).

export function capabilityRank(cap: Capability): number {
  return RANK[cap]
}

/** The acting principal's highest effective capability rank on a scope — their
 *  grants OR their coarse org role (owner=5, admin=4). 0 = no standing. */
export async function actorMaxRankOnScope(
  c: Context<AppEnv>,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
): Promise<number> {
  const auth = c.get('auth')
  let max = auth.role === 'owner' ? RANK.owner : auth.role === 'admin' ? RANK.admin : 0
  if (auth.memberId) {
    const grants = auth.capabilities ?? (await resolveCapabilities(c.env, auth.memberId))
    const squadDept =
      scopeType === 'squad' && scopeId ? await resolveSquadDepartment(c.env, scopeId) : null
    // highest capability that resolves true on this scope = the actor's ceiling
    for (const cap of ['owner', 'admin', 'lead', 'member', 'observer'] as Capability[]) {
      if (hasCapability(grants, scopeType, scopeId, cap, squadDept ?? undefined)) {
        max = Math.max(max, RANK[cap])
        break
      }
    }
  }
  return max
}

// ── surface-capability gate (#106) ────────────────────────────────────────────
// Per-surface capabilities (e.g. 'outreach:send-gated', 'budget:write',
// 'content:write') are stored as free-text rows in the gate_grants table.
// At mint time, mintScopedKey writes one gate_grants row per surface in
// the preset's allows list. hasSurfaceCap queries that table; owner/admin
// always pass (rank bypass — the ladder already covers them).
//
// This is intentionally separate from the RANK ladder: rank says "how high
// can you act on this scope"; surface caps say "which named actions are
// your token explicitly allowed to take". Both must pass on gated paths.

/**
 * Check whether a principal holds the named surface capability in gate_grants.
 * Owner / admin roles bypass the check (rank is sufficient for them).
 */
export async function hasSurfaceCap(env: Env, auth: AuthContext, surface: string): Promise<boolean> {
  if (isOrgAdmin(auth)) return true
  const principalId = auth.memberId ?? auth.userId
  const principalType: 'member' | 'agent' = auth.memberId ? 'member' : 'agent'
  if (!principalId) return false
  const row = await env.DB.prepare(
    `SELECT 1 FROM gate_grants
      WHERE capability     = ?1
        AND principal_type = ?2
        AND principal_id   = ?3
      LIMIT 1`,
  )
    .bind(surface, principalType, principalId)
    .first<{ 1: number }>()
  return row !== null
}

/**
 * Route-level middleware that 403s when the auth context lacks the named
 * surface capability. Must run after requireAuth.
 */
export function requireSurfaceCap(surface: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth')
    if (!auth) return c.json({ error: 'unauthenticated' }, 401)
    const ok = await hasSurfaceCap(c.env, auth, surface)
    if (!ok) return c.json({ error: 'forbidden', need: surface }, 403)
    await next()
  }
}
