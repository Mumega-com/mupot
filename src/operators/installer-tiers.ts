// mupot — installer window tier table (design S1.3). Pure data + pure predicates, no imports of the auth layer, so
// src/auth/elevation.ts (request-time validation) and src/operators/installer-window.ts (the synthesizer) can both read it
// without a module cycle. The tier decides WHICH acts an installer window may ask the chokepoint about and the ceiling
// (max_grant) the synthesized delegation carries; every other fence is the chokepoint's own (evaluateDelegated).
//
// Token / credential mint is OUT of both tiers on purpose: it stays the separate `action:mint_token` decision. Nothing
// here names mint_agent_token, mint_member_token or register_agent_key, and tests/installer-window.test.ts pins that.

import type { Env } from '../types'
import type { StructuralAction } from './chokepoint'

/** Default OFF. With the flag off nothing in this feature runs: no request is accepted, no row is synthesized. */
export function installerWindowEnabled(env: Pick<Env, 'INSTALLER_WINDOW'>): boolean {
  const v = env.INSTALLER_WINDOW?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

export type InstallerTier = 'standard' | 'high'

export const INSTALL_STANDARD_ACTION = 'action:install_standard'
export const INSTALL_HIGH_ACTION = 'action:install_high'

export interface InstallerTierDef {
  readonly tier: InstallerTier
  readonly action: string
  /** Ceiling of the synthesized delegation: standard = member, high = lead. */
  readonly maxGrant: 'member' | 'lead'
  readonly acts: ReadonlySet<StructuralAction>
  readonly durationsMinutes: readonly number[]
}

const STANDARD_ACTS: readonly StructuralAction[] = [
  'squad_member_add',
  'squad_member_remove',
  'grant_agent_membership', // HTTP twin of squad_member_add: the same verdict on both doors (#1357 class)
  'move_agent_squad',
  'project_squad_set',
  'project_squad_remove',
  'create_agent',
  'create_squad',
]

export const INSTALLER_TIERS: Readonly<Record<InstallerTier, InstallerTierDef>> = {
  standard: {
    tier: 'standard',
    action: INSTALL_STANDARD_ACTION,
    maxGrant: 'member',
    acts: new Set<StructuralAction>(STANDARD_ACTS),
    durationsMinutes: [15, 60, 240],
  },
  high: {
    tier: 'high',
    action: INSTALL_HIGH_ACTION,
    maxGrant: 'lead',
    acts: new Set<StructuralAction>([...STANDARD_ACTS, 'grant_agent_capability']),
    durationsMinutes: [15, 60, 240, 480],
  },
}

export const INSTALLER_ACTION_KEYS: readonly string[] = [INSTALL_STANDARD_ACTION, INSTALL_HIGH_ACTION]

export function isInstallerAction(key: string): boolean {
  return INSTALLER_ACTION_KEYS.includes(key)
}

export function installerTierForAction(key: string): InstallerTierDef | null {
  if (key === INSTALL_STANDARD_ACTION) return INSTALLER_TIERS.standard
  if (key === INSTALL_HIGH_ACTION) return INSTALLER_TIERS.high
  return null
}

/** Request-time shape check: an install request names exactly ONE install action and nothing else, with that tier's durations. */
export function installerRequestRefusal(actions: readonly string[], durationMinutes: number): string | null {
  const installs = actions.filter(isInstallerAction)
  if (installs.length === 0) return null
  if (actions.length !== installs.length || installs.length !== 1) {
    return `an installer window is requested alone: name exactly one of ${INSTALLER_ACTION_KEYS.join(' | ')} and no other action (credentials are never part of a window; ask for action:mint_token separately)`
  }
  const def = installerTierForAction(installs[0])
  if (def && !def.durationsMinutes.includes(durationMinutes)) {
    return `${def.action} allows duration_minutes ${def.durationsMinutes.join(' | ')}`
  }
  return null
}
