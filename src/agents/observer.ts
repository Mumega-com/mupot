// mupot — goal-loop meta-observer (S2 sane-brain anti-spam spine).
//
// The observer durably tracks per-(tenant, agent) cycle outcomes and surfaces
// two signals back to AgentDO:
//
//   cooldown  — too many consecutive no-ops → extend the next alarm window.
//               The agent rests until there is something new to do, rather than
//               burning a model call on the same empty situation every 15 min.
//
//   escalate  — consecutive failures OR liveness failures crossed a threshold →
//               operator attention needed. Escalation is ONE-SHOT (deduped via
//               last_escalated_at + ESCALATION_COOLDOWN_MS): the same stuck state
//               does not flood the operator on every tick.
//
// Outcome shape follows the natural cycle lifecycle:
//   'spawned'        — at least one task was created; productive tick; reset counters.
//   'deduped'        — fingerprint already reserved; counted as a noop.
//   'rate_limited'   — meter blocked; counted as noop (not a failure).
//   'budget_exhausted' — dollar cap hit; counted as noop.
//   'observe-only'   — effort=low; counted as noop.
//   'no-goal'        — agent has no OKR; observer is a no-op (nothing to observe).
//   'kpi-met'        — goal reached; observer is a no-op.
//   'liveness_fail'  — agent row not found or paused; counted as liveness failure.
//   'error'          — unhandled exception in the cycle; counted as failure.

import type { Env, Agent } from '../types'

// ── Thresholds (named constants — no magic numbers) ───────────────────────────

/** Consecutive no-op ticks before triggering a cooldown extension. */
export const NOOP_COOLDOWN_THRESHOLD = 6

/** Consecutive error/exception ticks before triggering an escalation. */
export const FAIL_ESCALATION_THRESHOLD = 3

/** Cumulative liveness failures before triggering an escalation. */
export const LIVENESS_ESCALATION_THRESHOLD = 3

/** How long (ms) to extend the alarm when cooling down. */
export const COOLDOWN_EXTENSION_MS = 30 * 60 * 1000 // 30 minutes

/** Minimum interval (ms) between escalations for the same agent. */
export const ESCALATION_COOLDOWN_MS = 60 * 60 * 1000 // 1 hour — dedup window

// ── Outcome type ──────────────────────────────────────────────────────────────

export type ObserverOutcome =
  | 'spawned'
  | 'deduped'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'observe-only'
  | 'no-goal'
  | 'kpi-met'
  | 'liveness_fail'
  | 'error'

// ── Observer result ───────────────────────────────────────────────────────────

export interface ObserveResult {
  /** When true, AgentDO should extend the next alarm by COOLDOWN_EXTENSION_MS. */
  cooldown: boolean
  /** When true, a single operator escalation signal should be emitted. */
  escalate: boolean
  /** Human-readable reason string for the signal (for logging / result telemetry). */
  reason?: string
}

// ── Row shape (matches loop_observer table) ───────────────────────────────────

interface ObserverRow {
  consecutive_noops: number
  consecutive_fails: number
  liveness_fails: number
  last_escalated_at: string | null
  cooldown_until: string | null
}

// ── observe ───────────────────────────────────────────────────────────────────

/**
 * observe — record the outcome of one goal-cycle tick for (tenant, agent) and
 * return the cooldown + escalate signals.
 *
 * Durably updates loop_observer counters via a single UPSERT per call.
 * Escalation is deduped: escalate=true is returned at most once per
 * ESCALATION_COOLDOWN_MS, so the operator receives ONE signal per stuck state,
 * not one per tick.
 *
 * AgentDO consumes:
 *   cooldown  → extend the next alarm (back off; don't busy-loop)
 *   escalate  → emit a single operator notification via existing approval/notification
 *               seam. TODO: wire the actual emit in AgentDO (see agent-do.ts).
 *
 * The `now` parameter is injectable for determinism in tests.
 */
export async function observe(
  env: Env,
  agent: Agent,
  outcome: ObserverOutcome,
  now?: string,
): Promise<ObserveResult> {
  const tenant = env.TENANT_SLUG
  const nowStr = now ?? new Date().toISOString()

  // No-ops for terminal or benign states — nothing to count.
  if (outcome === 'no-goal' || outcome === 'kpi-met') {
    return { cooldown: false, escalate: false }
  }

  // Read existing row (may be null on first cycle).
  const existing = await env.DB.prepare(
    `SELECT consecutive_noops, consecutive_fails, liveness_fails, last_escalated_at, cooldown_until
       FROM loop_observer
      WHERE tenant = ? AND agent_id = ?
      LIMIT 1`,
  )
    .bind(tenant, agent.id)
    .first<ObserverRow>()

  const prev: ObserverRow = existing ?? {
    consecutive_noops: 0,
    consecutive_fails: 0,
    liveness_fails: 0,
    last_escalated_at: null,
    cooldown_until: null,
  }

  // ── Compute new counter values based on outcome ──────────────────────────────

  let consecutive_noops = prev.consecutive_noops
  let consecutive_fails = prev.consecutive_fails
  let liveness_fails = prev.liveness_fails

  switch (outcome) {
    case 'spawned':
      // Productive tick → reset all counters. Agent is healthy.
      consecutive_noops = 0
      consecutive_fails = 0
      liveness_fails = 0
      break

    case 'deduped':
    case 'rate_limited':
    case 'budget_exhausted':
    case 'observe-only':
      // Non-productive but non-failing ticks → increment noop counter only.
      consecutive_noops += 1
      // Do NOT increment fail counters — these are governed/expected states.
      break

    case 'error':
      // Unhandled exception → failure counter.
      consecutive_fails += 1
      consecutive_noops += 1 // also a noop (no work spawned)
      break

    case 'liveness_fail':
      // Agent row missing or paused — the worst signal.
      liveness_fails += 1
      consecutive_fails += 1
      consecutive_noops += 1
      break
  }

  // ── Determine signals ────────────────────────────────────────────────────────

  const cooldown = consecutive_noops >= NOOP_COOLDOWN_THRESHOLD

  const shouldEscalate =
    consecutive_fails >= FAIL_ESCALATION_THRESHOLD ||
    liveness_fails >= LIVENESS_ESCALATION_THRESHOLD

  // Dedup: only escalate if we haven't escalated recently.
  const lastEscalated = prev.last_escalated_at ? new Date(prev.last_escalated_at).getTime() : 0
  const nowMs = new Date(nowStr).getTime()
  const escalateCooldownExpired = nowMs - lastEscalated >= ESCALATION_COOLDOWN_MS
  const escalate = shouldEscalate && escalateCooldownExpired

  // ── Compute cooldown_until ────────────────────────────────────────────────────

  const cooldown_until = cooldown
    ? new Date(nowMs + COOLDOWN_EXTENSION_MS).toISOString()
    : null

  // ── Persist updated counters ──────────────────────────────────────────────────

  const last_escalated_at = escalate ? nowStr : prev.last_escalated_at

  await env.DB.prepare(
    `INSERT INTO loop_observer
       (tenant, agent_id, consecutive_noops, consecutive_fails, liveness_fails,
        last_escalated_at, cooldown_until, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant, agent_id) DO UPDATE SET
         consecutive_noops  = excluded.consecutive_noops,
         consecutive_fails  = excluded.consecutive_fails,
         liveness_fails     = excluded.liveness_fails,
         last_escalated_at  = excluded.last_escalated_at,
         cooldown_until     = excluded.cooldown_until,
         updated_at         = excluded.updated_at`,
  )
    .bind(
      tenant,
      agent.id,
      consecutive_noops,
      consecutive_fails,
      liveness_fails,
      last_escalated_at ?? null,
      cooldown_until,
      nowStr,
    )
    .run()

  // ── Build reason string ───────────────────────────────────────────────────────

  let reason: string | undefined
  if (escalate) {
    const parts: string[] = []
    if (consecutive_fails >= FAIL_ESCALATION_THRESHOLD) {
      parts.push(`consecutive_fails=${consecutive_fails}`)
    }
    if (liveness_fails >= LIVENESS_ESCALATION_THRESHOLD) {
      parts.push(`liveness_fails=${liveness_fails}`)
    }
    reason = `escalate: ${parts.join(', ')}`
  } else if (cooldown) {
    reason = `cooldown: consecutive_noops=${consecutive_noops}`
  }

  return { cooldown, escalate, reason }
}
