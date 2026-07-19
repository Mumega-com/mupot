import { hasCapability } from '../auth/capability'
import type { AuthContext, CapabilityGrant, Env } from '../types'
import {
  projectReadAccessFromGrants,
  projectVisibilityClause,
  type ProjectReadAccess,
} from '../projects/access'

export interface RoutinePrincipal {
  tenant: string
  actor_type: 'member' | 'agent'
  actor_id: string
  workspace_admin: boolean
  // Coarse role facts are retained for source services that must mirror legacy
  // Task endpoint bypasses. Callers constructing principals before v0.25 omit
  // these flags and therefore get the conservative non-bypass behavior.
  legacy_owner_admin?: boolean
  org_owner?: boolean
  grants: CapabilityGrant[]
  project_read: ProjectReadAccess
}

export function routinePrincipal(auth: AuthContext): RoutinePrincipal {
  const grants = auth.capabilities ?? []
  const projectRead = projectReadAccessFromGrants(auth, grants)
  return {
    tenant: auth.tenant,
    actor_type: auth.boundAgentId ? 'agent' : 'member',
    actor_id: auth.boundAgentId ?? auth.memberId ?? auth.userId,
    workspace_admin: projectRead.workspaceAdmin,
    legacy_owner_admin: auth.role === 'owner' || auth.role === 'admin',
    org_owner: auth.role === 'owner',
    grants,
    project_read: projectRead,
  }
}

export async function principalCanReadProject(
  env: Env,
  principal: RoutinePrincipal,
  projectId: string,
): Promise<boolean> {
  if (principal.tenant !== env.TENANT_SLUG) return false
  const visibility = projectVisibilityClause(principal.project_read)
  const row = await env.DB.prepare(
    `SELECT 1 FROM projects p WHERE p.id = ? AND ${visibility.sql} LIMIT 1`,
  ).bind(projectId, ...visibility.binds).first()
  return row !== null
}

export async function principalCanRunForSquad(
  env: Env,
  principal: RoutinePrincipal,
  projectId: string,
  squadId: string,
): Promise<boolean> {
  if (principal.tenant !== env.TENANT_SLUG) return false
  if (principal.workspace_admin) return true
  const squad = await env.DB.prepare(
    `SELECT s.department_id
       FROM squads s
       JOIN project_squad_access psa ON psa.squad_id = s.id
      WHERE s.id = ? AND psa.project_id = ? AND psa.access_level IN ('write','admin')`,
  ).bind(squadId, projectId).first<{ department_id: string }>()
  return squad !== null && hasCapability(
    principal.grants,
    'squad',
    squadId,
    'member',
    squad.department_id,
  )
}
