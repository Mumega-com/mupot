// mupot — installer window synthesizer (design S1.2, PR-C). Flag INSTALLER_WINDOW, default OFF.
//
// WHAT IT IS. A time-boxed bundle of structural acts, authorised by a LIVE session-bound elevation grant
// (`action:install_standard` / `action:install_high`) the human approved. It writes NO table and adds NO judge: for a
// bound-agent caller it builds IN-MEMORY DelegationRow(s) from the live grant and hands them to the chokepoint's existing
// evaluateDelegated unchanged. Every delegation fence therefore applies as-is (no acts on humans, the delegator or the agent
// itself, no home squads, no gate/admin grants, target standing above the ceiling refused, delegator still admin).
//
// ONE LIVENESS SOURCE. Expiry, revoke, the agent session and the APPROVER's live authority all come from hasElevatedAction
// (src/auth/elevation.ts), re-derived on every call: nothing is cached and nothing is stored on the synthesized row, so there
// is nothing to desync. A row exists only for the duration of the call that built it, only from a live grant, only for an act
// in that tier's act list. `agent_id` is the caller's own bound agent: another session's grant can never produce a row.
//
// NOT IN EITHER TIER: credential mint (mint_agent_token, mint_member_token, register_agent_key). They are not delegable, so
// no tier can name them (tests/installer-window.test.ts pins both directions).

import type { AuthContext, Env } from '../types'
import {
  boundAgentHasAnyLiveElevationGrant,
  hasElevatedAction,
  loadLiveElevationGrantsForSession,
  loadLiveSessionForBoundAgent,
  type ElevationGrantRecord,
} from '../auth/elevation'
import { attachedAuthority } from '../auth/attached-ceiling'
import type { StructuralAction } from './chokepoint'
import type { DelegationRow } from './delegations'
import {
  INSTALLER_ACTION_KEYS,
  INSTALLER_STANDING_GRANT_CAP,
  INSTALLER_TIERS,
  installerTierForAction,
  installerWindowEnabled,
  type InstallerTier,
} from './installer-tiers'

export const INSTALLER_DELEGATION_PREFIX = 'elev:'

export function isInstallerDelegationId(id: string): boolean {
  return id.startsWith(INSTALLER_DELEGATION_PREFIX)
}

export function installerGrantIdOf(delegationId: string): string {
  return delegationId.slice(INSTALLER_DELEGATION_PREFIX.length)
}

export interface LiveInstallerWindow {
  tier: InstallerTier
  grant: ElevationGrantRecord
  agentSessionId: string
}

/**
 * Every installer window this caller holds RIGHT NOW. A grant counts only when hasElevatedAction says so for the grant's own
 * scope: live session, not expired, not revoked, approver still admin on the scope, approving web session alive, and (for an
 * attached chat) an allow-listed action, which no install action is. recordUsage:false: a probe never logs usage.
 * The two call sites below name the action as a literal on purpose (tests/elevation-actions-enforced.test.ts scans for them).
 */
export async function liveInstallerWindows(env: Env, auth: AuthContext, nowMs: number = Date.now()): Promise<LiveInstallerWindow[]> {
  if (!auth.boundAgentId) return []
  // SCOPE CUT (PR #2039 round 3): a seat session (attached or not) never holds or uses a window. A seat's real authority is its effective
  // auth.capabilities (the human's grants copied in), but the chokepoint's conferral bound reads the seat member's DB rows only.
  // Seats regain windows only when every installer bound reads the seat's effective rank, with its own gate.
  if (auth.seatBinding) return []
  const session = await loadLiveSessionForBoundAgent(env, auth, nowMs)
  if (!session) return []
  const grants = await loadLiveElevationGrantsForSession(env, auth.tenant, session.id, nowMs)
  const out: LiveInstallerWindow[] = []
  const seen = new Set<string>()
  for (const g of grants) {
    if (!INSTALLER_ACTION_KEYS.includes(g.action)) continue
    const key = `${g.action}|${g.scope_type}|${g.scope_id}`
    if (seen.has(key)) continue
    seen.add(key)
    const scopeId = g.scope_type === 'org' ? null : g.scope_id
    const opts = { nowMs, recordUsage: false, onlyGrantId: g.id } as const
    const res = g.action === 'action:install_high'
      ? await hasElevatedAction(env, auth, 'action:install_high', g.scope_type, scopeId, opts)
      : await hasElevatedAction(env, auth, 'action:install_standard', g.scope_type, scopeId, opts)
    if (!res.granted) continue
    const def = installerTierForAction(res.grant.action)
    if (!def) continue
    out.push({ tier: def.tier, grant: res.grant, agentSessionId: session.id })
  }
  return out
}

/** Cheap existence probe for the MCP capability floor: does this session hold ANY live install grant? Grants nothing by itself. */
export async function boundAgentMayBeInstalling(env: Env, auth: AuthContext): Promise<boolean> {
  if (!installerWindowEnabled(env) || !auth.boundAgentId) return false
  if (!(await boundAgentHasAnyLiveElevationGrant(env, auth))) return false
  return (await liveInstallerWindows(env, auth)).length > 0
}

/** The in-memory delegation row for one live window. Never persisted; the id names the grant so receipts and usage tie back. */
function synthesizeRow(env: Env, auth: AuthContext, w: LiveInstallerWindow): DelegationRow {
  const g = w.grant
  const def = INSTALLER_TIERS[w.tier]
  return {
    id: `${INSTALLER_DELEGATION_PREFIX}${g.id}`,
    tenant: env.TENANT_SLUG,
    agent_id: auth.boundAgentId as string, // liveInstallerWindows returned [] unless auth.boundAgentId is set
    delegator_member_id: g.approved_by_member_id,
    scope_type: g.scope_type,
    scope_id: g.scope_type === 'org' ? null : g.scope_id,
    max_grant: def.maxGrant,
    created_by_member_id: g.approved_by_member_id,
    created_at: g.created_at,
    revoked_at: null,
  }
}

/**
 * Delegation rows an installer window contributes for ONE act: only windows whose tier lists the act, and, for the standard
 * tier, never an org-scope window for create_squad (org-scope squad creation is high-tier only).
 */
export async function installerDelegationsFor(
  env: Env,
  auth: AuthContext,
  action: StructuralAction,
  nowMs: number = Date.now(),
): Promise<{ rows: DelegationRow[]; windows: LiveInstallerWindow[] }> {
  if (!installerWindowEnabled(env) || !auth.boundAgentId) return { rows: [], windows: [] }
  const windows = (await liveInstallerWindows(env, auth, nowMs)).filter((w) => {
    if (!INSTALLER_TIERS[w.tier].acts.has(action)) return false
    if (w.tier === 'standard' && action === 'create_squad' && w.grant.scope_type === 'org') return false
    return true
  })
  // High first, so a refusal's usage row names the widest window the caller held.
  windows.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'high' ? -1 : 1))
  return { rows: windows.map((w) => synthesizeRow(env, auth, w)), windows }
}

export interface InstallerWindowView {
  tier: InstallerTier
  scope_type: string
  scope_id: string | null
  expires_at: string
  acts: string[]
  used: number
  /** Per-window write cap (authorised writes). */
  write_cap: number
  /** Standing grants made under this window are capped at this rank, whatever the tier (pending Hadi's decision). */
  standing_grant_cap: 'member'
}

/** What the elevated agent sees in whoami: its widest live window, or nothing. Flag off => undefined, no reads. */
export async function installerWindowView(env: Env, auth: AuthContext): Promise<InstallerWindowView | undefined> {
  if (!installerWindowEnabled(env) || !auth.boundAgentId || attachedAuthority(auth)) return undefined
  const windows = await liveInstallerWindows(env, auth)
  if (windows.length === 0) return undefined
  // widest first: high beats standard, then the later expiry
  windows.sort((a, b) => (a.tier === b.tier ? Date.parse(b.grant.expires_at) - Date.parse(a.grant.expires_at) : a.tier === 'high' ? -1 : 1))
  const w = windows[0]
  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM elevation_usage_log WHERE tenant = ?1 AND elevation_grant_id = ?2 AND status = 'applied'",
  )
    .bind(auth.tenant, w.grant.id)
    .first<{ n: number }>()
  return {
    tier: w.tier,
    scope_type: w.grant.scope_type,
    scope_id: w.grant.scope_type === 'org' ? null : w.grant.scope_id,
    expires_at: w.grant.expires_at,
    acts: [...INSTALLER_TIERS[w.tier].acts].sort(),
    used: used?.n ?? 0,
    write_cap: INSTALLER_TIERS[w.tier].writeCap,
    standing_grant_cap: INSTALLER_STANDING_GRANT_CAP,
  }
}

/** Which tier an act needs, for the refusal wording: standard when any tier-standard lists it, else high, else none. */
export function installerTierNeededFor(action: StructuralAction): InstallerTier | null {
  if (INSTALLER_TIERS.standard.acts.has(action)) return 'standard'
  if (INSTALLER_TIERS.high.acts.has(action)) return 'high'
  return null
}
