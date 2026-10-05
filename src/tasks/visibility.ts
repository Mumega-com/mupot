// src/tasks/visibility.ts — THE task-visibility chokepoint (mupot#1647).
//
// "Which tasks may this caller read?" is answered HERE and nowhere else. Readers call
// resolveVisibleTaskScope (lists), canReadSquadTasks / canReadTask (single rows) and
// visibleTaskClause (SQL). They never re-derive archive / home / rank / plane rules.
// Design + the condition x reader table: docs/architecture/task-visibility.md.
//
// This layer COMPOSES existing authorization primitives (hasCapability, planeCoversScope,
// resolveGrantedSquadIds, resolveAllSquadIds, TASK_NOT_ARCHIVED_SQL); it re-implements none.

import type { AuthContext, Capability, CapabilityGrant, Env } from '../types'
import {
  capabilityRank,
  hasCapability,
  loadSquadScope,
  planeCoversScope,
} from '../auth/capability'
import { TASK_NOT_ARCHIVED_SQL, isTaskArchived } from '../hygiene/filters'
import { resolveAllSquadIds, resolveGrantedSquadIds } from '../projects/readable-squads'

/** The rank every task READER requires (task_list, task_board, GET /tasks, GET /tasks/:id). */
export const TASK_READ_MINIMUM: Capability = 'member'

export interface VisibleTaskScope {
  /** Explicit, bounded, de-duplicated squad ids whose tasks the caller may read. Never null. */
  readonly squadIds: readonly string[]
  /** True when the caller holds the org-wide plane (legacy role while capabilities are
   *  unloaded, or an org-scope grant at member+). Informational: squadIds is already
   *  materialized (non-home squads + the caller's exact grants). */
  readonly orgWide: boolean
}

// The ONE definition of the legacy role plane: it counts ONLY while capabilities are
// unloaded (the bootstrap owner's real shape). A principal whose capabilities are loaded
// is judged by those grants alone, whatever auth.role says.
function rolePlaneActive(auth: AuthContext): boolean {
  return auth.capabilities === undefined && (auth.role === 'owner' || auth.role === 'admin')
}

// Ambient grants only. NEVER auth.latentCapabilities (a directory-channel session parks the
// member's real grants there precisely so they are NOT ambient authority).
function ambientGrants(auth: AuthContext): CapabilityGrant[] {
  return auth.capabilities ?? []
}

function exactSquadGrantIds(grants: CapabilityGrant[]): string[] {
  const ids: string[] = []
  for (const g of grants) {
    if (g.scope_type !== 'squad' || !g.scope_id) continue
    if (capabilityRank(g.capability) >= capabilityRank(TASK_READ_MINIMUM)) ids.push(g.scope_id)
  }
  return ids
}

async function homeSquadIdsAmong(env: Env, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await env.DB.prepare(
    `SELECT id FROM squads
      WHERE kind = 'home' AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))`,
  ).bind(JSON.stringify(ids)).all<{ id: string }>()
  return new Set((rows.results ?? []).map((r) => r.id))
}

export async function resolveVisibleTaskScope(env: Env, auth: AuthContext): Promise<VisibleTaskScope> {
  const grants = ambientGrants(auth)
  const rolePlane = rolePlaneActive(auth)
  const orgGrantMember = hasCapability(grants, 'org', null, TASK_READ_MINIMUM)
  const orgWide = rolePlane || orgGrantMember
  const exact = exactSquadGrantIds(grants)

  let inherited: string[]
  if (orgWide) {
    // Every NON-home squad. A home is reachable only through the caller's own exact grant.
    inherited = await resolveAllSquadIds(env, { excludeHome: true })
  } else {
    // Squad + department grants at member+. The department expansion can reach a home
    // squad when a (legacy / poisoned) department grant names a home department, so homes
    // are stripped from the INHERITED part below and re-admitted only via an exact grant.
    inherited = await resolveGrantedSquadIds(env, grants, TASK_READ_MINIMUM)
    const exactSet = new Set(exact)
    const candidates = inherited.filter((id) => !exactSet.has(id))
    const homes = await homeSquadIdsAmong(env, candidates)
    inherited = inherited.filter((id) => !homes.has(id))
  }
  return { squadIds: [...new Set([...inherited, ...exact])], orgWide }
}

/** Can this caller read tasks on ONE squad? The single-squad twin of resolveVisibleTaskScope
 *  (the seam test asserts they agree). Archive state is a TASK property — see canReadTask. */
export async function canReadSquadTasks(env: Env, auth: AuthContext, squadId: string): Promise<boolean> {
  const scope = await loadSquadScope(env, squadId)
  if (!scope) return false
  if (rolePlaneActive(auth) && planeCoversScope('role', scope)) return true
  return hasCapability(ambientGrants(auth), 'squad', scope, TASK_READ_MINIMUM)
}

/** Single-row reader. `includeArchived` is for an explicit history read (GET /tasks/:id);
 *  every LISTING surface leaves it false. */
export async function canReadTask(
  env: Env,
  auth: AuthContext,
  task: { id: string; squad_id: string },
  opts: { includeArchived?: boolean } = {},
): Promise<boolean> {
  if (!opts.includeArchived && (await isTaskArchived(env, task.id))) return false
  return canReadSquadTasks(env, auth, task.squad_id)
}

export interface VisibleTaskClause {
  sql: string
  binds: unknown[]
}

/** SQL predicate over a `tasks` row: squad in scope AND not archived. Numbered placeholders
 *  starting at `startIndex` (D1 requires the bind count to equal the placeholder count). */
export function visibleTaskClause(
  scope: Pick<VisibleTaskScope, 'squadIds'>,
  startIndex: number,
  alias = 'tasks',
): VisibleTaskClause {
  if (scope.squadIds.length === 0) return { sql: '1 = 0', binds: [] }
  return {
    sql: `${alias}.squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?${startIndex})) AND ${TASK_NOT_ARCHIVED_SQL(alias)}`,
    binds: [JSON.stringify(scope.squadIds)],
  }
}

/** True when the caller may read ANY project regardless of project_squad_access edges:
 *  the legacy role plane (capabilities unloaded) or an org-scope admin grant. */
export function hasProjectEdgeBypass(auth: AuthContext): boolean {
  return rolePlaneActive(auth) || hasCapability(ambientGrants(auth), 'org', null, 'admin')
}

/** Project selection precondition for a task listing filtered by project_id: the bypass
 *  plane reads any existing project; everyone else needs a project_squad_access edge to a
 *  squad they may read (`candidateSquadIds`: the one explicit squad, else scope.squadIds). */
export async function canReadProjectForTasks(
  env: Env,
  auth: AuthContext,
  projectId: string,
  candidateSquadIds: readonly string[],
): Promise<boolean> {
  if (hasProjectEdgeBypass(auth)) {
    return (await env.DB.prepare('SELECT 1 FROM projects WHERE id = ?1').bind(projectId).first()) !== null
  }
  if (candidateSquadIds.length === 0) return false
  return (await env.DB.prepare(
    `SELECT 1 FROM project_squad_access
      WHERE project_id = ?1 AND squad_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))`,
  ).bind(projectId, JSON.stringify(candidateSquadIds)).first()) !== null
}
