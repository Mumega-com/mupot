// mupot — durable two-phase receipt for elevated mutations (PR #1831 review F2).
//
// pending  : INSERTed AFTER authorization passes and BEFORE the mutation.
// applied  : flipped in the SAME D1 batch as the mutation where the write path is
//            a prepared statement we control (appliedReceiptStatement), else
//            flipped immediately after the mutation returns.
// failed   : the mutation was refused or threw; carries the error code.
// A row left 'pending' is never silently dropped: elevation_status reports rows
// older than STUCK_RECEIPT_MS as stuck_receipts.
//
// Deliberately dependency-free (types only) so src/projects and src/hygiene can
// build the in-batch flip without importing the auth layer.

import type { Env } from '../types'

export const STUCK_RECEIPT_MS = 10 * 60 * 1000

export interface ElevationReceiptGrant {
  id: string
  agent_session_id: string
  action: string
}

/** INSERT the pending row. Throws on failure: the caller must NOT attempt the mutation. */
export async function beginElevationReceipt(
  env: Env,
  tenant: string,
  grant: ElevationReceiptGrant,
  toolName: string,
  detail: unknown,
  nowMs: number = Date.now(),
): Promise<string> {
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO elevation_usage_log (id, tenant, elevation_grant_id, agent_session_id, action, tool_name, detail_json, occurred_at, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')`,
  )
    .bind(id, tenant, grant.id, grant.agent_session_id, grant.action, toolName, detail === undefined ? null : JSON.stringify(detail), new Date(nowMs).toISOString())
    .run()
  return id
}

/** The pending->applied flip as a batchable statement. `guardSql` (with `?N` binds
 *  starting at ?3) must hold ONLY when the mutation in the same batch really wrote,
 *  so a lost compare-and-set never produces an 'applied' row. */
export function appliedReceiptStatement(env: Env, receiptId: string, guardSql: string, guardBinds: readonly unknown[]): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE elevation_usage_log SET status = 'applied', resolved_at = ?2
      WHERE id = ?1 AND status = 'pending' AND EXISTS (${guardSql})`,
  ).bind(receiptId, new Date().toISOString(), ...guardBinds)
}

/** Resolve outside a batch. Only ever moves a row out of 'pending'. Retried once. */
export async function finishElevationReceipt(
  env: Env,
  receiptId: string,
  outcome: { status: 'applied' } | { status: 'failed'; errorCode: string },
): Promise<void> {
  const run = () =>
    env.DB.prepare(
      `UPDATE elevation_usage_log SET status = ?2, error_code = ?3, resolved_at = ?4 WHERE id = ?1 AND status = 'pending'`,
    )
      .bind(receiptId, outcome.status, outcome.status === 'failed' ? outcome.errorCode : null, new Date().toISOString())
      .run()
  try {
    await run()
  } catch {
    await run()
  }
}

export interface StuckReceipt {
  id: string
  elevation_grant_id: string
  tool_name: string | null
  detail_json: string | null
  occurred_at: string
}

/** Pending receipts of one agent session older than STUCK_RECEIPT_MS. */
export async function listStuckReceipts(env: Env, tenant: string, agentSessionId: string, nowMs: number = Date.now()): Promise<StuckReceipt[]> {
  const cutoff = new Date(nowMs - STUCK_RECEIPT_MS).toISOString()
  const rows = await env.DB.prepare(
    `SELECT id, elevation_grant_id, tool_name, detail_json, occurred_at FROM elevation_usage_log
      WHERE tenant = ?1 AND agent_session_id = ?2 AND status = 'pending' AND occurred_at < ?3
      ORDER BY occurred_at ASC LIMIT 100`,
  )
    .bind(tenant, agentSessionId, cutoff)
    .all<StuckReceipt>()
  return rows.results ?? []
}
