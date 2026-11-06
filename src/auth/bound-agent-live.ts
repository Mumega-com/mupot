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
//   - (#2343) a session with no consenter (#2345: keyed on consent, not channel) must still hold at least one
//     live capability: a member whose every capability was revoked is demoted, and the agent weld must not keep
//     reaching 'authenticated'-floor tools on its own. A consented session derives its capabilities separately.
// A refusal carries one stable code; the caller cannot tell which leg failed. A read that THROWS is not a refusal:
// it is 'unavailable' (retryable 503, BOUND_AGENT_CHECK_UNAVAILABLE), never a 403 and never a pass.
//
// Used by: the MCP doors + events/subscribe (src/mcp/index.ts), the push-time re-check (events-subscriptions.ts),
// and EVERY REST bearer route through resolveMemberByToken / resolveStreamMemberByToken / memberTokenHashIsLive
// (src/auth/member-bearer.ts), so a new /api route that resolves an agent bearer gets the check for free.

import type { AuthContext, Env } from '../types'
import { CAPABILITY_LIVE_PREDICATE, nowCapabilitySql } from './capability'

export const BOUND_AGENT_NOT_AUTHORIZED = 'agent_not_authorized'
/** Retryable 503: the liveness read itself failed, so we cannot say yes or no. */
export const BOUND_AGENT_CHECK_UNAVAILABLE = 'agent_check_unavailable'

export type BoundAgentVerdict = 'live' | 'refused' | 'unavailable'

/** Thrown by resolveMemberByToken when the liveness read fails; the app error handler maps it to the retryable 503. */
export class BoundAgentCheckUnavailableError extends Error {
  constructor() {
    super(BOUND_AGENT_CHECK_UNAVAILABLE)
    this.name = 'BoundAgentCheckUnavailableError'
  }
}

interface LiveRow {
  status: string
  owner_member_id: string | null
  owner_status: string | null
  consenter_status: string | null
  has_caps: number
}

/**
 * Tri-state live check for a session that carries an agent weld. One D1 statement. 'live' when the session has no weld, or the
 * weld is backed by a live agent, live owner/consenter and (for a plain workspace-style session) at least one live capability.
 * Default polling semantics permit paused agents; requireActive is the narrower agent-work check.
 */
export async function boundAgentVerdict(
  env: Pick<Env, 'DB' | 'TENANT_SLUG'>,
  auth: Pick<AuthContext, 'boundAgentId' | 'consentedByMemberId'> & { memberId?: string | null },
  options: { requireActive?: boolean } = {},
): Promise<BoundAgentVerdict> {
  const agentId = auth.boundAgentId
  if (!agentId) return 'live'
  const consenter = auth.consentedByMemberId ?? null
  // The capability leg applies to a session whose authority IS the member's own grants. A consented session derives
  // its capabilities through resolveConsentedAgentCapabilities (which already refuses an empty set) and is not re-judged
  // here. The exemption is keyed on the consenter being PRESENT (mupot#2345), never on the channel label: a directory
  // session with no consenter has no derived grants to lean on, so it is judged like any workspace session.
  const capMember = consenter === null ? (auth.memberId ?? null) : null
  try {
    const row = await env.DB.prepare(
      `SELECT a.status AS status, a.owner_member_id AS owner_member_id,
              om.status AS owner_status, cm.status AS consenter_status,
              CASE WHEN ?4 IS NULL THEN 1
                   WHEN EXISTS (SELECT 1 FROM capabilities c WHERE c.member_id = ?4 AND ${CAPABILITY_LIVE_PREDICATE('c', '?5')})
                     OR EXISTS (SELECT 1 FROM channel_capability_grants ccg JOIN squads s ON s.id = ccg.squad_id
                                 WHERE ccg.member_id = ?4 AND s.kind != 'home') THEN 1
                   ELSE 0 END AS has_caps
         FROM agents a
         LEFT JOIN members om ON om.id = a.owner_member_id AND om.tenant = ?2
         LEFT JOIN members cm ON cm.id = ?3 AND cm.tenant = ?2
        WHERE a.id = ?1
        LIMIT 1`,
    ).bind(agentId, env.TENANT_SLUG, consenter, capMember, nowCapabilitySql()).first<LiveRow>()
    if (!row || (row.status !== 'active' && (options.requireActive || row.status !== 'paused'))) return 'refused'
    if (row.owner_member_id !== null && row.owner_status !== 'active') return 'refused'
    if (consenter !== null && row.consenter_status !== 'active') return 'refused'
    if (row.has_caps !== 1) return 'refused'
    return 'live'
  } catch {
    return 'unavailable'
  }
}

/** Boolean form: true only on 'live' (a failed read is NOT live). */
export async function boundAgentIsLive(
  env: Pick<Env, 'DB' | 'TENANT_SLUG'>,
  auth: Pick<AuthContext, 'boundAgentId' | 'consentedByMemberId'> & { memberId?: string | null },
): Promise<boolean> {
  return (await boundAgentVerdict(env, auth)) === 'live'
}
