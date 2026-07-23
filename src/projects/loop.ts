// Project lifecycle loop — circuit breaker (slice 1) + structural completion
// (slice 2) + start-gate ghost alarm (slice 3).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
// Mirrors src/concierge/service.ts / src/loops/driver.ts: one bounded sweep per tick,
// best-effort per project, injectable seams for tests.

import type { Env, Project } from '../types'
import {
  CIRCUIT_BREAKER_PRINCIPAL,
  defaultCircuitBreakerDeps,
  evaluateProjectCircuitBreaker,
  type CircuitBreakerDeps,
  type CircuitBreakerOutcome,
} from './circuit-breaker'
import {
  defaultCompletionGateDeps,
  enterProjectReview,
  type CompletionGateDeps,
} from './completion-gate'
import {
  DEFAULT_GHOST_START_DAYS,
  START_GATE_PRINCIPAL,
  defaultGhostStartDeps,
  evaluateGhostStartAlarm,
  ghostCutoffIso,
  listStalePlannedProjects,
  type GhostStartDeps,
  type GhostStartOutcome,
} from './start-gate'

/** Cap projects evaluated per cron tick — mirrors MAX_PROJECTS_PER_TICK / MAX_LOOPS_PER_TICK. */
export const MAX_BOUNDARY_PROJECTS_PER_TICK = 25
export const MAX_COMPLETION_PROJECTS_PER_TICK = 25
export const MAX_GHOST_START_PROJECTS_PER_TICK = 25
export const STRUCTURAL_COMPLETION_PRINCIPAL = 'system:project-loop'

export interface ProjectLoopTickResult {
  ok: boolean
  scanned: number
  skipped: number
  recommitted: number
  killed: number
  completion_promoted: number
  ghost_alarmed: number
  errors: number
}

export interface ProjectLoopDeps {
  listDue?: (env: Env, nowIso: string) => Promise<Project[]>
  listActiveForCompletion?: (env: Env) => Promise<Project[]>
  listStalePlanned?: (env: Env, olderThanIso: string) => Promise<Project[]>
  evaluate?: (
    env: Env,
    project: Pick<Project, 'id' | 'status' | 'cycle_boundary_at'>,
    nowIso: string,
    deps: CircuitBreakerDeps,
  ) => Promise<CircuitBreakerOutcome>
  enterReview?: (
    env: Env,
    projectId: string,
    principal: string,
    deps: CompletionGateDeps,
  ) => ReturnType<typeof enterProjectReview>
  evaluateGhost?: (
    env: Env,
    project: Pick<Project, 'id' | 'status' | 'created_at'>,
    nowIso: string,
    deps: GhostStartDeps,
  ) => Promise<GhostStartOutcome>
  breakerDeps?: CircuitBreakerDeps
  completionDeps?: CompletionGateDeps
  ghostDeps?: GhostStartDeps
  nowIso?: () => string
}

const PROJECT_SELECT = `id, slug, name, description, goal, status, parent_project_id, target_date,
            cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at`

/**
 * Projects with a due boundary that are not already terminal or in completion review.
 * Status filter matches shouldEvaluateBreaker (completed/archived/review exempt).
 */
export async function listProjectsDueAtBoundary(
  env: Env,
  nowIso: string,
): Promise<Project[]> {
  const result = await env.DB.prepare(
    `SELECT ${PROJECT_SELECT}
       FROM projects
      WHERE cycle_boundary_at IS NOT NULL
        AND cycle_boundary_at <= ?1
        AND status NOT IN ('completed', 'archived', 'review')
      ORDER BY cycle_boundary_at ASC, id ASC
      LIMIT ?2`,
  )
    .bind(nowIso, MAX_BOUNDARY_PROJECTS_PER_TICK)
    .all<Project>()
  return result.results ?? []
}

/** Active projects that may be ready for structural completion → review. */
export async function listActiveProjectsForCompletion(env: Env): Promise<Project[]> {
  const result = await env.DB.prepare(
    `SELECT ${PROJECT_SELECT}
       FROM projects
      WHERE status = 'active'
      ORDER BY updated_at ASC, id ASC
      LIMIT ?1`,
  )
    .bind(MAX_COMPLETION_PROJECTS_PER_TICK)
    .all<Project>()
  return result.results ?? []
}

/**
 * runProjectLoopTick — one heartbeat for project lifecycle.
 * Best-effort: a failed list returns {ok:false}; a failed project is counted and
 * does not abort the sweep.
 */
export async function runProjectLoopTick(
  env: Env,
  deps: ProjectLoopDeps,
): Promise<ProjectLoopTickResult> {
  const nowIso = (deps.nowIso ?? (() => new Date().toISOString()))()
  const list = deps.listDue ?? listProjectsDueAtBoundary
  const listActive = deps.listActiveForCompletion ?? listActiveProjectsForCompletion
  const listStale = deps.listStalePlanned ?? listStalePlannedProjects
  const evaluate = deps.evaluate ?? evaluateProjectCircuitBreaker
  const enterReview = deps.enterReview ?? enterProjectReview
  const evaluateGhost = deps.evaluateGhost ?? evaluateGhostStartAlarm
  const breakerDeps = deps.breakerDeps ?? defaultCircuitBreakerDeps()
  const completionDeps = deps.completionDeps ?? defaultCompletionGateDeps()
  const ghostDeps = deps.ghostDeps ?? defaultGhostStartDeps()

  let projects: Project[]
  try {
    projects = await list(env, nowIso)
  } catch {
    return {
      ok: false,
      scanned: 0,
      skipped: 0,
      recommitted: 0,
      killed: 0,
      completion_promoted: 0,
      ghost_alarmed: 0,
      errors: 0,
    }
  }

  let skipped = 0
  let recommitted = 0
  let killed = 0
  let errors = 0
  let completionPromoted = 0
  let ghostAlarmed = 0

  for (const project of projects) {
    try {
      const outcome = await evaluate(env, project, nowIso, breakerDeps)
      if (outcome === 'skipped') skipped++
      else if (outcome === 'recommitted') recommitted++
      else if (outcome === 'killed') killed++
    } catch (err) {
      errors++
      console.error('project-loop: circuit breaker failed (non-fatal)', {
        tenant: env.TENANT_SLUG,
        project_id: project.id,
        principal: CIRCUIT_BREAKER_PRINCIPAL,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let activeProjects: Project[]
  try {
    activeProjects = await listActive(env)
  } catch {
    activeProjects = []
  }

  for (const project of activeProjects) {
    try {
      const result = await enterReview(env, project.id, STRUCTURAL_COMPLETION_PRINCIPAL, completionDeps)
      if (result.ok && result.value.status === 'review' && project.status === 'active') {
        completionPromoted++
      }
    } catch (err) {
      errors++
      console.error('project-loop: structural completion failed (non-fatal)', {
        tenant: env.TENANT_SLUG,
        project_id: project.id,
        principal: STRUCTURAL_COMPLETION_PRINCIPAL,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let stalePlanned: Project[]
  try {
    const thresholdDays = ghostDeps.ghostThresholdDays ?? DEFAULT_GHOST_START_DAYS
    const cutoff = ghostCutoffIso(nowIso, thresholdDays)
    stalePlanned = await listStale(env, cutoff)
  } catch {
    stalePlanned = []
  }

  for (const project of stalePlanned.slice(0, MAX_GHOST_START_PROJECTS_PER_TICK)) {
    try {
      const outcome = await evaluateGhost(env, project, nowIso, ghostDeps)
      if (outcome === 'alarmed') ghostAlarmed++
      else if (outcome === 'skipped' || outcome === 'already_alarmed') skipped++
    } catch (err) {
      errors++
      console.error('project-loop: ghost-start alarm failed (non-fatal)', {
        tenant: env.TENANT_SLUG,
        project_id: project.id,
        principal: START_GATE_PRINCIPAL,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    ok: true,
    scanned: projects.length + activeProjects.length + stalePlanned.length,
    skipped,
    recommitted,
    killed,
    completion_promoted: completionPromoted,
    ghost_alarmed: ghostAlarmed,
    errors,
  }
}
