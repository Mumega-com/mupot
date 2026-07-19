import type { Env } from '../types'

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
