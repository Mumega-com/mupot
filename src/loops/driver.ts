// mupot — the Loop driver: runs active loops on the cron heartbeat (P3, #34).
//
// runLoopCycle (P2) is the cycle body; nothing drove it on a schedule. The driver
// is that caller — each metabolism tick it loads this tenant's ACTIVE loops and runs
// one cycle of each (capped + best-effort), so "set a loop's knobs and walk away"
// is autonomous. Mirrors src/agents/metabolism.ts (the agent heartbeat); both run
// from the Worker's scheduled() handler.
//
// All I/O is injected (list / runCycle) so the fan-out logic is unit-tested with no
// D1 or model.

import type { Env } from '../types'
import { listLoops } from './service'
import { runLoopCycle } from './runtime'
import type { RuntimeDeps } from './runtime'
import type { LoopManifest } from './manifest'
import { wireGatedAct } from './gate'

/** Max loops driven per cron tick. Large tenants rotate across ticks (oldest-first via listLoops order). */
export const MAX_LOOPS_PER_TICK = 25

export interface LoopsTickResult {
  ok: boolean
  ran: number // cycles executed
  acted: number // ungated acts fired across all loops
  gated: number // acts queued for approval across all loops
  errors: number // cycles that errored (counted, never fatal)
}

export interface DriverDeps {
  /** List the active loops to drive. Default: tenant-scoped listLoops(status:'active'). */
  list?: (env: Env) => Promise<LoopManifest[]>
  /** Run one cycle. Default: runLoopCycle. */
  runCycle?: typeof runLoopCycle
  /** Seams forwarded into each cycle (resolve/reason/performAct/observeKpi/…). */
  runtimeDeps?: RuntimeDeps
}

/**
 * runLoopsTick — one heartbeat for loops. Best-effort: a failed list returns a graceful
 * {ok:false}; a failed/erroring cycle is counted and does NOT abort the sweep. Each cycle
 * already self-governs (budget gate + structural human gate), so the driver just fans out.
 */
export async function runLoopsTick(env: Env, deps: DriverDeps = {}): Promise<LoopsTickResult> {
  const list = deps.list ?? ((e) => listLoops(e, { status: 'active' }))
  const runCycle = deps.runCycle ?? runLoopCycle

  let loops: LoopManifest[]
  try {
    loops = await list(env)
  } catch {
    return { ok: false, ran: 0, acted: 0, gated: 0, errors: 0 }
  }

  const batch = loops.slice(0, MAX_LOOPS_PER_TICK)
  let ran = 0
  let acted = 0
  let gated = 0
  let errors = 0

  // Production runtime seams: gated acts route to the verdict/approvals pipeline
  // (wireGatedAct). A caller's runtimeDeps override these (tests, future reason/KPI).
  const runtimeDeps: RuntimeDeps = { queueGatedAct: wireGatedAct, ...deps.runtimeDeps }

  for (const loop of batch) {
    try {
      const r = await runCycle(env, loop, runtimeDeps)
      ran++
      acted += r.acted
      gated += r.gated
      if (!r.ok) errors++
    } catch {
      errors++ // one bad cycle must not stop the rest
    }
  }

  return { ok: true, ran, acted, gated, errors }
}
