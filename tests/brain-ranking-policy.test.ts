// Unit tests for the default BrainPort ranking policy (SOS perceive→rank→rest).
// Pure: no D1, no Env, no network — proves rank-not-act by construction.

import { describe, expect, it } from 'vitest'
import type { BrainContext } from '../src/types'
import {
  createRankingPolicyBrain,
  decideRankingPolicy,
  RANKING_POLICY_ID,
} from '../src/brain/ranking-policy'

function ctx(partial: Partial<BrainContext> = {}): BrainContext {
  return {
    tenant: 'test',
    goals: [],
    board: [],
    ...partial,
  }
}

describe('decideRankingPolicy — rest when healthy / starved', () => {
  it('noops on empty board with no goals', () => {
    const d = decideRankingPolicy(ctx())
    expect(d.ranked).toHaveLength(1)
    expect(d.ranked[0].kind).toBe('noop')
    expect(d.rationale).toContain(RANKING_POLICY_ID)
    expect(d.rationale).toContain('empty_board')
  })

  it('noops when budget is exhausted even if board has open work', () => {
    const d = decideRankingPolicy(
      ctx({
        budgetRemainingMicroUsd: 0,
        board: [{ taskId: 't1', status: 'open', agentId: null }],
      }),
    )
    expect(d.ranked[0].kind).toBe('noop')
    expect(d.ranked[0].summary).toMatch(/budget/)
    expect(d.rationale).toContain('budget_starved')
  })

  it('proposes wake_agent when goals incomplete and board empty', () => {
    const d = decideRankingPolicy(
      ctx({
        goals: [{ agentId: 'a1', okr: 'ship ranking policy', kpiProgress: 10 }],
      }),
    )
    expect(d.ranked[0]).toMatchObject({
      kind: 'wake_agent',
      agentId: 'a1',
    })
    expect(d.rationale).toContain('empty_board_incomplete_goal')
  })
})

describe('decideRankingPolicy — board ranking order', () => {
  it('ranks in_progress before open before blocked', () => {
    const d = decideRankingPolicy(
      ctx({
        board: [
          { taskId: 'blocked-1', status: 'blocked', agentId: 'a1' },
          { taskId: 'open-1', status: 'open', agentId: null },
          { taskId: 'wip-1', status: 'in_progress', agentId: 'a2' },
        ],
      }),
    )
    const actionable = d.ranked.filter((p) => p.kind !== 'noop' || p.summary.includes('blocked'))
    expect(actionable[0].kind).toBe('wake_agent')
    expect(actionable[0].agentId).toBe('a2')
    expect(actionable[0].summary).toMatch(/wip-1/)
    expect(actionable[1].kind).toBe('spawn_task')
    expect(actionable[1].summary).toMatch(/open-1/)
    expect(actionable[2].kind).toBe('noop')
    expect(actionable[2].summary).toMatch(/blocked-1/)
  })

  it('is idempotent for a stable context', () => {
    const input = ctx({
      lastHumanDirective: 'finish the gate first',
      board: [
        { taskId: 'b', status: 'open', agentId: null },
        { taskId: 'a', status: 'open', agentId: null },
      ],
    })
    const once = decideRankingPolicy(input)
    const twice = decideRankingPolicy(input)
    expect(twice).toEqual(once)
  })

  it('biases summaries with the human directive without changing kind', () => {
    const d = decideRankingPolicy(
      ctx({
        lastHumanDirective: 'no new features',
        board: [{ taskId: 't9', status: 'open', agentId: null }],
      }),
    )
    expect(d.ranked[0].kind).toBe('spawn_task')
    expect(d.ranked[0].summary).toContain('[directive: no new features]')
  })

  it('ignores terminal board rows (done/review) for ranking', () => {
    const d = decideRankingPolicy(
      ctx({
        board: [
          { taskId: 'done-1', status: 'done', agentId: 'a1' },
          { taskId: 'review-1', status: 'review', agentId: 'a1' },
        ],
      }),
    )
    expect(d.ranked[0].kind).toBe('noop')
    expect(d.rationale).toContain('empty_board')
  })
})

describe('createRankingPolicyBrain — BrainPort seam', () => {
  it('exposes async decide matching the pure function', async () => {
    const brain = createRankingPolicyBrain()
    const input = ctx({ board: [{ taskId: 't1', status: 'open', agentId: null }] })
    const fromPort = await brain.decide(input)
    expect(fromPort).toEqual(decideRankingPolicy(input))
  })
})
