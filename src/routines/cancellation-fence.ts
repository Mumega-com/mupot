import type { Env } from '../types'

/**
 * Durable cancellation fence for Project Routines.
 *
 * A run with `cancellation_requested` and no terminal cancellation outcome must
 * not be claimed by the scheduler, dispatch, or action executor.
 */

const SQL_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/

function qualifiedRunColumns(runAlias: string): { id: string; tenant: string } {
  if (!SQL_ALIAS.test(runAlias)) throw new Error('invalid Routine run SQL alias')
  return { id: `${runAlias}.id`, tenant: `${runAlias}.tenant` }
}

/** SQL boolean expression — true when an open cancellation request fences the run. */
export function sqlCancellationPending(runAlias: string): string {
  const run = qualifiedRunColumns(runAlias)
  return `EXISTS (
    SELECT 1 FROM routine_run_events requested
     WHERE requested.run_id = ${run.id}
       AND requested.tenant = ${run.tenant}
       AND requested.kind = 'cancellation_requested'
       AND NOT EXISTS (
         SELECT 1 FROM routine_run_events outcome
          WHERE outcome.run_id = requested.run_id
            AND outcome.tenant = requested.tenant
            AND outcome.kind IN ('cancellation_confirmed', 'cancellation_unconfirmed')
       )
  )`
}

/** Inverse — safe for UPDATE ... WHERE claim guards. */
export function sqlNotCancellationPending(runAlias: string): string {
  return `NOT ${sqlCancellationPending(runAlias)}`
}

/** Runtime check for the same fence used in SQL claim guards. */
export async function isCancellationPending(
  env: Env,
  runId: string,
  tenant: string,
): Promise<boolean> {
  const event = await env.DB.prepare(
    `SELECT 1 AS ok FROM routine_run_events requested
      WHERE requested.run_id = ? AND requested.tenant = ?
        AND requested.kind = 'cancellation_requested'
        AND NOT EXISTS (
          SELECT 1 FROM routine_run_events outcome
           WHERE outcome.run_id = requested.run_id
             AND outcome.tenant = requested.tenant
             AND outcome.kind IN ('cancellation_confirmed', 'cancellation_unconfirmed')
        )
      LIMIT 1`,
  ).bind(runId, tenant).first()
  return event !== null
}
