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

import type { Env } from '../types'
import type { ToolSpec } from './index'
import { fail, done } from './index'
import { attachSeatToAgent, seatAttachEnabled } from '../members/seat-attach'
import { attachedAuthority } from '../auth/attached-ceiling'
import { claimUrl } from '../members/claim'
import { resolveBoundSeat } from '../agents/inbox-seat'
import { markMessagesHandledByAttachment, MAX_MARK_HANDLED_IDS, normalizeHandledIds } from '../members/attached-handled'

/** The claim link first (open it signed in, press Confirm: no typing); the code stays as the fallback for /connections. */
function claimFields(env: Env, code: string): { claim_url?: string; tell_the_person: string } {
  const url = claimUrl(env, code)
  return url
    ? { claim_url: url, tell_the_person: `Show the person this link: ${url} . They open it while signed in and press Confirm; nothing to type. (Fallback: your attach code is ${code}; press Admit only on the card showing it.)` }
    : { tell_the_person: `Tell the person: your attach code is ${code}. Press Admit only on the card showing this code.` }
}

const toolSeatAttach: ToolSpec = {
  name: 'seat_attach',
  scope: 'Only for a chat on its own seat that wants to act as an existing agent its human administers. Never call it from a workspace-token agent; from an already-attached chat it only confirms the current attachment: self (attach THIS thread to an existing agent the human has admitted; seat session only)',
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
    // An already-attached thread: the requested ref is compared ONLY against the agent it is attached to (id or slug), without resolving
    // any other agent, so a non-match is the same already_attached answer whether or not the named agent exists (no oracle).
    const attachedAs = seat.attached ? seat.attached.agentId : null
    if (attachedAs !== null) {
      const ref = typeof args.agent === 'string' ? args.agent.trim() : ''
      const row = ref.length > 0 && ref.length <= 128
        ? await env.DB.prepare(`SELECT id, slug FROM agents WHERE id = ?1 LIMIT 1`).bind(attachedAs).first<{ id: string; slug: string }>()
        : null
      if (!row || (ref !== row.id && ref.toLowerCase() !== row.slug.toLowerCase())) {
        return fail(409, 'already_attached', 'This thread is already attached to an agent. Ask your human to detach or move it on their Connections page.')
      }
    }
    const agentRef = typeof args.agent === 'string' ? args.agent.trim() : ''
    if (agentRef.length === 0 || agentRef.length > 128) return fail(400, 'invalid_args', { field: 'agent' })

    const r = await attachSeatToAgent(env, {
      humanMemberId: seat.humanMemberId,
      seatId: seat.seatId,
      agentRef: attachedAs ?? agentRef, // already attached: only ever the agent it is attached to (id), never a second resolution of the caller's text
      via: 'tool',
      requesterAgentId: auth.boundAgentId,
      grantTokenId: seat.grantTokenId,
    })
    if (r.ok && r.status === 'attached') {
      return done({
        status: 'attached',
        attachment_id: r.attachment_id,
        admission_id: r.admission_id,
        agent: r.agent,
        note: `Attached. Your NEXT request acts as ${r.agent.slug || r.agent.name}: call boot_context to see the identity_receipt. You hold at most the access level your human approved (member unless they chose higher) and, only if the admission allows it and the agent holds a review gate, task_verdict reviews as the agent (never on work that is yours, your human's, or the agent's own). Your human can detach you at any time.`,
      })
    }
    if (r.ok && r.already_pending) {
      if (!r.attach_code) {
        return done({
          status: 'already_pending',
          admission_id: r.admission_id,
          expires_at: r.expires_at,
          note: 'A different chat holds this pending request for this agent, so no code or link is given here. Ask your human to deny it on their Connections page, then ask again from this chat to get your own code.',
        })
      }
      return done({
        status: 'already_pending',
        admission_id: r.admission_id,
        expires_at: r.expires_at,
        attach_code: r.attach_code,
        ...claimFields(env, r.attach_code),
        note: 'Your request is already waiting for your human. No new link was made: the one you were given still works, or they can decide it on their Connections page and type your code. After they approve, call seat_attach again.',
      })
    }
    if (r.ok) {
      return done({
        status: 'pending_admission',
        admission_id: r.admission_id,
        approve_url: r.approve_url,
        expires_at: r.expires_at,
        ...(r.attach_code ? { attach_code: r.attach_code, ...claimFields(env, r.attach_code) } : {}),
        note: r.approve_url
          ? 'Pending. Give your human approve_url: a one-time link where they tap their passkey to let chats from this app act as that agent. Nothing is attached until then. After they approve, call seat_attach again; it attaches immediately.'
          : 'Pending. Your human can approve this on their Connections page (no secure-moment link is available on this pot). Nothing is attached until then; after they approve, call seat_attach again.',
      })
    }
    switch (r.error) {
      case 'seat_attach_disabled':
        return fail(403, r.error)
      case 'agent_not_found':
        return fail(404, r.error, 'No agent by that name is available for your human to admit.')
      case 'agent_not_designated_for_you': {
        return fail(409, r.error, {
          who_acts: 'owner',
          agent: r.agent,
          // Static text (#2081): the agent is named in the structured `agent` field, never interpolated here. The control
          // lives on the agent's own page, not on Connections.
          next_step: "This agent isn't set up for you yet. Ask your human to open this agent's page in the mupot dashboard (Agents → the agent), press 'Allow for me' in the box 'Allow my chats to become this agent', then ask me to attach again.",
        })
      }
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
      case 'approval_bound_to_other_chat':
        return fail(409, r.error, 'This agent is approved for a different chat; ask the human to approve this one (they revoke the old admission on their Connections page, then this chat asks again and gets its own code).')
      case 'attach_code_mismatch':
        return fail(403, r.error)
      case 'attach_refused':
        return fail(409, r.error, 'The attach could not be completed (the agent, the admission, its token or this seat changed). Retry; if it persists the owner must re-admit this chat on their Connections page.')
      default:
        return fail(400, r.error)
    }
  },
}

// inbox_mark_handled (mupot#1937) — the attached chat's ONLY inbox write. See members/attached-handled.ts.
const toolInboxMarkHandled: ToolSpec = {
  name: 'inbox_mark_handled',
  scope: 'self (an ATTACHED thread records which of the agent\'s peeked messages it handled; per-attachment receipt only)',
  min: 'authenticated',
  args: `{ ids: string[] }  // 1..${MAX_MARK_HANDLED_IDS} message ids from your own peek. Attached threads only: it never consumes, leases, acks or moves the host's cursor`,
  inputSchema: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Message ids (from inbox {peek:true}) this chat handled.' } },
    required: ['ids'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    // (the SEAT_ATTACH flag is refused by invokeTool's SEAT_ATTACH_FLAG_TOOLS gate before this runs)
    // Server-derived: only a thread the SERVER bound to a LIVE attachment. A host / agent-bound token consumes with inbox_ack.
    const att = attachedAuthority(auth)
    if (!att) {
      return fail(403, 'not_attached_seat', 'inbox_mark_handled is for an attached chat. An agent host clears mail with inbox_ack.')
    }
    const ids = normalizeHandledIds(args.ids)
    if (!ids) return fail(400, 'invalid_args', { field: 'ids', detail: `1..${MAX_MARK_HANDLED_IDS} non-empty message ids` })
    // The seat partition is the attachment token's OWN label (never a client claim): the same value its peek uses.
    const seat = await resolveBoundSeat(env, auth.tokenId ?? null)
    const r = await markMessagesHandledByAttachment(env, { attachmentId: att.attachmentId, agentId: att.agentId, seat, ids })
    if (!r.ok) return r.error === 'invalid_ids' ? fail(400, 'invalid_args', { field: 'ids' }) : fail(500, r.error)
    return done({
      handled: r.handled,
      not_visible: r.not_visible,
      note: 'Recorded for THIS chat only: your own peek now hides these. The host and other chats still see them; nothing was consumed.',
    })
  },
}

export const SEAT_ATTACH_TOOLS: ToolSpec[] = [toolSeatAttach, toolInboxMarkHandled]
