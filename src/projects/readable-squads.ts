import type { AuthContext, Capability, CapabilityGrant, Env } from '../types'
import { capabilityRank, hasCapability, isOrgAdmin, resolveCapabilities } from '../auth/capability'

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
  // G-FP1b point 2/3: an org-scope grant resolves to EVERY squad EXCEPT a
  // home squad (resolveAllSquadIds would otherwise leak every member's home
  // into any org-grant holder's "which squads can I see" answer — the exact
  // shape of the acceptance tests for squad_recall/squad_member_list/
  // task_list/task_board/kanban). An EXACT squad-scope grant naming a home
  // (below, in the per-grant loop) still resolves it — that is the home's
  // owner, not an inherited plane.
  if (hasCapability(grants, 'org', null, minimum)) return resolveAllSquadIds(env, { excludeHome: true })

  const squadIds: string[] = []
  const departmentIds: string[] = []
  for (const grant of grants) {
    if (!grant.scope_id) continue
    // Self-referential check (this grant, on its OWN declared scope) — no
    // inheritance involved, so this is exactly a rank comparison and needs
    // no SquadScope/kind lookup (an exact squad-scope grant always covers
    // its own squad regardless of kind, per hasCapability's contract).
    if (capabilityRank(grant.capability) < capabilityRank(minimum)) continue
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
// `null` (unrestricted) is UNCHANGED by G-FP1b — still zero extra D1 cost,
// exactly as before this PR (an earlier cut of this fix materialized every
// non-home squad id instead, which (a) turned a free check into a real query
// on every dashboard/task/agent read for the common org-admin case, and (b)
// broke several tests' explicit "an unrestricted caller issues the SAME
// query shape as always, no extra filter" assertions — see
// tests/dashboard-agents-admin.test.ts's own doc comment on exactly this
// property). Home exclusion for the unrestricted case is instead the
// CONSUMER's job: every one of this function's callers that reads squad-
// scoped rows already joins `squads` (or filters against a real squad list)
// and must add `kind != 'home'` there, the same way
// src/dashboard/agents-admin.ts's loadAllAgents and
// src/tasks/index.ts's GET / handler do. See the PR body's per-consumer
// table for which of the eight callers carry that exclusion and how it was
// verified.
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

export async function resolveAllSquadIds(env: Env, opts: { excludeHome?: boolean } = {}): Promise<string[]> {
  const resolved: string[] = []
  let lastId = ''
  const kindClause = opts.excludeHome ? `AND kind != 'home'` : ''

  while (true) {
    const result = await env.DB.prepare(
      `SELECT id FROM squads
        WHERE id > ?1 ${kindClause}
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
