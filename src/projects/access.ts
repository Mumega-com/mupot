import { hasCapability } from '../auth/capability'
import type { AuthContext, CapabilityGrant } from '../types'

export interface ProjectReadAccess {
  workspaceAdmin: boolean
  orgRead: boolean
  squadIds: string[]
  departmentIds: string[]
}

export function projectReadAccessFromGrants(
  auth: AuthContext,
  grants: CapabilityGrant[],
): ProjectReadAccess {
  const legacyAdmin = auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin')
  const workspaceAdmin = legacyAdmin || hasCapability(grants, 'org', null, 'admin')
  if (workspaceAdmin) {
    return { workspaceAdmin: true, orgRead: true, squadIds: [], departmentIds: [] }
  }

  const squadIds = new Set<string>()
  const departmentIds = new Set<string>()
  for (const grant of grants) {
    if (!hasCapability([grant], grant.scope_type, grant.scope_id, 'observer')) continue
    if (grant.scope_type === 'squad' && grant.scope_id) squadIds.add(grant.scope_id)
    if (grant.scope_type === 'department' && grant.scope_id) departmentIds.add(grant.scope_id)
  }

  return {
    workspaceAdmin: false,
    orgRead: hasCapability(grants, 'org', null, 'observer'),
    squadIds: [...squadIds],
    departmentIds: [...departmentIds],
  }
}

export function unrestrictedProjectRead(access: ProjectReadAccess): boolean {
  return access.workspaceAdmin || access.orgRead
}

export function projectVisibilityClause(access: ProjectReadAccess): { sql: string; binds: string[] } {
  if (unrestrictedProjectRead(access)) return { sql: '1 = 1', binds: [] }
  return {
    sql: `EXISTS (
      SELECT 1
        FROM project_squad_access psa
        JOIN squads s ON s.id = psa.squad_id
       WHERE psa.project_id = p.id
         AND (s.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
           OR s.department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?)))
    )`,
    binds: [JSON.stringify([...new Set(access.squadIds)]), JSON.stringify([...new Set(access.departmentIds)])],
  }
}
