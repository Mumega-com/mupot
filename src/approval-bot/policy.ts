// mupot — what the approval bot may carry, and how a request is worded for the human.
//
// A tap in a Telegram chat is a weaker proof than a passkey, so the bot is a LIST, not a default: it carries only the
// actions below. Everything else (minting, installer windows, irreversible acts, home access, anything from an attached
// chat) keeps its stronger channel (Mini App biometric, passkey, Access page) and the bot is never offered for it.
// A request that names even one action outside the list is not offered to the bot at all.
import type { Env } from '../types'
import { ELEVATION_ACTIONS } from '../auth/elevation-actions'
import type { ElevationRequestRecord } from '../auth/elevation'
import { exactCallLine } from '../auth/owner-sudo-args'
import { untrustedLine } from '../auth/untrusted-line'

/** Reversible, enforced, narrow, and not credential- or structure-minting. The broad action:manage_access is NOT here: it stays passkey / Mini App only. Adding a key here is a reviewed one-line change. */
export const APPROVAL_BOT_ACTIONS: readonly string[] = [
  'action:project_lifecycle',
  'action:org_structure',
  'action:workspace_project',
  'action:routine_policy',
  'action:project_status',
  // owner sudo: ONE call of ONE owner-only tool, run as the approver (src/auth/owner-sudo.ts)
  'action:sudo_squad_member_add',
  'action:sudo_squad_dyad_pin',
  'action:sudo_grant_gate_capability',
  'action:sudo_seat_event_grant',
]

export function parseRequestedActions(req: Pick<ElevationRequestRecord, 'requested_actions_json'>): string[] {
  try {
    const parsed: unknown = JSON.parse(req.requested_actions_json)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

/** True only when EVERY requested action is on the bot's list (an empty or unparsable set is never carried). */
export function botMayCarry(req: Pick<ElevationRequestRecord, 'requested_actions_json'>): boolean {
  const actions = parseRequestedActions(req)
  return actions.length > 0 && actions.every((a) => APPROVAL_BOT_ACTIONS.includes(a))
}

const SHORT_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789' // no 0/o/1/l/i: typed by a human; 30 symbols
export const SHORT_ID_LEN = 8
export const SHORT_ID_RE = /^[a-hjkmnp-tv-z2-9]{8}$/

export function newShortId(): string {
  // Rejection sampling: 240 = 8 * 30, so a byte below 240 maps to a symbol with no modulo bias.
  const limit = 256 - (256 % SHORT_ALPHABET.length)
  let out = ''
  while (out.length < SHORT_ID_LEN) {
    for (const b of crypto.getRandomValues(new Uint8Array(SHORT_ID_LEN * 2))) {
      if (b < limit && out.length < SHORT_ID_LEN) out += SHORT_ALPHABET[b % SHORT_ALPHABET.length]
    }
  }
  return out
}

export { untrustedLine }

async function scopeName(env: Env, req: ElevationRequestRecord): Promise<string> {
  if (req.requested_scope_type === 'org') return 'the whole organisation'
  const table = req.requested_scope_type === 'squad' ? 'squads' : 'departments'
  const column = req.requested_scope_type === 'squad' ? 'slug' : 'name'
  const row = await env.DB.prepare(`SELECT ${column} AS label FROM ${table} WHERE id = ?1 LIMIT 1`).bind(req.requested_scope_id).first<{ label: string | null }>().catch(() => null)
  const label = untrustedLine(row?.label, 60)
  return `${req.requested_scope_type} ${label ? `"${label}" ` : ''}(${req.requested_scope_id})`
}

/** The message the human reads. Facts come from the request row and the registry; the agent's own words are quoted and labelled. */
export async function describeForBot(env: Env, req: ElevationRequestRecord, shortId: string, nowMs: number): Promise<string> {
  const slugRow = await env.DB.prepare('SELECT slug FROM agents WHERE id = ?1 LIMIT 1').bind(req.agent_id).first<{ slug: string }>().catch(() => null)
  const who = untrustedLine(slugRow?.slug, 60) || req.agent_id
  const actions = parseRequestedActions(req).map((a) => {
    const def = Object.prototype.hasOwnProperty.call(ELEVATION_ACTIONS, a) ? ELEVATION_ACTIONS[a] : null
    return def ? `- ${def.label} [${a}] (${def.effect})` : `- unrecognised action [${untrustedLine(a, 60)}]`
  })
  const mins = req.requested_duration_minutes
  // An owner-sudo request carries its ONE exact call, from the shared renderer every decision surface uses.
  const exact = await exactCallLine(env, req)
  const lines = [
    `Approval request ${shortId}`,
    `Agent: ${who}`,
    'Wants to do, as you:',
    ...actions,
    ...(exact ? [exact] : []),
    `Scope: ${await scopeName(env, req)}`,
    `Duration: ${mins} min from the moment you approve`,
    `Agent says (its own words, unverified): "${untrustedLine(req.reason, 300)}"`,
  ]
  const recRow = await env.DB.prepare('SELECT recommendation FROM elevation_requests WHERE id = ?1 LIMIT 1').bind(req.id).first<{ recommendation: string | null }>().catch(() => null)
  const rec = untrustedLine(recRow?.recommendation, 200)
  if (rec) lines.push(`Agent recommends (its own words, unverified): "${rec}"`)
  const secsLeft = Math.max(0, Math.floor((Date.parse(req.decision_expires_at) - nowMs) / 1000))
  lines.push(`Decide within ${Math.ceil(secsLeft / 60)} min. Tap a button, or reply /muapprove ${shortId} or /mudeny ${shortId}. /murevoke ends everything you approved. The id is the request id from this message. Task decisions go to the decision bot.`)
  return lines.join('\n')
}
