import { canOnSquad, hasCapability, resolveCapabilities } from './capability'
import { resolveAgentMemberBinding } from '../members/service'
import type { AuthContext, Env } from '../types'

export type ExecutionScopeRequest =
  | { action: 'router:read'; squadId: string }
  | { action: 'router:mutate'; squadId: string }
  | { action: 'meter:read'; agentId: string }

export type ExecutionScopeDecision =
  | { ok: true; tenant: string; squadId: string; agentId: string | null; source: 'principal' }
  | { ok: false; status: 403 | 404; error: 'forbidden' | 'not_found' }

const forbidden = (): ExecutionScopeDecision => ({ ok: false, status: 403, error: 'forbidden' })
const notFound = (): ExecutionScopeDecision => ({ ok: false, status: 404, error: 'not_found' })

async function principalCanOnSquad(
  env: Env,
  auth: AuthContext,
  squadId: string,
  min: 'observer' | 'lead',
): Promise<boolean> {
  if (!auth.memberId) return false

  // A durable lookup catches revoked grants, but cannot restore authority the
  // authenticated session has already had removed. In particular, directory
  // sessions use capabilities: [] as their B1 ambient ceiling.
  const durableGrants = await resolveCapabilities(env, auth.memberId)
  if (!(await canOnSquad(env, durableGrants, squadId, min))) return false
  if (auth.capabilities === undefined) return true
  return canOnSquad(env, auth.capabilities, squadId, min)
}

async function principalIsOrgAdmin(env: Env, auth: AuthContext): Promise<boolean> {
  // Preserve the legacy server-owned role only when no fine-grained ambient plane
  // is present. Once a channel supplies capabilities (including B1's empty
  // directory ceiling), durable grants and ambient authority must both allow.
  if (auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin')) {
    return true
  }
  if (!auth.memberId) return false

  const durableGrants = await resolveCapabilities(env, auth.memberId)
  if (!hasCapability(durableGrants, 'org', null, 'admin')) return false
  if (auth.capabilities === undefined) return true
  return hasCapability(auth.capabilities, 'org', null, 'admin')
}

interface AuthorizedAgentRow {
  id: string
  squad_id: string
  department_id: string
}

/**
 * Resolve an agent only through a durable lead-or-higher grant. A missing agent
 * and an existing foreign agent therefore produce the same empty result. The
 * ambient capability plane is intersected afterward so B1-clamped sessions can
 * never resurrect a durable grant.
 */
async function findAgentAuthorizedForLead(
  env: Env,
  auth: AuthContext,
  agentId: string,
): Promise<AuthorizedAgentRow | null> {
  if (!auth.memberId) return null

  const agent = await env.DB.prepare(
    `WITH durable_grants AS (
       SELECT scope_type, scope_id, capability
         FROM capabilities
        WHERE member_id = ?2
       UNION ALL
       SELECT 'squad' AS scope_type, squad_id AS scope_id, capability
         FROM channel_capability_grants
        WHERE member_id = ?2
     )
     SELECT a.id, a.squad_id, s.department_id
       FROM agents a
       JOIN squads s ON s.id = a.squad_id
      WHERE a.id = ?1
        AND EXISTS (
          SELECT 1
            FROM durable_grants g
           WHERE g.capability IN ('lead', 'admin', 'owner')
             AND (
               g.scope_type = 'org'
               OR (g.scope_type = 'squad' AND g.scope_id = a.squad_id)
               OR (g.scope_type = 'department' AND g.scope_id = s.department_id)
             )
        )
      LIMIT 1`,
  ).bind(agentId, auth.memberId).first<AuthorizedAgentRow>()
  if (!agent) return null

  if (
    auth.capabilities !== undefined
    && !hasCapability(auth.capabilities, 'squad', agent.squad_id, 'lead', agent.department_id)
  ) {
    return null
  }
  return agent
}

async function authorizeRouterScope(
  env: Env,
  auth: AuthContext,
  request: Extract<ExecutionScopeRequest, { action: 'router:read' | 'router:mutate' }>,
): Promise<ExecutionScopeDecision> {
  const required = request.action === 'router:read' ? 'observer' : 'lead'
  const actorMemberId = auth.memberId
  if (!actorMemberId || !(await principalCanOnSquad(env, auth, request.squadId, required))) {
    return forbidden()
  }

  const squad = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1')
    .bind(request.squadId)
    .first<{ id: string }>()
  if (!squad) return notFound()

  return {
    ok: true,
    tenant: env.TENANT_SLUG,
    squadId: squad.id,
    agentId: null,
    source: 'principal',
  }
}

async function authorizeMeterScope(
  env: Env,
  auth: AuthContext,
  request: Extract<ExecutionScopeRequest, { action: 'meter:read' }>,
): Promise<ExecutionScopeDecision> {
  if (auth.boundAgentId) {
    if (!auth.memberId || auth.boundAgentId !== request.agentId) return forbidden()
    const binding = await resolveAgentMemberBinding(env, request.agentId)
    if (binding.kind !== 'bound' || binding.memberId !== auth.memberId) return forbidden()

    const agent = await env.DB.prepare('SELECT id, squad_id FROM agents WHERE id = ?1')
      .bind(request.agentId)
      .first<{ id: string; squad_id: string }>()
    if (!agent) return notFound()
    return {
      ok: true,
      tenant: env.TENANT_SLUG,
      squadId: agent.squad_id,
      agentId: agent.id,
      source: 'principal',
    }
  }

  if (await principalIsOrgAdmin(env, auth)) {
    const agent = await env.DB.prepare('SELECT id, squad_id FROM agents WHERE id = ?1')
      .bind(request.agentId)
      .first<{ id: string; squad_id: string }>()
    if (!agent) return notFound()
    return {
      ok: true,
      tenant: env.TENANT_SLUG,
      squadId: agent.squad_id,
      agentId: agent.id,
      source: 'principal',
    }
  }

  const agent = await findAgentAuthorizedForLead(env, auth, request.agentId)
  if (!agent) return forbidden()

  return {
    ok: true,
    tenant: env.TENANT_SLUG,
    squadId: agent.squad_id,
    agentId: agent.id,
    source: 'principal',
  }
}

/**
 * Resolve an MCP/REST execution request into a server-authorized scope.
 *
 * Request data names only the target. Tenant, grants, and a bound-agent identity
 * are derived from the environment, authenticated principal, and D1 respectively.
 */
export async function authorizeExecutionScope(
  env: Env,
  auth: AuthContext,
  request: ExecutionScopeRequest,
): Promise<ExecutionScopeDecision> {
  if (request.action === 'meter:read') return authorizeMeterScope(env, auth, request)
  return authorizeRouterScope(env, auth, request)
}
