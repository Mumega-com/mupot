// Leaf module (imports only token-lifecycle + attach-designated): THE one definition of "this attachment is live right now",
// as SQL fragments. findLiveAttachment (every request of an attached thread, src/members/seat-attach.ts) and the verdict write
// guard (buildVerdictStatements, src/tasks/service.ts, mupot#2095) both embed these, so the per-request pre-check and the
// atomic write cannot diverge. Do not copy the clauses anywhere: call these.
//
// The fragments need the aliases: att (agent_seat_attachments), adm (agent_seat_admissions), s (agent_seats), a (agents),
// b (agent_member_bindings), am (members), hr (harnesses). Each placeholder is requested through `ph`, so a caller with
// numbered binds (?1..?5) and a caller with positional binds (an UPDATE's WHERE) share the same text.
import type { Env } from '../types'
import { TOKEN_LIVE_PREDICATE } from '../auth/token-lifecycle'
import { attachDesignatedClause, ADMISSION_BOUND_TO_SEAT_SQL } from './attach-designated'

export type LivePlaceholder = 'tenant' | 'seat' | 'grantToken' | 'human' | 'now'
export type LivePh = (k: LivePlaceholder) => string

/** The joins. The agent's welded member must be active (am.status), and the harness must still be the human's (hr). */
export const LIVE_ATTACHMENT_FROM_SQL = `agent_seat_attachments att
       JOIN agent_seat_admissions adm ON adm.id = att.admission_id AND adm.tenant = att.tenant
       JOIN agent_seats s ON s.id = att.seat_id AND s.tenant = att.tenant
       JOIN agents a ON a.id = att.agent_id
       JOIN agent_member_bindings b ON b.tenant = att.tenant AND b.agent_id = a.id
       JOIN members am ON am.id = b.member_id AND am.tenant = att.tenant AND am.status = 'active'
       JOIN harnesses hr ON hr.id = att.harness_id AND hr.tenant = att.tenant AND hr.member_id = att.human_member_id`

/** The attachment's own (seat) token: bound to the weld, agent and directory channel, and live. Evaluated with `t` as the token alias. */
export function seatTokenLiveSql(ph: LivePh): string {
  return `t.id = att.seat_token_id AND t.member_id = b.member_id AND t.agent_id = a.id
                AND t.tenant = ${ph('tenant')} AND t.channel = 'directory'
                AND ${TOKEN_LIVE_PREDICATE(ph('now'))}`
}

/** Every WHERE condition findLiveAttachment applies, minus the seat-token liveness (a select-list value there, see seatTokenLiveSql). */
export function liveAttachmentConditionsSql(env: Env, ph: LivePh): string {
  return `att.tenant = ${ph('tenant')}
        AND att.seat_id = ${ph('seat')}
        AND att.detached_at IS NULL
        AND att.human_member_id = ${ph('human')}
        AND adm.status = 'live'
        AND adm.agent_id = att.agent_id
        AND adm.human_member_id = att.human_member_id
        AND adm.harness_id = att.harness_id
        AND ${ADMISSION_BOUND_TO_SEAT_SQL}
        AND (adm.scope = 'seat' OR (${ph('grantToken')} IS NOT NULL AND hr.credential_kind = 'oauth' AND hr.grant_id = 'oauth:' || ${ph('grantToken')})) -- R1: a harness-wide admission needs THIS request's grant to be the install's own
        AND s.retired_at IS NULL
        AND s.member_id = att.human_member_id
        AND s.harness_id = att.harness_id
        AND a.status = 'active'
        ${attachDesignatedClause(env, 'a', ph('human'))}
        AND (${ph('grantToken')} IS NULL OR EXISTS (SELECT 1 FROM member_tokens g
                     WHERE g.id = ${ph('grantToken')} AND g.member_id = ${ph('human')} AND g.tenant = ${ph('tenant')}
                       AND g.channel = 'directory' AND g.agent_id IS NULL
                       AND ${TOKEN_LIVE_PREDICATE(ph('now'), 'g')}))`
}
