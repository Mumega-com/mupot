// Shared attached-inbox context and message shapes.  The context is minted
// only from AuthContext.seatBinding; wire arguments never select a scope.
import { attachedAuthority } from '../auth/attached-ceiling'
import type { AuthContext } from '../types'
import type { ContinuityRequest } from './attachment-continuity'

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

/** A group receipt is allowed only for an exact logical target or a genuine broadcast. */
export function continuityGroupVisibleSql(message = 'm', scope = 'cs'): string {
  return `((${message}.target_continuity_scope_id = ${scope}.id AND ${message}.target_seat = 'continuity:' || ${scope}.id)
    OR (${message}.target_continuity_scope_id IS NULL AND ${message}.target_seat IS NULL))`
}

/** Physical receipts/views never see a non-null logical target. */
export function attachmentPhysicalVisibleSql(message = 'm', seat = '?'): string {
  return `${message}.target_continuity_scope_id IS NULL AND ${message}.target_seat IS NOT NULL AND ${message}.target_seat = ${seat}`
}
