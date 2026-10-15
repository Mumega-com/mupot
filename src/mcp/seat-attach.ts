// mupot W2 — seat_attach MCP tool. Thin glue over src/members/seat-attach.ts (read that file for the model, the
// single admission chokepoint and the authority argument).
//
// WHO MAY CALL. Only a SEAT session: a request the SERVER bound to a seat (auto-seat from the client's per-thread key,
// or a seat_select handle), i.e. auth.seatBinding is set. That is server-derived on every request. A legacy
// agent-bound session, a workspace key or a bare unbound grant has no seatBinding and is refused, so a model can
// never move itself into another agent's identity through this tool. An already-attached thread is refused too: a
// move is the human's act (dashboard Connections).
//
// WHAT IT DOES. The thread names an agent it wants to act as. The server resolves that name ONLY inside the agents the
// underlying human administers (anything else reads as agent_not_found, no existence oracle). If the human has not yet
// admitted that agent for this harness, a PENDING admission is filed and a one-time secure-moment link is returned for
// the human's passkey tap; nothing is attached. Once admitted, the thread attaches immediately and its NEXT request
// acts as that agent.

import type { ToolSpec } from './index'
import { fail, done } from './index'
import { attachSeatToAgent, seatAttachEnabled } from '../members/seat-attach'

const toolSeatAttach: ToolSpec = {
  name: 'seat_attach',
  scope: 'self (attach THIS thread to an existing agent the human has admitted; seat session only)',
  min: 'authenticated',
  args: '{ agent: string }  // the agent id, slug or exact name; resolved only among agents your human administers',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', description: 'The existing agent this thread should act as: id, slug or exact name. A label to look up, not an access request: the human decides.' },
    },
    required: ['agent'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    if (!seatAttachEnabled(env)) return fail(403, 'seat_attach_disabled', 'Attaching a thread to an existing agent is not enabled on this pot.')
    const seat = auth.seatBinding
    // Server-derived: a legacy agent-bound / workspace / bare unbound session has no seatBinding.
    if (!seat || auth.channel !== 'directory' || !auth.boundAgentId) {
      return fail(403, 'seat_required', 'seat_attach runs only from a seat session (a conversation-keyed auto seat, or a seat_select handle). An agent-bound connection cannot move itself into another agent.')
    }
    if (seat.attached) {
      return fail(409, 'already_attached', 'This thread is already attached to an agent. Ask your human to detach or move it on their Connections page.')
    }
    const agentRef = typeof args.agent === 'string' ? args.agent.trim() : ''
    if (agentRef.length === 0 || agentRef.length > 128) return fail(400, 'invalid_args', { field: 'agent' })

    const r = await attachSeatToAgent(env, {
      humanMemberId: seat.humanMemberId,
      seatId: seat.seatId,
      agentRef,
      via: 'tool',
      requesterAgentId: auth.boundAgentId,
    })
    if (r.ok && r.status === 'attached') {
      return done({
        status: 'attached',
        attachment_id: r.attachment_id,
        admission_id: r.admission_id,
        agent: r.agent,
        note: `Attached. Your NEXT request acts as ${r.agent.slug || r.agent.name}: call boot_context to see the identity_receipt. You hold at most member-level access and none of this agent's approval gates. Your human can detach you at any time.`,
      })
    }
    if (r.ok && r.already_pending) {
      return done({
        status: 'already_pending',
        admission_id: r.admission_id,
        expires_at: r.expires_at,
        note: 'An admission for this agent is already waiting for your human. No new link was made: the one you were given still works, or they can decide it on their Connections page. After they approve, call seat_attach again.',
      })
    }
    if (r.ok) {
      return done({
        status: 'pending_admission',
        admission_id: r.admission_id,
        approve_url: r.approve_url,
        expires_at: r.expires_at,
        note: r.approve_url
          ? 'Pending. Give your human approve_url: a one-time link where they tap their passkey to let threads from this app act as that agent. Nothing is attached until then. After they approve, call seat_attach again; it attaches immediately.'
          : 'Pending. Your human can approve this on their Connections page (no secure-moment link is available on this pot). Nothing is attached until then; after they approve, call seat_attach again.',
      })
    }
    switch (r.error) {
      case 'seat_attach_disabled':
        return fail(403, r.error)
      case 'agent_not_found':
        return fail(404, r.error, 'No agent by that name is available for your human to admit.')
      case 'agent_ambiguous':
        return fail(409, r.error, 'More than one agent matches; use the agent id.')
      case 'agent_identity_unminted':
        return fail(409, r.error, 'That agent\'s identity is not usable right now (for example its identity member is suspended), so a thread cannot act as it. An admin must restore it first.')
      case 'already_attached':
        return fail(409, r.error)
      case 'too_many_pending_admissions':
        return fail(429, r.error, 'Your human already has too many pending admissions. Ask them to clear some on their Connections page.')
      case 'seat_not_found':
        return fail(409, r.error, 'This thread has no live seat.')
      case 'attach_refused':
        return fail(409, r.error, 'The attach could not be completed (the agent, the admission or this seat changed). Retry, or ask your human to check their Connections page.')
      default:
        return fail(400, r.error)
    }
  },
}

export const SEAT_ATTACH_TOOLS: ToolSpec[] = [toolSeatAttach]
