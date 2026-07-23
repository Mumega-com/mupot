// MCP tools: seat human members on squads + bind Hermes agents (BYOA architect ceremony).

import type { Capability, Env } from '../types'
import { hasCapability } from '../auth/capability'
import { resolveSquadRef, resolveAgentRef } from '../org/resolve'
import {
  type ToolSpec,
  fail,
  done,
  str,
  memberCanOnSquad,
} from './index'
import {
  architectCeremonyPlan,
  assertSeatableCapability,
  openArchitectStandupGate,
  seatMemberOnSquad,
  ARCHITECT_GATE_OWNER,
} from '../hermes-surfaces/architect'
import {
  bindMemberHermesAgent,
  HermesSurfacesError,
  getMemberHermesBinding,
} from '../hermes-surfaces/bindings'

const STRING_SCHEMA = { type: 'string' }

async function resolveMemberRef(
  env: Env,
  ref: string,
): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  const raw = ref.trim()
  if (!raw) return { ok: false, reason: 'empty' }
  const byId = await env.DB.prepare(
    `SELECT id FROM members WHERE id = ?1 AND tenant = ?2 AND status = 'active' LIMIT 1`,
  )
    .bind(raw, env.TENANT_SLUG)
    .first<{ id: string }>()
  if (byId) return { ok: true, id: byId.id }
  const byEmail = await env.DB.prepare(
    `SELECT id FROM members WHERE lower(email) = lower(?1) AND tenant = ?2 AND status = 'active' LIMIT 1`,
  )
    .bind(raw, env.TENANT_SLUG)
    .first<{ id: string }>()
  if (byEmail) return { ok: true, id: byEmail.id }
  return { ok: false, reason: 'not_found' }
}

const toolSeatMemberOnSquad: ToolSpec = {
  name: 'seat_member_on_squad',
  scope: 'squad',
  min: 'admin',
  args:
    '{ member: string (id|email), squad: string (id|slug), capability: "observer"|"member"|"lead"|"admin", hermes_agent?: string (id|slug) }',
  inputSchema: {
    type: 'object',
    properties: {
      member: STRING_SCHEMA,
      squad: STRING_SCHEMA,
      capability: { type: 'string', enum: ['observer', 'member', 'lead', 'admin'] },
      hermes_agent: STRING_SCHEMA,
    },
    required: ['member', 'squad', 'capability'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const memberRef = str(args.member)
    const squadRef = str(args.squad)
    const capRaw = str(args.capability)
    if (!memberRef || !squadRef || !capRaw) return fail(400, 'invalid_args')

    let capability: Capability
    try {
      capability = assertSeatableCapability(capRaw)
    } catch {
      return fail(400, 'invalid_capability')
    }

    const memberResult = await resolveMemberRef(env, memberRef)
    if (!memberResult.ok) return fail(404, 'member_not_found')

    const squadResult = await resolveSquadRef(env, squadRef)
    if (!squadResult.ok) return fail(404, 'squad_not_found')
    const squad = squadResult.value

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, squad.id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }
    if (!hasCapability(grants, 'squad', squad.id, capability)) {
      // Caller must hold at least the rank they grant (org-admin inherits).
      if (!hasCapability(grants, 'org', null, 'admin')) {
        return fail(403, 'cannot_grant_above_own_rank')
      }
    }

    let hermesAgentId: string | null = null
    const hermesRef = str(args.hermes_agent)
    if (hermesRef) {
      const agentResult = await resolveAgentRef(env, hermesRef)
      if (!agentResult.ok) return fail(404, 'agent_not_found')
      if (agentResult.value.squad_id !== squad.id) {
        return fail(400, 'agent_not_on_squad', 'hermes_agent must belong to the target squad')
      }
      hermesAgentId = agentResult.value.id
    }

    try {
      const result = await seatMemberOnSquad(env, {
        memberId: memberResult.id,
        squadId: squad.id,
        capability,
        hermesAgentId,
      })
      return done({
        member_id: memberResult.id,
        squad_id: squad.id,
        ...result,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'seat_failed'
      if (msg === 'member_not_found') return fail(404, msg)
      if (msg === 'squad_not_found') return fail(404, msg)
      if (e instanceof HermesSurfacesError) return fail(400, e.code, e.message)
      return fail(500, 'seat_failed', msg)
    }
  },
}

const toolBindMemberHermesAgent: ToolSpec = {
  name: 'bind_member_hermes_agent',
  scope: "agent's squad",
  min: 'admin',
  args: '{ member: string (id|email), agent: string (id|slug) }',
  inputSchema: {
    type: 'object',
    properties: { member: STRING_SCHEMA, agent: STRING_SCHEMA },
    required: ['member', 'agent'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const memberRef = str(args.member)
    const agentRef = str(args.agent)
    if (!memberRef || !agentRef) return fail(400, 'invalid_args')

    const memberResult = await resolveMemberRef(env, memberRef)
    if (!memberResult.ok) return fail(404, 'member_not_found')

    const agentResult = await resolveAgentRef(env, agentRef)
    if (!agentResult.ok) return fail(404, 'agent_not_found')
    const agent = agentResult.value

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, agent.squad_id, 'admin'))) {
      return fail(403, 'forbidden', { need: 'admin', scope: 'squad' })
    }

    try {
      const binding = await bindMemberHermesAgent(env, {
        memberId: memberResult.id,
        agentId: agent.id,
      })
      return done({ binding })
    } catch (e) {
      if (e instanceof HermesSurfacesError) {
        const status = e.code.endsWith('not_found') ? 404 : 400
        return fail(status as 400 | 404, e.code, e.message)
      }
      return fail(500, 'bind_failed')
    }
  },
}

const toolArchitectCeremony: ToolSpec = {
  name: 'architect_ceremony_plan',
  scope: 'org',
  min: 'observer',
  args: '{ department_slug: string, squad_slug: string, agent_slug: string, requester_member?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      department_slug: STRING_SCHEMA,
      squad_slug: STRING_SCHEMA,
      agent_slug: STRING_SCHEMA,
      requester_member: STRING_SCHEMA,
    },
    required: ['department_slug', 'squad_slug', 'agent_slug'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    void env
    const departmentSlug = str(args.department_slug)
    const squadSlug = str(args.squad_slug)
    const agentSlug = str(args.agent_slug)
    if (!departmentSlug || !squadSlug || !agentSlug) return fail(400, 'invalid_args')
    let requester = str(args.requester_member) || (auth.memberId as string | undefined) || ''
    if (!requester) requester = '<requester-member-id>'
    return done(
      architectCeremonyPlan({
        departmentSlug,
        squadSlug,
        agentSlug,
        requesterMemberId: requester,
      }),
    )
  },
}

const toolRequestArchitectStandup: ToolSpec = {
  name: 'request_architect_standup',
  scope: 'squad',
  min: 'member',
  args:
    '{ squad_id: string (host squad for the gate task), department_slug: string, squad_slug: string, agent_slug: string, requester_member?: string (id|email), department_name?: string, squad_name?: string, agent_name?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      squad_id: STRING_SCHEMA,
      department_slug: STRING_SCHEMA,
      squad_slug: STRING_SCHEMA,
      agent_slug: STRING_SCHEMA,
      requester_member: STRING_SCHEMA,
      department_name: STRING_SCHEMA,
      squad_name: STRING_SCHEMA,
      agent_name: STRING_SCHEMA,
    },
    required: ['squad_id', 'department_slug', 'squad_slug', 'agent_slug'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const hostSquadId = str(args.squad_id)
    const departmentSlug = str(args.department_slug)
    const squadSlug = str(args.squad_slug)
    const agentSlug = str(args.agent_slug)
    if (!hostSquadId || !departmentSlug || !squadSlug || !agentSlug) return fail(400, 'invalid_args')

    const grants = auth.capabilities ?? []
    if (!(await memberCanOnSquad(env, grants, hostSquadId, 'member'))) {
      return fail(403, 'forbidden', { need: 'member', scope: 'squad' })
    }

    const actorId = typeof auth.memberId === 'string' ? auth.memberId.trim() : ''
    if (!actorId) return fail(401, 'member_required')

    let requesterId = actorId
    const requesterRef = str(args.requester_member)
    if (requesterRef) {
      const resolved = await resolveMemberRef(env, requesterRef)
      if (!resolved.ok) return fail(404, 'member_not_found')
      requesterId = resolved.id
    }

    try {
      const { task, plan } = await openArchitectStandupGate(env, {
        squadId: hostSquadId,
        departmentSlug,
        squadSlug,
        agentSlug,
        requesterMemberId: requesterId,
        departmentName: str(args.department_name) || null,
        squadName: str(args.squad_name) || null,
        agentName: str(args.agent_name) || null,
        actorMemberId: actorId,
      })
      return done({
        task,
        plan,
        gate_owner: ARCHITECT_GATE_OWNER,
        hint: 'Owner/admin must approve this review task, then run the ceremony steps and seat the requester.',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'gate_open_failed'
      if (msg.startsWith('done_when_required')) return fail(400, 'done_when_required', msg)
      return fail(500, 'gate_open_failed', msg)
    }
  },
}

const toolGetMemberHermesBinding: ToolSpec = {
  name: 'get_member_hermes_binding',
  scope: 'org',
  min: 'observer',
  args: '{ member: string (id|email) }',
  inputSchema: {
    type: 'object',
    properties: { member: STRING_SCHEMA },
    required: ['member'],
    additionalProperties: false,
  },
  async run(_auth, env, args) {
    const memberRef = str(args.member)
    if (!memberRef) return fail(400, 'invalid_args')
    const memberResult = await resolveMemberRef(env, memberRef)
    if (!memberResult.ok) return fail(404, 'member_not_found')
    const binding = await getMemberHermesBinding(env, memberResult.id)
    return done({ binding })
  },
}

export const ARCHITECT_TOOLS: ToolSpec[] = [
  toolSeatMemberOnSquad,
  toolBindMemberHermesAgent,
  toolArchitectCeremony,
  toolRequestArchitectStandup,
  toolGetMemberHermesBinding,
]
