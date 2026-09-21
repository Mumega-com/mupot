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
//   - isOrgAdmin(auth): boolean                          — org owner|admin, on EITHER plane
//                                                          (legacy role OR an org-scope grant)
//   - requireCapability(scope, min): MiddlewareHandler   — per-route gate
//   - requireOrgCapability(min): MiddlewareHandler       — convenience over org scope
//
// Capability ladder (rank): owner(5) > admin(4) > lead(3) > member(2) > observer(1).
// Scope inheritance: an `org` grant covers every scope; a `department` grant covers
// its squads (when the squad's department id is supplied); a `squad` grant covers
// only itself. Grants never bubble UP (a squad/department grant is not an org grant).

import type { Context, MiddlewareHandler } from 'hono'
import type { Env, AuthContext, Capability, CapabilityGrant, CapabilityScopeType, OrgKind } from '../types'
import { hasActiveGateGrant } from '../gates/grants'
import { resolveGatePrincipal } from '../gates/principal'

// ── squad scope (mupot#1452 round 2 successor, G-FP1b point 1) ────────────────
//
// mupot#1452 round 2 tried to exclude `kind='home'` squads from inherited
// authority by adding an OPTIONAL "squadKind" (typed `OrgKind`, question-mark
// modifier) parameter to
// hasCapability/canOnSquad/canOnSquadAuth. An optional parameter on an authz
// predicate is the opposite of a chokepoint: every one of the ~25 existing
// call sites that did not know about the new parameter silently kept the OLD
// (kind-blind) behaviour, and the round-2 adversarial pass demonstrated the
// exact bypass on org-scope grants, elevation, invites, flight-spine, and
// projects/access. See MEMORY
// feedback_optional_parameter_on_authz_predicate_is_not_a_chokepoint.md.
//
// The fix is structural, not another parameter: a squad-scope capability
// check REQUIRES a `SquadScope` — id + department_id + kind, loaded fresh
// from D1 by the ONE function below — never a bare `string` id. hasCapability
// is overloaded so that `hasCapability(grants, 'squad', someSquadId, min)`
// with `someSquadId: string` FAILS TO TYPECHECK; only a real `SquadScope`
// (from `loadSquadScope`, or a full `Squad`/`HomeSquadRow`-shaped object that
// structurally satisfies it) is accepted. scripts/check-bare-squad-id-authz.mjs
// is the CI-side belt (catches a `// @ts-expect-error`/`as any` escape around
// this at the text level); the typechecker is the braces.
// Adversarial round 1 on G-FP1b (P1, Athena): a 1-of-9-escapes ratchet plus a
// plain structural type let a caller fabricate a SquadScope out of thin air
// (a hoisted `as SquadScope`, a hand-built `{id, department_id, kind: 'work'}`
// literal, kind lifted straight off a request body) and every one of those
// would typecheck cleanly against a bare `{id, department_id, kind}`
// interface. `SQUAD_SCOPE_BRAND` is a module-private symbol never exported —
// only `brandSquadScope` (below) can attach it, so a caller anywhere else in
// the tree that writes out the three visible fields by hand gets a TYPE
// ERROR (missing the brand), not a silently-accepted scope. Every
// construction site in this codebase goes through `brandSquadScope` with
// fields that just came out of a real `squads` row (loadSquadScope, or a
// query result already shaped like one) — never from a request body, an
// elevation grant, or a hand-typed literal.
declare const SQUAD_SCOPE_BRAND: unique symbol

export interface SquadScope {
  readonly [SQUAD_SCOPE_BRAND]: true
  id: string
  department_id: string
  kind: OrgKind
}

/**
 * brandSquadScope — the ONLY sanctioned way to construct a `SquadScope` from
 * raw fields. Callers must be able to point at the real `squads` row the
 * fields came from (a `loadSquadScope`/`resolveSquadRef`/`getSquad`-style
 * query result, or a full `Squad` row) — never a value assembled from a
 * request body, an elevation grant's own scope_id/kind pair, or a literal
 * typed in by hand for convenience. This is a thin, deliberately unchecked
 * cast at the one seam that must exist for the type to be constructible at
 * all; it carries no runtime validation because its whole job is to be the
 * single grep-able chokepoint a reviewer (or a future ratchet) can point at,
 * not to re-verify what its caller already fetched from D1.
 */
export function brandSquadScope(fields: { id: string; department_id: string; kind: OrgKind }): SquadScope {
  // The ONE sanctioned unchecked cast in this codebase for this type — see
  // the doc comment above for why this exists and what may call it.
  return fields as unknown as SquadScope
}

/**
 * loadSquadScope — the ONE loader for a squad's authz-relevant shape. Every
 * squad-scope capability check must go through this (or already hold a
 * structurally-compatible object, e.g. a full `Squad` row) rather than
 * resolving `department_id`/`kind` piecemeal — that piecemeal pattern is
 * exactly what let round 2's `kind` exclusion miss ~25 call sites that
 * resolved department_id alone and never looked at kind at all.
 */
export async function loadSquadScope(env: Env, squadId: string): Promise<SquadScope | null> {
  const row = await env.DB.prepare('SELECT id, department_id, kind FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ id: string; department_id: string; kind: OrgKind }>()
  return row ? brandSquadScope(row) : null
}

/**
 * planeCoversScope — G-FP1b point 2. A `kind='home'` squad (a member's own
 * private room, written ONLY by `createHomeForMember`) is capability-dead to
 * every INHERITED authority plane: an org-scope grant, a department-scope
 * grant, and the legacy `auth.role` owner/admin plane all answer false here
 * for a home scope. The ONLY plane that ever covers a home squad is an EXACT
 * squad-scope grant on that exact squad (the direct admin row
 * `createHomeForMember` writes) — that check does not call this helper at
 * all, by design, because it is not inheritance.
 *
 * This is intentionally the SAME answer for every plane today (org,
 * department, role) — kept as three named call sites rather than one
 * `if (scope.kind === 'home') return false` inlined three times, so (a) a
 * future plane-specific carve-out has one place to add a branch, and (b) a
 * reviewer/grep can see every plane this file believes can reach a squad and
 * confirm none of them was missed — the exact class of miss round 2 had.
 *
 * TABLE INVENTORY (adversarial round 1, Athena — every table that can yield
 * squad-scope authority, and what gates its WRITER against a home target;
 * the next grant table should be added here and gated the same way):
 *
 *   capabilities              — the primary grant table. WRITERS: src/members/index.ts's
 *                                POST /members/:id/capabilities (home_scope_not_grantable),
 *                                src/mcp/provision.ts's grant_agent_capability
 *                                (home_scope_not_grantable, checked before elevation),
 *                                src/members/squad-membership.ts's addSquadMember/
 *                                removeSquadMember (home_squad_immutable),
 *                                src/members/project-invites.ts's createProjectInvite
 *                                (home_scope_not_invitable), src/onboarding/doors.ts's
 *                                selfGrant (home_scope_not_grantable). The ONLY writer that
 *                                MAY target a home is org/service.ts's createHomeForMember
 *                                (the member's own exact-match admin row).
 *   channel_capability_grants — a SECOND capabilities-shaped table, unioned into
 *                                resolveCapabilities below as scope_type='squad' exact rows.
 *                                WRITERS: src/channels/admin.ts's POST /bindings
 *                                (home_scope_not_grantable at bind time) and
 *                                src/channels/sync.ts's ensureSquadGrant (belt-and-braces
 *                                refusal, since a binding could predate the fix). READER
 *                                BELT: resolveCapabilities' UNION branch for this table
 *                                JOINs squads.kind and drops any row where kind='home' at
 *                                resolution time, so an already-poisoned row can never
 *                                resolve as live authority even before a cleanup runs
 *                                (scripts/cleanup-home-channel-grants.mjs is the idempotent
 *                                data-hygiene follow-up for existing rows).
 *   elevation_grants           — time-boxed, NEVER standing. src/auth/elevation.ts's
 *                                createElevationRequest refuses to even REQUEST
 *                                action:home_access at org/department scope, and
 *                                hasElevatedAction's matcher gates its own org/department
 *                                inheritance limbs through this exact function. The
 *                                approver-authority re-check (also in hasElevatedAction)
 *                                means only a home's exact-grant holder can durably remain
 *                                the approver — see tests/home-access-elevation.test.ts.
 *   memberships                — agent↔squad RBAC edge (mirrors `capabilities` for AGENTS
 *                                rather than members). Same writers as `capabilities` above
 *                                (addSquadMember/removeSquadMember write both in one
 *                                transaction), so the same home_squad_immutable refusal
 *                                covers it — there is no separate memberships writer.
 *   gate_grants                — NOT squad-scoped. A gate_grants row names a free-text
 *                                'gate:*' surface capability tied to a principal
 *                                (migrations/0008_gate_grants.sql) — it has no scope_id/
 *                                squad concept at all, so it cannot confer authority on a
 *                                home squad by construction. No guard needed.
 *   project_squad_access       — DELIBERATELY UNGUARDED, on purpose. This is a squad's own
 *                                OUTBOUND grant of access TO a project (project_squad_set/
 *                                project_squad_remove, src/mcp/projects.ts) — the opposite
 *                                direction from "who has capability ON the squad". FP-01
 *                                Slice 2's own design uses this to give a member's home
 *                                write access to a project; blocking it would break the
 *                                feature this flight exists to build. It never grants
 *                                anyone entry INTO the squad itself.
 */
export type CapabilityPlane = 'org' | 'department' | 'role'

export function planeCoversScope(plane: CapabilityPlane, scope: SquadScope): boolean {
  if (scope.kind === 'home') return false
  // Reference the parameter so a future per-plane carve-out is a small diff,
  // not a signature change — every current plane answers identically.
  void plane
  return true
}

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
 * isOrgAdmin — "may this principal act as an org admin?", asked of BOTH RBAC planes.
 *
 * This gates every dashboard admin surface (Operations, Deployment, Addons,
 * Marketing/CRO, People & Access, Scoped Keys, Connectors, GitHub, Create-agent,
 * Mint-agent-token, the addon consoles). It used to read ONLY `auth.role` — the
 * coarse legacy column that `src/types.ts` itself annotates "capabilities are the
 * fine grain". That column is written exactly once, at account creation
 * (src/auth/index.ts: first account ever → 'owner', every later account →
 * 'member', permanently), and no supported interface can change it afterwards:
 * there is no update_member / set_member_role tool, and migrations/0002_members.sql
 * has no role column at all. So an operator whose account was created second could
 * never reach an admin page — including the org OWNER, whose ownership lives as a
 * capability row (scope 'org' → 'owner') that this function did not read. Measured
 * on the credential that holds org ownership: role='member', capabilities org→owner,
 * and GET /admin/agent-token answered 403. (Issue #530: which RBAC plane is canonical.)
 *
 * The MCP plane already asked the right question — src/mcp/index.ts does
 * `hasCapability(grants, 'org', null, 'admin')`. Same question, two answers. This
 * makes the dashboard agree with it.
 *
 * SHAPE — capability OR legacy role, never AND:
 *   1. legacy `role` owner|admin still admits (the bootstrap owner has no grant
 *      rows at all; dropping this would lock the FIRST account out instead of the
 *      second). It is an additional ACCEPT, never a REQUIREMENT.
 *   2. an ORG-scope grant of 'admin' or higher admits. One `hasCapability` call
 *      covers both 'admin' and 'owner': the ladder ranks owner(5) above admin(4),
 *      so an org→owner grant meets min='admin'.
 *
 * WIDENING IS THE DANGEROUS DIRECTION — what this deliberately does NOT admit:
 *   - a squad-scope or department-scope admin/owner grant. hasCapability's org
 *     branch matches `scope_type === 'org'` only, and grants never bubble UP, so
 *     squad admin does not become org admin. That is the escalation this function
 *     must never allow.
 *   - `latentCapabilities`. On a directory-channel session the B1 ceiling zeroes
 *     ambient authority and parks the real grants in `latentCapabilities`; reading
 *     them here would reinstate exactly the silent inheritance that ceiling exists
 *     to prevent (#712). We read `capabilities`, the ambient view, only.
 *   - a principal with no grants and a plain 'member' role — unchanged, still refused.
 */
export function isOrgAdmin(auth: AuthContext | null | undefined): boolean {
  if (!auth) return false
  // Legacy plane — still honoured, so the bootstrap owner never regresses.
  if (auth.role === 'owner' || auth.role === 'admin') return true
  // Modern plane — an ORG-scope grant at admin rank or above.
  if (auth.capabilities === undefined) return false
  return hasCapability(auth.capabilities, 'org', null, 'admin')
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
     -- G-FP1b point 4/P0-2 (Athena's resolver-side belt): channel_capability_grants
     -- is written ONLY by ensureSquadGrant (src/channels/sync.ts), which now
     -- refuses a home-squad target — but this JOIN+filter also protects
     -- against an already-poisoned row from before that fix (or any future
     -- writer that forgets the check): a channel-derived grant on a squad
     -- that is (or has since become) kind='home' never resolves as a live
     -- grant, full stop. The capabilities table's OWN squad-scope rows are
     -- NOT filtered this way — a home's exact-match admin grant
     -- (createHomeForMember's own write) must still resolve.
     SELECT ccg.member_id, 'squad' AS scope_type, ccg.squad_id AS scope_id, ccg.capability
       FROM channel_capability_grants ccg
       JOIN squads s ON s.id = ccg.squad_id
      WHERE ccg.member_id = ?1 AND s.kind != 'home'`,
  )
    .bind(memberId)
    .all<CapabilityGrant>()
  return rows.results ?? []
}

// ── pure check ──────────────────────────────────────────────────────────────────

/**
 * hasCapability — pure ladder + scope-inheritance check. No DB access.
 *
 * OVERLOADED (G-FP1b point 1): a 'squad' scope check REQUIRES a `SquadScope`
 * object (id + department_id + kind), never a bare string id — passing a
 * plain squad-id string where the compiler expects a SquadScope is a
 * TYPE ERROR, not a runtime under-check. Load one with `loadSquadScope`, or
 * pass a full `Squad`/`HomeSquadRow` row (either structurally satisfies it).
 *
 * An 'org' grant covers ALL scopes EXCEPT a home squad (see
 * `planeCoversScope`). A 'department' grant covers its own squads the same
 * way. A 'squad' grant covers only itself — including a home squad, since
 * that is an EXACT match, not inheritance. Grants never bubble UP.
 */
export function hasCapability(grants: CapabilityGrant[], scopeType: 'org', scopeId: null, min: Capability): boolean
export function hasCapability(
  grants: CapabilityGrant[],
  scopeType: 'department',
  scopeId: string,
  min: Capability,
): boolean
export function hasCapability(
  grants: CapabilityGrant[],
  scopeType: 'squad',
  scope: SquadScope,
  min: Capability,
): boolean
export function hasCapability(
  grants: CapabilityGrant[],
  scopeType: CapabilityScopeType,
  scopeIdOrScope: string | null | SquadScope,
  min: Capability,
): boolean {
  if (scopeType === 'squad') {
    const scope = scopeIdOrScope as SquadScope
    for (const g of grants) {
      // Exact squad-scope grant always covers itself — this is what makes a
      // home squad's own direct admin row (createHomeForMember) work; it is
      // NOT inheritance, so planeCoversScope does not gate it.
      if (g.scope_type === 'squad' && g.scope_id === scope.id && meets(g.capability, min)) return true
      // Org-wide grant — gated by planeCoversScope (never covers a home squad).
      if (g.scope_type === 'org' && meets(g.capability, min) && planeCoversScope('org', scope)) return true
      // Department → squad inheritance — same gate.
      if (
        g.scope_type === 'department' &&
        g.scope_id === scope.department_id &&
        meets(g.capability, min) &&
        planeCoversScope('department', scope)
      ) {
        return true
      }
    }
    return false
  }

  // org / department: no `kind` concept reachable through THIS scope type —
  // kind='home' is a property of squads, not of the department/org row being
  // checked here, so no planeCoversScope gate applies on this branch.
  for (const g of grants) {
    if (g.scope_type === 'org' && meets(g.capability, min)) return true
    if (g.scope_type === scopeType && g.scope_id === scopeIdOrScope && meets(g.capability, min)) return true
  }
  return false
}

/**
 * hasCapabilityOnDynamicScope — for the small set of callers that do not know
 * `scopeType` until runtime (elevation decisions, OAuth grant-height
 * derivation, Discord role sync, readable-squads enumeration). Loads a
 * SquadScope from D1 itself when the scope turns out to be a squad — never
 * accepts a caller-supplied department id standing in for it. This is the
 * dynamic-dispatch escape hatch for the handful of genuinely scope-agnostic
 * callers; every caller that DOES know its scopeType statically must call
 * `hasCapability` directly so the compiler enforces the SquadScope
 * requirement on it.
 */
export async function hasCapabilityOnDynamicScope(
  env: Env,
  grants: CapabilityGrant[],
  scopeType: CapabilityScopeType,
  scopeId: string | null,
  min: Capability,
): Promise<boolean> {
  if (scopeType === 'org') return hasCapability(grants, 'org', null, min)
  if (scopeType === 'department') {
    if (!scopeId) return false
    return hasCapability(grants, 'department', scopeId, min)
  }
  if (!scopeId) return false
  // Fail closed on a missing/unknown squad row — see resolveSquadScopeArg's
  // doc comment (Athena, adversarial round 1 on G-FP1b).
  const scope = await resolveSquadScopeArg(env, scopeId)
  if (!scope) return false
  return hasCapability(grants, 'squad', scope, min)
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

// ── D1: resolve a squad's scope for inheritance (see loadSquadScope, above) ────
//
// A caller who ALREADY holds a full squad row (id + department_id + kind —
// e.g. a `Squad` or `HomeSquadRow`) may pass it directly; `canOnSquad`/
// `canOnSquadAuth` only hit D1 themselves when given a bare id string. This
// is the one loader boundary where a bare squad id is legitimately allowed
// IN — it is resolved to a real SquadScope before a single capability check
// ever runs, and `hasCapability` itself never sees the bare id.
// Adversarial round 1 on G-FP1b (Athena, 2026-09-21): an EARLIER version of
// this function fabricated a synthetic `{id, department_id: '', kind: 'work'}`
// scope when the `squads` row was missing, reasoning that
// capabilities.scope_id carries no FK so an exact grant on a dead/garbage
// scope_id should still resolve. That is a FAIL-OPEN hole: deleting a home
// squad's row (or a capability row simply outliving its squad) would let an
// ORG-WIDE grant "regain" the scope, because nothing on the fabricated scope
// records that it used to be — or might be — a home. Athena's ruling:
// "a missing/unknown squad row is NEVER a work squad for authz — fail closed
// everywhere." This function now returns `null` on a missing row, full stop
// — NO authority resolves for it via ANY plane, including an exact-id match.
// Distinguishing "squad genuinely doesn't exist" (a 404-class outcome) from
// "squad exists but you lack rank" (403) is a LOADER/ROUTE concern for a
// caller that needs it, never something this predicate should paper over by
// inventing a scope.
// The convenience input shape `canOnSquad`/`canOnSquadAuth` accept alongside
// a bare id: an already-loaded `SquadScope`, OR a plain object shaped like
// one (a full `Squad` row, a `HomeSquadRow`, etc.) that the CALLER already
// obtained from a real `squads`/`agents` query — never from a request body
// or a hand-typed literal. This is deliberately auto-branded below rather
// than requiring every such call site to say `brandSquadScope(squad)`
// explicitly: unlike the ~7 sites that build a scope from SEPARATELY
// resolved fields (which DO have to call brandSquadScope, since a bare
// object literal no longer typechecks as SquadScope), a caller that already
// holds a full row from a real table is not fabricating anything.
export type SquadScopeLike = SquadScope | { id: string; department_id: string; kind: OrgKind }

async function resolveSquadScopeArg(env: Env, squadIdOrScope: string | SquadScopeLike): Promise<SquadScope | null> {
  if (typeof squadIdOrScope === 'string') return loadSquadScope(env, squadIdOrScope)
  return brandSquadScope(squadIdOrScope)
}

/**
 * canOnSquad — squad-scope capability check with department inheritance resolved from D1.
 * The canonical "can this member act on this squad" primitive (grants + department
 * inheritance, same ladder as hasCapability). Exported here — rather than only living as
 * mcp/index.ts's local `memberCanOnSquad` — so non-MCP callers (e.g. the agent-message send
 * call-path, src/agents/messages.ts) can reuse the SAME check without importing mcp/index.ts,
 * which would create a circular import (mcp/index.ts already imports agents/messages.ts).
 * mcp/index.ts's `memberCanOnSquad` delegates to this so there is exactly one implementation.
 *
 * Accepts either a bare squad id (loaded fresh here) or an already-loaded
 * `SquadScope`/`Squad` — never a caller-supplied department id standing in
 * for it (that was the round-2 defect class).
 */
export async function canOnSquad(
  env: Env,
  grants: CapabilityGrant[],
  squadIdOrScope: string | SquadScopeLike,
  min: Capability,
): Promise<boolean> {
  const scope = await resolveSquadScopeArg(env, squadIdOrScope)
  if (!scope) return false
  return hasCapability(grants, 'squad', scope, min)
}

/**
 * canOnSquadAuth — the squad check that sees BOTH authority planes.
 *
 * canOnSquad above takes `grants` and never `auth`, so it is blind to the
 * LEGACY ROLE plane. Org-owner authority lives on that plane, and the auth
 * bridge deliberately leaves `auth.capabilities` UNDEFINED for an owner/admin
 * (assigning [] is what downgrades them, see src/auth/index.ts). Every caller
 * written as `canOnSquad(env, auth.capabilities ?? [], ...)` therefore
 * materialises an EMPTY grant list for precisely the principal with the most
 * authority in the pot, and refuses them.
 *
 * Measured 2026-09-09 on prod 04586ef8: the org owner opens /enroll, the picker
 * lists his agents (that path passes isOrgAdmin(auth) — mupot#1351), and the
 * mint on the same page returns squad_admin_required. Visible seat, refused
 * mint, and no amount of additional authority fixes it because none of it is
 * visible to the check.
 *
 * BOTH doors that mint an agent credential had this, identically:
 *   src/mcp/provision.ts   mint_agent_token   memberCanOnSquad -> canOnSquad
 *   src/dashboard/enroll.ts authorizeEnrollMint                 canOnSquad
 *
 * That is why the fix is HERE and both call sites consume it, rather than a
 * patch to the dashboard route. src/dashboard/enroll.ts:128-136 records
 * Athena's ruling on PR #1254 verbatim: enroll matches the MCP primitive, and
 * "if the intended policy is in fact org admin everywhere, the fix is to raise
 * mint_agent_token — the primitive — and let both dashboard routes inherit it.
 * Do not raise this route alone." Fixing enroll alone would have re-created the
 * divergence in the other direction and left the tool as the soft path.
 *
 * This is NOT a widening of the bar. The bar is unchanged — admin on the squad,
 * with org and department scopes inheriting exactly as hasCapability already
 * allows. It only stops the check from being blind to one of the two places
 * that authority is recorded.
 */
export async function canOnSquadAuth(
  env: Env,
  auth: AuthContext | null | undefined,
  squadIdOrScope: string | SquadScopeLike,
  min: Capability,
): Promise<boolean> {
  const scope = await resolveSquadScopeArg(env, squadIdOrScope)
  if (!scope) return false
  // The legacy ROLE plane, asked at the caller's OWN `min` — not at isOrgAdmin's
  // fixed admin-rank question. isOrgAdmin answers "is this an org admin?"; that is
  // the right question for the two call sites here (both pass 'admin'), but it
  // ignores `min`, so a future caller asking for 'owner' would have been satisfied
  // by a rank-4 admin. A rank ceiling has to guard the TARGET, not just the grant.
  //
  // G-FP1b point 2: this used to be an UNCONDITIONAL role-plane bypass — exactly
  // the master-key shape mupot#1452 round 1 found on the org-grant plane, just on
  // the OTHER authority plane this function exists to see. Gated by
  // planeCoversScope so a legacy owner/admin gets ZERO standing on a home squad
  // from this branch; only an exact squad-scope grant (below, via canOnSquad) or
  // an elevation grant (further below) reaches a home.
  if (auth && legacyRoleSatisfies(auth.role, min) && planeCoversScope('role', scope)) return true
  // The modern ORG-GRANT plane needs no separate limb: hasCapability's org branch
  // already matches an org-scope grant at `min` for a squad question (gated by
  // planeCoversScope internally), so canOnSquad covers it — at the caller's min,
  // with department inheritance intact, and zero standing on a home squad from
  // this plane either.
  if (await canOnSquad(env, auth?.capabilities ?? [], scope, min)) return true
  // Elevation-to-home (G-FP1b point 4): a home squad grants no standing access
  // from org/department/role planes by design (planeCoversScope above). The
  // ONLY additional door is a time-boxed, human-approved elevation grant naming
  // this exact squad. Bound-agent sessions only — see the PR body / this file's
  // header memory for why a pure web-session (dashboard) operator cannot use
  // this path without a schema change to migrations/0148 (agent_session_id is
  // NOT NULL there), which is out of scope for this PR.
  //
  // Dynamic import to avoid a module cycle: src/auth/elevation.ts already
  // imports `hasCapability`/`resolveCapabilities` from this file statically.
  if (scope.kind === 'home' && auth?.boundAgentId) {
    const { hasElevatedAction } = await import('./elevation')
    const result = await hasElevatedAction(env, auth, 'action:home_access', 'squad', scope.id)
    if (result.granted) return true
  }
  return false
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

    if (await hasCapabilityOnDynamicScope(c.env, grants, target.type, target.id, min)) {
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

/**
 * legacyRoleRank — the coarse legacy `role` column's rank on the SAME ladder as
 * a real capability grant: owner=5, admin=4, everything else (including
 * 'member') = 0. The single source of truth for "what does auth.role alone
 * grant, with no fine-grained capabilities in play" — exported so a caller
 * outside this module that needs a legacy-role FLOOR (e.g.
 * src/members/project-invites.ts's squad-rank computation, which must fall
 * back to this coarse role only when a member's capabilities were never
 * resolved at all) reuses this exact rule instead of re-deriving its own
 * copy that can drift from legacyRoleSatisfies below.
 */
export function legacyRoleRank(role: AuthContext['role']): number {
  if (role === 'owner') return RANK.owner
  if (role === 'admin') return RANK.admin
  return 0
}

// A pure web-login owner/admin (no capabilities array) satisfies ORG-scope checks
// when their coarse org role ranks at/above the required capability. owner→owner,
// admin→admin on the same ladder. A plain 'member' org role grants nothing here —
// members must carry real capability grants.
function legacyRoleSatisfies(role: AuthContext['role'], min: Capability): boolean {
  return legacyRoleRank(role) >= RANK[min]
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
 *  grants OR their coarse org role (owner=5, admin=4). 0 = no standing.
 *  Context-independent core so a non-HTTP service (e.g.
 *  src/members/project-invites.ts's member-bind invite path, mupot#1411 P0-1)
 *  can reuse the EXACT same computation `actorMaxRankOnScope` uses over HTTP,
 *  rather than hand-rolling a second copy that can drift.
 *  KNOWN DRIFT from requireCapability's stricter memberId-gated escape (see
 *  actorRankOnSquad's fix in src/members/project-invites.ts, P1-1 parity) —
 *  this function still floors on the coarse role even with no memberId on a
 *  non-org scope. Tracked separately, do not fix here: mupot#1408. */
export async function actorRankOnScopeFor(
  env: Env,
  auth: AuthContext,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
): Promise<number> {
  // G-FP1b point 2: the coarse legacy-role floor (owner=5/admin=4) is an
  // ORG-scope-shaped fact, and must be gated by planeCoversScope on a squad
  // scope — a legacy owner/admin's rank on a home squad is 0 from this
  // floor, same as it is via hasCapability's own org/role-plane exclusion.
  // Adversarial round 1 (Athena): a missing/unknown squad row must fail
  // CLOSED for every plane, including this legacy-role floor — squadScope
  // being null because scopeType isn't 'squad' (role floor unaffected, as
  // always) and squadScope being null because the ROW IS MISSING (role
  // floor must NOT apply) are different cases and must not be conflated.
  let squadScope: SquadScope | null = null
  let unknownSquadRow = false
  if (scopeType === 'squad' && scopeId) {
    squadScope = await resolveSquadScopeArg(env, scopeId)
    if (!squadScope) unknownSquadRow = true
  }
  const roleCovers = unknownSquadRow ? false : squadScope ? planeCoversScope('role', squadScope) : true
  let max = roleCovers ? (auth.role === 'owner' ? RANK.owner : auth.role === 'admin' ? RANK.admin : 0) : 0
  if (auth.memberId && !unknownSquadRow) {
    const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
    // highest capability that resolves true on this scope = the actor's ceiling
    for (const cap of ['owner', 'admin', 'lead', 'member', 'observer'] as Capability[]) {
      const resolves = squadScope
        ? hasCapability(grants, 'squad', squadScope, cap)
        : await hasCapabilityOnDynamicScope(env, grants, scopeType, scopeId, cap)
      if (resolves) {
        max = Math.max(max, RANK[cap])
        break
      }
    }
  }
  return max
}

export async function actorMaxRankOnScope(
  c: Context<AppEnv>,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
): Promise<number> {
  return actorRankOnScopeFor(c.env, c.get('auth'), scopeType, scopeId)
}

/**
 * The target's role-plane rank via `users.role` — bridged by EMAIL, the same
 * dedup key `upsertUserByEmail` (src/auth/index.ts) already uses to keep one
 * human's `users` row and `members` row in sync. `members` carries no `role`
 * column at all (see the schema in migrations/0001 — status only); a
 * principal's standing can therefore live ENTIRELY on this plane, with ZERO
 * capability rows. src/auth/index.ts:917-923 documents the exact case: "the
 * org owner... characteristically holds zero capability rows."
 *
 * A member with a null email, or an email matching no `users` row (an
 * IM-only member; a member who has never logged into the dashboard under
 * that email), has no standing on this plane — this returns 0, the same
 * safe default `targetMaxRankAcrossScopes` already returns for a member with
 * no capability grants. Absence of a bridge is never treated as elevation.
 *
 * mupot#1411 A2 round 5 (Athena final-gate, 2026-09-15): both hops of this
 * bridge used to compare EXACT case — every OTHER email bridge in this
 * codebase (`auth/index.ts:1285`, `sso.ts:114`, `resolve-human-member.ts:158,
 * 169`, migration 0146) is case-insensitive via `lower()`. A `members.email`
 * stored with any different casing than its `users.email` counterpart (e.g.
 * captured verbatim from a form, vs. the OAuth-normalized login email)
 * bridged to nothing, silently returning 0 and letting the target's real
 * role-plane rank fail open. Now `lower()`s the members-side value in SQL
 * before using it as the users-side lookup key, and the users-side match is
 * also `lower(email) = ?1` — so either hop being differently-cased still
 * bridges correctly.
 */
export async function targetLegacyRoleRank(env: Env, targetMemberId: string): Promise<number> {
  const member = await env.DB.prepare('SELECT lower(email) AS email FROM members WHERE id = ?1 LIMIT 1')
    .bind(targetMemberId)
    .first<{ email: string | null }>()
  if (!member?.email) return 0
  const user = await env.DB.prepare('SELECT role FROM users WHERE lower(email) = ?1 LIMIT 1')
    .bind(member.email)
    .first<{ role: AuthContext['role'] }>()
  if (!user) return 0
  return legacyRoleRank(user.role)
}

/**
 * The TARGET's highest effective capability rank across EVERY scope they hold
 * a grant on, AND their coarse legacy-role standing — not just the one scope
 * a caller happens to be checking, and not just one of the two authority
 * planes this codebase recognizes.
 *
 * mupot#1337's targetRankCeiling (src/members/index.ts) originally compared
 * the target's row on ONE (scopeType, scopeId) only. mupot#1411 P0-1
 * (kasra-review, 2026-09-15) found the resulting bypass on the member-bind
 * invite path: a squad-admin invites `member_id` = an org OWNER onto their
 * own (unrelated) squad at capability 'member'; the ceiling never looks at
 * the owner's REAL standing (an org-scope or other-squad grant), the invite
 * mints, and redeeming it from the victim's own Telegram id lets `/approve`
 * etc. resolve through `memberForChat` AS the owner — an unbindable identity
 * takeover (no route ever clears `members.telegram_chat_id`). The same class
 * applies to every existing targetRankCeiling call site (suspend/reactivate,
 * token mint, capability grant): a target's standing on ANY scope makes them
 * a higher-ranked principal, not merely their standing on the one scope a
 * particular action happens to touch.
 *
 * mupot#1411 P0-A round 4 (kasra-review, 2026-09-15): the fix above measured
 * ONLY the grant-rows plane while `actorRankOnScopeFor` floors the ACTOR on
 * BOTH `auth.role` and grants — an asymmetry that let an org admin (role
 * plane, rank 4) suspend/mint-for/grant-on/member-bind-invite-for the
 * bootstrap owner (role plane, rank 5, zero grant rows): reproduced end to
 * end (invite minted, redeemed, `PATCH .../status=suspended` on the owner
 * returned 200 — the exact #1337 lockout this ceiling exists to prevent).
 * Now folds targetLegacyRoleRank in too, so a target's standing on EITHER
 * plane sets the ceiling.
 */
export async function targetMaxRankAcrossScopes(env: Env, targetMemberId: string): Promise<number> {
  // Reuses resolveCapabilities — the SAME query every capability check in
  // this file already runs (capabilities ∪ channel_capability_grants) —
  // rather than a second, narrower hand-rolled query that could miss a
  // grant plane the canonical resolver already knows about.
  const grants = await resolveCapabilities(env, targetMemberId)
  let max = 0
  for (const grant of grants) {
    // G-FP1b point 2 (Athena's intent, documented rather than assumed): "a
    // home row is capability-dead OUTSIDE the home" cuts both ways — it does
    // not inherit access IN from org/department/role, and it must not
    // inflate the member's GLOBAL rank used to protect them from actions on
    // every OTHER scope (this ceiling). A member whose only standing is
    // admin on their own private home is not thereby immune to suspension,
    // token-mint-for, or a capability-grant action targeting them elsewhere
    // — so a home-squad grant is excluded from this max, and only a WORK
    // squad's grant counts.
    if (grant.scope_type === 'squad' && grant.scope_id) {
      const scope = await loadSquadScope(env, grant.scope_id)
      if (scope?.kind === 'home') continue
    }
    max = Math.max(max, RANK[grant.capability])
  }
  max = Math.max(max, await targetLegacyRoleRank(env, targetMemberId))
  return max
}

/**
 * True when the target's real standing (targetMaxRankAcrossScopes, GLOBAL —
 * every scope the target holds a grant on, unioned with their role-plane
 * rank) exceeds the ACTOR's org-scope-local standing (actorRankOnScopeFor
 * with scopeType 'org', scopeId null) — the shared predicate behind
 * targetRankCeiling (HTTP) and every non-HTTP caller that needs the same
 * "you cannot act on a principal who outranks you" rule. A principal can
 * never outrank themselves (self-exempt), independent of the comparison
 * below.
 *
 * mupot#1411 N2 round 4 (Athena, 2026-09-15): this used to take a caller-
 * computed `actorRank: number`, and every call site fed it a SCOPE-LOCAL
 * number (actorMaxRankOnScope) while the target side was already GLOBAL
 * (targetMaxRankAcrossScopes) — comparing two different quantities. Fixed
 * (wrongly, see below) by globalising the ACTOR side too
 * (actorMaxRankAcrossScopes) plus an explicit self-exemption.
 *
 * mupot#1411 A1 round 5 (Athena final-gate, 2026-09-15): round 4's
 * globalisation was itself the escalation. Org grants bubble DOWN to cover
 * every squad by design, but a squad grant never bubbles UP to satisfy an
 * org-scope check — `capability.ts`'s own stated invariant. Maxing the actor
 * over EVERY scope let an org admin who ALSO held 'owner' on one unrelated
 * squad treat their real authority as global rank 5 for every
 * `requireCapability(orgScope, 'admin')` route this ceiling gates: reproduced
 * end to end — that principal minted a token AS the (unrelated) org owner
 * (201), suspended the owner (200), and revoked the owner's org capability
 * row (200, removed:1). Every one of those routes only ever proves the
 * actor's ORG-scope standing (`requireCapability(orgScope, 'admin')` ran
 * first) — so the actor side of the ceiling belongs on that same scope, not
 * maxed over scopes the route never authorized the action on. The self-
 * exemption above is what actually closes N2 (self-target never compares at
 * all); it does not depend on which quantity the actor side computes, so it
 * stays. Reverting the actor side to `actorRankOnScopeFor(env, auth, 'org',
 * null)` flips the A1 probe to 403 (org-scope-local rank 4 < owner's global
 * rank 5); `actorMaxRankAcrossScopes` is deleted — nothing else called it.
 */
/**
 * The pure predicate at the heart of `exceedsTargetRankCeiling` — no DB
 * access, just the comparison + self-exemption. Split out (mupot#1454
 * round 2, F2/P2) because a non-HTTP service function that receives a
 * caller-resolved actor rank (rather than a full AuthContext) needs this
 * EXACT rule, self-exemption included, without paying for — or
 * reimplementing — the DB round trip `exceedsTargetRankCeiling` uses to
 * derive that rank from an AuthContext.
 *
 * mupot#1453 (`mintScopedKey`, src/dashboard/keys.ts) hand-rolled
 * `targetRank > minterRank` here WITHOUT the self-exemption below, and
 * drifted from this predicate the moment it was written: an org admin whose
 * GLOBAL rank exceeds their org-scope-local rank (e.g. they also hold
 * 'owner' on one unrelated squad) minting a key for THEMSELVES — even at
 * the lowest preset — was refused, because the comparison saw their own
 * global rank as "outranking" their org-scope-local minterRank. Never
 * reimplement this comparison inline again; call this function (or, when a
 * full AuthContext is already in hand, `exceedsTargetRankCeiling` below).
 */
export function exceedsTargetRankCeilingGivenRanks(
  actorMemberId: string | null,
  actorRank: number,
  targetMemberId: string,
  targetRank: number,
): boolean {
  if (actorMemberId && actorMemberId === targetMemberId) return false
  return targetRank > actorRank
}

export async function exceedsTargetRankCeiling(
  env: Env,
  auth: AuthContext,
  targetMemberId: string,
): Promise<boolean> {
  const [targetRank, actorRank] = await Promise.all([
    targetMaxRankAcrossScopes(env, targetMemberId),
    actorRankOnScopeFor(env, auth, 'org', null),
  ])
  return exceedsTargetRankCeilingGivenRanks(auth.memberId ?? null, actorRank, targetMemberId, targetRank)
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
  const principal = resolveGatePrincipal(auth)
  if (!principal) return false
  return hasActiveGateGrant(env, surface, principal.type, principal.id)
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
