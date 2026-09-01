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
//
// S-BRAIN-CTRL-MUPOT-1 additions:
//   loop_control check (AC#6): before each cycle the driver reads the loop_controls
//   table. A pending signal (pause|kill|budget_override) is honored before runCycle
//   is called. This mirrors the dry-round auto-pause pattern: the driver is the
//   enforcement layer; the runtime is the cycle body that runs only when cleared.
//   The cycleNum is tracked per-loop and threaded through RuntimeDeps so runtime.ts
//   can attach it to the appendDecision call (AC#2).

import type { Env } from '../types'
import { listLoops, bumpDryRounds, resetDryRounds, setLoopStatus } from './service'
import { runLoopCycle } from './runtime'
import type { RuntimeDeps } from './runtime'
import type { LoopManifest } from './manifest'
import { wireGatedAct } from './gate'
import { makeOutreachReason, makeOutreachObserveKpi } from './outreach'
import { makeCroReason, makeCroObserveKpi } from './cro'
import {
  getLoopControl,
  clearLoopControl,
} from './decisions'
import type { LoopControlRow } from './decisions'

/** Max loops driven per cron tick. Large tenants rotate across ticks (oldest-first via listLoops order). */
export const MAX_LOOPS_PER_TICK = 25

/** The runtime seams a loop's CONFIG supplies (reason + KPI). queueGatedAct is config-agnostic. */
export interface LoopConfig {
  reason: NonNullable<RuntimeDeps['reason']>
  observeKpi: NonNullable<RuntimeDeps['observeKpi']>
}

/** Factory per loop kind. Injectable so the routing is unit-tested without invoking a model. */
export interface LoopConfigFactories {
  outreach: () => LoopConfig
  cro: () => LoopConfig
}

const DEFAULT_LOOP_CONFIG_FACTORIES: LoopConfigFactories = {
  outreach: () => ({ reason: makeOutreachReason(), observeKpi: makeOutreachObserveKpi() }),
  cro: () => ({ reason: makeCroReason(), observeKpi: makeCroObserveKpi() }),
}

/**
 * loopRuntimeConfig — pick the reason + KPI seams for a loop by its `kind`. An absent
 * kind resolves to 'outreach' (back-compat). This is the ONLY place the driver branches
 * on config, so a new loop kind is added by extending the factory map + the LoopKind enum.
 */
export function loopRuntimeConfig(
  loop: LoopManifest,
  factories: LoopConfigFactories = DEFAULT_LOOP_CONFIG_FACTORIES,
): LoopConfig {
  return loop.kind === 'cro' ? factories.cro() : factories.outreach()
}

export interface LoopsTickResult {
  ok: boolean
  ran: number // cycles executed
  acted: number // ungated acts fired across all loops
  gated: number // acts queued for approval across all loops
  paused: number // loops paused this tick for hitting dry_rounds_max
  errors: number // cycles that errored (counted, never fatal)
}

export interface DriverDeps {
  /** List the active loops to drive. Default: tenant-scoped listLoops(status:'active'). */
  list?: (env: Env) => Promise<LoopManifest[]>
  /** Run one cycle. Default: runLoopCycle. */
  runCycle?: typeof runLoopCycle
  /** Dry-round bookkeeping seams (injectable for tests). */
  bumpDry?: (env: Env, id: string) => Promise<number>
  resetDry?: (env: Env, id: string) => Promise<void>
  pause?: (env: Env, id: string) => Promise<boolean>
  /** Governor control seams (injectable for tests, AC#6). */
  readControl?: (env: Env, id: string) => Promise<LoopControlRow | null>
  clearControl?: (env: Env, id: string) => Promise<void>
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
  const bumpDry = deps.bumpDry ?? bumpDryRounds
  const resetDry = deps.resetDry ?? resetDryRounds
  const pause = deps.pause ?? ((e, id) => setLoopStatus(e, id, 'paused'))
  const readControl = deps.readControl ?? ((e, id) => getLoopControl(e, id))
  const clearControl = deps.clearControl ?? ((e, id) => clearLoopControl(e, id))

  let loops: LoopManifest[]
  try {
    loops = await list(env)
  } catch {
    return { ok: false, ran: 0, acted: 0, gated: 0, paused: 0, errors: 0 }
  }

  const batch = loops.slice(0, MAX_LOOPS_PER_TICK)
  let ran = 0
  let acted = 0
  let gated = 0
  let paused = 0
  let errors = 0

  // cycleNum is tracked per-loop across this tick's batch. In production the
  // driver runs once per cron tick (one cycle per loop per tick), so we increment
  // by 1 per loop processed. The number is threaded into RuntimeDeps.cycleNum so
  // runtime.ts can attach it to the appendDecision row. A real monotone counter
  // would require a COUNT(*) pre-query; the timestamp already orders the feed, so
  // the tick-relative sequence is sufficient for the feed UI.
  const cycleCounts = new Map<string, number>()

  for (const loop of batch) {
    try {
      // ── loop_control check (AC#6) ────────────────────────────────────────
      // Read before calling runCycle. On a pause/kill signal: apply the lifecycle
      // transition, clear the signal, and skip the cycle. On budget_override:
      // patch the loop manifest for this cycle and clear after.
      let controlledLoop: LoopManifest = loop
      let pendingBudgetOverride = false
      try {
        const ctrl = await readControl(env, loop.id)
        if (ctrl) {
          if (ctrl.action === 'pause') {
            await pause(env, loop.id)
            await clearControl(env, loop.id)
            paused++
            errors++ // skipped cycle counts as an error in the sweep
            continue
          } else if (ctrl.action === 'kill') {
            await setLoopStatus(env, loop.id, 'done')
            await clearControl(env, loop.id)
            errors++ // skipped cycle counts as an error
            continue
          } else if (ctrl.action === 'budget_override') {
            // Always clear the control row for budget_override — valid OR invalid —
            // so a malformed value never causes the row to replay every tick.
            // A valid positive value patches the cap for this cycle only (not persisted).
            pendingBudgetOverride = true
            if (ctrl.value !== null) {
              const capOverride = parseInt(ctrl.value, 10)
              if (Number.isFinite(capOverride) && capOverride > 0) {
                // Patch the manifest's budget cap for THIS cycle only (not persisted).
                controlledLoop = {
                  ...loop,
                  budget: { ...loop.budget, cap_micro_usd: capOverride },
                }
              } else {
                // Invalid / non-positive value: clear the row and log, do not apply.
                console.error(
                  `[loops/driver] budget_override on loop ${loop.id} has invalid value (${JSON.stringify(ctrl.value)}); cleared without applying.`,
                )
              }
            }
          }
        }
      } catch {
        // control check is best-effort; never abort the cycle
      }

      // Select the loop's CONFIG (reason + KPI) by its kind; queueGatedAct is config-
      // agnostic (gated acts → /approvals via wireGatedAct). A caller's deps.runtimeDeps
      // overrides any seam; cycleNum is driver-forced (applied last) so appendDecision
      // gets the right number. Selection uses controlledLoop so a per-cycle patch is honored.
      const cfg = loopRuntimeConfig(controlledLoop)
      const cycleNum = (cycleCounts.get(loop.id) ?? 0) + 1
      cycleCounts.set(loop.id, cycleNum)
      const runtimeDeps: RuntimeDeps = {
        queueGatedAct: wireGatedAct,
        reason: cfg.reason,
        observeKpi: cfg.observeKpi,
        ...deps.runtimeDeps,
        cycleNum,
      }

      const r = await runCycle(env, controlledLoop, runtimeDeps)
      ran++
      acted += r.acted
      gated += r.gated
      if (!r.ok) errors++

      // Clear budget_override after the cycle ran.
      if (pendingBudgetOverride) {
        try {
          await clearControl(env, loop.id)
        } catch {
          // best-effort
        }
      }

      // Stop-condition bookkeeping: a 'dry' tick advances the empty-round counter and
      // pauses the loop at dry_rounds_max (bounds idle loops); any productive tick resets it.
      try {
        const max = loop.stop.dry_rounds_max
        if (r.decided === 'dry') {
          if (typeof max === 'number' && max > 0) {
            const n = await bumpDry(env, loop.id)
            if (n >= max && (await pause(env, loop.id))) paused++
          }
        } else if (r.ok) {
          await resetDry(env, loop.id)
        }
      } catch {
        // bookkeeping is best-effort; never abort the sweep
      }
    } catch {
      errors++ // one bad cycle must not stop the rest
    }
  }

  return { ok: true, ran, acted, gated, paused, errors }
}
