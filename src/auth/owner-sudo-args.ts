// mupot — owner sudo: the feature flag and the EXACT-ARGUMENTS binding (SENSITIVE).
//
// The human approves one concrete call, not a blank check inside an action and scope. Every sudo request carries the call's
// arguments (`sudo_args`, mandatory for all four actions); they are resolved to ids, fenced, canonicalised and stored with their
// sha256 on the request. The approval message shows them resolved to NAMES. At use time the call's own arguments go through the
// SAME canonicaliser and must hash to the stored digest, or the call is refused and spends nothing.
//
// The fences live here, in the canonicaliser, so they hold at request time AND at call time whatever the arguments say:
//   - a gate grant never confers gate:hadi, a reserved lane (src/gates/lanes.ts), any gate a HUMAN member already holds, or
//     anything to the requesting agent or its own member;
//   - the dyad pin cannot include the requesting agent; the seat-event host cannot be the requesting agent;
//   - squad_member_add confers observer/member only and never to the requesting agent.
import type { Env } from '../types'
import { GATE_CAPABILITY_RE } from '../gates/grants'
import * as lanes from '../gates/lanes'
import { untrustedLine } from './untrusted-line'
import { resolveAgentRef, resolveSquadRef } from '../org/resolve'

/** OWNER_SUDO_ENABLED = '1' | 'true'. Default OFF: with it off no sudo action can be requested and resolveOwnerSudo is a no-op. */
export function ownerSudoEnabled(env: Pick<Env, 'OWNER_SUDO_ENABLED'>): boolean {
  const v = env.OWNER_SUDO_ENABLED?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

export type SudoActionKey =
  | 'action:sudo_squad_member_add'
  | 'action:sudo_squad_dyad_pin'
  | 'action:sudo_grant_gate_capability'
  | 'action:sudo_seat_event_grant'

/** Named lane constants (src/gates/lanes.ts): a sudo call never confers these either (a stricter set than the shared reserved rule). */
const NAMED_LANES: ReadonlySet<string> = new Set<string>([
  ...Object.values(lanes).flatMap((v: unknown) => (typeof v === 'string' && v.startsWith('gate:') ? [v] : [])),
  ...lanes.COUNCIL_GATE_LANE_VALUES,
].map((s) => s.toLowerCase()))

/** A gate lane a sudo call may never confer: the ONE shared reserved rule (lanes.isReservedForHumansOrSubsystems, also used by
 *  dyad.ts and task_create: gate:hadi, gate:office, gate:routines, gate:agent-self-completion, gate:self-*) plus every named lane. */
export function isSudoReservedLane(capability: string): boolean {
  const c = capability.trim().toLowerCase()
  // gate:addons:* is the add-on namespace (e.g. the marketing recommendation gate): each add-on owns its lane, never conferrable by sudo.
  return lanes.isReservedForHumansOrSubsystems(c) || NAMED_LANES.has(c) || c.startsWith('gate:addons:')
}

export interface CanonicalSudoArgs {
  /** Canonical JSON (sorted keys, ids only): what is stored, hashed and compared. */
  json: string
  sha256: string
  /** The squad the call touches, when it has one (scope check, and pinned through the seat-event write). */
  squadId: string | null
}
export type CanonicalResult = { ok: true; value: CanonicalSudoArgs } | { ok: false; error: string; detail: string }

export interface Requester { agentId: string | null; memberId: string | null }

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function bad(error: string, detail: string): CanonicalResult { return { ok: false, error, detail } }
async function finish(obj: Record<string, unknown>, squadId: string | null): Promise<CanonicalResult> {
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  const json = JSON.stringify(sorted)
  return { ok: true, value: { json, sha256: await sha256Hex(json), squadId } }
}

const REQUIRED_KEYS: Readonly<Record<SudoActionKey, readonly string[]>> = {
  'action:sudo_squad_member_add': ['squad', 'agent', 'capability'],
  'action:sudo_squad_dyad_pin': ['squad', 'agent_a', 'agent_b'],
  'action:sudo_grant_gate_capability': ['capability', 'principal_type', 'principal_id'],
  'action:sudo_seat_event_grant': ['host_agent_id', 'agent_id'],
}
const OPTIONAL_KEYS: Readonly<Record<SudoActionKey, readonly string[]>> = {
  'action:sudo_squad_member_add': [],
  'action:sudo_squad_dyad_pin': [],
  'action:sudo_grant_gate_capability': [],
  'action:sudo_seat_event_grant': ['project_id'],
}

/** Resolve, fence and canonicalise one sudo call's arguments. `raw` is `sudo_args` at request time and the mapped tool args at use time. */
export async function canonicalizeSudoArgs(env: Env, action: SudoActionKey, raw: unknown, who: Requester): Promise<CanonicalResult> {
  if (!isObj(raw)) return bad('sudo_args_required', `${action} needs sudo_args: { ${REQUIRED_KEYS[action].join(', ')} }`)
  const allowed = new Set([...REQUIRED_KEYS[action], ...OPTIONAL_KEYS[action]])
  const extra = Object.keys(raw).filter((k) => !allowed.has(k))
  if (extra.length > 0) return bad('sudo_args_invalid', `unknown sudo_args key(s): ${extra.slice(0, 3).join(', ')}`)

  if (action === 'action:sudo_squad_member_add') {
    const sRef = text(raw.squad), aRef = text(raw.agent), cap = text(raw.capability)
    if (!sRef || !aRef || !cap) return bad('sudo_args_required', 'squad, agent and capability are required')
    if (cap !== 'observer' && cap !== 'member') return bad('sudo_capability_ceiling', 'an owner-sudo squad_member_add may confer observer or member only')
    const sq = await resolveSquadRef(env, sRef)
    const ag = await resolveAgentRef(env, aRef)
    if (!sq.ok || !ag.ok) return bad(!sq.ok ? 'squad_not_found' : 'agent_not_found', 'unknown squad or agent')
    if (sq.value.kind !== 'work') return bad('home_squad_immutable', 'not a work squad')
    if (who.agentId && ag.value.id === who.agentId) return bad('cannot_grant_to_self', 'a sudo call may not add the requesting agent to a squad')
    return finish({ squad_id: sq.value.id, agent_id: ag.value.id, capability: cap }, sq.value.id)
  }

  if (action === 'action:sudo_squad_dyad_pin') {
    const sRef = text(raw.squad)
    if (!sRef) return bad('sudo_args_required', 'squad is required')
    const sq = await resolveSquadRef(env, sRef)
    if (!sq.ok) return bad('squad_not_found', 'unknown squad')
    if (sq.value.kind !== 'work') return bad('dyad_pair_not_on_home_squad', 'not a work squad')
    if (raw.agent_a === null && raw.agent_b === null) return finish({ squad_id: sq.value.id, agent_a_id: null, agent_b_id: null }, sq.value.id)
    const aRef = text(raw.agent_a), bRef = text(raw.agent_b)
    if (!aRef || !bRef) return bad('sudo_args_required', 'agent_a and agent_b are both required (or both null to clear)')
    const a = await resolveAgentRef(env, aRef)
    const b = await resolveAgentRef(env, bRef)
    if (!a.ok || !b.ok) return bad('agent_not_found', 'unknown agent')
    if (a.value.id === b.value.id) return bad('sudo_args_invalid', 'a pair needs two distinct agents')
    // An agent never picks its own reviewer: neither side of the pair may be the requester.
    if (who.agentId && (a.value.id === who.agentId || b.value.id === who.agentId)) return bad('cannot_grant_to_self', 'a sudo dyad pin may not include the requesting agent')
    return finish({ squad_id: sq.value.id, agent_a_id: a.value.id, agent_b_id: b.value.id }, sq.value.id)
  }

  if (action === 'action:sudo_grant_gate_capability') {
    const cap = text(raw.capability), pt = text(raw.principal_type), pid = text(raw.principal_id)
    if (!cap || !pt || !pid) return bad('sudo_args_required', 'capability, principal_type and principal_id are required')
    if (!GATE_CAPABILITY_RE.test(cap)) return bad('invalid_capability', 'capability must be gate:<owner>')
    if (pt !== 'member' && pt !== 'agent') return bad('invalid_principal_type', 'principal_type is member or agent')
    const lane = cap.toLowerCase()
    if (isSudoReservedLane(lane)) return bad('sudo_gate_not_conferable', 'gate:hadi and the reserved lanes are never conferred by an agent-run call')
    // A gate a HUMAN member already holds is a human lane: never conferred this way.
    const humanHeld = await env.DB.prepare(`SELECT 1 AS x FROM gate_grants WHERE lower(capability) = ?1 AND principal_type = 'member' LIMIT 1`).bind(lane).first<{ x: number }>()
    if (humanHeld) return bad('sudo_gate_not_conferable', 'that gate is held by a member (a human lane)')
    if (pt === 'agent' && who.agentId && pid === who.agentId) return bad('cannot_grant_to_self', 'a sudo call may not give gate authority to the requesting agent')
    if (pt === 'member' && who.memberId && pid === who.memberId) return bad('cannot_grant_to_self', 'a sudo call may not give gate authority to the requesting agent\'s own member')
    const exists = pt === 'agent'
      ? await env.DB.prepare('SELECT 1 AS x FROM agents WHERE id = ?1 LIMIT 1').bind(pid).first<{ x: number }>()
      : await env.DB.prepare('SELECT 1 AS x FROM members WHERE id = ?1 AND tenant = ?2 LIMIT 1').bind(pid, env.TENANT_SLUG).first<{ x: number }>()
    if (!exists) return bad('principal_not_found', 'unknown principal')
    return finish({ capability: cap, principal_type: pt, principal_id: pid }, null)
  }

  // action:sudo_seat_event_grant
  const hostId = text(raw.host_agent_id), agentId = text(raw.agent_id)
  if (!hostId || !agentId) return bad('sudo_args_required', 'host_agent_id and agent_id are required')
  const projectId = raw.project_id === undefined || raw.project_id === null ? null : text(raw.project_id)
  if (raw.project_id !== undefined && raw.project_id !== null && !projectId) return bad('sudo_args_invalid', 'project_id must be a string')
  if (who.agentId && hostId === who.agentId) return bad('cannot_grant_to_self', 'the seat-event host may not be the requesting agent')
  const row = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ?1 LIMIT 1').bind(agentId).first<{ squad_id: string }>()
  if (!row) return bad('agent_not_visible', 'unknown agent')
  return finish({ agent_id: agentId, host_agent_id: hostId, project_id: projectId }, row.squad_id)
}

/** The tool call's arguments in the `sudo_args` shape of its action, or null when the call is not the act the action names. */
export function sudoRawFromToolArgs(tool: 'squad_member_add' | 'update_squad' | 'grant_gate_capability' | 'seat_event_grant', args: Record<string, unknown>): Record<string, unknown> | null {
  if (tool === 'squad_member_add') return { squad: args.squad, agent: args.agent, capability: args.capability }
  if (tool === 'update_squad') {
    // A dyad pin is ONLY a pin: any other key (slug, budget...) makes it a different call.
    const extra = Object.keys(args).filter((k) => !['squad', 'dyad_agent_a', 'dyad_agent_b', 'reason'].includes(k))
    if (extra.length > 0 || !('dyad_agent_a' in args) || !('dyad_agent_b' in args)) return null
    return { squad: args.squad, agent_a: args.dyad_agent_a, agent_b: args.dyad_agent_b }
  }
  if (tool === 'grant_gate_capability') return { capability: args.capability, principal_type: args.principal_type, principal_id: args.principal_id }
  return { host_agent_id: args.host_agent_id, agent_id: args.agent_id, ...('project_id' in args ? { project_id: args.project_id } : {}) }
}

const NAME_MAX = 60

/** A name for the card: ONE line, control/bidi chars stripped, length capped, and the id ALWAYS printed beside it, so a name can
 *  neither add a line nor stand in for the id. The id is printed through the same filter (an unresolved id is still agent text). */
function labelled(kind: string, name: string | null | undefined, id: unknown): string {
  const idText = untrustedLine(typeof id === 'string' ? id : String(id), 80)
  const n = untrustedLine(name, NAME_MAX)
  return n ? `${kind} "${n}" (id ${idText})` : `${kind} (id ${idText})`
}

/** One human line naming the approved call in NAMES (never the agent's free text), for the approval message. Every name goes
 *  through untrustedLine and is printed with its id. */
export async function describeSudoArgs(env: Env, action: string, json: string): Promise<string | null> {
  let o: Record<string, unknown>
  try { const p: unknown = JSON.parse(json); if (!isObj(p)) return null; o = p } catch { return null }
  const agent = async (id: unknown): Promise<string> => {
    const r = typeof id === 'string' ? await env.DB.prepare('SELECT slug FROM agents WHERE id = ?1 LIMIT 1').bind(id).first<{ slug: string }>().catch(() => null) : null
    return labelled('agent', r?.slug, id)
  }
  const squad = async (id: unknown): Promise<string> => {
    const r = typeof id === 'string' ? await env.DB.prepare('SELECT slug FROM squads WHERE id = ?1 LIMIT 1').bind(id).first<{ slug: string }>().catch(() => null) : null
    return labelled('squad', r?.slug, id)
  }
  const cap = (v: unknown): string => untrustedLine(typeof v === 'string' ? v : String(v), 130)
  if (action === 'action:sudo_squad_member_add') return `add ${await agent(o.agent_id)} to ${await squad(o.squad_id)} as ${cap(o.capability)}`
  if (action === 'action:sudo_squad_dyad_pin') {
    return o.agent_a_id === null ? `clear the review pair of ${await squad(o.squad_id)}` : `pin the review pair of ${await squad(o.squad_id)}: ${await agent(o.agent_a_id)} and ${await agent(o.agent_b_id)}`
  }
  if (action === 'action:sudo_grant_gate_capability') {
    let who: string
    if (o.principal_type === 'agent') who = await agent(o.principal_id)
    else {
      const row = typeof o.principal_id === 'string'
        ? await env.DB.prepare('SELECT display_name FROM members WHERE id = ?1 LIMIT 1').bind(o.principal_id).first<{ display_name: string | null }>().catch(() => null)
        : null
      who = labelled('member', row?.display_name, o.principal_id)
    }
    return `grant ${cap(o.capability)} to ${who}`
  }
  if (action === 'action:sudo_seat_event_grant') return `let host ${await agent(o.host_agent_id)} receive the seat events of ${await agent(o.agent_id)}${o.project_id ? ` (project ${untrustedLine(String(o.project_id), 80)})` : ''}`
  return null
}

export const EXACT_CALL_UNAVAILABLE = 'EXACT CALL unavailable: the arguments of this request could not be loaded. Do NOT approve it.'

/** The ONE renderer of the exact call for a sudo request, used by the bot card and every other decision surface (approve_url,
 *  Mini App, dashboard). Null when the request is not a sudo request. Always one line, prefixed `EXACT CALL`.
 *  A sudo request whose arguments cannot be loaded or described never renders as an ordinary request: strict (default) throws, so
 *  the card / page is not produced at all; `strict: false` (list views only) returns an explicit do-not-approve line. */
export async function exactCallLine(env: Env, req: { id: string; requested_actions_json: string }, opts: { strict?: boolean } = {}): Promise<string | null> {
  const strict = opts.strict !== false
  let actions: unknown
  try { actions = JSON.parse(req.requested_actions_json) } catch { return null }
  const sudoAction = Array.isArray(actions) ? actions.find((a): a is string => typeof a === 'string' && a.startsWith('action:sudo_')) : undefined
  if (!sudoAction) return null
  const fail = (): string => {
    if (strict) throw new Error('sudo_exact_call_unavailable')
    return EXACT_CALL_UNAVAILABLE
  }
  let json: string | null
  try {
    const row = await env.DB.prepare('SELECT sudo_args_json FROM elevation_requests WHERE id = ?1 LIMIT 1').bind(req.id).first<{ sudo_args_json: string | null }>()
    json = row?.sudo_args_json ?? null
  } catch { return fail() }
  if (!json) return fail()
  const text = await describeSudoArgs(env, sudoAction, json)
  return text ? `EXACT CALL (one call, then the approval is spent): ${text}` : fail()
}
