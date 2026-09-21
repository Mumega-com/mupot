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
//   - hasCapability(grants, scopeType, scopeId, min, squadDepartmentId?, squadKind?): boolean
//   - isOrgAdmin(auth): boolean                          — org owner|admin, on EITHER plane
//                                                          (legacy role OR an org-scope grant)
//   - requireCapability(scope, min): MiddlewareHandler   — per-route gate
//   - requireOrgCapability(min): MiddlewareHandler       — convenience over org scope
//
// Capability ladder (rank): owner(5) > admin(4) > lead(3) > member(2) > observer(1).
// Scope inheritance: an `org` grant covers every scope; a `department` grant covers
// its squads (when the squad's department id is supplied); a `squad` grant covers
// only itself. Grants never bubble UP (a squad/department grant is not an org grant).
//
// EXCEPTION — home squads (mupot#1452 P0-1, Athena's ruling): a squad whose
// `kind` column is 'home' (a member's private room) is covered ONLY by an exact
// squad-scope grant on that squad. Org and department grants, and the legacy
// owner/admin role, never reach it — see hasCapability's and canOnSquadAuth's
// doc comments below for the mechanism.

import type { Context, MiddlewareHandler } from 'hono'
import type { Env, AuthContext, Capability, CapabilityGrant, CapabilityScopeType, OrgKind } from '../types'
import { hasActiveGateGrant } from '../gates/grants'
import { resolveGatePrincipal } from '../gates/principal'

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
 * @param squadKind         OPTIONAL — when checking a 'squad' scope, that squad's
 *                          `kind` column ('work' | 'home'). When it is 'home',
 *                          org and department grants are EXCLUDED — mupot#1452
 *                          P0-1 / Athena's ruling: a member's private home squad
 *                          is satisfied ONLY by an exact ('squad', <that squad
 *                          id>) grant, no matter how high the caller's org or
 *                          department rank is. Omit it (or pass 'work') and the
 *                          check is unchanged from before this rule existed.
 *
 * An 'org' grant covers ALL scopes EXCEPT a kind='home' squad. A 'department'
 * grant covers its own squads (only when squadDepartmentId names that
 * department) EXCEPT a kind='home' squad. A 'squad' grant covers only itself,
 * always — home included. Grants never bubble UP.
 */
export function hasCapability(
  grants: CapabilityGrant[],
  scopeType: CapabilityScopeType,
  scopeId: string | null,
  min: Capability,
  squadDepartmentId?: string | null,
  squadKind?: OrgKind | null,
): boolean {
  const isHomeSquad = scopeType === 'squad' && squadKind === 'home'
  for (const g of grants) {
    // Exact-scope match (same type + same id) — checked FIRST because it is the
    // ONLY branch a kind='home' squad may be satisfied by.
    if (g.scope_type === scopeType && g.scope_id === scopeId && meets(g.capability, min)) {
      return true
    }

    // A home squad is never covered by org or department grants — skip both
    // wider branches for this grant row (mupot#1452 P0-1). The loop continues
    // so a LATER grant row can still supply the exact-match this squad needs.
    if (isHomeSquad) continue

    // An org-wide grant covers every OTHER scope.
    if (g.scope_type === 'org' && meets(g.capability, min)) return true

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

// ── D1: resolve a squad's department + kind for inheritance ────────────────────
// ONE query, not two — hasCapability needs both `department_id` (department
// inheritance) and `kind` (mupot#1452 P0-1: a kind='home' squad excludes org and
// department grants) to answer a squad-scope question, so every caller resolves
// them together instead of a per-field lookup that would double the D1 reads.

interface SquadCapabilityContext {
  departmentId: string | null
  kind: OrgKind
}

async function resolveSquadContext(env: Env, squadId: string): Promise<SquadCapabilityContext | null> {
  const r = await env.DB.prepare('SELECT department_id, kind FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ department_id: string; kind: OrgKind }>()
  return r ? { departmentId: r.department_id ?? null, kind: r.kind } : null
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
 * A squad that no longer exists (deleted between the caller resolving its id and
 * this check running) resolves to `kind: 'work'` in the fail-closed sense that
 * matters here: hasCapability's exact-match branch already requires the grant's
 * scope_id to equal squadId, so an absent squad denies exactly as before — the
 * home-squad exclusion only ever NARROWS, it cannot be used to widen a check on
 * a squad that isn't there.
 */
export async function canOnSquad(
  env: Env,
  grants: CapabilityGrant[],
  squadId: string,
  min: Capability,
): Promise<boolean> {
  const ctx = await resolveSquadContext(env, squadId)
  return hasCapability(grants, 'squad', squadId, min, ctx?.departmentId ?? null, ctx?.kind ?? 'work')
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
  squadId: string,
  min: Capability,
): Promise<boolean> {
  const ctx = await resolveSquadContext(env, squadId)
  const isHomeSquad = ctx?.kind === 'home'

  // The legacy ROLE plane, asked at the caller's OWN `min` — not at isOrgAdmin's
  // fixed admin-rank question. isOrgAdmin answers "is this an org admin?"; that is
  // the right question for the two call sites here (both pass 'admin'), but it
  // ignores `min`, so a future caller asking for 'owner' would have been satisfied
  // by a rank-4 admin. A rank ceiling has to guard the TARGET, not just the grant.
  //
  // EXCLUDED for a kind='home' squad (mupot#1452 P0-1 / Athena's ruling): the
  // legacy owner/admin role is org-wide authority by construction, and a home
  // squad is satisfied ONLY by an exact squad-scope grant — an org owner with
  // no capabilities row on this specific home must be refused exactly like an
  // org-scope grant holder is refused by hasCapability's exclusion below.
  if (!isHomeSquad && auth && legacyRoleSatisfies(auth.role, min)) return true
  // The modern ORG-GRANT plane needs no separate limb: hasCapability's org branch
  // already matches an org-scope grant at `min` for a squad question (except on a
  // home squad, where it is excluded), so this covers it — at the caller's min,
  // with department inheritance intact. Resolved via the SAME ctx as above, not a
  // second D1 read.
  return hasCapability(auth?.capabilities ?? [], 'squad', squadId, min, ctx?.departmentId ?? null, ctx?.kind ?? 'work')
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
    let squadKind: OrgKind | null = null
    if (target.type === 'squad' && target.id !== null) {
      const ctx = await resolveSquadContext(c.env, target.id)
      squadDepartmentId = ctx?.departmentId ?? null
      squadKind = ctx?.kind ?? null
    }

    if (hasCapability(grants, target.type, target.id, min, squadDepartmentId, squadKind)) {
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
  let max = auth.role === 'owner' ? RANK.owner : auth.role === 'admin' ? RANK.admin : 0
  if (auth.memberId) {
    const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
    const squadCtx = scopeType === 'squad' && scopeId ? await resolveSquadContext(env, scopeId) : null
    // highest capability that resolves true on this scope = the actor's ceiling
    for (const cap of ['owner', 'admin', 'lead', 'member', 'observer'] as Capability[]) {
      if (hasCapability(grants, scopeType, scopeId, cap, squadCtx?.departmentId ?? undefined, squadCtx?.kind ?? undefined)) {
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
export async function exceedsTargetRankCeiling(
  env: Env,
  auth: AuthContext,
  targetMemberId: string,
): Promise<boolean> {
  if (auth.memberId && auth.memberId === targetMemberId) return false
  const [targetRank, actorRank] = await Promise.all([
    targetMaxRankAcrossScopes(env, targetMemberId),
    actorRankOnScopeFor(env, auth, 'org', null),
  ])
  return targetRank > actorRank
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
