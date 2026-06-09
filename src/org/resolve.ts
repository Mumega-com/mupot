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
): Promise<ResolveResult<T>> {
  const byId = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE id = ?1 LIMIT 1`)
    .bind(ref)
    .first<T>()
  if (byId) return { ok: true, value: byId }

  // No id match → resolve by slug, but COUNT matches; >1 is ambiguous, not "pick one".
  const bySlug = await env.DB.prepare(`SELECT ${cols} FROM ${table} WHERE slug = ?1`)
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

export function resolveAgentRef(
  env: Env,
  ref: string,
): Promise<ResolveResult<{ id: string; squad_id: string; slug: string; name: string }>> {
  return resolveByIdThenSlug(env, 'id, squad_id, slug, name', 'agents', ref)
}
