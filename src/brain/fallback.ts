// brain/fallback — the pot's fallback brain tick (the hybrid keystone, v0.20).
//
// Closes the coherence loop POT-SIDE when no external mind is connected:
//
//   sweep    land/fail the fallback's own in-air flights from their linked task
//            (landed cost = the POT-METERED delta, not anyone's claim)
//   defer    if the mind pushed fresh field state, do nothing — the mind flies
//   measure  per active agent: C (EMA over ended flights) + backlog + activity
//            → regime (brain/measure.ts), mirrored into agent_field with
//            source='pot_fallback' (guarded: never overwrites a fresh mind row)
//   correct  on a defect, dispatch ONE gated flight whose goal is the agent's
//            oldest open task. dispatchFlight applies the full gate — readiness,
//            budget headroom, and the trust friction: a chaos agent whose recent
//            flights mostly failed gets HELD (agent_unreliable), which is the
//            coherent verdict — the correction for an unreliable agent is a human
//            looking at the board, not another auto-flight.
//
// The dispatched flight's `agent` is the agents.id (the meter identity), so the
// outcome stats, the budget reads, and the landing reconciliation all key on the
// same string. Execution itself stays with the existing organs: the task is already
// on the books and the metabolism heartbeat pulses the agent; the flight is the
// gated, costed RECORD of the correction.
//
// Opt-in (it tees up spend): BRAIN_FALLBACK="on". Gentle by construction: at most
// MAX_DISPATCH_PER_TICK corrections per tick, one in-air flight per agent, and the
// per-flight budget rides the agent's own budget_cap_cents.

import type { Env } from '../types'
import {
  coherenceFromOutcomes,
  classifyRegime,
  type OutcomeSample,
  type FallbackRegime,
} from './measure'
import { dispatchFlight } from '../flight/dispatch'
import { landFlight, failFlight, listFlights, type FlightRow } from '../flight/service'
import { parseMeterTakeoff } from '../flight/reconcile'
import { sumCostMicroUsdSince } from '../agents/meter'
import { MICRO_USD_PER_CENT } from '../agents/meter'

export const MIND_FRESH_MS = 60 * 60 * 1000 // a 'mind' push younger than this = mind awake
export const MAX_AGENTS_PER_TICK = 25
export const MAX_DISPATCH_PER_TICK = 3
export const FLIGHT_BUDGET_MICRO_USD = 50_000 // $0.05 default correction budget
export const FLIGHT_OVERDUE_MS = 24 * 60 * 60 * 1000 // in-air this long without landing = failed

export interface FallbackTickReport {
  ran: boolean
  reason?: 'disabled' | 'mind_awake'
  swept: { landed: number; failed: number }
  measured: number
  dispatched: string[] // flight ids
  skipped: Array<{ agent: string; reason: string }>
}

const NOOP: Omit<FallbackTickReport, 'ran' | 'reason'> = {
  swept: { landed: 0, failed: 0 },
  measured: 0,
  dispatched: [],
  skipped: [],
}

export async function runFallbackBrainTick(env: Env): Promise<FallbackTickReport> {
  if (env.BRAIN_FALLBACK !== 'on') return { ran: false, reason: 'disabled', ...NOOP }

  const now = Date.now()

  // ── defer: a fresh mind push means the real brain is flying this pot ──
  const fresh = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_field WHERE tenant=?1 AND source='mind' AND field_updated_at >= ?2`,
  )
    .bind(env.TENANT_SLUG, now - MIND_FRESH_MS)
    .first<{ n: number }>()
  if ((fresh?.n ?? 0) > 0) return { ran: false, reason: 'mind_awake', ...NOOP }

  const report: FallbackTickReport = { ran: true, ...NOOP, swept: { landed: 0, failed: 0 }, dispatched: [], skipped: [] }

  // ── sweep: close the fallback's own in-air flights from their linked task ──
  const all = await listFlights(env, 500)
  const inAir = all.filter(
    (f) =>
      (f.status === 'running' || f.status === 'waiting' || f.status === 'sleeping') &&
      flightMeta(f).brain === 'pot_fallback',
  )
  for (const f of inAir) {
    const taskId = flightMeta(f).work_task_id
    if (typeof taskId !== 'string' || !taskId) {
      await failFlight(env, f.id, 'task_missing')
      report.swept.failed++
      continue
    }
    const task = await env.DB.prepare(`SELECT status FROM tasks WHERE id=?1`)
      .bind(taskId)
      .first<{ status: string }>()
    if (!task) {
      await failFlight(env, f.id, 'task_missing')
      report.swept.failed++
    } else if (task.status === 'done') {
      // Land with the pot-METERED cost: the meter delta since takeoff is the
      // strongest cost record we have — no one's self-report involved.
      const takeoff = parseMeterTakeoff(f.meta)
      const cost = takeoff
        ? Math.max(0, (await sumCostMicroUsdSince(env, f.agent, takeoff.at)) - takeoff.cost_micro_usd)
        : 0
      await landFlight(env, f.id, { cost_micro_usd: cost })
      report.swept.landed++
    } else if (task.status === 'blocked') {
      await failFlight(env, f.id, 'task_blocked')
      report.swept.failed++
    } else if (now - f.created_at > FLIGHT_OVERDUE_MS) {
      await failFlight(env, f.id, 'overdue')
      report.swept.failed++
    }
    // open/in_progress within the window → still flying, leave it
  }

  // ── measure + correct, per active agent ──
  const agents = await env.DB.prepare(
    `SELECT id, slug, budget_cap_cents FROM agents WHERE status='active' ORDER BY id LIMIT ?1`,
  )
    .bind(MAX_AGENTS_PER_TICK)
    .all<{ id: string; slug: string; budget_cap_cents: number | null }>()

  for (const agent of agents.results ?? []) {
    // Outcomes, newest first → oldest first for the EMA. Flights key on agents.id.
    const ended = await env.DB.prepare(
      `SELECT status, ended_at FROM flights WHERE tenant=?1 AND agent=?2 AND status IN ('landed','failed')
       ORDER BY ended_at DESC LIMIT 10`,
    )
      .bind(env.TENANT_SLUG, agent.id)
      .all<{ status: 'landed' | 'failed'; ended_at: number | null }>()
    const samples = (ended.results ?? []).slice().reverse() as OutcomeSample[]
    const lastFlightEnd = (ended.results ?? []).reduce<number | null>(
      (m, r) => (r.ended_at != null && (m == null || r.ended_at > m) ? r.ended_at : m),
      null,
    )

    const backlogRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM tasks
       WHERE assignee_agent_id=?1 AND status IN ('open','in_progress','blocked')`,
    )
      .bind(agent.id)
      .first<{ n: number; last: string | null }>()
    const backlog = backlogRow?.n ?? 0
    const lastTaskTouch = backlogRow?.last ? Date.parse(backlogRow.last) : NaN
    const lastActivityAt = [lastFlightEnd, Number.isFinite(lastTaskTouch) ? lastTaskTouch : null]
      .filter((x): x is number => x != null)
      .reduce<number | null>((m, x) => (m == null || x > m ? x : m), null)

    const coherence = coherenceFromOutcomes(samples)
    const reading = classifyRegime({
      coherence,
      endedSample: samples.length,
      backlog,
      lastActivityAt,
      nowMs: now,
    })

    await mirrorField(env, agent.id, coherence, reading.regime, now)
    report.measured++

    if (!reading.defect) continue
    if (report.dispatched.length >= MAX_DISPATCH_PER_TICK) {
      report.skipped.push({ agent: agent.id, reason: 'tick_dispatch_cap' })
      continue
    }

    // One correction in the air per agent, ever.
    const flying = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM flights WHERE tenant=?1 AND agent=?2 AND status IN ('preflight','running','waiting','sleeping')`,
    )
      .bind(env.TENANT_SLUG, agent.id)
      .first<{ n: number }>()
    if ((flying?.n ?? 0) > 0) {
      report.skipped.push({ agent: agent.id, reason: 'already_flying' })
      continue
    }

    // A correction needs a goal the pot can point at: the oldest open task.
    const goalTask = await env.DB.prepare(
      `SELECT id, title FROM tasks WHERE assignee_agent_id=?1 AND status='open' ORDER BY created_at ASC LIMIT 1`,
    )
      .bind(agent.id)
      .first<{ id: string; title: string }>()
    if (!goalTask) {
      report.skipped.push({ agent: agent.id, reason: 'no_goal' })
      continue
    }

    const spentToday = await sumCostMicroUsdSince(env, agent.id, now)
    const capMicro = agent.budget_cap_cents && agent.budget_cap_cents > 0 ? agent.budget_cap_cents * MICRO_USD_PER_CENT : null
    const landedCount = samples.filter((s) => s.status === 'landed').length
    const result = await dispatchFlight(
      env,
      {
        agent: agent.id,
        goal: `[fallback ${reading.regime}] ${goalTask.title}`,
        trigger_source: 'cron',
        budget_micro_usd: FLIGHT_BUDGET_MICRO_USD,
        meta: { brain: 'pot_fallback', work_task_id: goalTask.id, regime: reading.regime, defect: reading.reason },
      },
      {
        contextComplete: true, // the goal task IS the loaded context
        toolsReachable: true, // the work runs on the pot's own task loop
        budgetRemainingMicroUsd: capMicro != null ? Math.max(0, capMicro - spentToday) : FLIGHT_BUDGET_MICRO_USD,
        budgetEstimateMicroUsd: FLIGHT_BUDGET_MICRO_USD,
        // Cold-start priors are optimistic-neutral; with history they are the record.
        recentProgress: coherence,
        progressPerStep: samples.length > 0 ? landedCount / samples.length : 0.5,
        wastePerStep: samples.length > 0 ? (samples.length - landedCount) / samples.length : 0.25,
        stepSeconds: 60,
      },
    )
    // GO or recorded hold — both are the loop working; only GO counts as dispatched.
    if (result.go) report.dispatched.push(result.id)
    else report.skipped.push({ agent: agent.id, reason: `held:${result.reasons.join(',')}` })
  }

  return report
}

// ── helpers ────────────────────────────────────────────────────────────────────

function flightMeta(f: FlightRow): Record<string, unknown> {
  try {
    const m = JSON.parse(f.meta)
    return m && typeof m === 'object' ? (m as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// Mirror the fallback measure into agent_field — provenance-marked and GUARDED:
// a fresh 'mind' row is never overwritten (the WHERE on the upsert); trust/spin
// are mind-owned and left untouched (slow-moving identity values keep serving
// orient even while the fallback owns coherence/regime).
async function mirrorField(env: Env, agentId: string, coherence: number, regime: FallbackRegime, nowMs: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO agent_field (tenant, agent_id, coherence, regime, field_updated_at, source)
       VALUES (?1, ?2, ?3, ?4, ?5, 'pot_fallback')
     ON CONFLICT(tenant, agent_id) DO UPDATE SET
       coherence = ?3, regime = ?4, field_updated_at = ?5, source = 'pot_fallback'
     WHERE agent_field.source != 'mind' OR agent_field.field_updated_at < ?6`,
  )
    .bind(env.TENANT_SLUG, agentId, coherence, regime, nowMs, nowMs - MIND_FRESH_MS)
    .run()
}
