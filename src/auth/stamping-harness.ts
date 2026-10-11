// S13 (P1-2): SQL for "does this agent hold a live token that names a stamping harness?".
// ONE definition, three call sites (the tool door, the commit batch's anchor, the use-time re-check),
// so they cannot drift. The fact read is the token ROW's server-written label (see
// STAMPING_HARNESS_TOKEN_LABELS), never a value the caller passes in the call.

import { STAMPING_HARNESS_TOKEN_LABELS } from './elevation-actions'
import { TOKEN_LIVE_PREDICATE } from './token-lifecycle'

/** `EXISTS (...)` with BARE `?` placeholders, in this bind order:
 *    tenant, agentId, [tokenId when `pinToken`], nowSqlUtc, ...labels (use stampingBinds).
 *  `pinToken` additionally requires the exact token row that authenticated THIS call. */
export function stampingTokenExistsSql(pinToken: boolean): string {
  const labels = STAMPING_HARNESS_TOKEN_LABELS.map(() => '?').join(', ')
  return `EXISTS (SELECT 1 FROM member_tokens t
             WHERE t.tenant = ? AND t.agent_id = ?${pinToken ? ' AND t.id = ?' : ''}
               AND ${TOKEN_LIVE_PREDICATE('?')}
               AND lower(trim(t.label)) IN (${labels}))`
}

export function stampingBinds(tenant: string, agentId: string, tokenId: string | null, nowSql: string): string[] {
  return [tenant, agentId, ...(tokenId === null ? [] : [tokenId]), nowSql, ...STAMPING_HARNESS_TOKEN_LABELS]
}
