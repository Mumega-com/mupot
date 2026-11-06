// A binding is established by the authenticating door, never by tool arguments.
// Workspace, live admitted seats, OAuth and verified signing keys share this
// resource identity check. Capabilities/ceilings and credential-specific proofs
// stay with their existing authenticators and operation guards.
import type { AuthContext, Env } from '../types'
import { boundAgentVerdict, BOUND_AGENT_CHECK_UNAVAILABLE, BOUND_AGENT_NOT_AUTHORIZED } from './bound-agent-live'

export const AGENT_PAUSED_NEXT_STEP = 'Ask the operator to resume this agent, then retry the same operation or attempt_id.'

export type BoundAgentCaller = Pick<AuthContext, 'tenant' | 'memberId' | 'boundAgentId' | 'consentedByMemberId' | 'capabilities'>
export type BoundAgentCallerResult =
  | { ok: true; agentId: string; memberId: string }
  | { ok: false; status: 403 | 503; error: string; detail?: { next_step: string } }

export async function resolveBoundAgentCaller(
  env: Pick<Env, 'DB' | 'TENANT_SLUG'>,
  auth: BoundAgentCaller,
  options: { requireActive?: boolean } = {},
): Promise<BoundAgentCallerResult> {
  if (auth.tenant !== env.TENANT_SLUG || !auth.boundAgentId || !auth.memberId) {
    return { ok: false, status: 403, error: 'not_agent_bound' }
  }
  // A provided capability snapshot is the authenticated ceiling, never widened by the DB read.
  if (auth.capabilities && auth.capabilities.length === 0) return { ok: false, status: 403, error: BOUND_AGENT_NOT_AUTHORIZED }
  const verdict = await boundAgentVerdict(env, auth, { requireActive: options.requireActive ?? true })
  if (verdict === 'unavailable') return { ok: false, status: 503, error: BOUND_AGENT_CHECK_UNAVAILABLE }
  if (verdict === 'paused') return { ok: false, status: 403, error: 'agent_paused', detail: { next_step: AGENT_PAUSED_NEXT_STEP } }
  if (verdict !== 'live') return { ok: false, status: 403, error: BOUND_AGENT_NOT_AUTHORIZED }
  return { ok: true, agentId: auth.boundAgentId, memberId: auth.memberId }
}
