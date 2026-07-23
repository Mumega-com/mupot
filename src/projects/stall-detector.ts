// Project lifecycle stall detector (slice 4) — idle → stalled flag → early breaker.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// ECC loop-status pattern: detection → decision, never detection → auto-fix.
// Each poll computes idle-duration per active project from AUTHENTICATED progress
// receipts / state-transition events (not mutable task metadata). Past
// stall_threshold_days (NULL = tenant default) sets projects.stalled=1.
// Fresh activity clears the flag. The flag alone never archives — it only
// raises the slice-1 circuit-breaker check early.

import type { Env, Project } from '../types'

/** Tenant default when projects.stall_threshold_days is NULL. */
export const DEFAULT_STALL_THRESHOLD_DAYS = 14

export const STALL_DETECTOR_PRINCIPAL = 'system:project-loop'

export type StallDetectorOutcome = 'skipped' | 'flagged' | 'cleared' | 'unchanged' | 'quarantined'

export interface ProjectIdleSignals {
  /** Newest authenticated task status-transition / dispatch / verdict / workflow receipt. */
  newest_progress_receipt_at: string | null
  newest_flight_event_at: string | null
  newest_evidence_at: string | null
}

export type SetProjectStalledFn = (
  env: Env,
  projectId: string,
  stalled: 0 | 1,
  nowIso: string,
) => Promise<void>

export type LoadIdleSignalsFn = (env: Env, projectId: string) => Promise<ProjectIdleSignals>

export interface StallDetectorDeps {
  loadIdleSignals: LoadIdleSignalsFn
  setStalled: SetProjectStalledFn
  /** Tenant default threshold when project.stall_threshold_days is NULL. */
  defaultThresholdDays: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Resolve effective threshold: per-project override, else tenant default.
 * Non-finite or negative values are rejected.
 */
export function resolveStallThresholdDays(
  stallThresholdDays: number | null,
  defaultThresholdDays: number,
): number {
  if (!Number.isFinite(defaultThresholdDays) || defaultThresholdDays < 0) {
    throw new Error('invalid_default_stall_threshold_days')
  }
  if (stallThresholdDays === null) return defaultThresholdDays
  if (!Number.isFinite(stallThresholdDays) || stallThresholdDays < 0) {
    throw new Error('invalid_stall_threshold_days')
  }
  return stallThresholdDays
}

/**
 * Parse a candidate activity timestamp as canonical UTC.
 * Returns null for empty/invalid input. Future timestamps are rejected
 * (fail-closed) so they cannot suppress stall detection.
 */
export function parseActivityUtcMs(candidate: string, nowMs: number): number | null {
  const trimmed = candidate.trim()
  if (trimmed === '') return null
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return null
  if (ms > nowMs) return null
  return ms
}

/** Max ISO timestamp among candidates; null if none parse as non-future UTC. */
export function newestIso(
  candidates: ReadonlyArray<string | null>,
  nowIso: string,
): string | null {
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) {
    throw new Error('invalid_now_iso')
  }
  let bestMs = Number.NEGATIVE_INFINITY
  let bestIso: string | null = null
  for (const candidate of candidates) {
    if (candidate === null || candidate.trim() === '') continue
    const ms = parseActivityUtcMs(candidate, nowMs)
    if (ms === null) continue
    if (ms >= bestMs) {
      bestMs = ms
      bestIso = new Date(ms).toISOString()
    }
  }
  return bestIso
}

/**
 * Idle duration in days from last activity to now.
 * When no activity signals exist, falls back to projectCreatedAt (active but quiet).
 * Future baselines fail closed.
 */
export function idleDurationDays(
  lastActivityIso: string | null,
  projectCreatedAt: string,
  nowIso: string,
): number {
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) {
    throw new Error('invalid_now_iso')
  }
  const baseline = lastActivityIso ?? projectCreatedAt
  const lastMs = parseActivityUtcMs(baseline, nowMs)
  if (lastMs === null) {
    throw new Error('invalid_last_activity_iso')
  }
  return (nowMs - lastMs) / MS_PER_DAY
}

/** True when idle strictly exceeds the threshold ("past" the threshold). */
export function isPastStallThreshold(idleDays: number, thresholdDays: number): boolean {
  if (!Number.isFinite(idleDays) || !Number.isFinite(thresholdDays)) {
    throw new Error('invalid_stall_comparison')
  }
  return idleDays > thresholdDays
}

export function lastActivityFromSignals(
  signals: ProjectIdleSignals,
  nowIso: string,
): string | null {
  return newestIso(
    [
      signals.newest_progress_receipt_at,
      signals.newest_flight_event_at,
      signals.newest_evidence_at,
    ],
    nowIso,
  )
}

/**
 * Load authenticated progress signals for one project.
 * Deliberately excludes tasks.updated_at (title/body churn is forgeable).
 * Progress = dispatch receipts, workflow receipts, gate verdicts, flight landings,
 * and completed_at on done tasks with non-empty result evidence.
 */
export async function loadProjectIdleSignals(
  env: Env,
  projectId: string,
): Promise<ProjectIdleSignals> {
  const [progressRow, flightRow, evidenceRow] = await Promise.all([
    env.DB.prepare(
      `SELECT MAX(ts) AS newest FROM (
         SELECT MAX(d.created_at) AS ts
           FROM task_dispatch_receipts d
           JOIN tasks t ON t.id = d.task_id
          WHERE t.project_id = ?1
         UNION ALL
         SELECT MAX(w.created_at) AS ts
           FROM workflow_receipts w
           JOIN tasks t ON t.id = w.task_id
          WHERE t.project_id = ?1
         UNION ALL
         SELECT MAX(v.decided_at) AS ts
           FROM task_verdicts v
           JOIN tasks t ON t.id = v.task_id
          WHERE t.project_id = ?1
       )`,
    )
      .bind(projectId)
      .first<{ newest: string | null }>(),
    env.DB.prepare(
      `SELECT MAX(created_at) AS newest
         FROM flight_event_outbox
        WHERE project_id = ?1
          AND actor_kind IN ('member', 'agent')
          AND length(trim(actor_id)) > 0`,
    )
      .bind(projectId)
      .first<{ newest: string | null }>(),
    env.DB.prepare(
      `SELECT MAX(completed_at) AS newest
         FROM tasks
        WHERE project_id = ?1
          AND status = 'done'
          AND completed_at IS NOT NULL
          AND result IS NOT NULL
          AND length(trim(result)) > 0`,
    )
      .bind(projectId)
      .first<{ newest: string | null }>(),
  ])

  return {
    newest_progress_receipt_at: progressRow?.newest ?? null,
    newest_flight_event_at: flightRow?.newest ?? null,
    newest_evidence_at: evidenceRow?.newest ?? null,
  }
}

export async function setProjectStalledFlag(
  env: Env,
  projectId: string,
  stalled: 0 | 1,
  nowIso: string,
): Promise<void> {
  if (stalled !== 0 && stalled !== 1) {
    throw new Error('invalid_stalled_flag')
  }
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) {
    throw new Error('invalid_now_iso')
  }
  const result = await env.DB.prepare(
    `UPDATE projects
        SET stalled = ?1, updated_at = ?2
      WHERE id = ?3
        AND stalled <> ?1`,
  )
    .bind(stalled, new Date(nowMs).toISOString(), projectId)
    .run()
  if (!result.success) {
    throw new Error('stall_flag_update_failed')
  }
}

export function defaultStallDetectorDeps(): StallDetectorDeps {
  return {
    loadIdleSignals: loadProjectIdleSignals,
    setStalled: setProjectStalledFlag,
    defaultThresholdDays: DEFAULT_STALL_THRESHOLD_DAYS,
  }
}

/**
 * Detection only: set or clear projects.stalled. Never archives.
 * Future / unparseable activity baselines quarantine (treat as stalled).
 */
export async function evaluateProjectStall(
  env: Env,
  project: Pick<Project, 'id' | 'status' | 'created_at' | 'stalled' | 'stall_threshold_days'>,
  nowIso: string,
  deps: StallDetectorDeps,
): Promise<StallDetectorOutcome> {
  if (project.status !== 'active') return 'skipped'

  const thresholdDays = resolveStallThresholdDays(
    project.stall_threshold_days,
    deps.defaultThresholdDays,
  )
  const signals = await deps.loadIdleSignals(env, project.id)
  const lastActivity = lastActivityFromSignals(signals, nowIso)

  let idleDays: number
  try {
    idleDays = idleDurationDays(lastActivity, project.created_at, nowIso)
  } catch {
    // Fail-closed: unparseable / future baseline → treat as stalled.
    if (project.stalled !== 1) {
      await deps.setStalled(env, project.id, 1, nowIso)
      return 'quarantined'
    }
    return 'unchanged'
  }

  const shouldStall = isPastStallThreshold(idleDays, thresholdDays)
  const nextFlag: 0 | 1 = shouldStall ? 1 : 0
  const currentFlag: 0 | 1 = project.stalled === 1 ? 1 : 0

  if (nextFlag === currentFlag) return 'unchanged'

  await deps.setStalled(env, project.id, nextFlag, nowIso)
  return nextFlag === 1 ? 'flagged' : 'cleared'
}
