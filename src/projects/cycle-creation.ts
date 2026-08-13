// Project lifecycle cycle creation (slice 5) — calendar-driven boundary rollover.
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
//
// For each active project, schedule the next cycle_boundary_at if not already
// scheduled, or advance it if the current boundary has elapsed. NO auto-carry of
// incomplete items — just update the boundary date. The circuit breaker (slice 1)
// uses the boundary to trigger recommit-or-kill evaluation.

import type { Env, Project } from '../types'
import { getProject } from './service'

export const CYCLE_CREATION_PRINCIPAL = 'system:project-loop'
/** Default cycle duration: 14 days (matches Shape Up / Linear practice). */
export const DEFAULT_CYCLE_DAYS = 14

export type CycleCreationOutcome = 'skipped' | 'scheduled' | 'advanced'

export interface CycleCreationDeps {
  cycleDaysInterval?: number
  nowIso?: () => string
}

/**
 * Calculate the next cycle boundary, given an optional existing boundary.
 * If no existing boundary, return now + interval.
 * If existing boundary is in the past, return lastBoundary + interval.
 * If existing boundary is in the future, return null (no change needed).
 */
export function nextCycleBoundary(
  nowIso: string,
  existingBoundaryIso: string | null,
  cycleDaysInterval: number,
): string | null {
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) return null
  if (!Number.isFinite(cycleDaysInterval) || cycleDaysInterval <= 0) return null

  const intervalMs = cycleDaysInterval * 24 * 60 * 60 * 1000
  if (existingBoundaryIso === null || existingBoundaryIso.trim() === '') {
    return new Date(nowMs + intervalMs).toISOString()
  }

  const boundaryMs = Date.parse(existingBoundaryIso)
  if (Number.isNaN(boundaryMs)) return null

  // Only advance if existing boundary is in the past (or now).
  if (boundaryMs <= nowMs) {
    return new Date(boundaryMs + intervalMs).toISOString()
  }

  // Boundary is in the future, no change needed.
  return null
}

/** List active projects needing cycle boundary creation or advancement. */
export async function listActiveProjectsForCycleCreation(env: Env): Promise<Project[]> {
  const result = await env.DB.prepare(
    `SELECT id, slug, name, description, goal, status, parent_project_id, target_date,
            cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at
       FROM projects
      WHERE status = 'active'
      ORDER BY updated_at ASC, id ASC
      LIMIT 25`,
  )
    .all<Project>()
  return result.results ?? []
}

/**
 * Idempotent: schedule or advance cycle boundary for a single active project.
 * Returns 'scheduled' (new), 'advanced' (past boundary), or 'skipped' (no change).
 */
export async function scheduleCycleBoundary(
  env: Env,
  projectId: string,
  nowIso: string,
  cycleDaysInterval: number,
): Promise<CycleCreationOutcome> {
  const project = await getProject(env, projectId)
  if (!project || project.status !== 'active') return 'skipped'

  const nextBoundary = nextCycleBoundary(nowIso, project.cycle_boundary_at, cycleDaysInterval)
  if (!nextBoundary) return 'skipped'

  const outcome = project.cycle_boundary_at === null ? 'scheduled' : 'advanced'

  try {
    const result = await env.DB.prepare(
      `UPDATE projects SET cycle_boundary_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    )
      .bind(nextBoundary, new Date().toISOString(), projectId)
      .run()

    if (result.success && result.meta.changes > 0) {
      return outcome
    }
    return 'skipped'
  } catch {
    return 'skipped'
  }
}

/**
 * Process active projects for cycle boundary creation/advancement.
 * Scans up to 25 projects per call (rate-limited for long-running cron).
 */
export async function processProjectCycleCreation(
  env: Env,
  nowIso: string,
  cycleDaysInterval: number = DEFAULT_CYCLE_DAYS,
): Promise<{ scanned: number; scheduled: number; advanced: number; errors: number }> {
  let scanned = 0
  let scheduled = 0
  let advanced = 0
  let errors = 0

  let projects: Project[]
  try {
    projects = await listActiveProjectsForCycleCreation(env)
  } catch {
    return { scanned: 0, scheduled: 0, advanced: 0, errors: 1 }
  }

  scanned = projects.length
  for (const project of projects) {
    try {
      const outcome = await scheduleCycleBoundary(env, project.id, nowIso, cycleDaysInterval)
      if (outcome === 'scheduled') scheduled++
      else if (outcome === 'advanced') advanced++
    } catch (err) {
      errors++
      console.error('cycle-creation: scheduling failed (non-fatal)', {
        tenant: env.TENANT_SLUG,
        project_id: project.id,
        principal: CYCLE_CREATION_PRINCIPAL,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { scanned, scheduled, advanced, errors }
}
