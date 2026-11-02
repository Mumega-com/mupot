// NAMED_INTENT_CONNECT — connect_intent MCP tool. Thin glue over src/members/named-intent.ts (read that file for the model).
//
// A connection that knows which agent it means says so FIRST: connect_intent { agent, reason }. The server resolves the
// name among the agents the human may attach to, makes (or reuses) the carrier seat only after that succeeds, and files
// (or reuses) the one pending admission whose passkey tap is the human's single consent. Calling it again after the tap
// attaches. min 'authenticated' (like seat_select): an unbound seat carries zero ambient capability by design; the real
// gates live in connectNamedIntent and the writers it calls.

import type { ToolSpec } from './index'
import { fail, done } from './index'
import { connectNamedIntent, INTENT_REASON_MAX, INTENT_REF_MAX } from '../members/named-intent'
import { attachOutcome } from './seat-attach'
import { humanCanDesignateAtAll } from '../members/seat-attach'
import { consentChoiceLabels, consentLabels } from './refusal-next-step'

const NEXT_CALL = 'After your human approves, call connect_intent again with the same agent: it attaches immediately, and your NEXT request acts as that agent.'

const toolConnectIntent: ToolSpec = {
  name: 'connect_intent',
  scope: 'Only for a chat that knows WHICH existing agent it should act as and has not attached yet. Call it first, before boot_context, when you were told an agent: self (state the agent this connection means; one passkey consent attaches it)',
  min: 'authenticated',
  args: '{ agent: string, reason: string, scope?: "seat" | "harness" }  // agent: id, slug or exact name of an EXISTING agent your human administers (a selector, never authority); reason (1..280 characters, REQUIRED)',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', maxLength: INTENT_REF_MAX, description: 'The existing agent this connection means: id, slug or exact name. A label to look up, not an access request: your human decides.' },
      reason: { type: 'string', minLength: 1, maxLength: INTENT_REASON_MAX, description: 'Required: why THIS connection should act as that agent (1..280 characters).' },
      scope: { type: 'string', enum: ['seat', 'harness'], description: 'Optional. "seat" (default): the approval covers this chat only. "harness": approve once for every chat of this app. A request, not authority: your human sees it at the tap and can refuse it.' },
    },
    required: ['agent', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const r = await connectNamedIntent(env, auth, { agent: args.agent, reason: args.reason, scope: args.scope })
    if (r.ok) {
      if (r.attach === null) {
        return done({ status: 'attached', agent: { id: r.target.id, slug: r.target.slug, name: r.target.name }, note: 'This thread is already attached to that agent. Nothing to do: call boot_context to see the identity_receipt.' })
      }
      const out = await attachOutcome(env, auth.seatBinding?.humanMemberId ?? auth.memberId ?? '', r.attach)
      if (out.ok && typeof out.result === 'object' && out.result !== null) {
        return done({
          ...out.result,
          target: { id: r.target.id, slug: r.target.slug, name: r.target.name },
          // mumega-com#1628: the guidance depends on how the SERVER bound this seat. 'handle' means a presented mseat_
          // handle with no per-conversation key, so telling the caller to pass nothing would lose the seat on the next
          // call. 'auto:*' means the client's own per-thread key already identifies the conversation: nothing to pass.
          // The handle value is never echoed.
          instruction: auth.seatBinding?.source === 'handle'
            ? 'Keep passing the same `seat` handle you used for this call: this conversation has no per-conversation key, so a next call without it will not act as the agent. A different conversation does not either.'
            : 'Nothing to pass: after approval this same conversation acts as the agent on its next request, with no handle. A different conversation does not.',
          next_call: NEXT_CALL,
        })
      }
      return out
    }
    switch (r.error) {
      case 'named_intent_disabled':
        return fail(403, r.error, 'Named-intent connection is not enabled on this pot. Call boot_context: its available_doors lists what this session can do instead.')
      case 'invalid_args':
        return fail(400, r.error, {
          ...(typeof r.detail === 'object' && r.detail !== null ? r.detail : {}),
          next_step: 'Call connect_intent { agent: "<id, slug or exact name of an existing agent>", reason: "<why this chat should act as it, 1..280 characters>" }. Both are required.',
        })
      case 'seat_session_required':
        return fail(403, r.error, {
          who_acts: 'self',
          next_step: 'connect_intent runs from a chat connector session that has no agent yet, or from an unattached seat. An agent-bound or workspace credential already is an agent; call boot_context to see which.',
        })
      case 'already_attached':
        return fail(409, r.error, 'This thread is already attached to a different agent. Ask your human to detach or move it on their Connections page.')
      case 'seat_handle_rejected':
        return fail(403, r.error, { next_step: 'The seat handle you sent was not accepted and a rejected handle is final: pass the exact `seat` value seat_select returned for this chat, or omit it and let this conversation use its own key.' })
      case 'conversation_key_required':
        return fail(409, r.error, {
          who_acts: 'self',
          next_step: 'This connection sends no per-conversation key (openai/session or a Codex threadId), so it cannot prove which chat is asking and a one-chat approval could be reused by another. Nothing was created. Use a client that sends one, or ask your human to attach this chat from their Connections page, or call seat_attach from a seat session.',
        })
      case 'agent_not_found':
        // One text for every miss (no existence oracle) and no silent creation: say what this door does NOT do.
        return fail(404, r.error, {
          who_acts: 'owner',
          next_step: 'No agent by that name is available for your human to admit. This door never creates an agent and a name grants nothing. If it exists, an org admin must make it attachable for your human (admin on its squad; designate with update_agent attach_designated_member_id when designation is on). If it does not exist yet, an org admin creates it first. Then call connect_intent again. connect_intent with a different name, or seat_attach with no agent, lists what is available now.',
        })
      case 'agent_ambiguous':
        return fail(409, r.error, { next_step: 'More than one agent matches that name; call connect_intent again with the agent id.' })
      case 'agent_not_designated_for_you': {
        const canPress = r.agent ? await humanCanDesignateAtAll(env, auth.seatBinding?.humanMemberId ?? auth.memberId ?? '', r.agent.id) : false
        return fail(409, r.error, {
          who_acts: canPress ? 'owner' : 'admin',
          agent: r.agent,
          next_step: canPress
            ? "This agent isn't set up for you yet. Ask your human to open this agent's page in the mupot dashboard (Agents -> the agent), press 'Allow for me', then call connect_intent again."
            : "This agent isn't set up for you yet. Ask your human to ask an org admin to designate them for it (update_agent, attach_designated_member_id = your human's member id), then call connect_intent again.",
        })
      }
      case 'seat_failed': {
        if (r.seatError === 'harness_required') {
          return fail(403, r.seatError, `This connection carries no verified harness. Your human re-consents this connector (remove and add it again) and picks ${consentLabels(consentChoiceLabels(env)).many} to register its harness; then call connect_intent again.`)
        }
        const status = r.seatError === 'rate_limited' ? 429 : r.seatError === 'provisioning_failed' ? 500 : 409
        return fail(status, r.seatError, { ...(typeof r.detail === 'object' && r.detail !== null ? r.detail : {}), next_step: 'The connection seat could not be made, so nothing was filed. Retry once; if it persists tell your human so an org admin can look at the audit log. Do not loop.' })
      }
      /* c8 ignore next 2 -- NamedIntentFailure is exhaustively handled above; safety net. */
      default:
        return fail(500, 'internal_error')
    }
  },
}

export const NAMED_INTENT_TOOLS: ToolSpec[] = [toolConnectIntent]
