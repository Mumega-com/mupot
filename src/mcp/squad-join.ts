// mupot — squad_join_request MCP tool. Thin glue over src/members/squad-join.ts (read that file for the model and the
// authority argument).
//
// WHO MAY CALL. A bound agent, or a chat ATTACHED to an agent (it acts as that agent, so the request is for that agent
// and only that agent). Both arrive with auth.boundAgentId set by the SERVER; nothing in args names who is asking. A
// session with no agent behind it, or an unattached throwaway seat, is refused. The optional `agent` arg exists only so
// a caller that names ANOTHER agent is refused outright (own_agent_only): it is compared to the caller's own id/slug,
// never resolved, so it can neither widen the request nor probe for other agents.
//
// WHAT IT DOES. Files a pending request and a one-time secure-moment link that goes ONLY to the eligible approvers. Nothing is
// granted. The reply is { status, expires_at, agent_prompt } (no link) and is identical whether or not the squad exists or is visible.

import type { ToolSpec } from './index'
import { fail, done, str } from './index'
import { secureMomentsStatus } from '../secure-moments/config'
import { SQUAD_JOIN_REASON_MAX, fileSquadJoinRequest, isJoinCapability, oneLine, type JoinCapability } from '../members/squad-join'
import { attachedAuthority } from '../auth/attached-ceiling'

/** The copyable text the agent shows its human, in mupot's voice. The same words for every squad ref and NO link: the approval link
 *  goes only to the squad's admins (a link in the agent's hands would let it read squad names it cannot see). */
export function squadJoinAgentPrompt(i: { agentName: string; squadRef: string; capability: JoinCapability; expiresAt: string }): string {
  const agent = oneLine(i.agentName, 60) || 'An agent'
  const squad = oneLine(i.squadRef, 64)
  return [
    `Message from mupot. ${agent} asked to join the squad "${squad}" as ${i.capability}.`,
    `The request was sent to that squad's admins, who can approve it with their passkey. Nothing changes until one of them does.`,
    `It expires ${i.expiresAt}. ${agent} will be told the outcome in its inbox. If you are an admin of that squad and have heard nothing, ask the agent to request again.`,
  ].join('\n')
}

const toolSquadJoinRequest: ToolSpec = {
  name: 'squad_join_request',
  scope: 'self (ask to join a squad; a human admin of that squad decides with a passkey; grants nothing by itself)',
  min: 'authenticated',
  args: '{ squad: string (id|slug), capability?: "member"|"observer" (default member), reason?: string, agent?: string (must be you) }',
  inputSchema: {
    type: 'object',
    properties: {
      squad: { type: 'string', description: 'The squad you want to join: id or slug. You will not be told whether it exists; the human who decides sees the real squad.' },
      capability: { type: 'string', enum: ['member', 'observer'], description: 'member (default) or observer. A join request can never ask for more.' },
      reason: { type: 'string', description: `Why you want in, shown to the approver as untrusted text (max ${SQUAD_JOIN_REASON_MAX} characters).` },
      agent: { type: 'string', description: 'Optional. Must be YOUR OWN agent id or slug; anything else is refused. You can only ask for yourself.' },
    },
    required: ['squad'],
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    // Server-derived identity: the agent behind this session (the bound agent, or the agent an attached chat acts as).
    const agentId = auth.boundAgentId
    if (!agentId) {
      return fail(403, 'agent_required', 'squad_join_request is for an agent. A human can add an agent to a squad directly with squad_member_add.')
    }
    // An unattached seat is a throwaway per-thread agent: it must attach to a real agent first.
    if (auth.seatBinding && !auth.seatBinding.attached) {
      return fail(403, 'attach_first', 'This chat is not attached to an agent. Attach it with seat_attach first; a join request is for the agent you act as.')
    }
    const attached = attachedAuthority(auth)

    if (args.agent !== undefined) {
      const named = typeof args.agent === 'string' ? args.agent.trim() : ''
      if (named.length === 0 || named.length > 128) return fail(400, 'invalid_args', { field: 'agent' })
      const own = await env.DB.prepare(`SELECT id, slug FROM agents WHERE id = ?1 LIMIT 1`).bind(agentId).first<{ id: string; slug: string }>()
      if (!own || (named !== own.id && named.toLowerCase() !== own.slug.toLowerCase())) {
        return fail(403, 'own_agent_only', 'You can only ask to join a squad as yourself.')
      }
    }

    const squadRef = (str(args.squad) ?? '').trim()
    if (squadRef.length === 0 || squadRef.length > 128) return fail(400, 'invalid_args', { field: 'squad' })
    const capability = args.capability === undefined ? 'member' : args.capability
    if (!isJoinCapability(capability)) return fail(400, 'invalid_args', { field: 'capability', allowed: ['member', 'observer'] })
    let reason: string | null = null
    if (args.reason !== undefined) {
      if (typeof args.reason !== 'string') return fail(400, 'invalid_args', { field: 'reason' })
      // Control characters out; the length cap is a refusal, not a silent truncation the human would not see.
      reason = args.reason.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, '').trim()
      if (reason.length > SQUAD_JOIN_REASON_MAX) return fail(400, 'invalid_args', { field: 'reason', max: SQUAD_JOIN_REASON_MAX })
      if (reason.length === 0) reason = null
    }

    if (secureMomentsStatus(env).state !== 'on') {
      return fail(503, 'secure_moments_unavailable', 'Approval links are not enabled on this pot, so a join request cannot be made. Ask a squad admin to add you with squad_member_add.')
    }

    const r = await fileSquadJoinRequest(env, { agentId, squadRef, capability, reason, via: attached ? 'attached_chat' : 'agent', waitUntil: ctx?.waitUntil })
    if (r.ok) {
      return done({
        status: 'sent_to_admins',
        expires_at: r.expiresAt,
        agent_prompt: squadJoinAgentPrompt({ agentName: r.agentName, squadRef: r.squadRef, capability: r.capability, expiresAt: r.expiresAt }),
      })
    }
    switch (r.error) {
      case 'agent_inactive':
        return fail(403, r.error, 'This agent is not active, so it cannot ask to join a squad.')
      case 'agent_is_seat_agent':
        return fail(403, 'attach_first', 'This chat is not attached to an agent. Attach it with seat_attach first.')
      case 'rate_limited':
        return fail(429, r.error, 'Too many join requests from this agent in the last hour. Wait, and use the link you already have.')
      case 'too_many_pending_requests':
        return fail(429, r.error, 'This agent already has too many join requests waiting for a human. Wait for a decision.')
      case 'secure_moments_unavailable':
      case 'link_unavailable':
        return fail(503, 'secure_moments_unavailable', 'An approval link could not be made right now. Try again, or ask a squad admin to add you with squad_member_add.')
      default:
        return fail(400, r.error)
    }
  },
}

export const SQUAD_JOIN_TOOLS: ToolSpec[] = [toolSquadJoinRequest]
