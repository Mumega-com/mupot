import { canOnSquad, resolveCapabilities } from './capability'
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

async function principalGrants(env: Env, auth: AuthContext) {
  if (!auth.memberId) return []
  return resolveCapabilities(env, auth.memberId)
}

async function authorizeRouterScope(
  env: Env,
  auth: AuthContext,
  request: Extract<ExecutionScopeRequest, { action: 'router:read' | 'router:mutate' }>,
): Promise<ExecutionScopeDecision> {
  const squad = await env.DB.prepare('SELECT id FROM squads WHERE id = ?1')
    .bind(request.squadId)
    .first<{ id: string }>()
  if (!squad) return notFound()

  const grants = await principalGrants(env, auth)
  const required = request.action === 'router:read' ? 'observer' : 'lead'
  if (!(await canOnSquad(env, grants, squad.id, required))) return forbidden()

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
  const agent = await env.DB.prepare('SELECT id, squad_id FROM agents WHERE id = ?1')
    .bind(request.agentId)
    .first<{ id: string; squad_id: string }>()
  if (!agent) return notFound()

  if (auth.boundAgentId) {
    if (!auth.memberId || auth.boundAgentId !== agent.id) return forbidden()
    const binding = await resolveAgentMemberBinding(env, agent.id)
    if (binding.kind === 'bound' && binding.memberId === auth.memberId) {
      return {
        ok: true,
        tenant: env.TENANT_SLUG,
        squadId: agent.squad_id,
        agentId: agent.id,
        source: 'principal',
      }
    }
    return forbidden()
  }

  const grants = await principalGrants(env, auth)
  if (!(await canOnSquad(env, grants, agent.squad_id, 'lead'))) return forbidden()

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
