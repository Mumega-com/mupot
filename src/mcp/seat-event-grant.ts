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
        next_step: 'Ask your human to approve ONE exact call: request_elevation { actions: ["action:sudo_seat_event_grant"], scope_type: "squad", scope_id: <the agent\'s squad id>, duration_minutes: 15, reason, sudo_args: { host_agent_id, agent_id, project_id? } }. They see those names in Telegram and tap Approve.',
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
    // Owner sudo approved a call on ONE squad: the squad authorised here must be that one.
    if (auth.ownerSudo && auth.ownerSudo.squadId !== target.squadId) return fail(404, 'agent_not_visible')
    const res = await createSeatEventGrant(env, {
      hostAgentId,
      agentId,
      projectId: str(args.project_id),
      memberId: auth.memberId,
      reason,
      expectSquadId: target.squadId, // pinned through the write
    })
    if (!res.ok) {
      // ONE uniform answer for every refusal after authorization (a missing host key, a host without standing, a project the agent
      // lacks, an already-granted agent, a squad that moved), so the caller cannot probe which of them it was. Malformed input and a
      // storage fault keep their own codes (they say nothing about other rows).
      if (res.reason === 'invalid_args') return fail(400, 'invalid_args')
      if (res.reason === 'db_error') return fail(500, 'db_error')
      return fail(404, 'agent_not_visible')
    }
    return done({ ok: true, id: res.id })
  },
}

export const SEAT_EVENT_GRANT_TOOLS: ToolSpec[] = [toolSeatEventGrant]
