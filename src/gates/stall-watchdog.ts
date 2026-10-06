// src/gates/stall-watchdog.ts — gate-stall watchdog (mupot#1705).
//
// A task in 'review' with a gate_owner is waiting on a gate seat. The wake sent on review entry
// is best-effort: a seat can ACK it and never record a verdict (task d9f6b672: ~7.5h silent). This
// sweep notices that state and re-sends the SAME wake (wakeGateOwnerOnReview — reused, not copied),
// bounded and recorded durably.
//
// INVARIANTS
//  - Never changes task status, never writes or reverses a verdict. The only task write is the
//    gate_wake_notice column that wakeGateOwnerOnReview already owns.
//  - Wakes only whoever wakeGateOwnerOnReview resolves from the task's own gate_owner lane.
//  - At most one re-wake per task per threshold window, at most maxRewakes per review episode.
//    The bound is ONE atomic UPSERT…WHERE claim (changes === 1 wins); never read-compare-write.
//  - After the cap nothing is sent; the stall stays visible in the Needs You 'stuck' view reason
//    (src/attention/service.ts reads gate_stall_rewakes).

import type { Env, Task } from '../types'

export const DEFAULT_GATE_STALL_THRESHOLD_MINUTES = 30
export const DEFAULT_GATE_STALL_MAX_REWAKES = 3
const SWEEP_LIMIT = 50
const WATCHDOG_ID = 'mupot-gate-stall-watchdog'

export interface GateStallSweepResult {
  scanned: number
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
  const result: GateStallSweepResult = { scanned: 0, rewoken: 0, undelivered: 0, skipped_claimed: 0, errors: 0 }

  // Candidates: review + gate_owner + older than the threshold + no LIVE verdict since entering
  // review (reversed verdicts do not count; datetime() normalises 'YYYY-MM-DD HH:MM:SS' vs ISO).
  // Rows already at the cap or inside their window for this episode are filtered here too — the
  // claim below is still the authority, this just keeps the scan cheap.
  const rows = await env.DB.prepare(
    `SELECT t.* FROM tasks t
      WHERE t.status = 'review' AND t.gate_owner IS NOT NULL AND t.gate_owner <> ''
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

  const { wakeGateOwnerOnReview } = await import('../mcp')
  for (const task of rows.results ?? []) {
    result.scanned += 1
    try {
      // Atomic claim. Wins (changes === 1) only for a new episode (review_since differs) or when
      // the window has elapsed and the cap is not reached. A concurrent sweep that lost sees 0.
      const claim = await env.DB.prepare(
        `INSERT INTO gate_stall_rewakes (task_id, review_since, rewake_count, last_rewake_at)
         VALUES (?1, ?2, 1, ?3)
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
      const outcome = await wakeGateOwnerOnReview(
        env,
        task,
        { kind: 'agent', id: WATCHDOG_ID },
        WATCHDOG_ID,
      )
      // Only a wake that reached a holder counts as a re-wake. requires_human / no_live_holder /
      // ambiguous / delivery_failed spend the attempt budget but are never reported as re-wakes —
      // a counter shown to humans must count deliveries, not attempts (#1706 adversarial P1).
      const delivered = outcome.status === 'delivered' || outcome.status === 'partial'
      await env.DB.prepare(
        `UPDATE gate_stall_rewakes
            SET last_outcome = ?1,
                delivered_count = delivered_count + ?3
          WHERE task_id = ?2`,
      )
        .bind(outcome.status, task.id, delivered ? 1 : 0)
        .run()
      if (delivered) result.rewoken += 1
      else result.undelivered += 1
    } catch {
      result.errors += 1
    }
  }
  return result
}
