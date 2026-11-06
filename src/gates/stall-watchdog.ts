// src/gates/stall-watchdog.ts — gate-stall watchdog (mupot#1705).
//
// Review entry owns the first gate wake. Later stalls only update the bounded,
// durable watchdog ledger and log; Needs You keeps the aged review visible.
// Task status, verdicts, the initial wake and its gate-holder resolution are unchanged.

import type { Env, Task } from '../types'
import { TASK_NOT_ARCHIVED_SQL } from '../hygiene/filters'
import { safeConsole } from '../lib/log'

export const DEFAULT_GATE_STALL_THRESHOLD_MINUTES = 30
export const DEFAULT_GATE_STALL_MAX_REWAKES = 3
const SWEEP_LIMIT = 50
const WATCHDOG_ID = 'mupot-gate-stall-watchdog'

export interface GateStallSweepResult {
  scanned: number
  recorded: number
  rewoken: number
  undelivered: number
  skipped_claimed: number
  errors: number
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}

export async function sweepStalledGateReviews(env: Env, now: Date = new Date()): Promise<GateStallSweepResult> {
  const thresholdMin = positiveInt(env.GATE_STALL_THRESHOLD_MINUTES, DEFAULT_GATE_STALL_THRESHOLD_MINUTES)
  const maxRewakes = positiveInt(env.GATE_STALL_MAX_REWAKES, DEFAULT_GATE_STALL_MAX_REWAKES)
  const nowIso = now.toISOString()
  const cutoffIso = new Date(now.getTime() - thresholdMin * 60_000).toISOString()
  const result: GateStallSweepResult = { scanned: 0, recorded: 0, rewoken: 0, undelivered: 0, skipped_claimed: 0, errors: 0 }

  // Candidates: review + gate_owner + older than the threshold + no LIVE verdict since entering
  // review (reversed verdicts do not count; datetime() normalises 'YYYY-MM-DD HH:MM:SS' vs ISO).
  // Rows already at the cap or inside their window for this episode are filtered here too — the
  // claim below is still the authority, this just keeps the scan cheap.
  const rows = await env.DB.prepare(
    `SELECT t.* FROM tasks t
      WHERE t.status = 'review' AND t.gate_owner IS NOT NULL AND t.gate_owner <> ''
        AND ${TASK_NOT_ARCHIVED_SQL('t')}
        AND datetime(t.updated_at) <= datetime(?1)
        AND NOT EXISTS (
          SELECT 1 FROM task_verdicts v
           WHERE v.task_id = t.id AND v.reversed_at IS NULL
             AND datetime(v.decided_at) >= datetime(t.updated_at))
        AND NOT EXISTS (
          SELECT 1 FROM gate_stall_rewakes g
           WHERE g.task_id = t.id AND g.review_since = t.updated_at
             AND (g.rewake_count >= ?2 OR datetime(g.last_rewake_at) > datetime(?1)))
      ORDER BY t.updated_at ASC
      LIMIT ?3`,
  ).bind(cutoffIso, maxRewakes, SWEEP_LIMIT).all<Task>()

  for (const task of rows.results ?? []) {
    result.scanned += 1
    try {
      // Atomic claim. Wins (changes === 1) only for a new episode (review_since differs) or when
      // the window has elapsed and the cap is not reached. A concurrent sweep that lost sees 0.
      const claim = await env.DB.prepare(
        `INSERT INTO gate_stall_rewakes (task_id, review_since, rewake_count, last_rewake_at)
         SELECT ?1, ?2, 1, ?3
          WHERE NOT EXISTS (SELECT 1 FROM tasks_archive_state WHERE tasks_archive_state.task_id = ?1)  -- mupot#1783: no ledger row for an archived task
         ON CONFLICT(task_id) DO UPDATE SET
           rewake_count = CASE WHEN gate_stall_rewakes.review_since <> excluded.review_since
                               THEN 1 ELSE gate_stall_rewakes.rewake_count + 1 END,
           delivered_count = CASE WHEN gate_stall_rewakes.review_since <> excluded.review_since
                                  THEN 0 ELSE gate_stall_rewakes.delivered_count END,
           review_since = excluded.review_since,
           last_rewake_at = excluded.last_rewake_at
         WHERE gate_stall_rewakes.review_since <> excluded.review_since
            OR (gate_stall_rewakes.rewake_count < ?4
                AND datetime(gate_stall_rewakes.last_rewake_at) <= datetime(?5))`,
      ).bind(task.id, task.updated_at, nowIso, maxRewakes, cutoffIso).run()
      if ((claim.meta?.changes ?? 0) !== 1) {
        result.skipped_claimed += 1
        continue
      }
      await env.DB.prepare(`UPDATE gate_stall_rewakes SET last_outcome='logged_no_mail' WHERE task_id=?1`)
        .bind(task.id).run()
      result.recorded += 1
      safeConsole.info('[gate-stall]', { actor: WATCHDOG_ID, task_id: task.id, review_since: task.updated_at, outcome: 'logged_no_mail' })
    } catch {
      result.errors += 1
    }
  }
  return result
}
