// mupot — squad_choose MCP tool. Thin glue over src/members/squad-choice.ts (read that file for the authority argument).
//
// min: 'authenticated' on purpose: the caller is an agent in the lobby, whose own grants on the target squad are
// nil by design. The real gate is inside chooseSquad: the credential must be a direct agent-bound session, the agent
// must still be in a home squad, and the target must be a squad where the agent's OWNER holds lead or better.
//
// Without `squad_id` it only LISTS the candidates (same data boot_context carries) and writes nothing.

import type { ToolSpec } from './index'
import { fail, done, str } from './index'
import { chooseSquad, listSquadCandidates, loadChoiceContext, type SquadChoiceError } from '../members/squad-choice'

const STATUS: Record<SquadChoiceError, 400 | 403 | 404 | 409> = {
  agent_session_required: 403,
  attached_session_forbidden: 403,
  agent_not_found: 404,
  agent_inactive: 409,
  agent_identity_unminted: 409,
  owner_unknown: 409,
  already_placed: 409,
  squad_not_a_candidate: 403,
  invalid_squad: 400,
  invalid_level: 400,
  invalid_reason: 400,
  standing_lost: 403,
  in_flight_work: 409,
  choice_refused: 409,
}

const toolSquadChoose: ToolSpec = {
  name: 'squad_choose',
  scope: 'self (a connected agent still in its owner\'s home squad picks its working squad, once; bounded by the owner\'s standing, never an escalation)',
  min: 'authenticated',
  args: '{ squad_id?: string, level?: "member"|"observer" (default member), reason?: string }  // no squad_id = list candidates only',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: { type: 'string', description: 'The id of one of the candidate squads. Omit to list the candidates with a short reason each.' },
      level: { type: 'string', enum: ['member', 'observer'], description: 'Your level in the squad. Default member. It can never exceed your owner\'s standing there.' },
      reason: { type: 'string', description: 'Why this squad (kept on the receipt).' },
    },
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const squadId = str(args.squad_id)
    if (!squadId) {
      const ctx = await loadChoiceContext(env, auth)
      if (!ctx.ok) return fail(STATUS[ctx.error], ctx.error)
      return done({ in_lobby: ctx.inLobby, candidates: await listSquadCandidates(env, ctx) })
    }
    const res = await chooseSquad(env, auth, { squadId, level: args.level, reason: args.reason })
    if (!res.ok) {
      return res.in_flight
        ? fail(STATUS[res.error], res.error, { reason: 'finish or release your in-progress task, active dispatch or flight before choosing a squad', ...res.in_flight })
        : fail(STATUS[res.error], res.error)
    }
    return done({ already: res.already, squad: res.squad, level: res.level, audit_id: res.audit_id, effective: 'on your next request' })
  },
}

export const SQUAD_CHOICE_TOOLS: ToolSpec[] = [toolSquadChoose]
