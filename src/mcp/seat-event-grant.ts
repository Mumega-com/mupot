// mupot — MCP twin of POST /api/fleet/events/grants: authorize a fleet host to receive one agent's seat-event hints.
//
// Same write path (createSeatEventGrant) and the same authority rule (authorizeSeatGrantTarget: an org admin, or a lead on the
// target agent's squad) as the HTTP route, which refuses every agent-bound caller (operator_principal_required). This twin
// keeps that: a bound agent is refused here too, EXCEPT through owner sudo (src/auth/owner-sudo.ts), where invokeTool has
// already rebuilt `auth` as the APPROVING human for this one call (auth.ownerSudo names the agent as executor). The tool body
// therefore never reasons about sudo: it sees a human, and checks that human's live authority.
import { resolveCapabilities } from '../auth/capability'
import { authorizeSeatGrantTarget, createSeatEventGrant } from '../agents/seat-events'
import { type ToolSpec, fail, done, hasWorkspaceAdmin, str } from './index'

const STRING_SCHEMA = { type: 'string' }

const toolSeatEventGrant: ToolSpec = {
  name: 'seat_event_grant',
  scope: 'org admin, or lead on the target agent\'s squad (twin of POST /api/fleet/events/grants)',
  min: 'lead',
  args: '{ agent_id: string, host_agent_id: string, project_id?: string, reason: string }',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: STRING_SCHEMA,
      host_agent_id: STRING_SCHEMA,
      project_id: STRING_SCHEMA,
      reason: STRING_SCHEMA,
    },
    required: ['agent_id', 'host_agent_id', 'reason'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    // The HTTP twin's own rule, verbatim: an agent-bound caller is refused first. Owner sudo reaches here as the human, not as the agent.
    if (auth.boundAgentId) {
      return fail(403, 'operator_principal_required', {
        who_acts: 'owner',
        next_tool: 'request_elevation',
        next_step: 'Ask your human to approve ONE call: request_elevation { actions: ["action:sudo_seat_event_grant"], scope_type: "squad", scope_id: <the agent\'s squad id>, duration_minutes: 15, reason }. They tap Approve in Telegram.',
        needs: 'human_approval',
      })
    }
    if (!auth.memberId) return fail(403, 'forbidden', { need: 'member_identity' })
    const agentId = str(args.agent_id)
    const hostAgentId = str(args.host_agent_id)
    const reason = str(args.reason)
    if (!agentId || !hostAgentId || !reason) return fail(400, 'invalid_args', 'agent_id, host_agent_id and reason required')
    const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
    const target = await authorizeSeatGrantTarget(env, { grants, orgAdmin: hasWorkspaceAdmin(auth) }, agentId)
    if (!target.ok) return fail(target.status, target.error)
    const res = await createSeatEventGrant(env, {
      hostAgentId,
      agentId,
      projectId: str(args.project_id),
      memberId: auth.memberId,
      reason,
    })
    if (!res.ok) {
      const status = res.reason === 'agent_already_granted' ? 409
        : res.reason === 'db_error' ? 500
        : res.reason === 'invalid_args' ? 400
        : res.reason === 'host_key_missing' || res.reason === 'project_access_denied' || res.reason === 'host_no_squad_standing' ? 403
        : 404
      return fail(status, res.reason)
    }
    return done({ ok: true, id: res.id })
  },
}

export const SEAT_EVENT_GRANT_TOOLS: ToolSpec[] = [toolSeatEventGrant]
