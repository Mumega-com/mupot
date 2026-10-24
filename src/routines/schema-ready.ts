import type { Env } from '../types'
import { unwrapBinding } from '../lib/server-timing'

const routineSchemaReady = new WeakSet<object>()

/**
 * True when Project Routine tables from migration 0073 exist.
 * Used by Activity/Evidence projections and Project Situation so Worker code
 * can roll out before D1 applies the Routine schema.
 */
export async function routineTablesReady(env: Env): Promise<boolean> {
  const database = unwrapBinding(env.DB as unknown as object) // raw DB identity (see projections.ts)
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
