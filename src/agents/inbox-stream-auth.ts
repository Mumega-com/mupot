import type { Env } from '../types'
import { seatFloorSql } from '../auth/member-bearer'
import { TOKEN_LIVE_PREDICATE, nowSqlUtc } from '../auth/token-lifecycle'
import { seatDeliveryQuery } from './seat-events'

/** References captured ONLY after authenticating the connecting bearer. Not credentials. */
export interface StreamIdentity {
  tokenId: string
  memberId: string
  agentId: string
  seat: string | null
}
export type StreamAuthorization = 'valid' | 'invalid' | 'error'

/** One statement rechecks the exact identity and the SAME host delivery predicate.
 * No raw bearer, usage stamp, inbox read, or directory/OAuth authority is involved. */
export async function validateInboxStreamIdentity(env: Env, id: StreamIdentity): Promise<StreamAuthorization> {
  if (!env.TENANT_SLUG || !id.tokenId || !id.memberId || !id.agentId) return 'invalid'
  const sf = seatFloorSql(env)
  try {
    const row = await env.DB.prepare(`
      SELECT t.id ${sf.select}
      FROM member_tokens t
      JOIN members m ON m.id = t.member_id AND m.tenant = t.tenant AND m.status = 'active'
      JOIN agents target ON target.id = t.agent_id AND target.status = 'active'
      ${sf.join}
      WHERE t.id = ?1 AND t.tenant = ?2 AND t.member_id = ?3 AND t.agent_id = ?4
        AND t.channel <> 'directory' AND ${TOKEN_LIVE_PREDICATE('?5')}
        AND NULLIF(trim(t.label), '') IS ?6
        AND NOT EXISTS (${seatDeliveryQuery('?2', '?4')})
      LIMIT 1
    `).bind(id.tokenId, env.TENANT_SLUG, id.memberId, id.agentId, nowSqlUtc(), id.seat)
      .first<{ id: string; seat_row_id: string | null; seat_status: string | null }>()
    if (!row) return 'invalid'
    if (row.seat_row_id !== null && row.seat_status !== null && row.seat_status !== 'trusted') return 'invalid'
    return 'valid'
  } catch {
    return 'error'
  }
}
