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
  args: '{ agent: string, reason: string, scope?: "seat" | "harness", thread?: string }  // agent: id, slug or exact name of an EXISTING agent your human administers (a selector, never authority); reason (1..280 characters, REQUIRED): why this chat should act as it',
  inputSchema: {
    type: 'object',
    properties: {
      agent: { type: 'string', maxLength: INTENT_REF_MAX, description: 'The existing agent this connection means: id, slug or exact name. A label to look up, not an access request: your human decides.' },
      reason: { type: 'string', minLength: 1, maxLength: INTENT_REASON_MAX, description: 'Required: why THIS connection should act as that agent (1..280 characters).' },
      scope: { type: 'string', enum: ['seat', 'harness'], description: 'Optional. "seat" (default): the approval covers this chat only. "harness": approve once for every chat of this app. A request, not authority: your human sees it at the tap and can refuse it.' },
      thread: { type: 'string', maxLength: 100, description: 'Optional label that keeps a second, separate connection to the same agent distinct. Omit it to reuse the same connection after a restart.' },
    },
    required: ['agent', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const r = await connectNamedIntent(env, auth, { agent: args.agent, reason: args.reason, scope: args.scope, thread: args.thread })
    if (r.ok) {
      if (r.attach === null) {
        return done({ status: 'attached', agent: { id: r.target.id, slug: r.target.slug, name: r.target.name }, note: 'This thread is already attached to that agent. Nothing to do: call boot_context to see the identity_receipt.' })
      }
      const out = await attachOutcome(env, auth.seatBinding?.humanMemberId ?? auth.memberId ?? '', r.attach)
      if (out.ok && typeof out.result === 'object' && out.result !== null) {
        const seat = r.seat
        return done({
          ...out.result,
          target: { id: r.target.id, slug: r.target.slug, name: r.target.name },
          ...(seat && seat.handle ? { seat: seat.handle, seat_id: seat.handle, instruction: `Pass \`seat: ${seat.handle}\` on every call.` } : {}),
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
        const e = r.seatError
        if (e.error === 'harness_required') {
          return fail(403, e.error, `This connection carries no verified harness. Your human re-consents this connector (remove and add it again) and picks ${consentLabels(consentChoiceLabels(env)).many} to register its harness; then call connect_intent again.`)
        }
        const status = e.error === 'rate_limited' ? 429 : e.error === 'provisioning_failed' ? 500 : e.error === 'seat_cap_reached' || e.error === 'seat_agent_inactive' || e.error === 'seat_key_source_conflict' ? 409 : 403
        return fail(status, e.error, { ...(typeof e.detail === 'object' && e.detail !== null ? e.detail : {}), next_step: 'The connection seat could not be made, so nothing was filed. Retry once; if it persists tell your human so an org admin can look at the audit log. Do not loop.' })
      }
      /* c8 ignore next 2 -- NamedIntentFailure is exhaustively handled above; safety net. */
      default:
        return fail(500, 'internal_error')
    }
  },
}

export const NAMED_INTENT_TOOLS: ToolSpec[] = [toolConnectIntent]
