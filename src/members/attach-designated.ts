// Leaf module (imports only the harness flag): the attach flags and THE one "attach-designated" predicate.
// Used by seat-attach.ts (list, admissionRefusal, promote, dashboard insert, chokepoint, insert guard), the events readers,
// elevation's attachment-origin check and inbox_mark_handled. Do not copy the clause anywhere: call it.
import type { Env } from '../types'
import { seatAutoEnrollEnabled } from './harness'

/** The one definition of "is attach on". Strict '1' on both flags: attach without seats means nothing. */
export function seatAttachEnabled(env: Pick<Env, 'SEAT_ATTACH' | 'SEAT_AUTO_ENROLL'>): boolean {
  return env.SEAT_ATTACH === '1' && seatAutoEnrollEnabled(env)
}

/** SEAT_ATTACH_DESIGNATED (strict '1', and only with attach itself on): attach is narrowed to agents an org admin designated for
 *  THIS human (agents.attach_designated_member_id, migration 0238). Off = today's behaviour, byte for byte. */
export function seatAttachDesignatedEnabled(env: Pick<Env, 'SEAT_ATTACH' | 'SEAT_AUTO_ENROLL' | 'SEAT_ATTACH_DESIGNATED'>): boolean {
  return seatAttachEnabled(env) && env.SEAT_ATTACH_DESIGNATED === '1'
}

/**
 * THE ONE "this agent is attach-designated for this human" predicate, as an SQL AND-fragment. Every attach site embeds
 * THIS function and nothing else: listAttachableAgents (request + resolve), admissionRefusal (the human's decision),
 * the findLiveAttachment join (every request) and the attachment INSERT guard. Grant time and use time therefore share
 * one definition, and un-designating detaches on the next request with no sweep. `agentAlias` is the agents table alias in
 * the host statement; `humanParam` the numbered bind that holds the human member id (e.g. '?4').
 * Flag off: a tautology that still consumes the bind (so the statements keep one bind shape) and changes nothing.
 */
export function attachDesignatedClause(env: Pick<Env, 'SEAT_ATTACH' | 'SEAT_AUTO_ENROLL' | 'SEAT_ATTACH_DESIGNATED'>, agentAlias: string, humanParam: string): string {
  return seatAttachDesignatedEnabled(env)
    ? `AND ${agentAlias}.attach_designated_member_id = ${humanParam}`
    : `AND ${humanParam} IS NOT NULL`
}


/** The admission belongs to the chat that asked (#2056); NULL never matches. Shared by EVERY hand-copied attachment-liveness
 *  check (resolver, elevation origin, events) so they cannot drift apart. Needs aliases `adm` (admission) and `att` (attachment). */
export const ADMISSION_BOUND_TO_SEAT_SQL = 'adm.requested_seat_id = att.seat_id'
