// mupot — notify kernel: the ONE carry table. Which channels may carry which kind of event.
//
// Pure data and pure functions; no I/O. src/approval-bot/policy.ts derives its allow list from REVERSIBLE_ACTIONS here
// (one source); tests/notify-carry.test.ts pins the list to the exact set the bot carried before the switch.
import { ALL_ELEVATION_ACTION_KEYS } from '../auth/elevation-actions'

export type Severity = 'info' | 'attention' | 'decision' | 'critical'
/** reversible: the approval bot may carry it. high_risk: Mini App / passkey link only, never plain chat buttons. */
export type ActionClass = 'reversible' | 'high_risk'
export type Channel = 'telegram_dm' | 'dashboard' | 'approval_bot' | 'miniapp' | 'passkey_link'

export const ALL_CHANNELS: readonly Channel[] = ['telegram_dm', 'dashboard', 'approval_bot', 'miniapp', 'passkey_link']
/** Channels that interrupt a person (and so count against the rate cap). The dashboard is pulled, not pushed. */
export const PUSH_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['telegram_dm', 'approval_bot', 'miniapp', 'passkey_link'])
/** The only channel that renders plain one-tap buttons. */
export const PLAIN_BUTTON_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['approval_bot'])

/**
 * Elevation actions whose decision may ride plain buttons. This is the single source: APPROVAL_BOT_ACTIONS in
 * src/approval-bot/policy.ts is this array. Every other action, including every unknown key,
 * is high_risk: mint_token, manage_access, grants, money, publish, deletes, deploys, home access, structure that
 * outlives a grant.
 */
export const REVERSIBLE_ACTIONS: readonly string[] = Object.freeze([
  'action:project_lifecycle',
  'action:org_structure',
  'action:workspace_project',
  'action:routine_policy',
  'action:project_status',
  'action:sudo_squad_member_add',
  'action:sudo_squad_dyad_pin',
  'action:sudo_grant_gate_capability',
  'action:sudo_seat_event_grant',
  'action:sudo_archive_row',
  'action:sudo_move_agent_squad',
  'action:sudo_project_repo',
])

/** Fail closed: a key that is not on the reversible list (including a typo) is high_risk. */
export function classifyAction(actionKey: string): ActionClass {
  return REVERSIBLE_ACTIONS.includes(actionKey) ? 'reversible' : 'high_risk'
}

/** A request is reversible only if EVERY action is (the same all-or-nothing rule as botMayCarry); empty is high_risk. */
export function classifyActions(actionKeys: readonly string[]): ActionClass {
  return actionKeys.length > 0 && actionKeys.every((a) => classifyAction(a) === 'reversible') ? 'reversible' : 'high_risk'
}

export interface CarryInput {
  severity: Severity
  action_class?: ActionClass
}

/** The channels allowed to carry this event, in preference order. */
export function carryChannels(input: CarryInput): readonly Channel[] {
  // A decision with no declared class is treated as high_risk: never offered plain buttons by omission.
  const cls: ActionClass = input.action_class ?? 'high_risk'
  switch (input.severity) {
    case 'info':
    case 'attention':
      return ['telegram_dm', 'dashboard']
    case 'decision':
      return cls === 'reversible' ? ['approval_bot', 'miniapp', 'dashboard'] : ['miniapp', 'passkey_link']
    case 'critical':
      // "All" channels, except that a high-risk decision still never gets plain buttons.
      return cls === 'high_risk' ? ALL_CHANNELS.filter((c) => !PLAIN_BUTTON_CHANNELS.has(c)) : ALL_CHANNELS
  }
}

/** Critical events ignore quiet hours and the rate cap. (Quiet hours are not implemented in slice 1.) */
export function ignoresQuietHours(severity: Severity): boolean {
  return severity === 'critical'
}

/** Elevation actions the carry table has an opinion on (all of them: unknown means high_risk). */
export const KNOWN_ACTIONS: readonly string[] = ALL_ELEVATION_ACTION_KEYS
