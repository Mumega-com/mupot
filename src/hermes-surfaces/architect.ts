// KayHermes org-architect helpers — seat a human member on a squad + ceremony plan.
// Pure planning + thin DB writes. MCP tools call these; no hidden side effects beyond returns.

import type { Capability, Env } from '../types'
import { upsertCapabilityGrant } from '../members/service'
import { bindMemberHermesAgent } from './bindings'
import type { MemberHermesBinding } from './bindings'

const SEATABLE: ReadonlySet<Capability> = new Set(['observer', 'member', 'lead', 'admin'])

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
    ],
    rule:
      'Always seat the requesting member. Never leave an orphan squad. If caller lacks admin, open a gated owner-ACT task instead of creating structure.',
  }
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
