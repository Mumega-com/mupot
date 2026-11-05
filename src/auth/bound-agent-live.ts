// bound-agent-live — the ONE live capability check for agent-bound MCP sessions (mupot#983).
//
// A token welded to an agent (member_tokens.agent_id -> AuthContext.boundAgentId) authorised
// inbox / send / isSelf / presence and every other boundAgentId-keyed tool on that id ALONE. The
// token-liveness read proves the credential and its own member are live; it says nothing about the
// agent row or the humans the weld rests on. This helper closes that, for every tool, at the tool
// boundary (invokeToolInner), with a single D1 read:
//   - the agent row exists and is live: active or paused, the SAME set TOKEN_LIVE_PREDICATE admits (src/auth/token-lifecycle.ts),
//     so a pause keeps meaning "brake, token still polls" and this check changes nothing about it;
//   - the agent's owner (agents.owner_member_id), when one is set, is still an active member;
//   - the member who consented to the weld (AuthContext.consentedByMemberId), when one exists, is
//     still an active member. Their admin-rank floor is re-derived separately by
//     resolveConsentedAgentCapabilities on the same request; a weld that fails it never reaches here.
// A refusal carries one stable code; the caller cannot tell which leg failed.

import type { AuthContext, Env } from '../types'

export const BOUND_AGENT_NOT_AUTHORIZED = 'agent_not_authorized'

interface LiveRow {
  status: string
  owner_member_id: string | null
  owner_status: string | null
  consenter_status: string | null
}

/** True when the session carries no agent weld, or the weld is still backed by a live agent and live members. Fails closed on a read error. */
export async function boundAgentIsLive(
  env: Pick<Env, 'DB' | 'TENANT_SLUG'>,
  auth: Pick<AuthContext, 'boundAgentId' | 'consentedByMemberId'>,
): Promise<boolean> {
  const agentId = auth.boundAgentId
  if (!agentId) return true
  const consenter = auth.consentedByMemberId ?? null
  try {
    const row = await env.DB.prepare(
      `SELECT a.status AS status, a.owner_member_id AS owner_member_id,
              om.status AS owner_status, cm.status AS consenter_status
         FROM agents a
         LEFT JOIN members om ON om.id = a.owner_member_id AND om.tenant = ?2
         LEFT JOIN members cm ON cm.id = ?3 AND cm.tenant = ?2
        WHERE a.id = ?1
        LIMIT 1`,
    ).bind(agentId, env.TENANT_SLUG, consenter).first<LiveRow>()
    if (!row || (row.status !== 'active' && row.status !== 'paused')) return false
    if (row.owner_member_id !== null && row.owner_status !== 'active') return false
    if (consenter !== null && row.consenter_status !== 'active') return false
    return true
  } catch {
    return false
  }
}
