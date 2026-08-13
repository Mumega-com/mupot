// Project lifecycle loop — circuit breaker (slice 1) + structural completion
// (slice 2) + start-gate ghost alarm (slice 3) + stall detector (slice 4) +
// cycle creation (slice 5).
//
// Design: docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md
// Mirrors src/concierge/service.ts / src/loops/driver.ts: one bounded sweep per tick,
// best-effort per project, injectable seams for tests.

import type { Env, Project } from '../types'
import {
  CIRCUIT_BREAKER_PRINCIPAL,
  defaultCircuitBreakerDeps,
  evaluateProjectCircuitBreaker,
  shouldEvaluateBreaker,
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
import {
  STALL_DETECTOR_PRINCIPAL,
  defaultStallDetectorDeps,
  evaluateProjectStall,
  type StallDetectorDeps,
  type StallDetectorOutcome,
} from './stall-detector'
import {
  DEFAULT_CYCLE_DAYS,
  processProjectCycleCreation,
} from './cycle-creation'

/** Cap projects evaluated per cron tick — mirrors MAX_PROJECTS_PER_TICK / MAX_LOOPS_PER_TICK. */
export const MAX_BOUNDARY_PROJECTS_PER_TICK = 25
export const MAX_COMPLETION_PROJECTS_PER_TICK = 25
export const MAX_GHOST_START_PROJECTS_PER_TICK = 25
export const MAX_STALL_PROJECTS_PER_TICK = 25
export const STRUCTURAL_COMPLETION_PRINCIPAL = 'system:project-loop'

export interface ProjectLoopTickResult {
  ok: boolean
  scanned: number
  skipped: number
  recommitted: number
  killed: number
  completion_promoted: number
  ghost_alarmed: number
  stall_flagged: number
  stall_cleared: number
  cycles_scheduled: number
  cycles_advanced: number
  errors: number
}

export interface ProjectLoopDeps {
  listDue?: (env: Env, nowIso: string) => Promise<Project[]>
  listActiveForCompletion?: (env: Env) => Promise<Project[]>
  listActiveForStall?: (env: Env) => Promise<Project[]>
  listStalePlanned?: (env: Env, olderThanIso: string) => Promise<Project[]>
  evaluate?: (
    env: Env,
    project: Pick<Project, 'id' | 'status' | 'cycle_boundary_at' | 'stalled'>,
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
  evaluateStall?: (
    env: Env,
    project: Pick<Project, 'id' | 'status' | 'created_at' | 'stalled' | 'stall_threshold_days'>,
    nowIso: string,
    deps: StallDetectorDeps,
  ) => Promise<StallDetectorOutcome>
  breakerDeps?: CircuitBreakerDeps
  completionDeps?: CompletionGateDeps
  ghostDeps?: GhostStartDeps
  stallDeps?: StallDetectorDeps
  nowIso?: () => string
}

const PROJECT_SELECT = `id, slug, name, description, goal, status, parent_project_id, target_date,
            cycle_boundary_at, stalled, stall_threshold_days, completion_proposed_by, created_at, updated_at`

/**
 * Projects due for breaker evaluation: boundary elapsed (UTC instant compare),
 * OR stalled with a scheduled boundary (slice 4 early raise). Terminal / review
 * statuses exempt. String lexicographic compare is NOT used — offset ISO forms
 * like +03:00 would sort wrong against Zulu.
 */
export async function listProjectsDueAtBoundary(
  env: Env,
  nowIso: string,
): Promise<Project[]> {
  const nowMs = Date.parse(nowIso)
  if (Number.isNaN(nowMs)) {
    throw new Error('invalid_now_iso')
  }
  const result = await env.DB.prepare(
    `SELECT ${PROJECT_SELECT}
       FROM projects
      WHERE cycle_boundary_at IS NOT NULL
        AND status NOT IN ('completed', 'archived', 'review')
      ORDER BY cycle_boundary_at ASC, id ASC
      LIMIT ?1`,
  )
    .bind(MAX_BOUNDARY_PROJECTS_PER_TICK * 4)
    .all<Project>()

  const due: Project[] = []
  for (const project of result.results ?? []) {
    if (shouldEvaluateBreaker(project.status, project.cycle_boundary_at, nowIso, project.stalled)) {
      due.push(project)
    }
    if (due.length >= MAX_BOUNDARY_PROJECTS_PER_TICK) break
  }
  return due
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

/** Active projects scanned by the stall detector each tick. */
export async function listActiveProjectsForStall(env: Env): Promise<Project[]> {
  const result = await env.DB.prepare(
    `SELECT ${PROJECT_SELECT}
       FROM projects
      WHERE status = 'active'
      ORDER BY updated_at ASC, id ASC
      LIMIT ?1`,
  )
    .bind(MAX_STALL_PROJECTS_PER_TICK)
    .all<Project>()
  return result.results ?? []
}

/**
 * runProjectLoopTick — one heartbeat for project lifecycle.
 * Order: stall detect (so early raise sees fresh flags) → circuit breaker →
 * cycle creation (slice 5) → structural completion → ghost-start alarm.
 *
 * Cycle creation runs AFTER the breaker on purpose. It advances cycle_boundary_at
 * into the future, and the breaker fires only when that boundary has ELAPSED —
 * so placed first it pushes the boundary forward before the breaker can look at
 * it, and recommit-or-kill silently stops being reachable for any non-stalled
 * project. See the block comment at the call site.
 *
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
  const listStall = deps.listActiveForStall ?? listActiveProjectsForStall
  const listStale = deps.listStalePlanned ?? listStalePlannedProjects
  const evaluate = deps.evaluate ?? evaluateProjectCircuitBreaker
  const enterReview = deps.enterReview ?? enterProjectReview
  const evaluateGhost = deps.evaluateGhost ?? evaluateGhostStartAlarm
  const evaluateStall = deps.evaluateStall ?? evaluateProjectStall
  const breakerDeps = deps.breakerDeps ?? defaultCircuitBreakerDeps()
  const completionDeps = deps.completionDeps ?? defaultCompletionGateDeps()
  const ghostDeps = deps.ghostDeps ?? defaultGhostStartDeps()
  const stallDeps = deps.stallDeps ?? defaultStallDetectorDeps()

  let skipped = 0
  let recommitted = 0
  let killed = 0
  let errors = 0
  let completionPromoted = 0
  let ghostAlarmed = 0
  let stallFlagged = 0
  let stallCleared = 0
  let cyclesScheduled = 0
  let cyclesAdvanced = 0

  const cycleInterval = DEFAULT_CYCLE_DAYS

  let stallProjects: Project[]
  try {
    stallProjects = await listStall(env)
  } catch {
    return {
      ok: false,
      scanned: 0,
      skipped: 0,
      recommitted: 0,
      killed: 0,
      completion_promoted: 0,
      ghost_alarmed: 0,
      stall_flagged: 0,
      stall_cleared: 0,
      cycles_scheduled: cyclesScheduled,
      cycles_advanced: cyclesAdvanced,
      errors,
    }
  }

  for (const project of stallProjects) {
    try {
      const outcome = await evaluateStall(env, project, nowIso, stallDeps)
      if (outcome === 'flagged') stallFlagged++
      else if (outcome === 'cleared') stallCleared++
      else if (outcome === 'skipped' || outcome === 'unchanged') skipped++
    } catch (err) {
      errors++
      console.error('project-loop: stall detector failed (non-fatal)', {
        tenant: env.TENANT_SLUG,
        project_id: project.id,
        principal: STALL_DETECTOR_PRINCIPAL,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let projects: Project[]
  try {
    projects = await list(env, nowIso)
  } catch {
    return {
      ok: false,
      scanned: stallProjects.length,
      skipped,
      recommitted: 0,
      killed: 0,
      completion_promoted: 0,
      ghost_alarmed: 0,
      stall_flagged: stallFlagged,
      stall_cleared: stallCleared,
      cycles_scheduled: cyclesScheduled,
      cycles_advanced: cyclesAdvanced,
      errors,
    }
  }

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

  // CYCLE CREATION RUNS *AFTER* THE BREAKER, NOT BEFORE IT.
  //
  // This block was originally the first step of the tick. That is a silent disabling of
  // recommit-or-kill, and it merges clean:
  //
  //   listProjectsDueAtBoundary() selects on `cycle_boundary_at IS NOT NULL AND status NOT IN
  //   (...)` and then filters through shouldEvaluateBreaker(), which for a non-stalled project
  //   returns isAtCycleBoundary(cycleBoundaryAt, nowIso) — true only once the boundary has
  //   ELAPSED. Meanwhile scheduleCycleBoundary() advances any active project whose boundary is
  //   <= now to boundary + 14d, a FUTURE timestamp.
  //
  // Run first, it pushes the boundary forward before the breaker is given the chance to look
  // at it, and isAtCycleBoundary then reads false. The recommit-or-kill evaluation that the
  // boundary exists to trigger becomes reachable only through the `stalled === 1` early-raise
  // path — i.e. the ordinary case stops being evaluated at all, forever, with no error and no
  // changed counter.
  //
  // Running it here instead means the breaker evaluates THIS tick's boundary, and the advance
  // sets up the NEXT one. Both `projects` and the breaker loop above are already complete, so
  // nothing downstream re-reads cycle_boundary_at.
  try {
    const cycleResult = await processProjectCycleCreation(env, nowIso, cycleInterval)
    cyclesScheduled = cycleResult.scheduled
    cyclesAdvanced = cycleResult.advanced
    errors += cycleResult.errors
  } catch (err) {
    errors++
    console.error('project-loop: cycle creation failed (non-fatal)', {
      tenant: env.TENANT_SLUG,
      error: err instanceof Error ? err.message : String(err),
    })
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
    scanned: stallProjects.length + projects.length + activeProjects.length + stalePlanned.length,
    skipped,
    recommitted,
    killed,
    completion_promoted: completionPromoted,
    ghost_alarmed: ghostAlarmed,
    stall_flagged: stallFlagged,
    stall_cleared: stallCleared,
    cycles_scheduled: cyclesScheduled,
    cycles_advanced: cyclesAdvanced,
    errors,
  }
}
