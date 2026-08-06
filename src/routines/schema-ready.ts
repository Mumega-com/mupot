import type { Env } from '../types'

const routineSchemaReady = new WeakSet<object>()

/**
 * True when Project Routine tables from migration 0073 exist.
 * Used by Activity/Evidence projections and Project Situation so Worker code
 * can roll out before D1 applies the Routine schema.
 */
export async function routineTablesReady(env: Env): Promise<boolean> {
  const database = env.DB as unknown as object
  if (routineSchemaReady.has(database)) return true
  const result = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('routines', 'routine_runs', 'routine_run_events', 'routine_run_actions')`,
  ).all<{ count: number }>()
  const ready = Number(result.results?.[0]?.count ?? 0) === 4
  if (ready) routineSchemaReady.add(database)
  return ready
}
