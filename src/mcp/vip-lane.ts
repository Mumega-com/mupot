// mupot — join_squad MCP tool (#2035 wall 1, slice 1). Thin glue over src/members/vip-lane.ts (read that file for the authority
// argument). Flag VIP_LANE, default off.
//
// Eligible (unattached seat of an ACTIVE HUMAN whose effective grants give admin on the squad): the seat joins at once as OBSERVED.
// Anything else with an identity anchor: ONE pending card to the squad's approvers (join_requested), never a bare refusal.
// No identity anchor: refused with the next step. Nothing here reads args for identity: the actor is the server-derived session.

import type { ToolSpec } from './index'
import { fail, done, str } from './index'
import { resolveCapabilities } from '../auth/capability'
import { memberIsActiveHuman } from '../access/identity'
import { secureMomentsStatus } from '../secure-moments/config'
import { fileSquadJoinRequest, hasLivePendingJoin } from '../members/squad-join'
import { humanMayInstantJoin, instantObservedJoin, resolveJoinTargets, OBSERVED_TIER, type JoinTarget } from '../members/vip-lane'

const JOIN_REQUESTED_TEXT = "Your request went to that squad's owner/admins as one pending card. Nothing changes until one of them decides with a passkey; you will hear back in your inbox."

const toolJoinSquad: ToolSpec = {
  name: 'join_squad',
  scope: 'self (a verified owner/admin\'s own seat joins a squad it administers as OBSERVED; anyone else files one card to the squad owner)',
  min: 'authenticated',
  args: '{ squad?: string (id|slug), project?: string (id|slug; resolved through the project\'s squad access edges) } (exactly one)',
  inputSchema: {
    type: 'object',
    properties: {
      squad: { type: 'string', description: 'The squad to join: id or slug.' },
      project: { type: 'string', description: 'A project (id or slug). It maps to the squads that hold access to it; if more than one is yours, name the squad instead.' },
    },
    additionalProperties: false,
  },
  async run(auth, env, args, ctx) {
    const squadArg = args.squad === undefined ? undefined : str(args.squad)?.trim()
    const projectArg = args.project === undefined ? undefined : str(args.project)?.trim()
    if ((args.squad !== undefined && !squadArg) || (args.project !== undefined && !projectArg) || (squadArg === undefined) === (projectArg === undefined)) {
      return fail(400, 'invalid_args', { need: 'exactly one of squad | project, a non-empty string' })
    }
    if ((squadArg ?? projectArg ?? '').length > 128) return fail(400, 'invalid_args', { field: squadArg === undefined ? 'project' : 'squad' })

    // Identity anchor, server-derived: a seat, or a bound agent. A bare human session has none.
    const agentId = auth.boundAgentId
    const seat = auth.seatBinding
    if (!agentId) {
      return fail(403, 'identity_anchor_required', 'join_squad needs a seat or a bound agent behind this session. Connect through a harness so a seat is made (seat_select), then call join_squad again.')
    }

    const t = await resolveJoinTargets(env, squadArg !== undefined ? { squad: squadArg } : { project: projectArg })
    if (!t.ok) {
      // A squad ref that does not resolve still gets the card (no existence oracle); a project that does not resolve is a 404.
      if (squadArg === undefined) return fail(404, 'project_not_found')
      return requestCard(auth, env, agentId, squadArg, ctx?.waitUntil)
    }

    // Eligibility from the human's EFFECTIVE grants, only for an UNATTACHED seat of an active human.
    const instantSeat = seat && !seat.attached ? seat : null
    const eligible: JoinTarget[] = []
    let grants: Awaited<ReturnType<typeof resolveCapabilities>> = []
    if (instantSeat && (await memberIsActiveHuman(env, instantSeat.humanMemberId))) {
      grants = await resolveCapabilities(env, instantSeat.humanMemberId)
      for (const sq of t.squads) if (await humanMayInstantJoin(env, grants, sq.id)) eligible.push(sq)
    }

    if (eligible.length > 1) {
      return fail(400, 'ambiguous_project', { message: 'Several squads on this project are yours. Call join_squad with squad set to one of them.', squads: eligible.map((s) => s.slug) })
    }
    if (eligible.length === 1 && instantSeat) {
      const sq = eligible[0]
      const r = await instantObservedJoin(env, { humanMemberId: instantSeat.humanMemberId, seatId: instantSeat.seatId, seatAgentId: agentId, squad: sq, grants })
      if (r.ok) {
        return done({
          status: 'joined',
          squad: r.squad,
          admission_status: r.admission_status,
          membership: r.membership,
          floor: {
            tier: OBSERVED_TIER,
            can: 'read the board, docs and memory; check in; orient; message; propose and update tasks; recall and remember within the squad',
            cannot: 'decide gates, grant or change membership, mint tokens or identities, read secrets, publish, move money, add others',
          },
          note: 'You are an observed seat. The floor applies from your next call.',
        })
      }
      switch (r.error) {
        case 'member_not_active': return fail(403, r.error, 'The member behind this seat is not active.')
        case 'seat_held': return fail(403, r.error, 'This seat is held. An owner of the squad releases it; calling join_squad again does not.')
        case 'squad_not_joinable': return fail(409, r.error, 'That squad cannot be joined this way (a home or archived squad).')
        default: return fail(500, r.error)
      }
    }

    // Not eligible: ONE card. A project with several squads and none yours has no single owner to ask.
    if (t.squads.length !== 1) return fail(400, 'name_a_squad', 'That project is open to more than one squad and none is yours. Call join_squad with the squad you want; its owner is then asked.')
    return requestCard(auth, env, agentId, squadArg ?? t.squads[0].id, ctx?.waitUntil)
  },
}

async function requestCard(auth: Parameters<ToolSpec['run']>[0], env: Parameters<ToolSpec['run']>[1], agentId: string, squadRef: string, waitUntil: Parameters<typeof fileSquadJoinRequest>[1]['waitUntil']) {
  if (secureMomentsStatus(env).state !== 'on') {
    return fail(503, 'secure_moments_unavailable', 'Approval cards are not enabled on this pot. Ask a squad admin to add you with squad_member_add.')
  }
  const reply = { status: 'join_requested', decided_by: "the squad's owner/admins", agent_prompt: JOIN_REQUESTED_TEXT }
  // Repeat: the pending card stands. Do not re-file, rotate the link or re-notify.
  if (await hasLivePendingJoin(env, agentId, squadRef)) return done({ ...reply, already_pending: true })
  const r = await fileSquadJoinRequest(env, { agentId, squadRef, capability: 'observer', reason: null, via: auth.seatBinding?.attached ? 'attached_chat' : 'agent', waitUntil, allowSeatAgent: true })
  if (r.ok) return done(reply)
  switch (r.error) {
    case 'agent_inactive': return fail(403, r.error, 'This agent is not active, so it cannot ask to join a squad.')
    case 'rate_limited': return fail(429, r.error, 'Too many join requests from this agent in the last hour. Wait, and use the card already filed.')
    case 'too_many_pending_requests': return fail(429, r.error, 'This agent already has too many join requests waiting. Wait for a decision.')
    default: return fail(503, 'secure_moments_unavailable', 'An approval card could not be made right now. Try again, or ask a squad admin to add you with squad_member_add.')
  }
}

export const VIP_LANE_TOOLS: ToolSpec[] = [toolJoinSquad]
