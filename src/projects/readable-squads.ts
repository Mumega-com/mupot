import type { Env } from '../types'

function jsonIds(ids: string[]): string {
  return JSON.stringify([...new Set(ids)])
}

export async function resolveReadableSquadIds(
  env: Env,
  squadIds: string[],
  departmentIds: string[],
): Promise<string[]> {
  const rows = await env.DB.prepare(
    `SELECT id FROM squads
      WHERE id IN (SELECT CAST(value AS TEXT) FROM json_each(?1))
         OR department_id IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
      ORDER BY id`,
  ).bind(jsonIds(squadIds), jsonIds(departmentIds)).all<{ id: string }>()
  return (rows.results ?? []).map((row) => row.id)
}
