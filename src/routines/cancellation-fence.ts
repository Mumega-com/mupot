import type { Env } from '../types'

/**
 * Durable cancellation fence for Project Routines.
 *
 * A run with `cancellation_requested` and no terminal cancellation outcome must
 * not be claimed by the scheduler, dispatch, or action executor.
 */

/** SQL boolean expression — true when an open cancellation request fences the run. */
export function sqlCancellationPending(runIdSql: string, tenantSql: string): string {
  return `EXISTS (
    SELECT 1 FROM routine_run_events requested
     WHERE requested.run_id = ${runIdSql}
       AND requested.tenant = ${tenantSql}
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
export function sqlNotCancellationPending(runIdSql: string, tenantSql: string): string {
  return `NOT ${sqlCancellationPending(runIdSql, tenantSql)}`
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
