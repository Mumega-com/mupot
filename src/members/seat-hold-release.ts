// mupot — HUMAN hold / release for observed seats (#2060; design: agents/kasra/docs/design-admission-by-observation-20261018.md (b)/(c)).
//
// This is the ONLY writer of agent_seats.admission_status after the NULL->observed stamp in vip-lane.ts. Callable ONLY from the dashboard
// (src/dashboard/connections.ts, real web session of the seat's own human + fresh reauth for the actions that widen reach). There is NO
// MCP tool and no seat/agent code path: a seat can never change its own status.
//
// ONE guarded statement per transition: UPDATE ... WHERE seat belongs to THIS human (agent_seats.member_id) AND tenant AND not retired
// AND current status = the exact `from` the audit row records. The audit row is inserted in the SAME D1 batch, guarded by the identical
// predicate, so no change without a row and no row without a change. VIP_LANE off refuses Hold/Return; Release clears a stale label with fresh reauth.

import type { Env } from '../types'
import { memberIsActiveHuman } from '../access/identity'
import { vipLaneEnabled, type SeatAdmissionStatus } from './vip-lane'

export type SeatHoldAction = 'hold' | 'release' | 'return'
/** Audit actions: the three human ones plus the system reset when a trusted seat joins a NEW squad. */
export type SeatAuditAction = SeatHoldAction | 'rejoin_reset'

/** action -> the statuses it may start from, and where it ends. The single source of the transition table. */
export const SEAT_TRANSITIONS: Readonly<Record<SeatHoldAction, { from: readonly SeatAdmissionStatus[]; to: SeatAdmissionStatus }>> = {
  hold: { from: ['observed', 'trusted'], to: 'held' },
  release: { from: ['observed', 'held'], to: 'trusted' },
  // trusted -> observed and held -> observed. Only held -> observed WIDENS reach (needs fresh reauth); trusted -> observed reduces it.
  return: { from: ['held', 'trusted'], to: 'observed' },
}

export function isSeatHoldAction(v: unknown): v is SeatHoldAction {
  return v === 'hold' || v === 'release' || v === 'return'
}

export type SeatHoldResult =
  | { ok: true; from: SeatAdmissionStatus; to: SeatAdmissionStatus }
  | { ok: false; error: 'vip_lane_disabled' | 'reauth_required' | 'member_ineligible' | 'seat_not_found' | 'invalid_transition' | 'conflict' }

/** True when this (action, from) pair WIDENS the seat's reach and so needs a fresh human reauth. */
export function wideningTransition(action: SeatHoldAction, from: SeatAdmissionStatus): boolean {
  return action === 'release' || (action === 'return' && from === 'held')
}

/** THE guarded write: status UPDATE + audit INSERT in one D1 batch, both scoped to this human's own live seat and the exact from-status. */
async function applyTransition(
  env: Env, p: { humanMemberId: string; seatId: string; from: SeatAdmissionStatus; to: SeatAdmissionStatus; action: SeatAuditAction },
): Promise<boolean> {
  const guard = `FROM agent_seats WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND retired_at IS NULL AND admission_status = ?4`
  const out = await env.DB.batch([
    env.DB.prepare(`INSERT INTO seat_admission_changes (id, tenant, seat_id, member_id, action, from_status, to_status)
        SELECT ?5, ?2, ?1, ?3, ?6, ?4, ?7 ${guard}`)
      .bind(p.seatId, env.TENANT_SLUG, p.humanMemberId, p.from, crypto.randomUUID(), p.action, p.to),
    env.DB.prepare(`UPDATE agent_seats SET admission_status = ?5 WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND retired_at IS NULL AND admission_status = ?4`)
      .bind(p.seatId, env.TENANT_SLUG, p.humanMemberId, p.from, p.to),
  ])
  return (out[1]?.meta?.changes ?? 0) === 1 // false = status moved between the caller's read and this write
}

/** Trust does not carry across squads: a TRUSTED seat that joins a squad it is not yet in goes back to observed. Audited. */
export async function resetTrustedOnRejoin(env: Env, p: { humanMemberId: string; seatId: string }): Promise<boolean> {
  return applyTransition(env, { ...p, from: 'trusted', to: 'observed', action: 'rejoin_reset' })
}

/** `fresh` = the caller's web session was re-authenticated recently. Widening transitions are refused without it, here and not only in the route. */
export async function changeSeatAdmission(
  env: Env, p: { humanMemberId: string; seatId: string; action: SeatHoldAction; fresh: boolean },
): Promise<SeatHoldResult> {
  const t = SEAT_TRANSITIONS[p.action]
  if (!t) return { ok: false, error: 'invalid_transition' }
  // VIP_LANE off: the floor is not enforced, so hold / return would promise a restriction nothing applies. Only RELEASE (clear the stale
  // observed/held label) is allowed then; it widens nothing in effect and keeps its fresh-reauth rule below.
  if (!vipLaneEnabled(env) && p.action !== 'release') return { ok: false, error: 'vip_lane_disabled' }
  if (!(await memberIsActiveHuman(env, p.humanMemberId))) return { ok: false, error: 'member_ineligible' }
  // Scoped read: another human's seat is indistinguishable from a missing one.
  const row = await env.DB.prepare(`SELECT admission_status AS s FROM agent_seats WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND retired_at IS NULL LIMIT 1`)
    .bind(p.seatId, env.TENANT_SLUG, p.humanMemberId).first<{ s: string | null }>()
  if (!row) return { ok: false, error: 'seat_not_found' }
  const from = row.s
  if (from !== 'observed' && from !== 'held' && from !== 'trusted') return { ok: false, error: 'invalid_transition' }
  if (!t.from.includes(from)) return { ok: false, error: 'invalid_transition' }
  if (wideningTransition(p.action, from) && !p.fresh) return { ok: false, error: 'reauth_required' }
  if (!(await applyTransition(env, { humanMemberId: p.humanMemberId, seatId: p.seatId, from, to: t.to, action: p.action }))) return { ok: false, error: 'conflict' }
  return { ok: true, from, to: t.to }
}

export interface ObservedSeatRow { seat_id: string; label: string; agent_name: string; status: 'observed' | 'held' | 'trusted'; last_used_at: string }

/** The human's OWN live seats that are observed, held or trusted (trusted rows can still be held or returned). Never another human's.
 *  Read with the flag off too (agent_seats.admission_status is an old column): a stale observed/held label must stay visible and clearable. */
export async function listObservedSeats(env: Env, humanMemberId: string): Promise<ObservedSeatRow[]> {
  try {
  const r = await env.DB.prepare(
    `SELECT s.id AS seat_id, s.label_basename AS label, a.name AS agent_name, s.admission_status AS status, COALESCE(s.last_used_at, s.created_at) AS last_used_at
       FROM agent_seats s JOIN agents a ON a.id = s.agent_id
      WHERE s.tenant = ?1 AND s.member_id = ?2 AND s.retired_at IS NULL AND s.admission_status IN ('observed','held','trusted')
      ORDER BY s.created_at DESC LIMIT 100`,
  ).bind(env.TENANT_SLUG, humanMemberId).all<ObservedSeatRow>()
  return r.results ?? []
  } catch {
    return [] // a pot whose schema predates the column: nothing to show, never a broken page
  }
}
