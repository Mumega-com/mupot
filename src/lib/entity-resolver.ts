// mupot — entity ID & short-UUID prefix resolver.
//
// Allows tools, APIs, and operators to pass full UUIDs or short (>=8 char) unique prefixes
// for agents, squads, tasks, and flights.
//
// Fail-closed guarantee:
//   - Input < 8 characters (and not exact full string) -> returns null (not found)
//   - Ambiguous prefix matching > 1 row -> returns 'ambiguous' (with candidate IDs)
//   - Zero matches -> returns null
//   - Exactly 1 match -> returns full row

import type { Env, Agent, Squad, Task } from '../types'
import type { FlightRow } from '../flight/service'

export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/([%_\\])/g, '\\$1')
}

export type EntityResolution<T> =
  | { ok: true; entity: T }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; candidates: string[] }

export type AllowedEntityTable = 'agents' | 'squads' | 'tasks' | 'flights'

export async function resolveEntity<T extends { id: string }>(
  env: Env,
  table: AllowedEntityTable,
  ref: string,
  extraWhere = '',
  extraBinds: unknown[] = [],
): Promise<EntityResolution<T>> {
  const trimmed = ref.trim()
  if (!trimmed) return { ok: false, reason: 'not_found' }

  // 1. Exact match fast path
  const exactQuery = `SELECT * FROM ${table} WHERE id = ?1 ${extraWhere} LIMIT 1`
  const exact = await env.DB.prepare(exactQuery).bind(trimmed, ...extraBinds).first<T>()
  if (exact) {
    return { ok: true, entity: exact }
  }

  // 2. Short prefix lookup (minimum 8 characters for uniqueness)
  if (trimmed.length < 8) {
    return { ok: false, reason: 'not_found' }
  }

  const prefixQuery = `SELECT * FROM ${table} WHERE id LIKE ?1 ESCAPE '\\' ${extraWhere} LIMIT 5`
  const prefixLike = `${escapeLikePrefix(trimmed)}%`
  const rows = await env.DB.prepare(prefixQuery).bind(prefixLike, ...extraBinds).all<T>()
  const results = rows.results ?? []

  if (results.length === 0) {
    return { ok: false, reason: 'not_found' }
  }
  if (results.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: results.map((r) => r.id),
    }
  }

  return { ok: true, entity: results[0] }
}

export async function resolveAgentEntity(env: Env, ref: string): Promise<EntityResolution<Agent>> {
  return resolveEntity<Agent>(env, 'agents', ref)
}

export async function resolveSquadEntity(env: Env, ref: string): Promise<EntityResolution<Squad>> {
  return resolveEntity<Squad>(env, 'squads', ref)
}

export async function resolveTaskEntity(env: Env, ref: string): Promise<EntityResolution<Task>> {
  return resolveEntity<Task>(env, 'tasks', ref)
}

export async function resolveFlightEntity(env: Env, ref: string): Promise<EntityResolution<FlightRow>> {
  return resolveEntity<FlightRow>(env, 'flights', ref, 'AND tenant = ?2', [env.TENANT_SLUG])
}
