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


/**
 * "This admission covers the seat in `seatCol`" -- THE one binding predicate, shared by EVERY attachment-liveness check
 * (resolver, elevation origin, events, the attach INSERT). Needs the alias `adm` (admission).
 *  - scope 'seat' (every legacy row, the default): the admission belongs to the chat that asked (#2056); NULL never matches.
 *  - scope 'harness' (R1, mupot#1792): the human approved it for every chat of ONE install, so any seat may use it, but ONLY while
 *    the install's own grant is proven live from the DB: the harness row is an OAuth harness whose `grant_id` is
 *    'oauth:<consent token id>' and that consent token is a live, unbound directory token of the SAME human. A null / legacy /
 *    token-kind anchor, or a revoked / expired / foreign token, matches nothing (the whole scope stops working at once).
 *  Request metadata plays no part: everything here is read from rows.
 */
export function admissionBoundToSeatSql(seatCol: string): string {
  return `((adm.scope = 'seat' AND adm.requested_seat_id = ${seatCol}) OR (adm.scope = 'harness' AND EXISTS (
            SELECT 1 FROM harnesses hs JOIN member_tokens gs ON gs.id = substr(hs.grant_id, 7)
             WHERE hs.id = adm.harness_id AND hs.tenant = adm.tenant AND hs.member_id = adm.human_member_id
               AND hs.credential_kind = 'oauth' AND hs.grant_id LIKE 'oauth:_%'
               AND gs.tenant = adm.tenant AND gs.member_id = adm.human_member_id AND gs.channel = 'directory' AND gs.agent_id IS NULL
               AND gs.revoked_at IS NULL AND (gs.expires_at IS NULL OR julianday(gs.expires_at) > julianday('now')))))`
}

/** Needs aliases `adm` (admission) and `att` (attachment). */
export const ADMISSION_BOUND_TO_SEAT_SQL = admissionBoundToSeatSql('att.seat_id')
