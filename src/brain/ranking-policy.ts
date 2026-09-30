// mupot — default BrainPort adapter: SOS perceive→rank→rest policy (rank-only).
//
// See docs/architecture/sos-brain-ranking-policy-path.md.
//
// Keystone (port-interfaces-model-brain.md / types.ts BrainPort):
//   the brain RANKS / PROPOSES — never acts. No Env, no D1, no bus, no wake.
//   Stable BrainContext → stable BrainDecision (idempotent rest when noop).
//
// This is Slice A of the SOS-brain port: the reusable policy from SOS
// (perceive → rank → dispatch-to-owner → rest) without forking field physics.

import type {
  BrainContext,
  BrainDecision,
  BrainPort,
  BrainProposal,
} from '../types'

export const RANKING_POLICY_ID = 'sos-ranking-policy/v1' as const

/** Actionable board statuses the policy ranks over (aligns with tasks/ranking.ts bands). */
const STATUS_PRIORITY: Readonly<Record<string, number>> = {
  in_progress: 0,
  open: 1,
  blocked: 2,
}

function actionableTasks(ctx: BrainContext): BrainContext['board'] {
  return ctx.board.filter((t) => t.status in STATUS_PRIORITY)
}

function sortBoard(board: BrainContext['board']): BrainContext['board'] {
  return [...board].sort((a, b) => {
    const band = (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99)
    if (band !== 0) return band
    // Stable tie-break on taskId so identical contexts yield identical order.
    return a.taskId.localeCompare(b.taskId)
  })
}

function directiveBias(ctx: BrainContext): string | null {
  const d = ctx.lastHumanDirective?.trim()
  return d && d.length > 0 ? d : null
}

function budgetStarved(ctx: BrainContext): boolean {
  return typeof ctx.budgetRemainingMicroUsd === 'number' && ctx.budgetRemainingMicroUsd <= 0
}

function goalsIncomplete(ctx: BrainContext): boolean {
  return ctx.goals.some((g) => g.kpiProgress < 100 && g.okr.trim().length > 0)
}

function withDirective(summary: string, directive: string | null): string {
  if (!directive) return summary
  // Keep directive audible without turning the brain into a steerer that acts.
  const clipped = directive.length > 120 ? `${directive.slice(0, 117)}...` : directive
  return `${summary} [directive: ${clipped}]`
}

function noop(summary: string, priority = 0): BrainProposal {
  return { kind: 'noop', summary, priority }
}

/**
 * Pure ranking: board + goals + directive + budget → ordered proposals.
 * Never mutates ctx; never performs I/O.
 */
export function decideRankingPolicy(ctx: BrainContext): BrainDecision {
  const directive = directiveBias(ctx)
  const actionable = sortBoard(actionableTasks(ctx))

  if (budgetStarved(ctx)) {
    return {
      ranked: [noop(withDirective('rest: budget exhausted — no new work', directive))],
      rationale: `${RANKING_POLICY_ID}: budget_starved`,
    }
  }

  if (actionable.length === 0) {
    if (goalsIncomplete(ctx)) {
      // Goals exist but board is empty — propose wake so an owner can refill work.
      // Core still gates; this adapter does not wake.
      const goal = ctx.goals.find((g) => g.kpiProgress < 100 && g.okr.trim().length > 0)!
      const proposal: BrainProposal = {
        kind: 'wake_agent',
        agentId: goal.agentId,
        summary: withDirective(
          `wake owner for incomplete goal (${goal.okr.slice(0, 80)}; kpi=${goal.kpiProgress})`,
          directive,
        ),
        priority: 1,
      }
      return {
        ranked: [proposal, noop('rest after owner wake if still empty')],
        rationale: `${RANKING_POLICY_ID}: empty_board_incomplete_goal`,
      }
    }
    return {
      ranked: [noop(withDirective('rest: no actionable work', directive))],
      rationale: `${RANKING_POLICY_ID}: empty_board`,
    }
  }

  const ranked: BrainProposal[] = []
  let priority = 1

  for (const task of actionable) {
    if (task.status === 'blocked') {
      ranked.push(
        noop(
          withDirective(
            `surface blocked task ${task.taskId} (awaiting external clear)`,
            directive,
          ),
          priority++,
        ),
      )
      continue
    }

    if (task.status === 'in_progress' && task.agentId) {
      ranked.push({
        kind: 'wake_agent',
        agentId: task.agentId,
        summary: withDirective(
          `finish in_progress task ${task.taskId} before starting new work`,
          directive,
        ),
        priority: priority++,
      })
      continue
    }

    // open (or in_progress without assignee): propose spawn/claim shape for core.
    ranked.push({
      kind: 'spawn_task',
      agentId: task.agentId ?? undefined,
      summary: withDirective(
        `prioritize ${task.status} task ${task.taskId}`,
        directive,
      ),
      doneWhen: `task ${task.taskId} reaches a terminal or gate status`,
      priority: priority++,
    })
  }

  ranked.push(noop('rest when ranked work is owned or complete'))

  return {
    ranked,
    rationale: `${RANKING_POLICY_ID}: ranked_${actionable.length}_actionable`,
  }
}

/** Default BrainPort adapter — swappable; sealed gates stay outside. */
export function createRankingPolicyBrain(): BrainPort {
  return {
    decide(ctx: BrainContext): Promise<BrainDecision> {
      return Promise.resolve(decideRankingPolicy(ctx))
    },
  }
}
