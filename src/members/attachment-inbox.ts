// Shared attached-inbox context and message shapes.  The context is minted
// only from AuthContext.seatBinding; wire arguments never select a scope.
import { attachedAuthority } from '../auth/attached-ceiling'
import type { AuthContext, Env } from '../types'
import { continuityScopeAuthoritySql, type ContinuityRequest } from './attachment-continuity'
import { LIVE_ATTACHMENT_FROM_SQL, liveAttachmentConditionsSql, seatTokenLiveSql, type LivePh } from './attach-live-sql'

export interface AttachedInboxContext {
  attachmentId: string
  agentId: string
  seatId: string
  harnessId: string
  humanMemberId: string
  sourceGrantTokenId: string
}

export function attachedInboxContext(auth: Pick<AuthContext, 'seatBinding'>): AttachedInboxContext | null {
  const attached = attachedAuthority(auth)
  const binding = auth.seatBinding
  if (!attached || !binding) return null
  return {
    attachmentId: attached.attachmentId,
    agentId: attached.agentId,
    seatId: binding.seatId,
    harnessId: binding.harnessId,
    humanMemberId: binding.humanMemberId,
    sourceGrantTokenId: binding.grantTokenId,
  }
}

export function attachmentContinuityRequest(context: AttachedInboxContext): ContinuityRequest {
  return context
}

/**
 * Statement-time proof for an attached inbox read.  This is intentionally an
 * EXISTS predicate, so page, remaining, and later custody queries all verify
 * the same current attachment/token chain without changing their row shape.
 * `scopeId` is selected only by server resolution; it is never a client arg.
 */
export function attachedInboxLiveSql(
  env: Env,
  context: AttachedInboxContext,
  scopeId: string | null,
  binds: (string | number | null)[],
): string {
  const start = binds.length
  // tenant, attachment, agent, harness, seat, grant, human, [scope]
  binds.push(env.TENANT_SLUG, context.attachmentId, context.agentId, context.harnessId, context.seatId, context.sourceGrantTokenId, context.humanMemberId)
  const ph: LivePh = (key) => ({
    tenant: `?${start + 1}`,
    seat: `?${start + 5}`,
    grantToken: `?${start + 6}`,
    human: `?${start + 7}`,
    now: "'now'",
  })[key]
  const scoped = scopeId !== null
  if (scoped) binds.push(scopeId)
  const scopeJoin = scoped ? ` JOIN attachment_continuity_scopes cs ON cs.id = ?${start + 8}` : ''
  const liveGuard = scoped ? continuityScopeAuthoritySql(env, ph, 'cs') : liveAttachmentConditionsSql(env, ph)
  return `EXISTS (SELECT 1 FROM ${LIVE_ATTACHMENT_FROM_SQL}
    JOIN member_tokens t ON ${seatTokenLiveSql(ph)}${scopeJoin}
    WHERE att.id = ?${start + 2} AND att.agent_id = ?${start + 3} AND att.harness_id = ?${start + 4}
      AND ${liveGuard})`
}

/** A group receipt is allowed only for an exact logical target or a genuine broadcast. */
export function continuityGroupVisibleSql(message = 'm', scope = 'cs'): string {
  return `((${message}.target_continuity_scope_id = ${scope}.id AND ${message}.target_seat = 'continuity:' || ${scope}.id)
    OR (${message}.target_continuity_scope_id IS NULL AND ${message}.target_seat IS NULL))`
}

/** Physical receipts/views never see a non-null logical target. */
export function attachmentPhysicalVisibleSql(message = 'm', seat = '?'): string {
  return `${message}.target_continuity_scope_id IS NULL AND ${message}.target_seat IS NOT NULL AND ${message}.target_seat = ${seat}`
}
