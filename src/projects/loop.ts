// Project lifecycle loop — drives the circuit breaker on the Worker cron.
//
// Slice 1 of docs/superpowers/specs/2026-07-23-project-lifecycle-control-loop-design.md.
// Mirrors src/concierge/service.ts / src/loops/driver.ts: one bounded sweep per tick,
// best-effort per project, injectable seams for tests.

import type { Env, Project } from '../types'
import {
  CIRCUIT_BREAKER_PRINCIPAL,
  canonicalizeUtcIso,
  clearInvalidCycleBoundary,
  defaultCircuitBreakerDeps,
  epochMs,
  evaluateProjectCircuitBreaker,
  type CircuitBreakerDeps,
  type CircuitBreakerOutcome,
} from './circuit-breaker'

/** Cap projects evaluated per cron tick — mirrors MAX_PROJECTS_PER_TICK / MAX_LOOPS_PER_TICK. */
export const MAX_BOUNDARY_PROJECTS_PER_TICK = 25

/** Over-fetch so epoch filtering / invalid quarantine still fills the tick cap. */
const LIST_CANDIDATE_MULTIPLIER = 4

export interface ProjectLoopTickResult {
  ok: boolean
  scanned: number
  skipped: number
  recommitted: number
  killed: number
  errors: number
}

export interface ProjectLoopDeps {
  listDue?: (env: Env, nowIso: string) => Promise<Project[]>
  evaluate?: (
    env: Env,
    project: Pick<Project, 'id' | 'status' | 'cycle_boundary_at'>,
    nowIso: string,
    deps: CircuitBreakerDeps,
  ) => Promise<CircuitBreakerOutcome>
  breakerDeps?: CircuitBreakerDeps
  nowIso?: () => string
}

/**
 * Projects with a due boundary that are not already terminal.
 * Boundaries are compared via normalized UTC epoch (not lexicographic text).
 * Invalid (NaN) boundaries are cleared so they cannot retry forever.
 */
export async function listProjectsDueAtBoundary(
  env: Env,
  nowIso: string,
): Promise<Project[]> {
  const nowCanonical = canonicalizeUtcIso(nowIso)
  if (nowCanonical === null) {
    throw new Error('project_loop_invalid_now')
  }
  const nowMs = epochMs(nowCanonical)
  if (nowMs === null) {
    throw new Error('project_loop_invalid_now')
  }

  const result = await env.DB.prepare(
    `SELECT id, slug, name, description, goal, status, parent_project_id, target_date,
            cycle_boundary_at, stalled, stall_threshold_days, created_at, updated_at
       FROM projects
      WHERE cycle_boundary_at IS NOT NULL
        AND status NOT IN ('completed', 'archived')
      ORDER BY cycle_boundary_at ASC, id ASC
      LIMIT ?1`,
  )
    .bind(MAX_BOUNDARY_PROJECTS_PER_TICK * LIST_CANDIDATE_MULTIPLIER)
    .all<Project>()

  const due: Project[] = []
  for (const project of result.results ?? []) {
    const canonicalBoundary = canonicalizeUtcIso(project.cycle_boundary_at)
    if (canonicalBoundary === null) {
      await clearInvalidCycleBoundary(env, project.id)
      continue
    }
    if (canonicalBoundary !== project.cycle_boundary_at) {
      await env.DB.prepare(
        `UPDATE projects SET cycle_boundary_at = ?1, updated_at = ?2 WHERE id = ?3`,
      )
        .bind(canonicalBoundary, new Date().toISOString(), project.id)
        .run()
      project.cycle_boundary_at = canonicalBoundary
    }
    const boundaryMs = epochMs(canonicalBoundary)
    if (boundaryMs === null) {
      await clearInvalidCycleBoundary(env, project.id)
      continue
    }
    if (boundaryMs > nowMs) continue
    due.push(project)
    if (due.length >= MAX_BOUNDARY_PROJECTS_PER_TICK) break
  }
  return due
}

/**
 * runProjectLoopTick — one heartbeat for the project circuit breaker.
 * Best-effort: a failed list returns {ok:false}; a failed project is counted and
 * does not abort the sweep.
 */
export async function runProjectLoopTick(
  env: Env,
  deps: ProjectLoopDeps,
): Promise<ProjectLoopTickResult> {
  const nowIso = (deps.nowIso ?? (() => new Date().toISOString()))()
  const list = deps.listDue ?? listProjectsDueAtBoundary
  const evaluate = deps.evaluate ?? evaluateProjectCircuitBreaker
  const breakerDeps = deps.breakerDeps ?? defaultCircuitBreakerDeps()

  let projects: Project[]
  try {
    projects = await list(env, nowIso)
  } catch {
    return { ok: false, scanned: 0, skipped: 0, recommitted: 0, killed: 0, errors: 0 }
  }

  let skipped = 0
  let recommitted = 0
  let killed = 0
  let errors = 0

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

  return {
    ok: true,
    scanned: projects.length,
    skipped,
    recommitted,
    killed,
    errors,
  }
}
