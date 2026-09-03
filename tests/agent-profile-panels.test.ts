import { describe, expect, it } from 'vitest'
import {
  PANELS,
  formatCost,
  panelByKey,
  summariseFlights,
  summariseWork,
  empty,
  ready,
  unavailable,
} from '../src/dashboard/agent-profile'

describe('panel state — absent and zero must never look alike', () => {
  it('marks a failed read unavailable, with a reason the reader can see', () => {
    const r = unavailable<string>('Flight history could not be read.')
    expect(r.state).toBe('unavailable')
    expect(r.reason).toBe('Flight history could not be read.')
    expect(r.data).toBeUndefined()
  })

  it('marks a successful read of nothing as empty, carrying no reason', () => {
    const r = empty<string>()
    expect(r.state).toBe('empty')
    expect(r.reason).toBeUndefined()
  })

  it('never reports unavailable as empty — that is the whole point of the split', () => {
    expect(unavailable<string>('x').state).not.toBe(empty<string>().state)
  })

  it('carries data only when ready', () => {
    expect(ready('x').data).toBe('x')
    expect(empty<string>().data).toBeUndefined()
    expect(unavailable<string>('x').data).toBeUndefined()
  })
})

describe('flight summary', () => {
  const rows = [
    { id: 'f1', goal: 'a', status: 'landed', cost_micro_usd: 1_500_000, created_at: '2026-09-03' },
    { id: 'f2', goal: 'b', status: 'failed', cost_micro_usd: 0, created_at: '2026-09-02' },
    { id: 'f3', goal: 'c', status: 'held', cost_micro_usd: 0, created_at: '2026-09-01' },
    { id: 'f4', goal: 'd', status: 'running', cost_micro_usd: 500_000, created_at: '2026-08-31' },
    { id: 'f5', goal: 'e', status: 'landed', cost_micro_usd: null, created_at: '2026-08-30' },
  ]

  it('counts each terminal and non-terminal status separately', () => {
    const s = summariseFlights(rows)
    expect(s.total).toBe(5)
    expect(s.landed).toBe(2)
    expect(s.failed).toBe(1)
    expect(s.held).toBe(1)
    expect(s.running).toBe(1)
  })

  it('sums cost across flights and survives a null cost', () => {
    expect(summariseFlights(rows).costMicroUsd).toBe(2_000_000)
  })

  // A null row does NOT exercise the finite-check: Number(null) is 0, not NaN.
  // A surviving mutation proved that. SQLite has dynamic column typing, so a
  // declared-INTEGER column can genuinely hold a string; that is the case the
  // guard exists for, and this is the case that kills the mutation.
  it('ignores a non-numeric cost instead of poisoning the whole sum with NaN', () => {
    const poisoned = [
      { id: 'f1', goal: 'a', status: 'landed', cost_micro_usd: 1_000_000, created_at: 'd1' },
      { id: 'f2', goal: 'b', status: 'landed', cost_micro_usd: 'not-a-number' as unknown as number, created_at: 'd2' },
      { id: 'f3', goal: 'c', status: 'landed', cost_micro_usd: 500_000, created_at: 'd3' },
    ]
    const s = summariseFlights(poisoned)
    expect(s.costMicroUsd).toBe(1_500_000)
    expect(Number.isNaN(s.costMicroUsd)).toBe(false)
    expect(s.total).toBe(3)
  })

  // A flight reaped by the watchdog really did cost zero. Rounding that away
  // would hide the most common failure on this deployment.
  it('keeps a zero-cost failed flight in the counts rather than discarding it', () => {
    const s = summariseFlights([rows[1]])
    expect(s.failed).toBe(1)
    expect(s.total).toBe(1)
    expect(s.costMicroUsd).toBe(0)
  })

  it('caps the recent list at five, newest first as given', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`, goal: 'g', status: 'landed', cost_micro_usd: 0, created_at: `d${i}`,
    }))
    const s = summariseFlights(many)
    expect(s.recent).toHaveLength(5)
    expect(s.recent[0].id).toBe('f0')
    expect(s.total).toBe(12)
  })

  it('an unknown status is counted in the total but claimed by no bucket', () => {
    const s = summariseFlights([{ id: 'x', goal: 'g', status: 'reaped', cost_micro_usd: 0, created_at: 'd' }])
    expect(s.total).toBe(1)
    expect(s.landed + s.failed + s.held + s.running).toBe(0)
  })

  it('returns all zeros for no rows without inventing a shape', () => {
    const s = summariseFlights([])
    expect(s).toMatchObject({ total: 0, landed: 0, failed: 0, held: 0, running: 0, costMicroUsd: 0 })
    expect(s.recent).toEqual([])
  })
})

describe('work summary', () => {
  const rows = [
    { id: 't1', title: 'a', status: 'open', github_issue_url: 'https://gh/1' },
    { id: 't2', title: 'b', status: 'done', github_issue_url: null },
    { id: 't3', title: 'c', status: 'approved', github_issue_url: 'https://gh/3' },
    { id: 't4', title: 'd', status: 'blocked', github_issue_url: null },
  ]

  it('treats approved as done, because a gated task closes through approval', () => {
    const s = summariseWork(rows)
    expect(s.done).toBe(2)
  })

  it('counts everything not done as open, including blocked', () => {
    expect(summariseWork(rows).open).toBe(2)
  })

  it('open and done always partition the total — no task falls through', () => {
    const s = summariseWork(rows)
    expect(s.open + s.done).toBe(s.total)
  })

  it('counts only tasks carrying an external issue link as tracked', () => {
    expect(summariseWork(rows).tracked).toBe(2)
  })

  it('returns zeros for no rows', () => {
    expect(summariseWork([])).toMatchObject({ total: 0, open: 0, done: 0, tracked: 0 })
  })
})

describe('registry — a new signal is a registration, not a rewrite', () => {
  it('is ordered and addressable by key', () => {
    expect(PANELS.map((p) => p.key)).toEqual(['flights', 'work'])
    expect(panelByKey('flights')?.title).toBe('Flights')
  })

  it('returns undefined for a panel that does not exist rather than a stub', () => {
    expect(panelByKey('reliability')).toBeUndefined()
  })

  // Unbuilt panels are ABSENT, not stubbed. A placeholder that looks like data
  // is worse than a missing section.
  it('does not register panels that cannot yet resolve', () => {
    const keys = PANELS.map((p) => p.key)
    expect(keys).not.toContain('reliability')
    expect(keys).not.toContain('collaboration')
  })

  it('every panel states what its empty case means', () => {
    for (const p of PANELS) {
      expect(p.emptyLabel.length).toBeGreaterThan(0)
      expect(p.title.length).toBeGreaterThan(0)
    }
  })
})

describe('cost formatting', () => {
  it('shows a real zero as zero — it is informative, not missing', () => {
    expect(formatCost(0)).toBe('$0.00')
  })

  it('converts micro-USD to dollars', () => {
    expect(formatCost(2_500_000)).toBe('$2.50')
  })

  it('shows an em dash for a value that is not a number, never $0.00', () => {
    expect(formatCost(Number.NaN)).toBe('—')
    expect(formatCost(-1)).toBe('—')
  })
})
