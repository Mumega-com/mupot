// mupot — delegated operators (Operators + Admission W0, mumega-com#1386): the HUMAN-ONLY write path for
// agent_operator_delegations, plus the live-row reads the chokepoint uses.
//
// A delegation is a human's standing permission for ONE agent to organise structure inside ONE scope, capped at
// 'member' or 'lead'. This module is the only writer of the table. It is reached from exactly one place, the
// operator_delegate / operator_revoke MCP tools (src/mcp/operators.ts), and both refuse an agent-bound caller before
// they read an argument. src/operators/chokepoint.ts never imports the writers.

import type { AuthContext, Env } from '../types'
import {
  actorRankOnScopeFor,
  capabilityRank,
  hasWorkspaceAdmin,
  sessionMemberId,
} from '../auth/capability'

export type DelegationScopeType = 'org' | 'department' | 'squad' | 'project'
export type DelegationMaxGrant = 'member' | 'lead'

export interface DelegationRow {
  id: string
  tenant: string
  agent_id: string
  delegator_member_id: string
  scope_type: DelegationScopeType
  scope_id: string | null
  max_grant: DelegationMaxGrant
  created_by_member_id: string
  created_at: string
  revoked_at: string | null
}

const SCOPE_TYPES: readonly DelegationScopeType[] = ['org', 'department', 'squad', 'project']
const MAX_GRANTS: readonly DelegationMaxGrant[] = ['member', 'lead']

export function delegatedOperatorsEnabled(env: Env): boolean {
  const v = env.DELEGATED_OPERATORS?.trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** True when this member id is welded to an agent (an agent's own seat identity), i.e. NOT a human principal. */
export async function memberIsAgentSeat(env: Env, memberId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS one FROM agent_member_bindings WHERE tenant = ?1 AND member_id = ?2 LIMIT 1',
  )
    .bind(env.TENANT_SLUG, memberId)
    .first<{ one: number }>()
  return row != null
}

/**
 * The agent a seat member is welded to, WHATEVER the member's status. This is the authorisation-side resolver: a suspended
 * seat member still IS that agent's identity, so a rank guard that reads the target must keep seeing it
 * (resolveBoundAgentForMember joins members.status = 'active' and returns null for a suspended seat, which silently
 * dropped the target's standing from the guard: gate P1 on W0). null = not an agent seat (a human or an unknown id).
 */
export async function agentIdForSeatMember(env: Env, memberId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT agent_id FROM agent_member_bindings WHERE tenant = ?1 AND member_id = ?2 LIMIT 1',
  )
    .bind(env.TENANT_SLUG, memberId)
    .first<{ agent_id: string }>()
  return row?.agent_id ?? null
}

/**
 * Fail-closed sibling of memberIsAgentSeat for the HUMAN-ONLY checks (who may delegate, who may be a delegator): a member is
 * treated as non-human when it is bound in agent_member_bindings OR holds any member_tokens row welded to an agent. The
 * binding table is the authority, but a legacy seat could predate it, and for these checks over-refusing is the safe error.
 * (memberIsAgentSeat alone is still used for the TARGET rule, where a wrong "agent" answer would be the unsafe one.)
 */
export async function memberLooksAgentBound(env: Env, memberId: string): Promise<boolean> {
  if (await memberIsAgentSeat(env, memberId)) return true
  const row = await env.DB.prepare(
    'SELECT 1 AS one FROM member_tokens WHERE member_id = ?1 AND agent_id IS NOT NULL LIMIT 1',
  )
    .bind(memberId)
    .first<{ one: number }>()
  return row != null
}

/** Live delegations for one agent, read fresh on every call. Never cached: revocation must bite on the next request. */
export async function listLiveDelegationsForAgent(env: Env, agentId: string): Promise<DelegationRow[]> {
  const rows = await env.DB.prepare(
    `SELECT id, tenant, agent_id, delegator_member_id, scope_type, scope_id, max_grant,
            created_by_member_id, created_at, revoked_at
       FROM agent_operator_delegations
      WHERE tenant = ?1 AND agent_id = ?2 AND revoked_at IS NULL
      ORDER BY created_at ASC, id ASC`,
  )
    .bind(env.TENANT_SLUG, agentId)
    .all<DelegationRow>()
  return rows.results ?? []
}

/** `onlyDelegator` (W2): an ATTACHED seat counts only the delegations its attaching human gave, never another human's. */
export async function agentHasLiveDelegation(env: Env, agentId: string, onlyDelegator?: string): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT 1 AS one FROM agent_operator_delegations WHERE tenant = ?1 AND agent_id = ?2 AND revoked_at IS NULL AND (?3 IS NULL OR delegator_member_id = ?3) LIMIT 1',
  )
    .bind(env.TENANT_SLUG, agentId, onlyDelegator ?? null)
    .first<{ one: number }>()
  return row != null
}

export type DelegationError =
  | 'operator_principal_required'
  | 'human_principal_required'
  | 'member_identity_required'
  | 'tenant_scope'
  | 'invalid_scope_type'
  | 'invalid_scope_id'
  | 'invalid_max_grant'
  | 'scope_not_found'
  | 'home_scope_not_delegable'
  | 'agent_not_found'
  | 'agent_inactive'
  | 'agent_identity_unminted'
  | 'forbidden'
  | 'delegation_exists'
  | 'delegation_not_found'

/** Scope-rank for a delegation scope. A project has no capability scope of its own: project structure is an
 *  org-admin act everywhere else (requireWorkspaceAdmin), so admin over a project means admin over the org. */
export function capabilityScopeForDelegation(
  scopeType: DelegationScopeType,
  scopeId: string | null,
): { type: 'org' | 'department' | 'squad'; id: string | null } {
  if (scopeType === 'project') return { type: 'org', id: null }
  return { type: scopeType, id: scopeId }
}

/** Is this caller a HUMAN principal? A bound-agent session, or a member row welded to an agent, never is. */
async function requireHuman(
  env: Env,
  auth: AuthContext,
): Promise<{ ok: true; memberId: string } | { ok: false; error: DelegationError }> {
  if (auth.boundAgentId) return { ok: false, error: 'operator_principal_required' }
  if (auth.tenant !== env.TENANT_SLUG) return { ok: false, error: 'tenant_scope' }
  const memberId = sessionMemberId(auth)
  if (!memberId) return { ok: false, error: 'member_identity_required' }
  if (await memberLooksAgentBound(env, memberId)) return { ok: false, error: 'operator_principal_required' }
  const member = await env.DB.prepare(
    "SELECT status FROM members WHERE id = ?1 AND (tenant = ?2 OR tenant IS NULL) LIMIT 1",
  )
    .bind(memberId, env.TENANT_SLUG)
    .first<{ status: string }>()
  if (!member || member.status !== 'active') return { ok: false, error: 'human_principal_required' }
  return { ok: true, memberId }
}

export interface CreateDelegationInput {
  agentId: string
  scopeType: unknown
  scopeId: unknown
  maxGrant: unknown
}

export async function createDelegation(
  env: Env,
  auth: AuthContext,
  input: CreateDelegationInput,
): Promise<{ ok: true; delegation: DelegationRow } | { ok: false; error: DelegationError }> {
  const human = await requireHuman(env, auth)
  if (!human.ok) return human

  if (typeof input.scopeType !== 'string' || !(SCOPE_TYPES as readonly string[]).includes(input.scopeType)) {
    return { ok: false, error: 'invalid_scope_type' }
  }
  const scopeType = input.scopeType as DelegationScopeType // narrowed by the includes() check above
  if (typeof input.maxGrant !== 'string' || !(MAX_GRANTS as readonly string[]).includes(input.maxGrant)) {
    return { ok: false, error: 'invalid_max_grant' }
  }
  const maxGrant = input.maxGrant as DelegationMaxGrant // narrowed by the includes() check above

  let scopeId: string | null = null
  if (scopeType === 'org') {
    if (input.scopeId !== undefined && input.scopeId !== null) return { ok: false, error: 'invalid_scope_id' }
  } else {
    if (typeof input.scopeId !== 'string' || input.scopeId.trim().length === 0) {
      return { ok: false, error: 'invalid_scope_id' }
    }
    // Normalised ONCE: the existence check, the rank check and the stored row all read this same string.
    scopeId = input.scopeId.trim()
    if (scopeType === 'department') {
      const d = await env.DB.prepare('SELECT kind FROM departments WHERE id = ?1 LIMIT 1')
        .bind(scopeId)
        .first<{ kind: string }>()
      if (!d) return { ok: false, error: 'scope_not_found' }
      if (d.kind === 'home') return { ok: false, error: 'home_scope_not_delegable' }
    } else if (scopeType === 'squad') {
      const s = await env.DB.prepare('SELECT kind FROM squads WHERE id = ?1 LIMIT 1')
        .bind(scopeId)
        .first<{ kind: string }>()
      if (!s) return { ok: false, error: 'scope_not_found' }
      if (s.kind === 'home') return { ok: false, error: 'home_scope_not_delegable' }
    } else {
      const p = await env.DB.prepare('SELECT 1 AS one FROM projects WHERE id = ?1 LIMIT 1')
        .bind(scopeId)
        .first<{ one: number }>()
      if (!p) return { ok: false, error: 'scope_not_found' }
    }
  }

  // The delegator must hold ADMIN over the scope right now (grants OR the legacy role plane), and admin is the floor,
  // so a delegation can never carry more than its creator could do themselves.
  const cap = capabilityScopeForDelegation(scopeType, scopeId)
  const rank = await actorRankOnScopeFor(env, auth, cap.type, cap.id)
  if (rank < capabilityRank('admin')) return { ok: false, error: 'forbidden' }
  if (rank < capabilityRank(maxGrant)) return { ok: false, error: 'forbidden' }

  const agent = await env.DB.prepare('SELECT id, status FROM agents WHERE id = ?1 LIMIT 1')
    .bind(input.agentId)
    .first<{ id: string; status: string }>()
  if (!agent) return { ok: false, error: 'agent_not_found' }
  if (agent.status !== 'active') return { ok: false, error: 'agent_inactive' }
  const binding = await env.DB.prepare(
    'SELECT member_id FROM agent_member_bindings WHERE tenant = ?1 AND agent_id = ?2 LIMIT 1',
  )
    .bind(env.TENANT_SLUG, agent.id)
    .first<{ member_id: string }>()
  if (!binding) return { ok: false, error: 'agent_identity_unminted' }
  // Nobody delegates to their own seat; a human row is never an operator agent.
  if (binding.member_id === human.memberId) return { ok: false, error: 'forbidden' }

  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO agent_operator_delegations
         (id, tenant, agent_id, delegator_member_id, scope_type, scope_id, max_grant, created_by_member_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?4)`,
    )
      .bind(id, env.TENANT_SLUG, agent.id, human.memberId, scopeType, scopeId, maxGrant)
      .run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('UNIQUE')) return { ok: false, error: 'delegation_exists' }
    throw err
  }
  const row = await env.DB.prepare('SELECT * FROM agent_operator_delegations WHERE id = ?1')
    .bind(id)
    .first<DelegationRow>()
  if (!row) throw new Error('receipt_failed: delegation row missing after insert')
  return { ok: true, delegation: row }
}

export async function revokeDelegation(
  env: Env,
  auth: AuthContext,
  delegationId: string,
): Promise<{ ok: true; delegation: DelegationRow } | { ok: false; error: DelegationError }> {
  const human = await requireHuman(env, auth)
  if (!human.ok) return human
  const row = await env.DB.prepare(
    'SELECT * FROM agent_operator_delegations WHERE id = ?1 AND tenant = ?2 LIMIT 1',
  )
    .bind(delegationId, env.TENANT_SLUG)
    .first<DelegationRow>()
  if (!row) return { ok: false, error: 'delegation_not_found' }
  if (row.revoked_at) return { ok: false, error: 'delegation_not_found' }
  // The delegator can always withdraw; anyone else needs admin over the scope the delegation covers.
  if (row.delegator_member_id !== human.memberId) {
    const cap = capabilityScopeForDelegation(row.scope_type, row.scope_id)
    const rank = await actorRankOnScopeFor(env, auth, cap.type, cap.id)
    if (rank < capabilityRank('admin')) return { ok: false, error: 'forbidden' }
  }
  const res = await env.DB.prepare(
    'UPDATE agent_operator_delegations SET revoked_at = ?1 WHERE id = ?2 AND tenant = ?3 AND revoked_at IS NULL',
  )
    .bind(new Date().toISOString(), delegationId, env.TENANT_SLUG)
    .run()
  if (!res.meta || res.meta.changes !== 1) return { ok: false, error: 'delegation_not_found' }
  const after = await env.DB.prepare('SELECT * FROM agent_operator_delegations WHERE id = ?1')
    .bind(delegationId)
    .first<DelegationRow>()
  return { ok: true, delegation: after ?? { ...row, revoked_at: new Date().toISOString() } }
}

export async function listDelegations(
  env: Env,
  filter: { agentId?: string; includeRevoked?: boolean },
): Promise<DelegationRow[]> {
  const where = ['tenant = ?1']
  const binds: string[] = [env.TENANT_SLUG]
  if (filter.agentId) {
    binds.push(filter.agentId)
    where.push(`agent_id = ?${binds.length}`)
  }
  if (!filter.includeRevoked) where.push('revoked_at IS NULL')
  const rows = await env.DB.prepare(
    `SELECT id, tenant, agent_id, delegator_member_id, scope_type, scope_id, max_grant,
            created_by_member_id, created_at, revoked_at
       FROM agent_operator_delegations WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC LIMIT 200`,
  )
    .bind(...binds)
    .all<DelegationRow>()
  return rows.results ?? []
}


/**
 * The delegations a caller may SEE: a workspace admin sees all; anyone else sees the ones they made or hold admin over the
 * scope of. A plain member must not be able to enumerate who may act for whom. The ONE copy of this predicate: the
 * operator_list MCP tool and the dashboard Operators page both call it.
 */
export async function listVisibleDelegations(
  env: Env,
  auth: AuthContext,
  filter: { agentId?: string; includeRevoked?: boolean },
): Promise<DelegationRow[]> {
  const all = await listDelegations(env, filter)
  const visible: DelegationRow[] = []
  for (const d of all) {
    if (hasWorkspaceAdmin(auth) || d.delegator_member_id === auth.memberId) {
      visible.push(d)
      continue
    }
    const cap = capabilityScopeForDelegation(d.scope_type, d.scope_id)
    if ((await actorRankOnScopeFor(env, auth, cap.type, cap.id)) >= capabilityRank('admin')) visible.push(d)
  }
  return visible
}
