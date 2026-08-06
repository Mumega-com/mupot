import { hasCapability } from '../auth/capability'
import type { AuthContext, CapabilityGrant, Env } from '../types'

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

// The ONE per-project write-access primitive for squads (moved from src/mcp/index.ts
// so non-MCP surfaces — task automation, #399 — can share it instead of re-deriving
// the write/admin threshold). Returns true only when EVERY squad in `squadIds` holds
// 'write' or 'admin' on `projectId`; a squad with no project_squad_access row at all
// is NOT writable (LEFT JOIN semantics are intentionally avoided — absence is denial).
export async function hasProjectWriteForSquads(
  env: Env,
  projectId: string,
  squadIds: string[],
): Promise<boolean> {
  const uniqueSquadIds = [...new Set(squadIds)]
  if (uniqueSquadIds.length === 0) return false
  const placeholders = uniqueSquadIds.map((_, index) => `?${index + 2}`).join(', ')
  const rows = await env.DB.prepare(
    `SELECT squad_id, access_level
       FROM project_squad_access
      WHERE project_id = ?1
        AND squad_id IN (${placeholders})`,
  ).bind(projectId, ...uniqueSquadIds).all<{ squad_id: string; access_level: string }>()
  const writable = new Set(
    (rows.results ?? [])
      .filter((row) => row.access_level === 'write' || row.access_level === 'admin')
      .map((row) => row.squad_id),
  )
  return uniqueSquadIds.every((squadId) => writable.has(squadId))
}

// The ANY-of variant of hasProjectWriteForSquads: true when AT LEAST ONE of `squadIds`
// holds 'write'/'admin' on the project. This is the correct "can THIS CALLER write to
// the project" test — a caller typically holds several squad grants (write on one,
// observer on unrelated others), so the every-squad-writable form (hasProjectWriteForSquads)
// would wrongly deny them. Same fail-closed discipline: absence of a project_squad_access
// row is denial, never a bypass.
export async function anySquadHasProjectWrite(
  env: Env,
  projectId: string,
  squadIds: string[],
): Promise<boolean> {
  const uniqueSquadIds = [...new Set(squadIds)]
  if (uniqueSquadIds.length === 0) return false
  const placeholders = uniqueSquadIds.map((_, index) => `?${index + 2}`).join(', ')
  const row = await env.DB.prepare(
    `SELECT 1 AS ok
       FROM project_squad_access
      WHERE project_id = ?1
        AND squad_id IN (${placeholders})
        AND access_level IN ('write', 'admin')
      LIMIT 1`,
  ).bind(projectId, ...uniqueSquadIds).first<{ ok: number }>()
  return row !== null
}
