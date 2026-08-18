import { canOnSquad, hasCapability } from '../auth/capability'
import type { AuthContext, Capability, CapabilityGrant, Env, Squad } from '../types'
import {
  commitAgentSquadAccess,
  commitRemoveAgentSquadAccess,
  resolveBoundAgentForMember,
  type AgentAccessCapability,
} from './agent-access'
import { resolveAgentMemberBinding } from './service'

export const GRANTABLE_SQUAD_MEMBER_CAPABILITIES: ReadonlySet<Capability> = new Set([
  'observer',
  'member',
  'lead',
  'admin',
])

export type SquadMembershipWriteDenial =
  | 'missing_member_identity'
  | 'self_grant'
  | 'forbidden'
  | 'cannot_grant_above_own_rank'

export type SquadMembershipMutationError =
  | SquadMembershipWriteDenial
  | 'agent_identity_unminted'
  | 'receipt_failed'
  | 'agent_not_found'
  | 'squad_not_found'
  | 'agent_identity_conflict'
  | 'home_squad_immutable'

export type SquadMembershipTarget = Pick<Squad, 'id' | 'department_id'>

export interface SquadMembershipListRow {
  agent_id: string
  slug: string
  name: string
  membership_capability: string
  grant_capability: string | null
}

function isSelfGrant(auth: AuthContext, targetAgentId: string, callerBoundAgentId: string | null): boolean {
  if (auth.boundAgentId === targetAgentId) return true
  return callerBoundAgentId === targetAgentId
}

/**
 * Single authorization predicate for add and remove. Auth is on the TARGET
 * squad (lead+), never on a capability the caller holds elsewhere. Self-grant
 * is refused even for an owner of that squad.
 */
export async function authorizeSquadMembershipWrite(input: {
  env: Env
  auth: AuthContext
  targetAgentId: string
  squad: SquadMembershipTarget
  requestedCapability: Capability | null
}): Promise<{ ok: true } | { ok: false; error: SquadMembershipWriteDenial }> {
  if (!input.auth.memberId) {
    return { ok: false, error: 'missing_member_identity' }
  }
  const callerBound = await resolveBoundAgentForMember(input.env, input.auth.memberId)
  const callerBoundAgentId = callerBound?.agentId ?? null
  if (isSelfGrant(input.auth, input.targetAgentId, callerBoundAgentId)) {
    return { ok: false, error: 'self_grant' }
  }
  const grants: CapabilityGrant[] = input.auth.capabilities ?? []
  const mayMutate = await canOnSquad(input.env, grants, input.squad.id, 'lead')
  if (!mayMutate) {
    return { ok: false, error: 'forbidden' }
  }
  if (input.requestedCapability !== null) {
    const canGrant = hasCapability(
      grants,
      'squad',
      input.squad.id,
      input.requestedCapability,
      input.squad.department_id,
    )
    if (!canGrant) {
      return { ok: false, error: 'cannot_grant_above_own_rank' }
    }
  }
  return { ok: true }
}

function receiptInsert(
  env: Env,
  row: {
    id: string
    actorMemberId: string
    actorBoundAgentId: string | null
    targetAgentId: string
    squadId: string
    action: 'add' | 'remove'
    capability: string | null
    priorCapability: string | null
    result: 'created' | 'updated' | 'unchanged' | 'removed'
  },
) {
  return env.DB.prepare(
    `INSERT INTO membership_receipts (
       id, tenant, actor_member_id, actor_bound_agent_id, target_agent_id,
       squad_id, action, capability, prior_capability, result
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(
    row.id,
    env.TENANT_SLUG,
    row.actorMemberId,
    row.actorBoundAgentId,
    row.targetAgentId,
    row.squadId,
    row.action,
    row.capability,
    row.priorCapability,
    row.result,
  )
}

export async function addSquadMember(input: {
  env: Env
  auth: AuthContext
  agentId: string
  squad: SquadMembershipTarget
  capability: AgentAccessCapability
}): Promise<
  | { ok: true; receiptId: string; result: 'created' | 'updated' | 'unchanged'; memberId: string }
  | { ok: false; error: SquadMembershipMutationError }
> {
  const authorized = await authorizeSquadMembershipWrite({
    env: input.env,
    auth: input.auth,
    targetAgentId: input.agentId,
    squad: input.squad,
    requestedCapability: input.capability,
  })
  if (!authorized.ok) return authorized

  const binding = await resolveAgentMemberBinding(input.env, input.agentId)
  if (binding.kind === 'unminted') {
    return { ok: false, error: 'agent_identity_unminted' }
  }

  const priorGrant = await input.env.DB.prepare(
    `SELECT capability
       FROM capabilities
      WHERE member_id = ?1
        AND scope_type = 'squad'
        AND scope_id = ?2
      LIMIT 1`,
  )
    .bind(binding.memberId, input.squad.id)
    .first<{ capability: string }>()

  const receiptId = crypto.randomUUID()
  let outcome
  try {
    outcome = await commitAgentSquadAccess(
      input.env,
      {
        agentId: input.agentId,
        memberId: binding.memberId,
        squadId: input.squad.id,
        capability: input.capability,
      },
      (prepared) => [
        receiptInsert(input.env, {
          id: receiptId,
          actorMemberId: input.auth.memberId as string,
          actorBoundAgentId: input.auth.boundAgentId ?? null,
          targetAgentId: input.agentId,
          squadId: input.squad.id,
          action: 'add',
          capability: input.capability,
          priorCapability: priorGrant?.capability ?? null,
          result: prepared.resultAfterCommit,
        }),
      ],
    )
  } catch {
    return { ok: false, error: 'receipt_failed' }
  }
  if (!outcome.ok) return outcome
  const result = outcome.result === 'removed' ? 'unchanged' : outcome.result
  return {
    ok: true,
    receiptId,
    result,
    memberId: binding.memberId,
  }
}

export async function removeSquadMember(input: {
  env: Env
  auth: AuthContext
  agentId: string
  squad: SquadMembershipTarget
}): Promise<
  | { ok: true; receiptId: string; result: 'removed' | 'unchanged' }
  | { ok: false; error: SquadMembershipMutationError }
> {
  const authorized = await authorizeSquadMembershipWrite({
    env: input.env,
    auth: input.auth,
    targetAgentId: input.agentId,
    squad: input.squad,
    requestedCapability: null,
  })
  if (!authorized.ok) return authorized

  const binding = await resolveAgentMemberBinding(input.env, input.agentId)
  if (binding.kind === 'unminted') {
    return { ok: false, error: 'agent_identity_unminted' }
  }

  const prior = await input.env.DB.prepare(
    `SELECT c.capability
       FROM capabilities c
      WHERE c.member_id = ?1
        AND c.scope_type = 'squad'
        AND c.scope_id = ?2
      LIMIT 1`,
  )
    .bind(binding.memberId, input.squad.id)
    .first<{ capability: string }>()

  const receiptId = crypto.randomUUID()
  let outcome
  try {
    outcome = await commitRemoveAgentSquadAccess(
      input.env,
      {
        agentId: input.agentId,
        memberId: binding.memberId,
        squadId: input.squad.id,
      },
      (_priorCapability) => [
        receiptInsert(input.env, {
          id: receiptId,
          actorMemberId: input.auth.memberId as string,
          actorBoundAgentId: input.auth.boundAgentId ?? null,
          targetAgentId: input.agentId,
          squadId: input.squad.id,
          action: 'remove',
          capability: null,
          priorCapability: prior?.capability ?? null,
          result: 'removed',
        }),
      ],
    )
  } catch {
    return { ok: false, error: 'receipt_failed' }
  }
  if (!outcome.ok) return outcome
  if (outcome.result === 'unchanged') {
    return { ok: true, receiptId: '', result: 'unchanged' }
  }
  return { ok: true, receiptId, result: 'removed' }
}

export async function listSquadMembers(input: {
  env: Env
  auth: AuthContext
  squadId: string
}): Promise<
  | { ok: true; members: SquadMembershipListRow[] }
  | { ok: false; error: 'missing_member_identity' | 'forbidden' }
> {
  if (!input.auth.memberId) {
    return { ok: false, error: 'missing_member_identity' }
  }
  const grants: CapabilityGrant[] = input.auth.capabilities ?? []
  const mayRead = await canOnSquad(input.env, grants, input.squadId, 'observer')
  if (!mayRead) {
    return { ok: false, error: 'forbidden' }
  }
  const rows = await input.env.DB.prepare(
    `SELECT m.agent_id AS agent_id,
            a.slug AS slug,
            a.name AS name,
            m.capability AS membership_capability,
            c.capability AS grant_capability
       FROM memberships m
       JOIN agents a ON a.id = m.agent_id
       LEFT JOIN agent_member_bindings b
         ON b.agent_id = m.agent_id
        AND b.tenant = ?1
       LEFT JOIN capabilities c
         ON c.member_id = b.member_id
        AND c.scope_type = 'squad'
        AND c.scope_id = m.squad_id
      WHERE m.squad_id = ?2
      ORDER BY a.slug ASC`,
  )
    .bind(input.env.TENANT_SLUG, input.squadId)
    .all<SquadMembershipListRow>()
  return { ok: true, members: rows.results ?? [] }
}
