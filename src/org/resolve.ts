// mupot — shared org-ref resolvers (SENSITIVE: these feed capability gates).
//
// A "ref" is an id OR a slug. id is a globally-unique uuid PK, so it resolves
// deterministically (LIMIT 1). slug is NOT globally unique — agents.slug is
// UNIQUE(squad_id, slug) and squads.slug is UNIQUE(department_id, slug) — so a bare
// slug can match rows in different scopes. A LIMIT-1 slug lookup would return an
// arbitrary, insertion-order-dependent row, and since the row's squad_id/department_id
// then drives a capability check (and, in the mint path, which agent a credential is
// bound to), that is a self-poisoning defect (kasra-review P1, both the mint and the
// read-side orient gates). So: resolve by id first; on a slug, COUNT matches and REFUSE
// an ambiguous one. The caller must use the id (or a unique slug). Fail-closed.

import type { Env } from '../types'

export type ResolveResult<T> = { ok: true; value: T } | { ok: false; reason: 'not_found' | 'ambiguous' }

async function resolveByIdThenSlug<T extends { id: string }>(
  env: Env,
  cols: string,
  table: string,
  ref: string,
  /**
   * Extra predicate applied to the SLUG lookup only. Used by agents to exclude
   * deactivated rows — see resolveAgentRef. Never applied to the id lookup: an id is
   * globally unique and unambiguous by construction, and an operator must still be able
   * to address a deactivated row by id (to inspect, reactivate, or merge it).
   */
  slugPredicate = '',
): Promise<ResolveResult<T>> {
  const byId = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?1 LIMIT 1`)
    .bind(ref)
    .first<T>()
  if (byId) return { ok: true, value: byId }

  // No id match → resolve by slug, but COUNT matches; >1 is ambiguous, not "pick one".
  const bySlug = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE slug = ?1${slugPredicate}`)
    .bind(ref)
    .all<T>()
  const rows = bySlug.results ?? []
  if (rows.length === 0) return { ok: false, reason: 'not_found' }
  if (rows.length > 1) return { ok: false, reason: 'ambiguous' }
  return { ok: true, value: rows[0] }
}

export function resolveDepartmentRef(env: Env, ref: string): Promise<ResolveResult<{ id: string }>> {
  return resolveByIdThenSlug(env, 'id', 'departments', ref)
}

export function resolveSquadRef(
  env: Env,
  ref: string,
): Promise<ResolveResult<{ id: string; department_id: string }>> {
  return resolveByIdThenSlug(env, 'id, department_id', 'squads', ref)
}

/**
 * Resolve an agent ref. A SLUG resolves only against NON-TOMBSTONE agents (active or
 * paused); an ID resolves against any agent, including inactive ones.
 *
 * WHY THE STATUS FILTER (mupot#702, reported by hadi-claude and cyrus)
 *
 * `agents.slug` is UNIQUE(squad_id, slug), so the same slug legitimately exists in
 * different squads — and a deactivated row keeps its slug forever. Every deactivation
 * therefore left a permanent land-mine: the row does nothing, but it still COUNTS toward
 * ambiguity, so `agent: "kasra"` failed with `ambiguous_slug` against a row that had been
 * switched off weeks earlier.
 *
 * Measured in production 2026-08-05 — every duplicate pair was one deactivated row plus
 * at most one live one:
 *
 *   kasra        ea2b0370 inactive (2026-06-19)  +  c855f82c active (2026-07-21)
 *   hadi-codex   54a524af inactive (2026-07-12)  +  932f5b7b active (2026-08-05)
 *   cursor       79f14bac inactive               +  af7a30b5 inactive
 *
 * So NONE of these were genuine live collisions. All three were a live agent shadowed by
 * its own tombstone, and the fix is one predicate rather than three row deletions —
 * deletions that would also have destroyed the engrams those rows own (see #705: recall
 * filters by agentId, so an agent row is a memory partition, not just a directory entry).
 *
 * WHY `!= 'inactive'` AND NOT `= 'active'`
 *
 * agents.status is CHECK (status IN ('active','paused','inactive')) — THREE states, not
 * two. `paused` is a live agent that is temporarily stopped; you address it by slug
 * precisely in order to resume, inspect or reassign it. Matching only 'active' would have
 * made every paused agent slug-unaddressable — trading one silent breakage for another.
 * Only 'inactive' is a tombstone, so only 'inactive' is excluded. (Athena, gate on #707.
 * The first version read `= 'active'` because I reasoned "the live one" instead of reading
 * the enum — the same infer-the-schema habit that #684 cost us.)
 *
 * WHAT THIS DOES AND DOES NOT NARROW — stated precisely, because the loose version of this
 * sentence was itself a gate finding. The CANDIDATE set narrows: tombstones no longer
 * count. The SUCCESS set therefore WIDENS for exactly one shape — a slug matching one live
 * row plus one or more tombstones now RESOLVES where it previously refused as ambiguous.
 * That is the entire point of the change, and it must be read as an intended widening
 * rather than hidden behind "never widens".
 *
 * The fail-closed property that is genuinely preserved is narrower and worth naming on its
 * own: a slug matching TWO OR MORE NON-TOMBSTONE agents is still refused as ambiguous. The
 * self-poisoning defect this resolver exists to prevent — an arbitrary insertion-ordered
 * row driving a capability gate and credential binding — is untouched. `cursor`, whose
 * rows are both inactive, now resolves to not_found instead of ambiguous: both are
 * refusals, and "not_found" is the truthful one for an agent nobody has activated.
 *
 * The id path is deliberately unfiltered, so a deactivated agent stays addressable by id
 * for inspection, reactivation, or engram merge.
 */
export function resolveAgentRef(
  env: Env,
  ref: string,
): Promise<ResolveResult<{ id: string; squad_id: string; slug: string; name: string }>> {
  return resolveByIdThenSlug(
    env,
    'id, squad_id, slug, name',
    'agents',
    ref,
    ` AND status != 'inactive'`,
  )
}
