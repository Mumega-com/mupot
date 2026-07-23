// KayHermes org-architect helpers — seat a human member on a squad + ceremony plan.
// Pure planning + thin DB writes. MCP tools call these; no hidden side effects beyond returns.

import type { Capability, Env, Task } from '../types'
import { upsertCapabilityGrant } from '../members/service'
import { createTask } from '../tasks/service'
import { bindMemberHermesAgent } from './bindings'
import type { MemberHermesBinding } from './bindings'

const SEATABLE: ReadonlySet<Capability> = new Set(['observer', 'member', 'lead', 'admin'])

/** Gate capability string for owner ACT on architect stand-ups (owner/admin always pass verdict). */
export const ARCHITECT_GATE_OWNER = 'gate:architect'

export interface SeatMemberInput {
  memberId: string
  squadId: string
  capability: Capability
  hermesAgentId: string | null
}

export interface SeatMemberResult {
  grant: { member_id: string; scope_type: 'squad'; scope_id: string; capability: Capability }
  grant_result: 'created' | 'updated' | 'unchanged'
  hermes_binding: MemberHermesBinding | null
}

export interface ArchitectCeremonyPlan {
  steps: readonly string[]
  tools: readonly string[]
  rule: string
}

export interface ArchitectStandupGateInput {
  squadId: string
  departmentSlug: string
  squadSlug: string
  agentSlug: string
  requesterMemberId: string
  departmentName: string | null
  squadName: string | null
  agentName: string | null
  actorMemberId: string
}

/** Deterministic ceremony checklist KayHermes (and docs) follow. */
export function architectCeremonyPlan(input: {
  departmentSlug: string
  squadSlug: string
  agentSlug: string
  requesterMemberId: string
}): ArchitectCeremonyPlan {
  const dept = input.departmentSlug.trim()
  const squad = input.squadSlug.trim()
  const agent = input.agentSlug.trim()
  const member = input.requesterMemberId.trim()
  return {
    steps: [
      `create_department { slug: "${dept}", name: "…" }`,
      `create_squad { department: "<dept id|slug>", slug: "${squad}", name: "…" }`,
      `create_agent { squad: "<squad id|slug>", slug: "${agent}", name: "…", runtime hint: hermes }`,
      `mint_agent_token { agent: "<agent id|slug>" } — show-once; wire into Hermes profile`,
      `seat_member_on_squad { member: "${member}", squad: "<squad>", capability: "member", hermes_agent: "<agent>" }`,
      `addConnector hermes_api scoped to agent with meta.api_url + API key (BYOA / admin)`,
      `Requester talks via Open WebUI (/api/member-hermes) or Telegram IM; agent talks to peers via send/inbox`,
    ],
    tools: [
      'create_department',
      'create_squad',
      'create_agent',
      'mint_agent_token',
      'seat_member_on_squad',
      'bind_member_hermes_agent',
      'request_architect_standup',
    ],
    rule:
      'Always seat the requesting member. Never leave an orphan squad. If caller lacks admin, call request_architect_standup (gated owner-ACT) instead of creating structure.',
  }
}

/** Open a review task for owner ACT when the caller cannot provision structure directly. */
export async function openArchitectStandupGate(
  env: Env,
  input: ArchitectStandupGateInput,
): Promise<{ task: Task; plan: ArchitectCeremonyPlan }> {
  const plan = architectCeremonyPlan({
    departmentSlug: input.departmentSlug,
    squadSlug: input.squadSlug,
    agentSlug: input.agentSlug,
    requesterMemberId: input.requesterMemberId,
  })
  const title = `Architect standup: ${input.departmentSlug.trim()}/${input.squadSlug.trim()}/${input.agentSlug.trim()}`
  const bodyLines = [
    'Gated owner-ACT: create department → squad → Hermes agent, then seat the requester.',
    `requester_member_id: ${input.requesterMemberId.trim()}`,
    `department_slug: ${input.departmentSlug.trim()}`,
    input.departmentName ? `department_name: ${input.departmentName.trim()}` : null,
    `squad_slug: ${input.squadSlug.trim()}`,
    input.squadName ? `squad_name: ${input.squadName.trim()}` : null,
    `agent_slug: ${input.agentSlug.trim()}`,
    input.agentName ? `agent_name: ${input.agentName.trim()}` : null,
    '',
    'Ceremony steps:',
    ...plan.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `gate_owner: ${ARCHITECT_GATE_OWNER}`,
  ].filter((line): line is string => line !== null)

  const task = await createTask(
    env,
    {
      squad_id: input.squadId,
      title,
      body: bodyLines.join('\n'),
      done_when:
        'Owner approved this gate; department, squad, and Hermes agent exist; requester is seated on the squad with a hermes binding.',
      status: 'review',
      gate_owner: ARCHITECT_GATE_OWNER,
    },
    { actor: { kind: 'member', id: input.actorMemberId } },
  )
  return { task, plan }
}

export function assertSeatableCapability(raw: string): Capability {
  if (!SEATABLE.has(raw as Capability)) {
    throw new Error('invalid_capability')
  }
  return raw as Capability
}

export async function seatMemberOnSquad(
  env: Env,
  input: SeatMemberInput,
): Promise<SeatMemberResult> {
  const memberId = input.memberId.trim()
  const squadId = input.squadId.trim()
  if (!memberId || !squadId) throw new Error('invalid_args')

  const member = await env.DB.prepare(
    `SELECT id FROM members WHERE id = ?1 AND tenant = ?2 AND status = 'active' LIMIT 1`,
  )
    .bind(memberId, env.TENANT_SLUG)
    .first<{ id: string }>()
  if (!member) throw new Error('member_not_found')

  const squad = await env.DB.prepare(
    `SELECT id FROM squads WHERE id = ?1 LIMIT 1`,
  )
    .bind(squadId)
    .first<{ id: string }>()
  if (!squad) throw new Error('squad_not_found')

  const outcome = await upsertCapabilityGrant(env, {
    member_id: memberId,
    scope_type: 'squad',
    scope_id: squadId,
    capability: input.capability,
  })

  let hermes_binding: MemberHermesBinding | null = null
  if (input.hermesAgentId) {
    hermes_binding = await bindMemberHermesAgent(env, {
      memberId,
      agentId: input.hermesAgentId,
    })
  }

  return {
    grant: outcome.grant as SeatMemberResult['grant'],
    grant_result: outcome.result,
    hermes_binding,
  }
}
