// mupot — the Loop runtime: the manifest-driven cycle the container runs (P2, #33).
//
// This generalizes the agent goal loop (src/agents/loop.ts) into a source/channel-
// agnostic cycle driven by a LoopManifest:
//
//   perceive → reason → act (through the gate) → observe → stop
//
// The container's job is to RUN the cycle and ENFORCE the resource accounting; it is
// NOT where the cleverness lives. The `reason` step is a thin, SWAPPABLE seam — the
// reasoning loop itself is commoditized (market scan 2026-06-08), so we abstract it
// out rather than differentiate on it. Our value is the container + governance.
//
// Everything I/O is an injected seam (resolve / meterCheck / reason / performAct /
// observeKpi), so the decision flow is unit-tested with no model, D1, or network.

import type { Env, ModelPort } from '../types'
import type { LoopManifest, ResourceRef } from './manifest'
import { resolveResource } from './resources'
import type { ResolvedResource, ResourceItem } from './resources'
import { checkAndReserve, recordTokens } from '../agents/meter'
import { costMicroUsd } from '../agents/cost'
import { LOOP_PLANNING_MAX_TOKENS } from '../agents/loop'

// ── results ─────────────────────────────────────────────────────────────────────

export type LoopDecided =
  | 'inactive' // status !== 'active' — not run
  | 'kpi-met' // observed KPI >= 100 — goal reached
  | 'budget_exhausted' // dollar cap reached — zero spend
  | 'rate_limited' // count/token cap — zero spend
  | 'dry' // perceive produced nothing actionable
  | 'acted' // at least one ungated act fired on a channel
  | 'gated_pending' // acts were queued for human approval (nothing fired)

export interface LoopCycleResult {
  ok: boolean
  decided: LoopDecided
  perceived: number
  acted: number // ungated acts that fired on a channel
  gated: number // acts routed to the approval gate (queued, NOT fired)
  kpi: number // observed KPI (0..100) after the cycle
  error?: string
}

/** A proposed action targeting one of the loop's bound channels (or an internal task). */
export interface ProposedAct {
  channel_index: number // index into loop.channels; -1 = internal task only
  tool: string // tool to call on the channel
  args: Record<string, unknown>
  summary: string
}

export interface ReasonInput {
  loop: LoopManifest
  context: ResourceItem[] // what perceive gathered from the sources
  budget: number // max acts this cycle (effort-derived)
}

export interface PerformActDeps {
  resolve: (env: Env, ref: ResourceRef) => ResolvedResource
}

export interface RuntimeDeps {
  resolve?: (env: Env, ref: ResourceRef) => ResolvedResource
  meterCheck?: typeof checkAndReserve
  recordTokens?: typeof recordTokens
  /** Swappable reasoning seam. Default proposes nothing (the container is reasoning-agnostic). */
  reason?: (env: Env, input: ReasonInput) => Promise<ProposedAct[]>
  /** Fires ONE ungated act on its bound channel. Only ever called for an ungated loop. */
  performAct?: (env: Env, loop: LoopManifest, act: ProposedAct, deps: PerformActDeps) => Promise<void>
  /** Queues ONE act for human approval (gated loops). Default: throws until P4 wires the pipeline. */
  queueGatedAct?: (env: Env, loop: LoopManifest, act: ProposedAct) => Promise<void>
  /** Observe the outcome KPI (0..100). Default = 0 (a real signal lands in P3). */
  observeKpi?: (env: Env, loop: LoopManifest) => Promise<number>
  model?: ModelPort
}

// effort → how many acts the loop may produce per cycle (mirrors agents/loop.ts).
const EFFORT_ACT_BUDGET: Record<string, number> = { low: 0, standard: 1, high: 2, sprint: 3 }

/**
 * runLoopCycle — one tick of a loop. Pure decision flow over injected seams.
 *
 *  1. inactive guard (status)
 *  2. observe KPI → kpi-met guard
 *  3. budget gate (enforcement $cap, reused from the meter) → rate_limited/budget_exhausted
 *  4. perceive bound sources → context; empty ⇒ dry
 *  5. reason → proposed acts (≤ effort budget)
 *  6. act: route each through performAct (gate policy applied there)
 *  7. record planning spend; re-observe KPI for the result
 */
export async function runLoopCycle(
  env: Env,
  loop: LoopManifest,
  deps: RuntimeDeps = {},
): Promise<LoopCycleResult> {
  const resolve = deps.resolve ?? resolveResource
  const meterCheck = deps.meterCheck ?? checkAndReserve
  const reason = deps.reason ?? (async () => [])
  const performAct = deps.performAct ?? defaultPerformAct
  const queueGatedAct = deps.queueGatedAct ?? defaultQueueGatedAct
  const observeKpi = deps.observeKpi ?? (async () => 0)

  // 1. inactive guard
  if (loop.status !== 'active') {
    return { ok: true, decided: 'inactive', perceived: 0, acted: 0, gated: 0, kpi: 0 }
  }

  // 2. kpi-met guard
  const kpiBefore = clampKpi(await observeKpi(env, loop))
  if (kpiBefore >= 100) {
    return { ok: true, decided: 'kpi-met', perceived: 0, acted: 0, gated: 0, kpi: kpiBefore }
  }

  // The meter is per-subject; a loop is owned by exactly one work-unit.
  const subjectId = loop.agent_id ?? loop.squad_id
  if (!subjectId) {
    return { ok: false, decided: 'inactive', perceived: 0, acted: 0, gated: 0, kpi: kpiBefore, error: 'loop_has_no_owner' }
  }

  const effort = loop.budget.effort ?? 'standard'
  const actBudget = EFFORT_ACT_BUDGET[effort] ?? 1

  // 3. budget gate — reuse the enforcement meter. The manifest cap is micro-USD; pass
  // it VERBATIM (budgetCapMicroUsd) so an intentful sub-cent cap can never round to
  // unlimited (the meter takes a precise micro cap; no lossy cents conversion here).
  const estimateMicroUsd = costMicroUsd(loopModel(loop), LOOP_PLANNING_MAX_TOKENS)
  const meterResult = await meterCheck(env, subjectId, {
    estimateMicroUsd,
    budgetCapMicroUsd: loop.budget.cap_micro_usd ?? null,
    budgetWindow: loop.budget.window ?? 'day',
  })
  if (!meterResult.ok) {
    const decided: LoopDecided =
      meterResult.reason === 'budget_cap_exceeded' ? 'budget_exhausted' : 'rate_limited'
    return { ok: false, decided, perceived: 0, acted: 0, gated: 0, kpi: kpiBefore, error: meterResult.reason }
  }

  // effort=low ⇒ observe-only: no perceive/reason/act, just KPI tracking.
  if (actBudget === 0) {
    return { ok: true, decided: 'dry', perceived: 0, acted: 0, gated: 0, kpi: kpiBefore }
  }

  // 4. perceive — read every bound source; tolerate a failing source (skip it).
  const context: ResourceItem[] = []
  for (const ref of loop.sources) {
    try {
      const handle = resolve(env, ref)
      const items = await handle.read(loop.okr, { limit: 5 })
      context.push(...items)
    } catch {
      // a broken source must not abort the cycle; the loop perceives what it can
    }
  }
  if (context.length === 0) {
    return { ok: true, decided: 'dry', perceived: 0, acted: 0, gated: 0, kpi: kpiBefore }
  }

  // 5. reason — propose acts (bounded by effort).
  let proposed: ProposedAct[] = []
  try {
    proposed = (await reason(env, { loop, context, budget: actBudget })).slice(0, actBudget)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'reason_failed'
    return { ok: false, decided: 'dry', perceived: context.length, acted: 0, gated: 0, kpi: kpiBefore, error: msg }
  }

  // 6. act — the GATE DECISION IS STRUCTURAL HERE, not delegated to a seam: a gated
  // loop NEVER reaches performAct (channel fire); its acts are queued for approval.
  // This is the load-bearing guarantee — the human gate cannot be bypassed by an
  // injected performAct.
  const gatePending = loop.gate.require_approval === true
  let acted = 0
  let gated = 0
  for (const act of proposed) {
    try {
      if (gatePending) {
        await queueGatedAct(env, loop, act) // pending approval; nothing fires
        gated++
      } else {
        await performAct(env, loop, act, { resolve })
        acted++
      }
    } catch {
      // one failed act must not abort the rest
    }
  }

  // 7. record the planning spend (so the $cap sees the loop's own burn) + re-observe.
  const record = deps.recordTokens ?? recordTokens
  try {
    await record(env, subjectId, LOOP_PLANNING_MAX_TOKENS, estimateMicroUsd)
  } catch {
    // best-effort accounting
  }
  const kpiAfter = clampKpi(await observeKpi(env, loop))

  const decided: LoopDecided = acted > 0 ? 'acted' : gated > 0 ? 'gated_pending' : 'dry'
  return { ok: true, decided, perceived: context.length, acted, gated, kpi: kpiAfter }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function clampKpi(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, n))
}

/**
 * The model id used to price a planning call. A LoopManifest does not carry a model
 * (that lives on the owning agent); until the runtime is wired to load the owner's
 * model (P3), we price at a conservative default so the estimate never reads low.
 */
function loopModel(_loop: LoopManifest): string {
  return 'unknown-premium' // resolves to the family/fallback ceiling in cost.ts
}

/**
 * Default channel fire (ungated acts only — runLoopCycle never calls this for a gated
 * loop). Resolves the bound channel and calls the tool. Defense in depth: refuse if the
 * loop is somehow gated.
 */
async function defaultPerformAct(
  env: Env,
  loop: LoopManifest,
  act: ProposedAct,
  deps: PerformActDeps,
): Promise<void> {
  if (loop.gate.require_approval) {
    throw new Error('gated_act_must_not_fire') // belt-and-suspenders; the cycle already branched
  }
  if (act.channel_index < 0 || act.channel_index >= loop.channels.length) {
    throw new Error('act_channel_out_of_range')
  }
  const channel = deps.resolve(env, loop.channels[act.channel_index])
  await channel.act(act.tool, act.args)
}

/**
 * Default gated-act handler. The approval pipeline (verdict + GHL act-channel) is wired
 * in P4 (#35). Until then a gated act throws here — so a gated loop visibly errors per
 * act (decided stays 'dry', gated stays 0) rather than silently appearing to have acted.
 */
async function defaultQueueGatedAct(_env: Env, _loop: LoopManifest, _act: ProposedAct): Promise<void> {
  throw new Error('gated_approval_pipeline_unwired')
}
