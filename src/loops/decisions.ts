// mupot — loop_decisions + loop_controls service (S-BRAIN-CTRL-MUPOT-1).
//
// loop_decisions: persist each cycle outcome so the /brain panel has a feed to
// render. The runtime writes one row per cycle; the API reads them back newest-first.
//
// loop_controls: governor signal table. An admin POSTs a control action (pause|kill|
// budget_override) through the /brain panel; the driver reads it BEFORE each cycle
// and honors it (pause → setLoopStatus; kill → setLoopStatus done; budget_override →
// overrides cap_micro_usd for that cycle). After acting, the driver deletes the
// control row so the signal is self-clearing (one-shot, not sticky).
//
// Builder's choice (§5 loop_control table vs loops.status): a separate table is used
// because (a) it gives an audit trail of who issued the control signal and when,
// (b) it avoids a race where setLoopStatus written mid-tick conflicts with the
// running loop reading its own status field, and (c) the governor intent ("pause this
// next cycle") is semantically different from the durable state ("loop is paused").
// loops.status remains the canonical lifecycle state; loop_controls is the signal
// channel the governor uses to request a transition.

import type { Env } from '../types'
import type { LoopCycleResult } from './runtime'

// ── loop_decisions ────────────────────────────────────────────────────────────

export interface LoopDecisionRow {
  id: string
  loop_id: string
  tenant: string
  cycle_num: number
  decided: string
  perceived: number
  acted: number
  gated: number
  kpi: number
  error: string | null
  capability_descriptor: string | null
  recorded_at: string
}

/**
 * appendLoopDecision — write one cycle outcome row.
 *
 * cycle_num is passed in from the driver (it tracks the count so this function
 * stays a pure write, no read-before-write needed).
 *
 * capability_descriptor is a stub for E-BRAIN-CONTROL §12 tier-awareness. When the
 * loop's owning agent model is known, pass a JSON string; for now the driver passes
 * null until the runtime is wired to load the owner's model field (P3).
 */
export async function appendLoopDecision(
  env: Env,
  loopId: string,
  cycleNum: number,
  result: LoopCycleResult,
  capabilityDescriptor: string | null = null,
): Promise<void> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO loop_decisions
       (id, loop_id, tenant, cycle_num, decided, perceived, acted, gated, kpi, error, capability_descriptor, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      loopId,
      env.TENANT_SLUG,
      cycleNum,
      result.decided,
      result.perceived,
      result.acted,
      result.gated,
      result.kpi,
      result.error ?? null,
      capabilityDescriptor,
      now,
    )
    .run()
}

/**
 * listLoopDecisions — tenant-scoped, newest-first feed for one loop.
 *
 * limit defaults to 50; offset allows pagination (GET ?limit=&offset=).
 * The feed is scoped by BOTH loop_id AND tenant so a mis-scoped call can never
 * read another tenant's decisions even if loop_id were guessable.
 */
export async function listLoopDecisions(
  env: Env,
  loopId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<LoopDecisionRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200)
  const offset = opts.offset ?? 0
  const rows = await env.DB.prepare(
    `SELECT id, loop_id, tenant, cycle_num, decided, perceived, acted, gated, kpi, error, capability_descriptor, recorded_at
       FROM loop_decisions
      WHERE loop_id = ? AND tenant = ?
      ORDER BY recorded_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(loopId, env.TENANT_SLUG, limit, offset)
    .all<LoopDecisionRow>()
  return rows.results ?? []
}

// ── loop_controls ─────────────────────────────────────────────────────────────

export type LoopControlAction = 'pause' | 'kill' | 'budget_override'

export interface LoopControlRow {
  loop_id: string
  tenant: string
  action: LoopControlAction
  value: string | null
  issued_by: string
  issued_at: string
}

/**
 * setLoopControl — upsert a governor control signal. The driver picks it up on
 * the next cycle. Tenant is always env-derived; loop_id must be validated by the
 * caller (it's an admin-gated endpoint so the loop must belong to this tenant).
 */
export async function setLoopControl(
  env: Env,
  loopId: string,
  action: LoopControlAction,
  issuedBy: string,
  value: string | null = null,
): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO loop_controls (loop_id, tenant, action, value, issued_by, issued_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(loop_id) DO UPDATE SET
       action = excluded.action,
       value  = excluded.value,
       issued_by = excluded.issued_by,
       issued_at = excluded.issued_at`,
  )
    .bind(loopId, env.TENANT_SLUG, action, value, issuedBy, now)
    .run()
}

/**
 * getLoopControl — read the pending control signal for a loop (if any).
 * Returns null when no pending signal exists.
 */
export async function getLoopControl(env: Env, loopId: string): Promise<LoopControlRow | null> {
  const row = await env.DB.prepare(
    `SELECT loop_id, tenant, action, value, issued_by, issued_at
       FROM loop_controls WHERE loop_id = ? AND tenant = ? LIMIT 1`,
  )
    .bind(loopId, env.TENANT_SLUG)
    .first<LoopControlRow>()
  return row ?? null
}

/**
 * clearLoopControl — delete the pending signal after the driver has honored it.
 * Best-effort (non-fatal if the row was already gone).
 */
export async function clearLoopControl(env: Env, loopId: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM loop_controls WHERE loop_id = ? AND tenant = ?`,
  )
    .bind(loopId, env.TENANT_SLUG)
    .run()
}

/**
 * isLoopControlAction — type guard for the action values.
 */
export function isLoopControlAction(v: unknown): v is LoopControlAction {
  return v === 'pause' || v === 'kill' || v === 'budget_override'
}
