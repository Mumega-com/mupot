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
