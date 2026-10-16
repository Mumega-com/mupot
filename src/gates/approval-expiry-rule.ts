// src/gates/approval-expiry.ts — an unanswered gate ask expires (Hadi, org owner, 2026-10-16:
// "if one didn't answer to the approval it expires").
//
// BEFORE: a task in `review` with a gate_owner waited forever. The only exit from review is a
// verdict and nothing swept (the stall watchdog only re-wakes; it never closes).
//
// RULE (one config constant, below):
//   - a gate verdict ask and a publish ask expire 14 days after the task ENTERED review;
//   - a secret-env request expires after 30 days;
//   - elevations (10 min) and secure moments keep their own windows and are NOT touched here.
//   Slice 1 enforces the gate-verdict window (tasks in `review`). The publish and secret-env
//   windows are recorded here as the rule but their enforcement is a follow-up (see issue).
//
// ONE PREDICATE. GATE_ASK_LIVE_PREDICATE is written once and used by:
//   - the read side (Needs You approvals source, /approvals queue),
//   - the verdict WRITE (buildVerdictStatements' UPDATE ... WHERE, the chokepoint HTTP, MCP, IM,
//     harness-attested origin and office all funnel through),
//   - the sweep's candidate scan (as NOT live).
//   A reader that hides an ask the writer would still accept (or the reverse) is the defect this
//   avoids. EXPIRY IS NEVER APPROVAL: an expired ask cannot be approved; the sweep moves it to
//   `blocked`, it never writes a verdict.
//
// CLOCK. review_entered_at is stamped BY TRIGGER (migrations/0232) on every transition into
// review. updated_at is NOT the clock: stall rewakes and notices bump it.

import type { Env } from '../types'

export const APPROVAL_EXPIRY = {
  /** Gate verdict asks (tasks in `review` with a gate_owner): days after review entry. */
  gate_verdict_days: 14,
  /** Publish asks: days after review entry (enforcement is a follow-up; see module header). */
  publish_days: 14,
  /** Secret-env requests: days after request (enforcement is a follow-up; see module header). */
  secret_env_days: 30,
  /**
   * Expiries a task may suffer before a resubmission to review needs a human. MUST equal the
   * literal in the tasks_resubmit_cap trigger (migrations/0232); tests/approval-expiry.test.ts
   * pins the two together.
   */
  resubmit_cap: 2,
  /** A CI-fail bounce keeps the old clock only if the task re-enters review within this many hours. MUST equal the literal in the tasks_review_entered_stamp_update trigger (migrations/0232). */
  bounce_carry_hours: 24,
  /** Tasks transitioned per sweep invocation (bounded; the next tick takes the next batch). */
  sweep_batch: 50,
  sweep_batch_max: 200,
} as const

export const RESUBMIT_CAP_ERROR = 'resubmit_cap_needs_human'

export type ExpiryReason = 'approval_expired' | 'gate_owner_dead'

const NOW_SQL_LITERAL = /^(?:'\d{4}-\d{2}-\d{2}T[0-9:.]+Z'|datetime\('now'\)|\?\d*)$/

/**
 * SQL boolean: the gate ask on `alias` (a tasks row in review) is still LIVE — it entered review
 * less than gate_verdict_days ago. `nowSql` is an ISO literal, `datetime('now')` or a bound
 * parameter placeholder; anything else is refused so no caller string reaches the statement.
 * Live iff now < entered + window, so an ask is expired at exactly the window.
 */
export function GATE_ASK_LIVE_PREDICATE(alias: string, nowSql: string): string {
  if (!NOW_SQL_LITERAL.test(nowSql)) throw new Error('invalid_gate_ask_now_sql')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid_gate_ask_alias')
  // Expiry applies ONLY to gated asks: an ungated review task has no gate to answer and no sweep
  // would ever move it, so refusing its verdict would strand it. An unreadable time (NULL datetime)
  // counts as EXPIRED (COALESCE ... 0), never as a silent NULL that the sweep's NOT() would skip.
  return `(${alias}.gate_owner IS NULL OR ${alias}.gate_owner = '' OR COALESCE(datetime(COALESCE(${alias}.review_entered_at, ${alias}.updated_at), '+${APPROVAL_EXPIRY.gate_verdict_days} days') > datetime(${nowSql}), 0))`
}

/** The expiry timestamp for a review entry (display/receipt only; the predicate above decides). */
export function gateAskExpiresAt(reviewEnteredAt: string): string | null {
  const ms = Date.parse(reviewEnteredAt)
  return Number.isNaN(ms) ? null : new Date(ms + APPROVAL_EXPIRY.gate_verdict_days * 86_400_000).toISOString()
}

/** True when the task is in review and its ask is past the window (post-failure classification). */
export async function isGateAskExpired(env: Env, taskId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS expired FROM tasks
      WHERE id = ?1 AND status = 'review' AND NOT (${GATE_ASK_LIVE_PREDICATE('tasks', "datetime('now')")})`,
  ).bind(taskId).first()
  return row !== null
}

export function isResubmitCapError(error: unknown): boolean {
  return (error instanceof Error ? error.message : String(error)).includes(RESUBMIT_CAP_ERROR)
}

