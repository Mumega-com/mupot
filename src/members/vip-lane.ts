// mupot — the VIP lane (#2035 wall 1, slice 1; design: agents/kasra/docs/design-admission-by-observation-20261018.md (a)).
//
// A verified owner/org-admin's own seat joins a squad it administers INSTANTLY, as an OBSERVED seat. Everyone else files ONE card.
// Flag VIP_LANE (strict '1', default off): off = the tool is not advertised, a direct call refuses, and the floor below is never read.
//
// AUTHORITY (the argument, so a reviewer can attack it):
//   * WHO: the OAuth session resolved to an ACTIVE HUMAN member (agent_seats.member_id via seatBinding.humanMemberId, never an email
//     match), and the session has an identity anchor (an UNATTACHED seat; an attached chat or a bound agent goes to the card path,
//     because joining would widen a long-lived agent, not a throwaway seat).
//   * ELIGIBLE: the human's EFFECTIVE grants, from resolveCapabilities (the function the seat read path, resolveSeatCapabilities, uses),
//     give 'admin' on the TARGET squad through canOnSquad (squad admin/owner, plus the org/department planes where the squad kind allows
//     it; a kind='home' squad is never reachable by inheritance). Never a parallel SELECT on capabilities/memberships: an expired grant,
//     a channel grant and the home-squad isolation are all handled by the shared function. The seat's own clamped auth.capabilities are
//     NOT consulted (a seat is clamped to 'member' by design; the human's standing is what justifies the join).
//   * THE WRITE: addSquadMember, the SAME function squad_member_add and the squad_join approval run (membership + capability row +
//     receipt), called as the HUMAN (auth built from the human's own grants), capability = OBSERVED_TIER, raise-only. The seat can
//     therefore not reach lead/admin/owner by this door, and the observed member cannot add others (squad_member_add needs lead;
//     the floor below also refuses it).
//   * THE FLOOR: agent_seats.admission_status = 'observed' is stamped FIRST (a seat that is observed with no membership is only more
//     restricted; the reverse order would leave an ungoverned member for a moment). Stamped only while NULL: a 'trusted' or 'held'
//     seat is never re-observed or released by calling join again. While observed or held, invokeTool refuses every tool outside
//     OBSERVED_FLOOR_TOOLS (deny-by-default, by NAME), re-read from the seat row on every call so a later hold bites at once.
//   * NOT ELIGIBLE: ONE pending squad_join_request card (observer), to that squad's approvers; the reply is the same whether or not the
//     squad exists. A repeat finds the pending row first and does not re-file or re-notify.

import type { AuthContext, Capability, Env, OrgKind } from '../types'
import { CAPABILITY_LIVE_PREDICATE, brandSquadScope, canOnSquad, capabilityRank, loadSquadScope, resolveCapabilities, type SquadScope } from '../auth/capability'
import { buildAuth, memberIsActiveHuman } from '../access/identity'
import { resolveSquadRef } from '../org/resolve'
import { addSquadMember } from './squad-membership'

export function vipLaneEnabled(env: Pick<Env, 'VIP_LANE'>): boolean {
  return env.VIP_LANE === '1'
}

/** The squad-level tier an observed seat is given. The seat clamp (SEAT_CEILING in seat-handle.ts) is also 'member', so
 *  min(squad observed tier, member ceiling) = 'member'; the floor list below is what makes it "observed". */
export const OBSERVED_TIER: Capability = 'member'
export const OBSERVED_TIER_RANK = capabilityRank(OBSERVED_TIER)

/**
 * What an OBSERVED (or held) seat may call: read the board, docs and memory, check in, orient, message, propose and update tasks,
 * scoped recall/remember, and this lane's own tools. EVERYTHING else is refused by name: no gates (task_verdict), no grants or
 * membership writes, no token/identity/seat tools, no elevation, no secrets or drops, no publish, no money, no broadcast.
 */
export const OBSERVED_FLOOR_TOOLS: ReadonlySet<string> = new Set([
  'boot_context', 'orient', 'connect', 'status', 'whoami', 'check_in', 'end_agent_session',
  'presence_register', 'presence_heartbeat', 'presence_deregister', 'presence_list', 'peers',
  // `send` = durable message to ONE agent's inbox (message-only by design; the doorbell is that message's own delivery).
  // squad_message is NOT here: it emits squad.dispatch, which the consumer routes to the squad coordinator = it wakes an agent to act.
  'inbox', 'message_get', 'inbox_ack', 'send',
  // squad_remember / project_remember are NOT here: they write the squad's/project's SHARED memory and there is no seat-scoped variant of them.
  // `remember` is the seat's own scope.
  'recall', 'remember', 'memory_recent', 'memory_get', 'squad_recall', 'project_recall', 'project_memory_get',
  'task_list', 'task_board', 'task_get', 'kanban_board', 'task_create', 'task_update',
  'project_list', 'project_get', 'project_context', 'project_wiki', 'project_wiki_get', 'project_squad_list',
  'squad_member_list', 'flight_get', 'flight_list', 'resolve_agent', 'get_agent_profile', 'fleet_agent_get',
  'join_squad', 'squad_join_request',
])

export type SeatAdmissionStatus = 'observed' | 'trusted' | 'held'

/** The seat's stored status, read fresh. null = no status (every pre-existing seat). Fails CLOSED to 'held' on a read error. */
export async function readSeatAdmissionStatus(env: Env, seatId: string): Promise<SeatAdmissionStatus | null> {
  try {
    const row = await env.DB.prepare(`SELECT admission_status AS s FROM agent_seats WHERE id = ?1 AND tenant = ?2 LIMIT 1`)
      .bind(seatId, env.TENANT_SLUG).first<{ s: string | null }>()
    if (!row || row.s === null) return null
    return row.s === 'observed' || row.s === 'trusted' || row.s === 'held' ? row.s : 'held'
  } catch {
    return 'held'
  }
}

/** The floor, applied at the tool chokepoint. null = allowed. Only an UNATTACHED seat session with VIP_LANE on is ever looked at. */
export async function observedFloorRefusal(env: Env, auth: AuthContext, toolName: string): Promise<{ status: SeatAdmissionStatus } | null> {
  if (!vipLaneEnabled(env)) return null
  const seat = auth.seatBinding
  if (!seat || seat.attached) return null
  const status = await readSeatAdmissionStatus(env, seat.seatId)
  if (status === null || status === 'trusted') return null
  return OBSERVED_FLOOR_TOOLS.has(toolName) ? null : { status }
}

export interface JoinTarget { id: string; slug: string; name: string; department_id: string; kind: string; status: string }

export type ResolvedTarget =
  | { ok: true; squads: JoinTarget[]; via: 'squad' | 'project' }
  | { ok: false; error: 'not_found' | 'ambiguous' }

const SQUAD_COLS = `s.id AS id, s.slug AS slug, s.name AS name, s.department_id AS department_id, s.kind AS kind, s.status AS status`

/** `squad` = id or slug (the shared, ambiguity-refusing resolver). `project` = id or slug, mapped through project_squad_access
 *  (a project has NO single owning squad: it has access edges to one or more squads). */
export async function resolveJoinTargets(env: Env, ref: { squad?: string; project?: string }): Promise<ResolvedTarget> {
  if (ref.squad !== undefined) {
    const r = await resolveSquadRef(env, ref.squad)
    if (!r.ok) return { ok: false, error: r.reason }
    const sq = await env.DB.prepare(`SELECT ${SQUAD_COLS} FROM squads s WHERE s.id = ?1 LIMIT 1`).bind(r.value.id).first<JoinTarget>()
    return sq ? { ok: true, squads: [sq], via: 'squad' } : { ok: false, error: 'not_found' }
  }
  const p = ref.project ?? ''
  const proj = await env.DB.prepare(`SELECT id FROM projects WHERE id = ?1 OR slug = ?1 LIMIT 2`).bind(p).all<{ id: string }>()
  const ids = [...new Set((proj.results ?? []).map((x) => x.id))]
  if (ids.length === 0) return { ok: false, error: 'not_found' }
  if (ids.length > 1) return { ok: false, error: 'ambiguous' }
  const rows = await env.DB.prepare(
    `SELECT ${SQUAD_COLS} FROM project_squad_access a JOIN squads s ON s.id = a.squad_id WHERE a.project_id = ?1 AND s.status != 'archived' ORDER BY s.id LIMIT 50`,
  ).bind(ids[0]).all<JoinTarget>()
  return { ok: true, squads: rows.results ?? [], via: 'project' }
}

/** ELIGIBLE = the human's EFFECTIVE grants (resolveCapabilities) give admin on the squad (canOnSquad). One predicate, one source. */
export async function humanMayInstantJoin(env: Env, grants: Awaited<ReturnType<typeof resolveCapabilities>>, squadId: string): Promise<boolean> {
  const scope = await loadSquadScope(env, squadId)
  return scope ? humanMayAdminScope(env, grants, scope) : false
}

/** The predicate itself, over an already-loaded scope (the list batches the scope read; join_squad loads one). */
export async function humanMayAdminScope(env: Env, grants: Awaited<ReturnType<typeof resolveCapabilities>>, scope: SquadScope): Promise<boolean> {
  if (scope.kind === 'home') return false
  return canOnSquad(env, grants, scope, 'admin')
}

export type InstantJoinResult =
  | { ok: true; admission_status: SeatAdmissionStatus; membership: 'created' | 'already' | 'kept'; squad: Pick<JoinTarget, 'id' | 'slug' | 'name'> }
  | { ok: false; error: 'member_not_active' | 'seat_held' | 'squad_not_joinable' | 'write_refused' | 'standing_lost' }

/**
 * The instant, observed join for an UNATTACHED seat. The caller (the tool) has already proved eligibility with humanMayInstantJoin;
 * this re-checks the pieces that must hold at write time (active human, squad open) and writes.
 */
export async function instantObservedJoin(
  env: Env,
  p: { humanMemberId: string; seatId: string; seatAgentId: string; squad: JoinTarget; grants: Awaited<ReturnType<typeof resolveCapabilities>> },
): Promise<InstantJoinResult> {
  if (!(await memberIsActiveHuman(env, p.humanMemberId))) return { ok: false, error: 'member_not_active' }
  if (p.squad.kind === 'home' || p.squad.status === 'archived') return { ok: false, error: 'squad_not_joinable' }
  const status = await readSeatAdmissionStatus(env, p.seatId)
  if (status === 'held') return { ok: false, error: 'seat_held' }
  // Re-derive standing NOW, at the write (the caller's grants may be stale by a few awaits): same function, fresh read. This narrows the
  // window between check and write; it does not make them one statement (a demotion landing between this line and the write still wins the race).
  const grants = await resolveCapabilities(env, p.humanMemberId)
  if (!(await humanMayInstantJoin(env, grants, p.squad.id))) return { ok: false, error: 'standing_lost' }
  // Floor first (only while NULL, only for a still-active member): a held/trusted seat is never re-stamped by a repeat join.
  await env.DB.prepare(`UPDATE agent_seats SET admission_status = 'observed' WHERE id = ?1 AND tenant = ?2 AND admission_status IS NULL
      AND EXISTS (SELECT 1 FROM members WHERE id = ?3 AND tenant = ?2 AND status = 'active' AND archived_at IS NULL)`)
    .bind(p.seatId, env.TENANT_SLUG, p.humanMemberId).run()
  const now = await readSeatAdmissionStatus(env, p.seatId)
  if (now === null || now === 'held') return { ok: false, error: 'seat_held' }
  const squad = { id: p.squad.id, slug: p.squad.slug, name: p.squad.name }

  const existing = await env.DB.prepare(`SELECT capability FROM memberships WHERE agent_id = ?1 AND squad_id = ?2 LIMIT 1`)
    .bind(p.seatAgentId, p.squad.id).first<{ capability: string }>()
  if (existing) {
    // Idempotent: same membership, no second receipt. A higher standing someone else gave this seat is kept, never lowered.
    return { ok: true, admission_status: now, membership: capabilityRank(existing.capability as Capability) > OBSERVED_TIER_RANK ? 'kept' : 'already', squad } // stored value, closed CHECK list in 0001
  }
  // The write runs AS the human, with the human's own effective grants (buildAuth leaves them undefined for a legacy owner/admin login).
  const humanAuth: AuthContext = { ...(await buildAuth(env, p.humanMemberId)), capabilities: grants }
  const w = await addSquadMember({
    env, auth: humanAuth, agentId: p.seatAgentId,
    squad: { id: p.squad.id, department_id: p.squad.department_id, kind: p.squad.kind as OrgKind }, // kind is the squads.kind CHECK list; 'home' was refused above
    capability: OBSERVED_TIER as 'member', neverLower: true, via: 'squad_join',
  })
  if (!w.ok) return { ok: false, error: 'write_refused' }
  return { ok: true, admission_status: now, membership: 'created', squad }
}

/** Per-HUMAN card caps across ALL of that human's seats (a per-seat cap is multiplied by however many seats a session can mint). */
export const VIP_CARD_MAX_PENDING_PER_HUMAN = 5
export const VIP_CARD_MAX_PER_HOUR_PER_HUMAN = 10

export async function humanCardCapReached(env: Env, humanMemberId: string, nowMs: number = Date.now()): Promise<boolean> {
  const nowIso = new Date(nowMs).toISOString()
  const pending = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM squad_join_requests r JOIN agent_seats s ON s.agent_id = r.agent_id
      WHERE s.tenant = ?1 AND s.member_id = ?2 AND r.status = 'pending' AND r.expires_at > ?3`,
  ).bind(env.TENANT_SLUG, humanMemberId, nowIso).first<{ n: number }>()
  if (Number(pending?.n ?? 0) >= VIP_CARD_MAX_PENDING_PER_HUMAN) return true
  const hour = await env.DB.prepare(
    `SELECT COALESCE(SUM(l.count), 0) AS n FROM squad_join_rate_limits l JOIN agent_seats s ON s.agent_id = l.agent_id
      WHERE s.tenant = ?1 AND s.member_id = ?2 AND l.bucket = ?3`,
  ).bind(env.TENANT_SLUG, humanMemberId, nowIso.slice(0, 13)).first<{ n: number }>()
  return Number(hour?.n ?? 0) >= VIP_CARD_MAX_PER_HOUR_PER_HUMAN
}

/** task_update under the observed floor: only a task assigned to THIS seat's agent (the tasks table has no creator column), and never the
 *  gate/assignee fields, nor a terminal status on a gated task. null = allowed. */
export async function observedTaskUpdateRefusal(
  env: Env, auth: AuthContext, existing: { assignee_agent_id: string | null; gate_owner: string | null }, args: Record<string, unknown>,
): Promise<string | null> {
  if (!vipLaneEnabled(env)) return null
  const seat = auth.seatBinding
  if (!seat || seat.attached) return null
  const status = await readSeatAdmissionStatus(env, seat.seatId)
  if (status === null || status === 'trusted') return null
  if (!auth.boundAgentId || existing.assignee_agent_id !== auth.boundAgentId) return 'An observed seat may update only tasks assigned to it.'
  for (const k of ['gate_owner', 'gate_owner_reason', 'assignee_agent_id', 'assignee_member_id']) {
    if (args[k] !== undefined) return `An observed seat may not change ${k}.`
  }
  if (existing.gate_owner && typeof args.status === 'string' && ['done', 'approved', 'rejected'].includes(args.status)) {
    return 'An observed seat may not close a gated task.'
  }
  return null
}

/** task_create under the observed floor: proposal-only. No assignee, no gate_owner, no explicit dispatch:true; dispatch is FORCED off
 *  (no task.created event, no doorbell) so a seat can never wake another agent. null = allowed; forceNoDispatch tells the tool to
 *  suppress the wake. A non-observed seat or flag off => { refusal: null, forceNoDispatch: false } (total no-op). */
export async function observedTaskCreateRefusal(
  env: Env, auth: AuthContext, args: Record<string, unknown>,
): Promise<{ refusal: string | null; forceNoDispatch: boolean }> {
  const allow = { refusal: null, forceNoDispatch: false }
  if (!vipLaneEnabled(env)) return allow
  const seat = auth.seatBinding
  if (!seat || seat.attached) return allow
  const status = await readSeatAdmissionStatus(env, seat.seatId)
  if (status === null || status === 'trusted') return allow
  for (const k of ['assignee_agent_id', 'assignee_member_id', 'gate_owner']) {
    if (args[k] !== undefined && args[k] !== null) return { refusal: `An observed seat creates proposal-only tasks: it may not set ${k}.`, forceNoDispatch: true }
  }
  if (args.dispatch !== undefined && args.dispatch !== false) {
    return { refusal: 'An observed seat may not dispatch a task (dispatch:true refused; omit it or pass false).', forceNoDispatch: true }
  }
  return { refusal: null, forceNoDispatch: true }
}

// #2035 wall 5: boot_context / orient point at join_squad. READ-ONLY, no new authority: the list reuses humanMayInstantJoin (the
// predicate join_squad itself runs) and shows only squads the human can admin, so it reveals nothing the human cannot already see.
export const JOINABLE_LIST_MAX = 10
const JOINABLE_SCAN_MAX = 500 // ONE query; the cap (10) applies AFTER authorization, in memory, over the human's admin set
const JOIN_OTHER_LINE = 'for any other squad: join_squad files a request to its owner'
const JOIN_FLAG_OFF_LINE = 'joining a squad: ask its owner/admin to add you (squad_join_request)'

export interface JoinNextSteps {
  note: string
  squads?: Array<{ id: string; slug: string; name: string; call: string }>
}

/** null = say nothing (a bare unbound session has no prerequisites). Flag off: one line, no DB read. Flag on: the list only for an
 *  UNATTACHED, non-held seat of an ACTIVE human; everyone else with a seat/bound agent gets the one line. Query count is constant in the
 *  number of squads: canOnSquad over a pre-loaded scope is pure, so the whole list is active-human + grants + held + ONE squads read. */
export async function joinNextSteps(env: Env, auth: Pick<AuthContext, 'seatBinding' | 'boundAgentId'>): Promise<JoinNextSteps | null> {
  const seat = auth.seatBinding
  if (!seat && !auth.boundAgentId) return null
  if (!vipLaneEnabled(env)) return { note: JOIN_FLAG_OFF_LINE }
  if (!seat || seat.attached || !auth.boundAgentId || !(await memberIsActiveHuman(env, seat.humanMemberId))) return { note: JOIN_OTHER_LINE }
  if ((await readSeatAdmissionStatus(env, seat.seatId)) === 'held') return { note: JOIN_OTHER_LINE }
  const grants = await resolveCapabilities(env, seat.humanMemberId)
  const rows = await env.DB.prepare(
    `SELECT s.id AS id, s.slug AS slug, s.name AS name, s.department_id AS department_id, s.kind AS kind FROM squads s
     WHERE s.status != 'archived' AND s.kind != 'home'
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.agent_id = ?1 AND m.squad_id = s.id AND ${CAPABILITY_LIVE_PREDICATE('m', "datetime('now')")})
       AND s.id != COALESCE((SELECT a.squad_id FROM agents a WHERE a.id = ?1), '')
     ORDER BY s.name, s.id LIMIT ?2`,
  ).bind(auth.boundAgentId, JOINABLE_SCAN_MAX).all<{ id: string; slug: string; name: string; department_id: string; kind: OrgKind }>()
  const squads: NonNullable<JoinNextSteps['squads']> = []
  for (const sq of rows.results ?? []) {
    if (squads.length >= JOINABLE_LIST_MAX) break
    // brandSquadScope: the fields came straight off a real squads row above.
    if (await humanMayAdminScope(env, grants, brandSquadScope({ id: sq.id, department_id: sq.department_id, kind: sq.kind }))) squads.push({ id: sq.id, slug: sq.slug, name: sq.name, call: `join_squad {squad:"${sq.id}"}` })
  }
  return { note: JOIN_OTHER_LINE, ...(squads.length ? { squads } : {}) }
}
