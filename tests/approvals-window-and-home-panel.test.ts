// mupot#1995 — pins the three behaviours the #1994 gate found unpinned:
//  (a) selectQueueWindow puts the viewer's OWN rows first, so >200 other-reviewer actionable rows
//      cannot push own cards out of the window while ownCount still counts them;
//  (b) ownCountIsLowerBound follows the OWN count (own overflow or candidate truncation) only;
//  (c) Home's "Needs your decision" panel shows when rows are rendered (approvals.length), not
//      when the own KPI count is non-zero.
import { describe, expect, it } from 'vitest'
import { APPROVALS_FETCH_CEILING, APPROVALS_QUEUE_LIMIT, selectQueueWindow, type ApprovalItem } from '../src/dashboard/approvals'
import { observatoryBody } from '../src/dashboard/index'
import type { OperatorCounts } from '../src/dashboard/operator-counts'
import type { ObservatoryData } from '../src/dashboard/observatory'
import type { AuthContext } from '../src/types'

function item(id: string, own: boolean, canVerdict = true): ApprovalItem {
  return {
    id, squad_id: 's1', squad_name: 'S', title: `T ${id}`, body: '', gate_owner: 'gate:x',
    assignee_agent_id: null, agent_name: null, result: null, completed_at: null,
    created_at: '2026-01-01T00:00:00.000Z', own_gate: own,
    can_verdict: canVerdict, can_approve: canVerdict, can_reject: canVerdict,
  }
}
const many = (prefix: string, n: number, own: boolean, canVerdict = true): ApprovalItem[] =>
  Array.from({ length: n }, (_, i) => item(`${prefix}-${String(i)}`, own, canVerdict))

describe('selectQueueWindow own-first ordering (#1995 a)', () => {
  it('own cards survive when more than the limit of other-reviewer actionable rows are older', () => {
    // Other reviewers' rows are OLDER (first in candidate order) and fill the whole window.
    const decorated = [...many('other', APPROVALS_QUEUE_LIMIT + 50, false), ...many('own', 3, true)]
    const q = selectQueueWindow(decorated)
    expect(q.items).toHaveLength(APPROVALS_QUEUE_LIMIT)
    const shownOwn = q.items.filter((t) => t.own_gate === true && t.can_verdict)
    expect(shownOwn.map((t) => t.id)).toEqual(['own-0', 'own-1', 'own-2'])
    expect(q.ownCount).toBe(3)
    expect(q.ownCount).toBe(shownOwn.length)
    expect(q.items[0]?.id).toBe('own-0')
  })
})

describe('selectQueueWindow ownCountIsLowerBound (#1995 b)', () => {
  it('is false for a small exact own count, even when other rows overflow the window', () => {
    const q = selectQueueWindow([...many('other', APPROVALS_QUEUE_LIMIT + 5, false), ...many('own', 2, true)])
    expect(q.actionableCountIsLowerBound).toBe(true)
    expect(q.ownCountIsLowerBound).toBe(false)
  })
  it('is true when own rows exceed the display window', () => {
    const q = selectQueueWindow(many('own', APPROVALS_QUEUE_LIMIT + 1, true))
    expect(q.ownCount).toBe(APPROVALS_QUEUE_LIMIT)
    expect(q.ownCountIsLowerBound).toBe(true)
  })
  it('is true when the candidate fetch hit the ceiling, even with few own rows', () => {
    const q = selectQueueWindow([...many('other', APPROVALS_FETCH_CEILING - 1, false), item('own-0', true)])
    expect(q.ownCount).toBe(1)
    expect(q.ownCountIsLowerBound).toBe(true)
  })
})

describe('Home operator panel visibility (#1995 c)', () => {
  const auth = { userId: 'u', memberId: 'm', email: null, role: 'owner', tenant: 't', capabilities: [] } as unknown as AuthContext // test fixture: only fields observatoryBody reads
  const data: ObservatoryData = {
    agents: [], stats: new Map(), runtimeStates: new Map(), bars: [],
    ticks: ['a', 'b', 'c', 'd', 'e', 'f', 'now'], recentTasks: [],
  }
  const counts = (own: number): OperatorCounts => ({
    generatedAtMs: 0, agentsTotal: 0, agentsActive: 0, agentsPaused: 0, liveRuntimeCount: 0,
    inFlightTotal: 0, spendMicroUsdTotal: 0, needsDecisionCount: own, needsDecisionCountIsLowerBound: false,
    allReviewersCount: own, allReviewersCountIsLowerBound: false, blockedOrRejectedCount: 0,
  })
  it('shows other reviewers\' rendered cards even when the viewer\'s own count is 0', () => {
    const html = String(observatoryBody('B', data, [item('other-1', false)], auth, counts(0)))
    expect(html).toContain('data-task="other-1"')
    expect(html).not.toContain('Gate clear')
  })
  it('shows the empty state when no rows are rendered', () => {
    const html = String(observatoryBody('B', data, [], auth, counts(0)))
    expect(html).toContain('Gate clear')
  })
})
