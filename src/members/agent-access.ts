import type { D1PreparedStatement } from '@cloudflare/workers-types'
import { assertBatchWritten } from '../lib/receipt'
import type { CapabilityGrant, Env, Membership } from '../types'
import type { AgentBindingProof } from './service'

export type AgentAccessCapability = 'observer' | 'member' | 'lead' | 'admin'

const ACCESS_CAPABILITIES: readonly AgentAccessCapability[] = [
  'observer',
  'member',
  'lead',
  'admin',
]

export interface SetAgentSquadAccessInput {
  agentId: string
  memberId: string
  squadId: string
  capability: AgentAccessCapability
}

export interface RemoveAgentSquadAccessInput {
  agentId: string
  memberId: string
  squadId: string
}

export type AgentSquadAccessError =
  | 'agent_not_found'
  | 'squad_not_found'
  | 'agent_identity_unminted'
  | 'agent_identity_conflict'
  | 'home_squad_immutable'
  | 'receipt_failed'

export interface PreparedAgentSquadAccess {
  statements: [D1PreparedStatement, D1PreparedStatement]
  priorMembership: 'present' | 'absent'
  priorCapability: AgentAccessCapability | null
  resultAfterCommit: 'created' | 'updated' | 'unchanged'
  membership: Membership
  grant: CapabilityGrant
}

type AccessFailure = { ok: false; error: AgentSquadAccessError }

export type PreparedAgentSquadAccessResult =
  | { ok: true; value: PreparedAgentSquadAccess }
  | AccessFailure

export type AgentSquadAccessResult =
  | {
      ok: true
      result: 'created' | 'updated' | 'unchanged' | 'removed'
      membership: Membership
      grant: CapabilityGrant
    }
  | AccessFailure

interface AgentBindingState {
  home_squad_id: string
  bound_member_id: string | null
}

interface PriorMembership {
  id: string
  capability: string
}

export function isAgentAccessCapability(value: unknown): value is AgentAccessCapability {
  return typeof value === 'string'
    && (ACCESS_CAPABILITIES as readonly string[]).includes(value)
}

export async function resolveBoundAgentForMember(
  env: Env,
  memberId: string,
): Promise<{ agentId: string; homeSquadId: string } | null> {
  const row = await env.DB.prepare(
    `SELECT b.agent_id, a.squad_id AS home_squad_id
       FROM agent_member_bindings b
       JOIN agents a ON a.id = b.agent_id
       JOIN members m
         ON m.id = b.member_id
        AND m.tenant = b.tenant
        AND m.status = 'active'
      WHERE b.tenant = ?
        AND b.member_id = ?
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, memberId).first<{
    agent_id: string
    home_squad_id: string
  }>()
  return row
    ? { agentId: row.agent_id, homeSquadId: row.home_squad_id }
    : null
}

async function loadAgentBindingState(
  env: Env,
  agentId: string,
): Promise<AgentBindingState | null> {
  return env.DB.prepare(
    `SELECT a.squad_id AS home_squad_id,
            CASE WHEN m.id IS NULL THEN NULL ELSE b.member_id END AS bound_member_id
       FROM agents a
       LEFT JOIN agent_member_bindings b
         ON b.tenant = ?
        AND b.agent_id = a.id
       LEFT JOIN members m
         ON m.id = b.member_id
        AND m.tenant = b.tenant
        AND m.status = 'active'
      WHERE a.id = ?
      LIMIT 1`,
  ).bind(env.TENANT_SLUG, agentId).first<AgentBindingState>()
}

async function targetSquadExists(env: Env, squadId: string): Promise<boolean> {
  return Boolean(await env.DB.prepare(
    'SELECT id FROM squads WHERE id = ? LIMIT 1',
  ).bind(squadId).first<{ id: string }>())
}

async function priorAccess(
  env: Env,
  input: SetAgentSquadAccessInput,
): Promise<{
  membership: PriorMembership | null
  capability: AgentAccessCapability | null
}> {
  const [membership, capability] = await Promise.all([
    env.DB.prepare(
      `SELECT id, capability
         FROM memberships
        WHERE agent_id = ?
          AND squad_id = ?
        LIMIT 1`,
    ).bind(input.agentId, input.squadId).first<PriorMembership>(),
    env.DB.prepare(
      `SELECT capability
         FROM capabilities
        WHERE member_id = ?
          AND scope_type = 'squad'
          AND scope_id = ?
        LIMIT 1`,
    ).bind(input.memberId, input.squadId).first<{ capability: AgentAccessCapability }>(),
  ])
  return {
    membership,
    capability: capability && isAgentAccessCapability(capability.capability)
      ? capability.capability
      : null,
  }
}

function classifyResult(
  membership: PriorMembership | null,
  priorCapability: AgentAccessCapability | null,
  requested: AgentAccessCapability,
): 'created' | 'updated' | 'unchanged' {
  if (priorCapability === null) return 'created'
  if (membership !== null && priorCapability === requested) return 'unchanged'
  return 'updated'
}

export async function prepareAgentSquadAccess(
  env: Env,
  input: SetAgentSquadAccessInput,
  bindingProof: AgentBindingProof,
): Promise<PreparedAgentSquadAccessResult> {
  if (
    bindingProof.agentId !== input.agentId
    || bindingProof.memberId !== input.memberId
  ) {
    return { ok: false, error: 'agent_identity_conflict' }
  }

  const committedAgent = await env.DB.prepare(
    'SELECT squad_id AS home_squad_id FROM agents WHERE id = ? LIMIT 1',
  ).bind(input.agentId).first<{ home_squad_id: string }>()
  if (bindingProof.disposition === 'existing' && !committedAgent) {
    return { ok: false, error: 'agent_not_found' }
  }
  const homeSquadId = committedAgent?.home_squad_id ?? bindingProof.homeSquadId
  if (homeSquadId !== bindingProof.homeSquadId) {
    return { ok: false, error: 'agent_identity_conflict' }
  }
  if (!(await targetSquadExists(env, input.squadId))) {
    return { ok: false, error: 'squad_not_found' }
  }
  if (!isAgentAccessCapability(input.capability)) {
    return { ok: false, error: 'receipt_failed' }
  }

  if (bindingProof.disposition === 'existing') {
    const binding = await env.DB.prepare(
      `SELECT b.member_id
         FROM agent_member_bindings b
         JOIN members m
           ON m.id = b.member_id
          AND m.tenant = b.tenant
          AND m.status = 'active'
        WHERE b.tenant = ?
          AND b.agent_id = ?
        LIMIT 1`,
    ).bind(env.TENANT_SLUG, input.agentId).first<{ member_id: string }>()
    if (!binding) return { ok: false, error: 'agent_identity_unminted' }
    if (binding.member_id !== input.memberId) {
      return { ok: false, error: 'agent_identity_conflict' }
    }
  }

  const prior = await priorAccess(env, input)
  const membership: Membership = {
    id: prior.membership?.id ?? crypto.randomUUID(),
    agent_id: input.agentId,
    squad_id: input.squadId,
    capability: input.capability,
  }
  const grant: CapabilityGrant = {
    member_id: input.memberId,
    scope_type: 'squad',
    scope_id: input.squadId,
    capability: input.capability,
  }

  const bindingGuard = bindingProof.disposition === 'creating'
  const membershipStatement = bindingGuard
    ? env.DB.prepare(
        `INSERT INTO memberships (id, agent_id, squad_id, capability)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1
              FROM agent_member_bindings
             WHERE tenant = ?
               AND agent_id = ?
               AND member_id = ?
          )
         ON CONFLICT(agent_id, squad_id)
         DO UPDATE SET capability = excluded.capability`,
      ).bind(
        membership.id,
        input.agentId,
        input.squadId,
        input.capability,
        env.TENANT_SLUG,
        input.agentId,
        input.memberId,
      )
    : env.DB.prepare(
        `INSERT INTO memberships (id, agent_id, squad_id, capability)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, squad_id)
         DO UPDATE SET capability = excluded.capability`,
      ).bind(membership.id, input.agentId, input.squadId, input.capability)

  const grantId = crypto.randomUUID()
  const capabilityStatement = bindingGuard
    ? env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         SELECT ?, ?, 'squad', ?, ?
          WHERE EXISTS (
            SELECT 1
              FROM agent_member_bindings
             WHERE tenant = ?
               AND agent_id = ?
               AND member_id = ?
          )
         ON CONFLICT(member_id, scope_type, scope_id)
         DO UPDATE SET capability = excluded.capability`,
      ).bind(
        grantId,
        input.memberId,
        input.squadId,
        input.capability,
        env.TENANT_SLUG,
        input.agentId,
        input.memberId,
      )
    : env.DB.prepare(
        `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
         VALUES (?, ?, 'squad', ?, ?)
         ON CONFLICT(member_id, scope_type, scope_id)
         DO UPDATE SET capability = excluded.capability`,
      ).bind(grantId, input.memberId, input.squadId, input.capability)

  return {
    ok: true,
    value: {
      statements: [membershipStatement, capabilityStatement],
      priorMembership: prior.membership ? 'present' : 'absent',
      priorCapability: prior.capability,
      resultAfterCommit: classifyResult(
        prior.membership,
        prior.capability,
        input.capability,
      ),
      membership,
      grant,
    },
  }
}

async function readCommittedAccess(
  env: Env,
  input: SetAgentSquadAccessInput,
): Promise<{ membership: Membership; grant: CapabilityGrant } | null> {
  const [membership, grant] = await Promise.all([
    env.DB.prepare(
      `SELECT id, agent_id, squad_id, capability
         FROM memberships
        WHERE agent_id = ?
          AND squad_id = ?
        LIMIT 1`,
    ).bind(input.agentId, input.squadId).first<Membership>(),
    env.DB.prepare(
      `SELECT member_id, scope_type, scope_id, capability
         FROM capabilities
        WHERE member_id = ?
          AND scope_type = 'squad'
          AND scope_id = ?
        LIMIT 1`,
    ).bind(input.memberId, input.squadId).first<CapabilityGrant>(),
  ])
  if (
    !membership
    || membership.capability !== input.capability
    || !grant
    || grant.capability !== input.capability
  ) {
    return null
  }
  return { membership, grant }
}

export async function commitAgentSquadAccess(
  env: Env,
  input: SetAgentSquadAccessInput,
  extraStatementsFor: (prepared: PreparedAgentSquadAccess) => D1PreparedStatement[],
): Promise<AgentSquadAccessResult> {
  const state = await loadAgentBindingState(env, input.agentId)
  if (!state) return { ok: false, error: 'agent_not_found' }
  if (!state.bound_member_id) return { ok: false, error: 'agent_identity_unminted' }
  if (state.bound_member_id !== input.memberId) {
    return { ok: false, error: 'agent_identity_conflict' }
  }

  const prepared = await prepareAgentSquadAccess(env, input, {
    agentId: input.agentId,
    memberId: input.memberId,
    homeSquadId: state.home_squad_id,
    disposition: 'existing',
  })
  if (!prepared.ok) return prepared

  const extras = extraStatementsFor(prepared.value)
  const writes = await env.DB.batch([
    ...extras,
    ...prepared.value.statements,
  ])
  try {
    assertBatchWritten(writes, 'set_agent_squad_access', 1)
  } catch {
    return { ok: false, error: 'receipt_failed' }
  }
  const committed = await readCommittedAccess(env, input)
  if (!committed) return { ok: false, error: 'receipt_failed' }
  return {
    ok: true,
    result: prepared.value.resultAfterCommit,
    membership: committed.membership,
    grant: committed.grant,
  }
}

export async function setAgentSquadAccess(
  env: Env,
  input: SetAgentSquadAccessInput,
): Promise<AgentSquadAccessResult> {
  return commitAgentSquadAccess(env, input, (_prepared) => [])
}

export async function commitRemoveAgentSquadAccess(
  env: Env,
  input: RemoveAgentSquadAccessInput,
  extraStatementsFor: (priorCapability: AgentAccessCapability | null) => D1PreparedStatement[],
): Promise<AgentSquadAccessResult> {
  const state = await loadAgentBindingState(env, input.agentId)
  if (!state) return { ok: false, error: 'agent_not_found' }
  if (!state.bound_member_id) return { ok: false, error: 'agent_identity_unminted' }
  if (state.bound_member_id !== input.memberId) {
    return { ok: false, error: 'agent_identity_conflict' }
  }
  if (!(await targetSquadExists(env, input.squadId))) {
    return { ok: false, error: 'squad_not_found' }
  }
  if (input.squadId === state.home_squad_id) {
    return { ok: false, error: 'home_squad_immutable' }
  }

  const prior = await priorAccess(env, {
    ...input,
    capability: 'member',
  })
  const removing = prior.membership !== null || prior.capability !== null
  const extras = removing ? extraStatementsFor(prior.capability) : []
  const writes = await env.DB.batch([
    ...extras,
    env.DB.prepare(
      `DELETE FROM memberships
        WHERE agent_id = ?
          AND squad_id = ?`,
    ).bind(input.agentId, input.squadId),
    env.DB.prepare(
      `DELETE FROM capabilities
        WHERE member_id = ?
          AND scope_type = 'squad'
          AND scope_id = ?`,
    ).bind(input.memberId, input.squadId),
  ])

  const membershipWrite = writes[extras.length]
  const capabilityWrite = writes[extras.length + 1]
  if (!membershipWrite || !capabilityWrite) {
    return { ok: false, error: 'receipt_failed' }
  }
  if (
    prior.membership !== null
    && (membershipWrite.meta?.changes ?? membershipWrite.meta?.rows_written ?? 0) < 1
  ) {
    return { ok: false, error: 'receipt_failed' }
  }
  if (
    prior.capability !== null
    && (capabilityWrite.meta?.changes ?? capabilityWrite.meta?.rows_written ?? 0) < 1
  ) {
    return { ok: false, error: 'receipt_failed' }
  }
  if (extras.length > 0) {
    try {
      assertBatchWritten(writes.slice(0, extras.length), 'remove_agent_squad_access_receipt', 1)
    } catch {
      return { ok: false, error: 'receipt_failed' }
    }
  }

  const committed = await priorAccess(env, {
    ...input,
    capability: 'member',
  })
  if (committed.membership || committed.capability) {
    return { ok: false, error: 'receipt_failed' }
  }

  return {
    ok: true,
    result: removing ? 'removed' : 'unchanged',
    membership: {
      id: prior.membership?.id ?? '',
      agent_id: input.agentId,
      squad_id: input.squadId,
      capability: 'member',
    },
    grant: {
      member_id: input.memberId,
      scope_type: 'squad',
      scope_id: input.squadId,
      capability: prior.capability ?? 'member',
    },
  }
}

export async function removeAgentSquadAccess(
  env: Env,
  input: RemoveAgentSquadAccessInput,
): Promise<AgentSquadAccessResult> {
  return commitRemoveAgentSquadAccess(env, input, (_priorCapability) => [])
}
