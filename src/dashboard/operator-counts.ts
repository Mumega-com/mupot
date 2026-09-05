// dashboard/operator-counts.ts — the ONE "how many" helper for operator-facing hero
// KPIs (Flight-008 Slice 1, mupot#1060).
//
// Before this file, Home (index.ts observatoryBody), Health (health.ts loadOpsHealth),
// and the Fleet-presence tab (mission-control-views.ts potFleetBody) each computed their
// own "how many agents are live / how many need my decision" numbers from independently
// shaped queries. The owner asked the same question on two pages and got two answers
// (documented example: Home 25 agents vs Health 23; Home 127 decisions vs Health 130) —
// the N-homes disease at the UI layer. See agents/river/docs/flight-008-2026-08-15/
// slice-1-canonical-truth.md (mumega.com repo) for the full brief.
//
// Design, mirroring the pure-builder/thin-D1-wiring split this codebase already uses for
// the same reason in dashboard/radar.ts (buildFleetRadar/loadFleetRadar):
//   - computeOperatorCounts is PURE (no I/O) — every surface's hero numbers derive from
//     THIS one function. Mutate a filter here and every caller changes with it, because
//     there is nowhere else the arithmetic could live.
//   - loadOperatorCounts is a thin D1-wiring convenience for callers that have not
//     already loaded the underlying maps. Callers that already have agents/stats/
//     runtimeStates/approvals loaded for their own rendering (Home does — the swimlane
//     and directory table need the same data) call computeOperatorCounts directly
//     instead of re-querying.
//
// Inputs are themselves the EXISTING canonical loaders, not new queries:
//   - loadAgentStats / loadAgentRuntimeStates: dashboard/observatory.ts (already the
//     shared source radar.ts's Fleet/ATC summary and Home's swimlane both use — see
//     observatory.ts and radar.ts's own header comments on why liveness is not
//     reinvented per surface).
//   - loadApprovals: dashboard/approvals.ts (the RBAC + gate_owner-scoped gate queue —
//     the only "review" tasks that are actually verdictable; see approvals.ts's own
//     comment on why an ungated review task must not be counted as needing a decision).
//   - loadTaskStatusCounts: one grouped COUNT owned by this file, for the "how many
//     tasks are blocked/rejected" evidence Health's Failures stat needs.
//
// What this file deliberately does NOT unify: per-project situation/detail queries
// (src/projects/situation.ts) and the presence-based "Present now" tally on the
// Fleet-presence tab (mission-control-views.ts potFleetBody, sourced from
// fleet/presence.ts listPresence). Both answer a genuinely different question —
// project-scoped detail rows, and "who/what has checked into this pot at all"
// (agents AND bound members), not "how many configured agents have a live runtime" —
// see the Flight-008 Slice 1 PR description for the full scoping rationale, including
// the pre-existing, separately-tracked dual-liveness-source gap (mupot#732) this slice
// does not attempt to collapse.

import type { Agent, AuthContext, Env } from '../types'
import { loadAgentStats, loadAgentRuntimeStates, type AgentStat, type AgentRuntimeState } from './observatory'
import { loadApprovals, type ApprovalsQueue } from './approvals'

export interface OperatorCounts {
  generatedAtMs: number
  /** agents.length — every configured agent identity in this pot, any status. */
  agentsTotal: number
  /** agents.status = 'active' (catalog intent — enabled, not necessarily connected). */
  agentsActive: number
  /** agents.status = 'paused'. agentsActive + agentsPaused === agentsTotal. */
  agentsPaused: number
  /** Agents whose runtime state (observatory.ts deriveAgentRuntimeState) is 'live'. */
  liveRuntimeCount: number
  /** Sum of AgentStat.in_flight (open|in_progress tasks) over the 24h stats window. */
  inFlightTotal: number
  /** Sum of AgentStat.spend_micro_usd over the 24h stats window. */
  spendMicroUsdTotal: number
  /** loadApprovals(env, auth).actionableCount — the RBAC+gate_owner-scoped gate
   *  queue's actionable rows. This IS "needs your decision": the only tasks a
   *  verdict endpoint will actually accept (mupot#1319 round 2 FINDING 4/2:
   *  this used to be approvals.length, which counted informational/
   *  unactionable rows too — a caller who lost squad access but still holds
   *  a stale gate grant is NOT "needing a decision" by this comment's own
   *  definition). */
  needsDecisionCount: number
  /** True when needsDecisionCount is a LOWER BOUND, not the exact total — see
   *  ApprovalsQueue.actionableCountIsLowerBound (src/dashboard/approvals.ts).
   *  A surface rendering this MUST show it as "N+" or otherwise signal
   *  incompleteness when true, never a bare exact-looking number. */
  needsDecisionCountIsLowerBound: boolean
  /** tasks.status IN ('blocked', 'rejected'), from the shared grouped count. */
  blockedOrRejectedCount: number
}

export interface OperatorCountsInputs {
  nowMs: number
  agents: Array<Pick<Agent, 'id' | 'status'>>
  stats: Map<string, AgentStat>
  runtimeStates: Map<string, AgentRuntimeState>
  // The full ApprovalsQueue (loadApprovals' return value) is accepted here —
  // only actionableCount/actionableCountIsLowerBound are read; `items` is
  // ignored (callers that also RENDER the queue, e.g. dashboard/index.ts's
  // two routes, pass approvals.items separately to their own card renderer).
  approvals: Pick<ApprovalsQueue, 'actionableCount' | 'actionableCountIsLowerBound'>
  /** status -> count, e.g. from loadTaskStatusCounts. Only 'blocked'/'rejected' are read. */
  taskStatusCounts: Map<string, number>
}

/** Pure. No I/O. Every surface's hero numbers must derive from this one function —
 *  see the module header. Do not re-derive any of these fields inline in a view. */
export function computeOperatorCounts(inputs: OperatorCountsInputs): OperatorCounts {
  const { nowMs, agents, stats, runtimeStates, approvals, taskStatusCounts } = inputs

  let agentsActive = 0
  let agentsPaused = 0
  let liveRuntimeCount = 0
  let inFlightTotal = 0
  let spendMicroUsdTotal = 0

  for (const a of agents) {
    if (a.status === 'active') agentsActive++
    else if (a.status === 'paused') agentsPaused++

    if (runtimeStates.get(a.id) === 'live') liveRuntimeCount++

    const s = stats.get(a.id)
    if (s) {
      inFlightTotal += s.in_flight
      spendMicroUsdTotal += s.spend_micro_usd
    }
  }

  const blockedOrRejectedCount =
    (taskStatusCounts.get('blocked') ?? 0) + (taskStatusCounts.get('rejected') ?? 0)

  return {
    generatedAtMs: nowMs,
    agentsTotal: agents.length,
    agentsActive,
    agentsPaused,
    liveRuntimeCount,
    inFlightTotal,
    spendMicroUsdTotal,
    needsDecisionCount: approvals.actionableCount,
    needsDecisionCountIsLowerBound: approvals.actionableCountIsLowerBound,
    blockedOrRejectedCount,
  }
}

interface TaskStatusRow {
  status: string
  count: number | string
}

/** The ONE grouped tasks-by-status count. Callers that need the raw breakdown (e.g.
 *  Health's "Task queues" check, which also shows open/in_progress in its detail text)
 *  call this directly instead of hand-writing a second GROUP BY. */
export async function loadTaskStatusCounts(env: Env): Promise<Map<string, number>> {
  const rs = await env.DB.prepare('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status').all<TaskStatusRow>()
  const map = new Map<string, number>()
  for (const row of rs.results ?? []) {
    const n = typeof row.count === 'number' ? row.count : Number(row.count)
    map.set(row.status, Number.isFinite(n) ? n : 0)
  }
  return map
}

/** Thin D1 wiring for callers that have NOT already loaded agents/stats/runtimeStates/
 *  approvals for their own rendering. Home and Health already have (or need) some of
 *  these independently shaped, so their routes call computeOperatorCounts directly with
 *  their own fetched inputs — see index.ts's `/` route and health.ts's loadOpsHealth. */
export async function loadOperatorCounts(
  env: Env,
  auth: AuthContext,
  nowMs = Date.now(),
): Promise<OperatorCounts> {
  const [agentRows, stats, runtimeStates, approvals, taskStatusCounts] = await Promise.all([
    env.DB.prepare('SELECT id, status FROM agents').all<Pick<Agent, 'id' | 'status'>>(),
    loadAgentStats(env),
    loadAgentRuntimeStates(env, nowMs),
    loadApprovals(env, auth),
    loadTaskStatusCounts(env),
  ])

  return computeOperatorCounts({
    nowMs,
    agents: agentRows.results ?? [],
    stats,
    runtimeStates,
    approvals,
    taskStatusCounts,
  })
}
