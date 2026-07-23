// Project lifecycle stall detector (slice 4) — idle → stalled flag → early breaker.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// ECC loop-status pattern: detection → decision, never detection → auto-fix.
// Each poll computes idle-duration per active project as the max of:
//   newest task activity, newest flight event, newest evidence.
// Past stall_threshold_days (NULL = tenant default) sets projects.stalled=1.
// Fresh activity clears the flag. The flag alone never archives — it only
// raises the slice-1 circuit-breaker check early.

import type { Env, Project } from '../types'

/** Tenant default when projects.stall_threshold_days is NULL. */
export const DEFAULT_STALL_THRESHOLD_DAYS = 14

export const STALL_DETECTOR_PRINCIPAL = 'system:project-loop'

export type StallDetectorOutcome = 'skipped' | 'flagged' | 'cleared' | 'unchanged'

export interface ProjectIdleSignals {
  newest_task_activity_at: string | null
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

/** Max ISO timestamp among candidates; null if none parse. */
export function newestIso(candidates: ReadonlyArray<string | null>): string | null {
  let bestMs = Number.NEGATIVE_INFINITY
  let bestIso: string | null = null
  for (const candidate of candidates) {
    if (candidate === null || candidate.trim() === '') continue
    const ms = Date.parse(candidate)
    if (Number.isNaN(ms)) continue
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
 */
export function idleDurationDays(
  lastActivityIso: string | null,
  projectCreatedAt: string,
  nowIso: string,
): number {
  const baseline = lastActivityIso ?? projectCreatedAt
  const lastMs = Date.parse(baseline)
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(lastMs)) {
    throw new Error('invalid_last_activity_iso')
  }
  if (Number.isNaN(nowMs)) {
    throw new Error('invalid_now_iso')
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

export function lastActivityFromSignals(signals: ProjectIdleSignals): string | null {
  return newestIso([
    signals.newest_task_activity_at,
    signals.newest_flight_event_at,
    signals.newest_evidence_at,
  ])
}

/** Load idle signals from authoritative server-side timestamps only.
 *  Agent-writable task.updated_at / result filler do NOT count — those are the
 *  forgeable activity class. Activity requires an approved different-principal
 *  verdict; flights and workflow receipts are server-stamped.
 */
export async function loadProjectIdleSignals(
  env: Env,
  projectId: string,
): Promise<ProjectIdleSignals> {
  const [taskRow, flightRow, evidenceRow] = await Promise.all([
    env.DB.prepare(
      `SELECT MAX(v.decided_at) AS newest
         FROM task_verdicts v
         JOIN tasks t ON t.id = v.task_id
        WHERE t.project_id = ?1
          AND v.verdict = 'approved'
          AND (t.assignee_agent_id IS NULL OR v.decided_by <> t.assignee_agent_id)`,
    )
      .bind(projectId)
      .first<{ newest: string | null }>(),
    env.DB.prepare(
      `SELECT MAX(created_at) AS newest
         FROM flight_event_outbox
        WHERE project_id = ?1`,
    )
      .bind(projectId)
      .first<{ newest: string | null }>(),
    env.DB.prepare(
      `SELECT MAX(created_at) AS newest
         FROM workflow_receipts
        WHERE project_id = ?1`,
    )
      .bind(projectId)
      .first<{ newest: string | null }>(),
  ])

  return {
    newest_task_activity_at: taskRow?.newest ?? null,
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
  const lastActivity = lastActivityFromSignals(signals)
  const idleDays = idleDurationDays(lastActivity, project.created_at, nowIso)
  const shouldStall = isPastStallThreshold(idleDays, thresholdDays)
  const nextFlag: 0 | 1 = shouldStall ? 1 : 0
  const currentFlag: 0 | 1 = project.stalled === 1 ? 1 : 0

  if (nextFlag === currentFlag) return 'unchanged'

  await deps.setStalled(env, project.id, nextFlag, nowIso)
  return nextFlag === 1 ? 'flagged' : 'cleared'
}
