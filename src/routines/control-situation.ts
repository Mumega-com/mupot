import type { Env } from '../types'

// Dispatch and submit must exclude the same historical controls on every attempt.
export async function controlExclusions(env: Env, run: { id: string; tenant: string; task_id: string | null; flight_id: string | null }): Promise<{
  excludeTaskIds: string[]
  excludeFlightIds: string[]
  excludeMessageIds: string[]
}> {
  const refs = await env.DB.prepare(
    `SELECT ref_type, ref_id FROM routine_run_refs
      WHERE run_id = ? AND tenant = ? AND ref_type IN ('task','flight','message')`,
  ).bind(run.id, run.tenant).all<{ ref_type: string; ref_id: string }>()
  const rows = refs.results ?? []
  return {
    excludeTaskIds: [...new Set([run.task_id, ...rows.filter(row => row.ref_type === 'task').map(row => row.ref_id)].filter(Boolean) as string[])],
    excludeFlightIds: [...new Set([run.flight_id, ...rows.filter(row => row.ref_type === 'flight').map(row => row.ref_id)].filter(Boolean) as string[])],
    excludeMessageIds: [...new Set(rows.filter(row => row.ref_type === 'message').map(row => row.ref_id))],
  }
}
