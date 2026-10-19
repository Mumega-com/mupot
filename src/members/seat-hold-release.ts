// mupot — HUMAN hold / release for observed seats (#2060; design: agents/kasra/docs/design-admission-by-observation-20261018.md (b)/(c)).
//
// This is the ONLY writer of agent_seats.admission_status after the NULL->observed stamp in vip-lane.ts. Callable ONLY from the dashboard
// (src/dashboard/connections.ts, real web session of the seat's own human + fresh reauth for the actions that widen reach). There is NO
// MCP tool and no seat/agent code path: a seat can never change its own status.
//
// ONE guarded statement per transition: UPDATE ... WHERE seat belongs to THIS human (agent_seats.member_id) AND tenant AND not retired
// AND current status = the exact `from` the audit row records. The audit row is inserted in the SAME D1 batch, guarded by the identical
// predicate, so no change without a row and no row without a change. VIP_LANE off = inert (refuses; nothing read or written).

import type { Env } from '../types'
import { memberIsActiveHuman } from '../access/identity'
import { vipLaneEnabled, type SeatAdmissionStatus } from './vip-lane'

export type SeatHoldAction = 'hold' | 'release' | 'return'

/** action -> the statuses it may start from, and where it ends. The single source of the transition table. */
export const SEAT_TRANSITIONS: Readonly<Record<SeatHoldAction, { from: readonly SeatAdmissionStatus[]; to: SeatAdmissionStatus }>> = {
  hold: { from: ['observed'], to: 'held' },
  release: { from: ['observed', 'held'], to: 'trusted' },
  return: { from: ['held'], to: 'observed' },
}

export function isSeatHoldAction(v: unknown): v is SeatHoldAction {
  return v === 'hold' || v === 'release' || v === 'return'
}

export type SeatHoldResult =
  | { ok: true; from: SeatAdmissionStatus; to: SeatAdmissionStatus }
  | { ok: false; error: 'vip_lane_disabled' | 'member_ineligible' | 'seat_not_found' | 'invalid_transition' | 'conflict' }

export async function changeSeatAdmission(
  env: Env, p: { humanMemberId: string; seatId: string; action: SeatHoldAction },
): Promise<SeatHoldResult> {
  if (!vipLaneEnabled(env)) return { ok: false, error: 'vip_lane_disabled' }
  const t = SEAT_TRANSITIONS[p.action]
  if (!t) return { ok: false, error: 'invalid_transition' }
  if (!(await memberIsActiveHuman(env, p.humanMemberId))) return { ok: false, error: 'member_ineligible' }
  // Scoped read: another human's seat is indistinguishable from a missing one.
  const row = await env.DB.prepare(`SELECT admission_status AS s FROM agent_seats WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND retired_at IS NULL LIMIT 1`)
    .bind(p.seatId, env.TENANT_SLUG, p.humanMemberId).first<{ s: string | null }>()
  if (!row) return { ok: false, error: 'seat_not_found' }
  const from = row.s
  if (from !== 'observed' && from !== 'held' && from !== 'trusted') return { ok: false, error: 'invalid_transition' }
  if (!t.from.includes(from)) return { ok: false, error: 'invalid_transition' }
  const guard = `FROM agent_seats WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND retired_at IS NULL AND admission_status = ?4`
  const out = await env.DB.batch([
    env.DB.prepare(`INSERT INTO seat_admission_changes (id, tenant, seat_id, member_id, action, from_status, to_status)
        SELECT ?5, ?2, ?1, ?3, ?6, ?4, ?7 ${guard}`)
      .bind(p.seatId, env.TENANT_SLUG, p.humanMemberId, from, crypto.randomUUID(), p.action, t.to),
    env.DB.prepare(`UPDATE agent_seats SET admission_status = ?5 WHERE id = ?1 AND tenant = ?2 AND member_id = ?3 AND retired_at IS NULL AND admission_status = ?4`)
      .bind(p.seatId, env.TENANT_SLUG, p.humanMemberId, from, t.to),
  ])
  if ((out[1]?.meta?.changes ?? 0) !== 1) return { ok: false, error: 'conflict' } // status moved between the read and the write
  return { ok: true, from, to: t.to }
}

export interface ObservedSeatRow { seat_id: string; label: string; agent_name: string; status: 'observed' | 'held'; last_used_at: string }

/** The human's OWN live seats that are observed or held. Never another human's. Empty with the flag off (reads nothing). */
export async function listObservedSeats(env: Env, humanMemberId: string): Promise<ObservedSeatRow[]> {
  if (!vipLaneEnabled(env)) return []
  const r = await env.DB.prepare(
    `SELECT s.id AS seat_id, s.label_basename AS label, a.name AS agent_name, s.admission_status AS status, COALESCE(s.last_used_at, s.created_at) AS last_used_at
       FROM agent_seats s JOIN agents a ON a.id = s.agent_id
      WHERE s.tenant = ?1 AND s.member_id = ?2 AND s.retired_at IS NULL AND s.admission_status IN ('observed','held')
      ORDER BY s.created_at DESC LIMIT 100`,
  ).bind(env.TENANT_SLUG, humanMemberId).all<ObservedSeatRow>()
  return r.results ?? []
}
