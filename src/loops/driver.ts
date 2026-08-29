// src/loops/driver.ts — Governed Autonomous Loop Driver (FLIGHT-LOOP-UNHOLD).
//
// Governs autonomous goal-seeking agent loops with propose-only boundaries and founder approval brakes:
// 1. Propose-Only Scope: Loops with gate.require_approval = true queue proposed acts into /approvals
//    rather than firing destructive mutations directly.
// 2. Founder / Operator Brakes: Hard stop brakes on budget, iteration limits, and human directive vetoes.
// 3. Autonomous Execution Tick: Executes unheld loop cycles and records state transitions in D1.

import type { Env } from '../types'
import type { LoopManifest } from './manifest'
import { getLoop, listLoops } from './service'
import { runLoopCycle, type LoopCycleResult, type ProposedAct } from './runtime'

export interface LoopDriverRunResult {
  loopId: string
  status: string
  cycleResult: LoopCycleResult
}

export interface LoopDriverSweepResult {
  scannedCount: number
  executedCount: number
  heldCount: number
  results: LoopDriverRunResult[]
}

/**
 * Executes a single tick of a governed loop.
 */
export async function executeGovernedLoopCycle(
  env: Env,
  loop: LoopManifest,
  options: { cycleNum?: number } = {},
): Promise<LoopCycleResult> {
  // Propose-Only Boundary: Gated acts route to /approvals tasks
  const queueGatedAct = async (env: Env, loop: LoopManifest, act: ProposedAct) => {
    const taskId = crypto.randomUUID()
    const now = new Date().toISOString()
    await env.DB.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'review', 'gate:loops', ?6, ?6)`,
    )
      .bind(
        taskId,
        loop.squad_id ?? 'squad-core',
        `[Loop Gated Act] ${act.tool}: ${act.summary.slice(0, 80)}`,
        `Act args: ${JSON.stringify(act.args)}\nTarget Channel: ${act.channel_index}`,
        'Approved by operator at /approvals',
        now,
      )
      .run()
  }

  return runLoopCycle(env, loop, {
    queueGatedAct,
    cycleNum: options.cycleNum ?? 1,
  })
}

/**
 * Sweep active loops in tenant and execute eligible cycles.
 */
export async function runGovernedLoopDriverTick(
  env: Env,
  options: { loopId?: string } = {},
): Promise<LoopDriverSweepResult> {
  let loopsResult: LoopManifest[] = []
  if (options.loopId) {
    const loopRes = await getLoop(env, options.loopId)
    if (loopRes) loopsResult = [loopRes]
  } else {
    loopsResult = await listLoops(env)
  }

  const results: LoopDriverRunResult[] = []
  let executedCount = 0
  let heldCount = 0

  for (const loop of loopsResult) {
    if (loop.status !== 'active') {
      heldCount++
      continue
    }

    const cycleResult = await executeGovernedLoopCycle(env, loop)
    executedCount++
    results.push({
      loopId: loop.id,
      status: loop.status,
      cycleResult,
    })
  }

  return {
    scannedCount: loopsResult.length,
    executedCount,
    heldCount,
    results,
  }
}

export const MAX_LOOPS_PER_TICK = 10

export interface LoopConfig {
  reason: (env: Env, input: any) => Promise<any[]>
  observeKpi: (env: Env, loop: LoopManifest) => Promise<number>
}

export interface LoopConfigFactories {
  outreach: (env: Env, loop: LoopManifest) => LoopConfig
  cro: (env: Env, loop: LoopManifest) => LoopConfig
}

export function loopRuntimeConfig(
  loop: LoopManifest,
  factories: LoopConfigFactories = {
    outreach: () => ({ reason: async () => [], observeKpi: async () => 0 }),
    cro: () => ({ reason: async () => [], observeKpi: async () => 0 }),
  },
  env: Env = {} as Env,
): LoopConfig {
  if (loop.kind === 'cro') {
    return factories.cro(env, loop)
  }
  return factories.outreach(env, loop)
}

export interface DriverDeps {
  list?: (env: Env, opts?: { status?: any; squadIds?: string[] | null }) => Promise<LoopManifest[]>
  runCycle?: (env: Env, loop: LoopManifest, deps?: any) => Promise<LoopCycleResult>
  bumpDry?: (env: Env, id: string) => Promise<number>
  resetDry?: (env: Env, id: string) => Promise<void>
  pause?: (env: Env, id: string) => Promise<boolean>
  readControl?: (env: Env, loopId: string) => Promise<any>
  clearControl?: (env: Env, loopId: string) => Promise<void>
}

export interface RunLoopsTickSummary {
  ok: boolean
  ran: number
  acted: number
  gated: number
  paused: number
  errors: number
  error?: string
}

/**
 * runLoopsTick — original driver sweep supporting dependency injection for tests
 * and scheduled maintenance heartbeats.
 */
export async function runLoopsTick(
  env: Env,
  deps: DriverDeps = {},
): Promise<RunLoopsTickSummary> {
  const summary: RunLoopsTickSummary = {
    ok: true,
    ran: 0,
    acted: 0,
    gated: 0,
    paused: 0,
    errors: 0,
  }

  let loops: LoopManifest[]
  try {
    const listFn = deps.list ?? ((e: Env) => listLoops(e, { status: 'active' }))
    loops = await listFn(env, { status: 'active' })
  } catch (err) {
    summary.ok = false
    summary.error = err instanceof Error ? err.message : String(err)
    return summary
  }

  const capped = loops.slice(0, MAX_LOOPS_PER_TICK)

  for (const loop of capped) {
    try {
      // Check control signal if provided
      if (deps.readControl) {
        const control = await deps.readControl(env, loop.id)
        if (control) {
          if (control.action === 'pause') {
            if (deps.pause) await deps.pause(env, loop.id)
            if (deps.clearControl) await deps.clearControl(env, loop.id)
            summary.paused++
            continue
          }
          if (control.action === 'kill') {
            if (deps.clearControl) await deps.clearControl(env, loop.id)
            summary.errors++
            continue
          }
          if (control.action === 'budget_override') {
            const val = Number(control.value)
            if (Number.isFinite(val) && val > 0) {
              loop.budget = { ...loop.budget, cap_micro_usd: val }
            }
            if (deps.clearControl) await deps.clearControl(env, loop.id)
          }
        }
      }

      const cycleFn = deps.runCycle ?? ((e: Env, l: LoopManifest) => executeGovernedLoopCycle(e, l))
      const res = await cycleFn(env, loop)
      if (!res.ok) {
        summary.errors++
      } else {
        summary.ran++
        summary.acted += res.acted ?? 0
        summary.gated += res.gated ?? 0

        if (res.decided === 'dry' && loop.stop?.dry_rounds_max && deps.bumpDry) {
          const dryCount = await deps.bumpDry(env, loop.id)
          if (dryCount >= loop.stop.dry_rounds_max && deps.pause) {
            await deps.pause(env, loop.id)
            summary.paused++
          }
        } else if (res.decided === 'acted' && deps.resetDry) {
          await deps.resetDry(env, loop.id)
        }
      }
    } catch {
      summary.errors++
    }
  }

  return summary
}
