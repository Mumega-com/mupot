// mupot — Discord capability↔role projection (Slice B, S196).
//
// mupot is the MASTER. Discord roles are a ONE-WAY PROJECTION of mupot
// `capabilities`. This module enforces that invariant at every seam:
//
//   projectMemberCapabilitiesToDiscord()  — outbound: cap → role sync
//   resolveDiscordInboundMember()         — inbound: platform user → member
//   checkInboundDiscordCap()              — inbound: fail-closed capability gate
//
// SOVEREIGN-CORE DISCIPLINE:
//   - Identity is ALWAYS the member_identities mapping, never self-asserted.
//   - Discord role changes NEVER mutate capabilities (the boundary is one-way).
//   - Unbound or under-scoped requests are refused regardless of Discord role.
//   - Scope escalation is impossible: a squad-scoped grant cannot satisfy an
//     org-scope check (hasCapability is monotone — grants never bubble up).
//   - The bot token is never logged, echoed, or returned in errors.
//
// §2A community map (S196, Hadi-approved 2026-06-28):
//
//   mupot capability            Discord role name
//   ─────────────────────────── ──────────────────
//   observer (any scope)      → @public
//   member (org scope)        → @member
//   member (squad scope)      → @squad
//   lead (any scope)          → @lead
//   owner (any scope)         → @owner
//
// The projection is ADDITIVE within the user's grant set: a member holding
// lead at org scope also satisfies member + observer. We project the HIGHEST
// matching tier only — Discord roles are then add/remove-diffed against the
// current role set (idempotent).
//
// Note: role names are used as MATCHING strings against the Discord guild's
// actual role list. The caller must pass the guild's role name→id map so the
// sync can resolve names to the IDs the Discord API requires.

import type { Env, Capability, CapabilityGrant, CapabilityScopeType } from '../types'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { addMemberRole, removeMemberRole, discordGet, getDiscordBotToken } from './adapters/discord'

// ── §2A capability → Discord role name map ────────────────────────────────────
//
// Order matters (highest to lowest): we project the HIGHEST tier that the member
// holds. Lower tiers are implied by the Discord permission hierarchy (roles are
// additive on Discord's end), but we keep the sync focused on the single
// authoritative tier. The sync adds the mapped role and removes any
// higher-tier roles the member no longer holds.
//
// Keys are the EXACT Discord role names configured in the Mumega server.

export const CAP_TO_DISCORD_ROLE: Record<string, string> = {
  owner: '@owner',
  lead: '@lead',
  squad: '@squad',    // member capability at squad scope (internal)
  member: '@member',  // member capability at org scope (OAuth-verified community)
  observer: '@public',
}

// All known Discord role names that this sync manages. Roles NOT in this list
// are NEVER touched — an unrelated role (e.g. @moderator) is not the sync's concern.
export const MANAGED_DISCORD_ROLES: readonly string[] = [
  '@owner',
  '@lead',
  '@squad',
  '@member',
  '@public',
]

// ── capability → tier key ─────────────────────────────────────────────────────

/**
 * capToRoleKey — map a member's resolved capabilities to the Discord role name
 * they should hold per §2A. Returns the HIGHEST applicable role.
 *
 * Mapping logic:
 *   - owner/lead at any scope → @owner / @lead
 *   - member at squad scope → @squad (internal)
 *   - member at org/dept scope → @member (community)
 *   - observer at any scope → @public
 *   - no grants → null (mupot is master: no grant = no role)
 */
export function capToRoleKey(grants: CapabilityGrant[]): string | null {
  if (grants.length === 0) return null

  // Check in descending rank order.
  // @owner and @lead both require ORG scope (WARN-1 + Loom §2A clarification):
  //   #admin is org-level visibility; a dept-scoped or squad-scoped lead does NOT
  //   earn org-level Discord admin access. Use hasCapability(…,'org',null,…) for
  //   both — no "any-scope" fallback for privileged tiers.
  if (hasCapability(grants, 'org', null, 'owner')) return '@owner'
  if (hasCapability(grants, 'org', null, 'lead')) return '@lead'

  // member at squad scope → @squad (internal channel access)
  if (grants.some((g) => g.capability === 'member' && g.scope_type === 'squad')) return '@squad'

  // member at org or dept scope → @member (OAuth-verified community)
  if (
    hasCapability(grants, 'org', null, 'member') ||
    grants.some((g) => g.capability === 'member' && (g.scope_type === 'org' || g.scope_type === 'department'))
  ) return '@member'

  // observer at any scope → @public
  if (grants.some((g) => g.capability === 'observer')) return '@public'

  return null
}

// ── identity resolution (server-derived, never self-asserted) ─────────────────

export interface ResolvedDiscordMember {
  memberId: string
  status: string
}

/**
 * resolveDiscordInboundMember — resolve a Discord user id to a mupot member via
 * member_identities. Returns null when unmapped. NEVER trusts a self-claimed
 * member id from message text — the externalUserId is a platform-level identifier
 * (Discord user snowflake), not something the user typed.
 *
 * This is the ONLY path through which a Discord user becomes a mupot principal.
 * An unbound Discord user cannot create their own binding by claiming it in a
 * message; they must go through the '/link <code>' OAuth-verified flow.
 */
export async function resolveDiscordInboundMember(
  env: Env,
  externalUserId: string,
): Promise<ResolvedDiscordMember | null> {
  const row = await env.DB.prepare(
    `SELECT m.id AS member_id, m.status AS status
       FROM member_identities mi
       JOIN members m ON m.id = mi.member_id
      WHERE mi.platform = 'discord' AND mi.external_user_id = ?1
      LIMIT 1`,
  )
    .bind(externalUserId)
    .first<{ member_id: string; status: string }>()

  if (!row) return null
  return { memberId: row.member_id, status: row.status }
}

// ── fail-closed inbound capability gate ──────────────────────────────────────

export interface CapCheckResult {
  ok: true
  memberId: string
  grants: CapabilityGrant[]
}

export interface CapCheckFailure {
  ok: false
  reason:
    | 'unbound'        // no member_identities row for this Discord user
    | 'suspended'      // member is suspended
    | 'insufficient'   // bound + active, but under-scoped for the action
}

/**
 * checkInboundDiscordCap — fail-closed capability gate for an inbound Discord
 * action. Three-stage check:
 *
 *   1. Identity: Discord user → mupot member via member_identities (never self-claimed).
 *      Unmapped → refused ('unbound').
 *   2. Status: suspended member → refused ('suspended').
 *   3. Capability: server-side check against the member's actual grants.
 *      Under-scoped → refused ('insufficient').
 *
 * Discord role is NOT the boundary. A user who has the @squad Discord role but
 * whose mupot grant was revoked is refused here regardless of their current
 * Discord role (mupot is master). This makes the gate fail-closed: a stale
 * Discord role cannot grant access after revocation.
 *
 * @param env             Worker environment (DB access)
 * @param externalUserId  Discord user snowflake id (platform-level; NOT self-asserted)
 * @param scopeType       Target scope type for the action
 * @param scopeId         Target scope id (null for org)
 * @param minCapability   Minimum capability required for the action
 */
export async function checkInboundDiscordCap(
  env: Env,
  externalUserId: string,
  scopeType: CapabilityScopeType,
  scopeId: string | null,
  minCapability: Capability,
): Promise<CapCheckResult | CapCheckFailure> {
  // 1. Identity — server-derived, never self-asserted.
  const identity = await resolveDiscordInboundMember(env, externalUserId)
  if (!identity) return { ok: false, reason: 'unbound' }

  // 2. Status — suspended members are inert regardless of capability.
  if (identity.status !== 'active') return { ok: false, reason: 'suspended' }

  // 3. Capability — real RBAC, loaded from D1, never from the Discord role.
  const grants = await resolveCapabilities(env, identity.memberId)
  if (!hasCapability(grants, scopeType, scopeId, minCapability)) {
    return { ok: false, reason: 'insufficient' }
  }

  return { ok: true, memberId: identity.memberId, grants }
}

// ── outbound projection (cap → Discord role, one-way) ────────────────────────

/** A Discord guild's role name→id map. The sync needs IDs to call the API; the
 *  caller resolves names from the guild's /roles endpoint. */
export type DiscordRoleMap = Record<string, string> // role name → role id

export interface ProjectionResult {
  ok: true
  discordUserId: string
  targetRole: string | null
  added: string[]
  removed: string[]
}

export interface ProjectionFailure {
  ok: false
  reason:
    | 'unbound'    // member has no Discord identity in member_identities
    | 'suspended'  // member is suspended
    | 'no_token'   // DISCORD_BOT_TOKEN absent — cannot reach Discord API
    | 'api_error'  // Discord API returned null or threw (token present but GET failed)
  detail?: string
}

/** Injectables for testing — all default to real Discord API calls in production. */
export interface ProjectionInjectables {
  /** Discord GET helper — defaults to the real bot-token fetch. */
  discordGetFn?: (path: string) => Promise<unknown | null>
  /** Add a Discord role to a guild member — defaults to addMemberRole(). */
  addRoleFn?: (guildId: string, discordUserId: string, roleId: string) => Promise<void>
  /** Remove a Discord role from a guild member — defaults to removeMemberRole(). */
  removeRoleFn?: (guildId: string, discordUserId: string, roleId: string) => Promise<void>
}

/**
 * projectMemberCapabilitiesToDiscord — one-way sync of a mupot member's
 * capabilities onto their Discord guild roles.
 *
 * Algorithm:
 *   1. Resolve the member's Discord user id from member_identities.
 *      No identity → 'unbound' (no-op, not an error — the member may not have
 *      linked Discord yet).
 *   2. Resolve capabilities from D1 (mupot is master).
 *   3. Compute the target Discord role name via capToRoleKey().
 *   4. Fetch the member's current Discord roles (GET /members/{user}).
 *   5. Diff: add missing managed roles, remove stale managed roles.
 *
 * INVARIANT (one-way): this function NEVER reads Discord roles back into D1.
 * Capabilities are always loaded from D1 only. A Discord role change (whether
 * by a server admin or a bot) has zero effect on mupot capabilities.
 *
 * @param env          Worker environment
 * @param memberId     mupot member id
 * @param guildId      Discord guild (server) id
 * @param roleMap      Discord role name → role id map for the guild
 * @param inject       Optional injectables for testing (GET/add/remove fns)
 */
export async function projectMemberCapabilitiesToDiscord(
  env: Env,
  memberId: string,
  guildId: string,
  roleMap: DiscordRoleMap,
  inject?: ProjectionInjectables,
): Promise<ProjectionResult | ProjectionFailure> {
  // 1. Resolve the member's Discord identity from member_identities.
  const identity = await env.DB.prepare(
    `SELECT mi.external_user_id, m.status
       FROM member_identities mi
       JOIN members m ON m.id = mi.member_id
      WHERE mi.member_id = ?1 AND mi.platform = 'discord'
      LIMIT 1`,
  )
    .bind(memberId)
    .first<{ external_user_id: string; status: string }>()

  if (!identity) return { ok: false, reason: 'unbound' }
  if (identity.status !== 'active') return { ok: false, reason: 'suspended' }
  const discordUserId = identity.external_user_id

  // 2. Load capabilities from D1 (NEVER from Discord roles).
  const grants = await resolveCapabilities(env, memberId)

  // 3. Compute target Discord role.
  const targetRole = capToRoleKey(grants)

  // Resolve injectables and enforce fail-closed GET discipline.
  // BLOCK-3 fix: fail-CLOSED on absent token and on GET failure.
  //   - No token + no injected getter  → 'no_token' (don't call add/remove).
  //   - Token present but GET null/throws → 'api_error' (don't treat as empty roles).
  //   - A member with no managed roles returns { roles:[] }, never null — so null from
  //     getFn unambiguously signals a failed GET, not a legitimately empty role set.
  const usingProductionGetter = !inject?.discordGetFn
  if (usingProductionGetter) {
    const token = getDiscordBotToken(env)
    if (!token) {
      return { ok: false, reason: 'no_token', detail: 'DISCORD_BOT_TOKEN not configured' }
    }
  }
  const getFn = inject?.discordGetFn ?? ((path: string) => discordGet(env, path))
  const doAddRole = inject?.addRoleFn ?? ((g, u, r) => addMemberRole(env, g, u, r))
  const doRemoveRole = inject?.removeRoleFn ?? ((g, u, r) => removeMemberRole(env, g, u, r))

  // 4. Fetch current Discord roles for this guild member.
  const getPath = `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(discordUserId)}`
  let memberData: unknown
  try {
    memberData = await getFn(getPath)
  } catch (err) {
    return {
      ok: false,
      reason: 'api_error',
      detail: `discord: member GET threw: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  // null = GET failed (API error, 404, network). An object with roles:[] is a
  // member who legitimately holds no managed roles — that's fine, not a failure.
  if (memberData == null) {
    return { ok: false, reason: 'api_error', detail: 'discord: member GET returned null' }
  }
  let currentRoleIds: string[] = []
  if (typeof memberData === 'object') {
    const roles = (memberData as { roles?: unknown }).roles
    if (Array.isArray(roles)) {
      currentRoleIds = roles.filter((r): r is string => typeof r === 'string')
    }
  }

  // Build current role id → name reverse map for the managed roles only.
  const idToName: Record<string, string> = {}
  for (const [name, id] of Object.entries(roleMap)) {
    idToName[id] = name
  }

  // Current managed roles held by the Discord member.
  const currentManaged = currentRoleIds
    .map((id) => idToName[id])
    .filter((name): name is string => typeof name === 'string' && MANAGED_DISCORD_ROLES.includes(name))

  // Target: exactly the one authoritative role (or empty if no grants).
  const targetManaged: string[] = targetRole ? [targetRole] : []

  // Diff.
  const toAdd = targetManaged.filter((r) => !currentManaged.includes(r))
  const toRemove = currentManaged.filter((r) => !targetManaged.includes(r))

  const added: string[] = []
  const removed: string[] = []

  try {
    for (const roleName of toAdd) {
      const roleId = roleMap[roleName]
      if (!roleId) continue // role not in this guild — skip
      await doAddRole(guildId, discordUserId, roleId)
      added.push(roleName)
    }
    for (const roleName of toRemove) {
      const roleId = roleMap[roleName]
      if (!roleId) continue
      await doRemoveRole(guildId, discordUserId, roleId)
      removed.push(roleName)
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'api_error',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  return { ok: true, discordUserId, targetRole, added, removed }
}

// noopGet was removed as part of the BLOCK-2 fix. The production default is now
// the real discordGet (bot-token fetch); tests that need a controlled GET inject
// a discordGetFn via ProjectionInjectables. See projectMemberCapabilitiesToDiscord.
