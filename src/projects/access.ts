import { capabilityRank, hasCapability } from '../auth/capability'
import type { AuthContext, CapabilityGrant, Env } from '../types'
import { chunkForD1InList } from '../lib/d1-in-list'

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
    // Self-referential check (is THIS grant, on ITS OWN declared scope, at
    // least observer) — never scope inheritance, so this is exactly
    // `capabilityRank(grant.capability) >= capabilityRank('observer')` and
    // needs no SquadScope/kind lookup (this function is deliberately
    // pure/sync — no `env` to load one with). A member's own home-squad
    // grant is legitimately theirs to see here; no home exclusion applies
    // to a caller reading their OWN scopes.
    if (capabilityRank(grant.capability) < capabilityRank('observer')) continue
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
  // mupot#1774: chunked under D1's 100-bind ceiling; the every-squad test runs over the union.
  const writable = new Set<string>()
  for (const chunk of chunkForD1InList(uniqueSquadIds, undefined, 1)) {
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const rows = await env.DB.prepare(
      `SELECT squad_id, access_level
         FROM project_squad_access
        WHERE project_id = ?1
          AND squad_id IN (${placeholders})`,
    ).bind(projectId, ...chunk).all<{ squad_id: string; access_level: string }>()
    for (const row of rows.results ?? []) {
      if (row.access_level === 'write' || row.access_level === 'admin') writable.add(row.squad_id)
    }
  }
  return uniqueSquadIds.every((squadId) => writable.has(squadId))
}

// THE caller-write chokepoint (adversarial gate #1974 P1-B): "can THIS CALLER write to the project".
// The caller must hold at least MEMBER rank on a squad that itself has write/admin on the project.
// anySquadHasProjectWrite below answers only "does any of these squads have write on the project";
// fed squadIds built from read access (which includes OBSERVER grants) it let an observer on a write
// squad write whenever they held member somewhere else (the tool floor passes on the other grant).
// Rank is filtered on the GRANTS before squads are collected, so the squad list can only contain
// squads where the caller's own grant is member or above. Legacy (capabilities undefined) callers
// keep the role path. Every caller-write check (project_remember, project_wiki_upsert, workspaces)
// goes through here.
export async function callerCanWriteProject(env: Env, auth: AuthContext, projectId: string): Promise<boolean> {
  const floored = auth.capabilities === undefined
    ? undefined
    : auth.capabilities.filter((g) => capabilityRank(g.capability) >= capabilityRank('member'))
  const access = projectReadAccessFromGrants({ ...auth, capabilities: floored }, floored ?? [])
  return access.workspaceAdmin || anySquadHasProjectWrite(env, projectId, access.squadIds)
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
  // mupot#1774: chunked under D1's 100-bind ceiling; any chunk with a writable squad grants it.
  for (const chunk of chunkForD1InList(uniqueSquadIds, undefined, 1)) {
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const row = await env.DB.prepare(
      `SELECT 1 AS ok
         FROM project_squad_access
        WHERE project_id = ?1
          AND squad_id IN (${placeholders})
          AND access_level IN ('write', 'admin')
        LIMIT 1`,
    ).bind(projectId, ...chunk).first<{ ok: number }>()
    if (row !== null) return true
  }
  return false
}

/**
 * "Is this caller a member of a squad that has access to the project" (any level), or a workspace admin.
 * Built on projectVisibilityClause with org-observer and department paths switched OFF, so squad-tier
 * wiki pages (src/pages/service.ts) are NOT visible to a caller whose only reach is org-wide observer
 * or a department grant. Absence of a project_squad_access row is denial.
 */
export async function callerHasSquadAccessToProject(env: Env, access: ProjectReadAccess, projectId: string): Promise<boolean> {
  if (access.workspaceAdmin) return true
  if (access.squadIds.length === 0) return false
  const visibility = projectVisibilityClause({ workspaceAdmin: false, orgRead: false, squadIds: access.squadIds, departmentIds: [] })
  const row = await env.DB.prepare(`SELECT 1 AS ok FROM projects p WHERE p.id = ? AND ${visibility.sql}`)
    .bind(projectId, ...visibility.binds).first<{ ok: number }>()
  return row !== null
}

/**
 * Of `projectIds`, the ones the viewer may read (workspace admin / org observer: all that exist).
 * One D1 query, built on the same projectVisibilityClause the project readers use.
 */
export async function readableProjectIdSet(
  env: Env,
  auth: AuthContext,
  projectIds: ReadonlyArray<string | null | undefined>,
): Promise<Set<string>> {
  const ids = [...new Set(projectIds.filter((id): id is string => typeof id === 'string' && id !== ''))]
  if (ids.length === 0) return new Set()
  const visibility = projectVisibilityClause(projectReadAccessFromGrants(auth, auth.capabilities ?? []))
  const res = await env.DB.prepare(
    `SELECT p.id AS id FROM projects p
      WHERE p.id IN (SELECT CAST(value AS TEXT) FROM json_each(?)) AND ${visibility.sql}`,
  ).bind(JSON.stringify(ids), ...visibility.binds).all<{ id: string }>()
  return new Set((res.results ?? []).map((r) => r.id))
}

/**
 * Null the joined `project_name` on rows whose project the viewer cannot read. Task visibility is
 * squad-scoped and a task can sit in a project its squad has no edge to, so the project NAME needs
 * its own read check. Fails closed: if the check cannot run, every name is dropped.
 */
export async function redactUnreadableProjectNames<T extends { project_id?: string | null; project_name?: string | null; project_slug?: string | null }>(
  env: Env,
  auth: AuthContext,
  rows: T[],
): Promise<T[]> {
  if (!rows.some((r) => r.project_name || r.project_slug)) return rows
  let readable: Set<string>
  try {
    readable = await readableProjectIdSet(env, auth, rows.map((r) => r.project_id))
  } catch {
    readable = new Set()
  }
  return rows.map((r) =>
    // as T: the generic row only promises project_name is string|null|undefined; null is in that set.
    (r.project_name || r.project_slug) && !(r.project_id && readable.has(r.project_id)) ? ({ ...r, project_name: null, ...(r.project_slug === undefined ? {} : { project_slug: null }) } as T) : r,
  )
}
