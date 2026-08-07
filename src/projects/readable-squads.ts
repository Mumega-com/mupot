import type { AuthContext, Capability, CapabilityGrant, Env } from '../types'
import { hasCapability, isOrgAdmin, resolveCapabilities } from '../auth/capability'

const READABLE_SQUAD_PAGE_SIZE = 500

function jsonIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)])
}

export async function resolveReadableSquadIds(
  env: Env,
  squadIds: string[],
  departmentIds: string[],
): Promise<string[]> {
  const directScope = jsonIds(squadIds)
  const departmentScope = jsonIds(departmentIds)
  const resolved: string[] = []
  let lastId = ''

  while (true) {
    const result = await env.DB.prepare(
      `SELECT id FROM squads
        WHERE (id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))
           OR department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2)))
          AND id > ?3
        ORDER BY id
        LIMIT ?4`,
    ).bind(directScope, departmentScope, lastId, READABLE_SQUAD_PAGE_SIZE).all<{ id: string }>()
    const page = result.results ?? []
    resolved.push(...page.map((row) => row.id))
    if (page.length < READABLE_SQUAD_PAGE_SIZE) break

    const nextLastId = page.at(-1)?.id
    if (!nextLastId || nextLastId <= lastId) throw new Error('readable_squad_pagination_stalled')
    lastId = nextLastId
  }

  return resolved
}

// resolveGrantedSquadIds — the squad ids a principal's OWN grants cover at >=
// `minimum` rank: an org-scope grant covers every squad (resolveAllSquadIds);
// otherwise every squad/department-scope grant meeting the floor is resolved
// through the squad table (department grants inherit their squads). Not
// project-specific despite living alongside the readable-squad pagination
// helpers — this is the general "which squads can this member act on" primitive,
// shared by project read-scoping (dashboard/projects.ts) and the agent roster
// (dashboard/agents-admin.ts, FLIGHT-001 F2) so there is exactly ONE
// implementation of "resolve my squads from my grants" (see
// [[feedback_two_tools_two_copies_of_one_predicate]] on why two copies of the
// same security predicate silently drift).
export async function resolveGrantedSquadIds(
  env: Env,
  grants: CapabilityGrant[],
  minimum: Capability,
): Promise<string[]> {
  if (hasCapability(grants, 'org', null, minimum)) return resolveAllSquadIds(env)

  const squadIds: string[] = []
  const departmentIds: string[] = []
  for (const grant of grants) {
    if (!grant.scope_id || !hasCapability([grant], grant.scope_type, grant.scope_id, minimum)) continue
    if (grant.scope_type === 'squad') squadIds.push(grant.scope_id)
    if (grant.scope_type === 'department') departmentIds.push(grant.scope_id)
  }
  if (!squadIds.length && !departmentIds.length) return []
  return resolveReadableSquadIds(env, squadIds, departmentIds)
}

// resolveAccessibleSquadIds — the squads a CALLER (not a raw grants array) may
// read at >= `minimum`, resolved straight from their auth context. null =
// unrestricted (org-scope grant, or the legacy owner/admin org role — same
// escape requireCapability/canOnOrg already use). [] = the caller holds SOME
// capability (they already passed the dashboard's global capability floor,
// FLIGHT-001 F2, #796) but none of their grants resolve to a live squad (e.g.
// a squad/department grant referencing a since-deleted scope) — callers MUST
// treat [] as "show nothing", never fall back to "show everything".
//
// Extracted from dashboard/agents-admin.ts's private `accessibleSquadIds`
// (FLIGHT-001 F2) so /fleet and /brain (FLIGHT-001 #797) share the SAME
// auth->squads resolution instead of each hand-rolling the isOrgAdmin /
// resolveCapabilities / org-grant-shortcut sequence a third and fourth time —
// see [[feedback_two_tools_two_copies_of_one_predicate]] on why N copies of
// one security predicate silently drift apart.
export async function resolveAccessibleSquadIds(
  env: Env,
  auth: AuthContext,
  minimum: Capability = 'observer',
): Promise<string[] | null> {
  if (isOrgAdmin(auth)) return null
  if (!auth.memberId) return []
  const grants = auth.capabilities ?? (await resolveCapabilities(env, auth.memberId))
  if (hasCapability(grants, 'org', null, minimum)) return null
  return resolveGrantedSquadIds(env, grants, minimum)
}

export async function resolveAllSquadIds(env: Env): Promise<string[]> {
  const resolved: string[] = []
  let lastId = ''

  while (true) {
    const result = await env.DB.prepare(
      `SELECT id FROM squads
        WHERE id > ?1
        ORDER BY id
        LIMIT ?2`,
    ).bind(lastId, READABLE_SQUAD_PAGE_SIZE).all<{ id: string }>()
    const page = result.results ?? []
    resolved.push(...page.map((row) => row.id))
    if (page.length < READABLE_SQUAD_PAGE_SIZE) break

    const nextLastId = page.at(-1)?.id
    if (!nextLastId || nextLastId <= lastId) throw new Error('all_squad_pagination_stalled')
    lastId = nextLastId
  }

  return resolved
}
