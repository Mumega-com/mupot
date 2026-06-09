import { describe, it, expect } from 'vitest'
import { buildBoard, formatUsd, formatPct, humanDur } from '../src/flight/board'
import type { FlightRow, FlightStatus } from '../src/flight/service'

const NOW = 1_900_000_000_000 // fixed reference (Unix ms)

function row(p: Partial<FlightRow> & { agent: string; status: FlightStatus }): FlightRow {
  return {
    id: p.id ?? crypto.randomUUID(),
    tenant: 'test',
    agent: p.agent,
    goal: p.goal ?? 'do the thing',
    status: p.status,
    trigger_source: 'manual',
    gate_verdict: null,
    gate_reason: '',
    score: p.score ?? null,
    budget_micro_usd: p.budget_micro_usd ?? null,
    cost_micro_usd: p.cost_micro_usd ?? 0,
    next_run_at: p.next_run_at ?? null,
    created_at: p.created_at ?? NOW,
    started_at: null,
    ended_at: null,
    meta: '{}',
  }
}

describe('formatUsd', () => {
  it('micro-USD → $0.0000', () => {
    expect(formatUsd(12_300)).toBe('$0.0123')
    expect(formatUsd(0)).toBe('$0.0000')
    expect(formatUsd(2_500_000)).toBe('$2.5000')
  })
  it('null/NaN → null', () => {
    expect(formatUsd(null)).toBeNull()
    expect(formatUsd(undefined)).toBeNull()
    expect(formatUsd(NaN)).toBeNull()
  })
})

describe('formatPct', () => {
  it('0..1 → integer percent', () => {
    expect(formatPct(0.82)).toBe('82%')
    expect(formatPct(1)).toBe('100%')
    expect(formatPct(null)).toBeNull()
  })
})

describe('humanDur', () => {
  it('scales s→m→h→d', () => {
    expect(humanDur(45_000)).toBe('45s')
    expect(humanDur(12 * 60_000)).toBe('12m')
    expect(humanDur(3 * 3_600_000)).toBe('3h')
    expect(humanDur(2 * 86_400_000)).toBe('2d')
  })
  it('clamps negatives to 0s', () => {
    expect(humanDur(-5000)).toBe('0s')
  })
})

describe('buildBoard — phase + live', () => {
  it('maps each status to its phase metaphor', () => {
    const rows = [
      row({ agent: 'a', status: 'running' }),
      row({ agent: 'b', status: 'waiting' }),
      row({ agent: 'c', status: 'sleeping' }),
      row({ agent: 'd', status: 'held' }),
      row({ agent: 'e', status: 'landed' }),
      row({ agent: 'f', status: 'failed' }),
      row({ agent: 'g', status: 'preflight' }),
    ]
    const cards = buildBoard(rows, NOW)
    expect(cards.map((c) => c.phase)).toEqual([
      'flying',
      'holding',
      'sleeping',
      'held',
      'landed',
      'failed',
      'preflight',
    ])
    // live = pre-launch / in-air / sleeping; terminal = history
    expect(cards.map((c) => c.live)).toEqual([true, true, true, false, false, false, true])
  })
})

describe('buildBoard — cost + budget', () => {
  it('formats cost, formats/keeps budget, flags over-budget', () => {
    const [c] = buildBoard(
      [row({ agent: 'a', status: 'landed', cost_micro_usd: 1_500_000, budget_micro_usd: 1_000_000 })],
      NOW,
    )
    expect(c.cost_usd).toBe('$1.5000')
    expect(c.budget_usd).toBe('$1.0000')
    expect(c.over_budget).toBe(true)
  })
  it('no budget → not over-budget, budget_usd null', () => {
    const [c] = buildBoard([row({ agent: 'a', status: 'running', cost_micro_usd: 99 })], NOW)
    expect(c.budget_usd).toBeNull()
    expect(c.over_budget).toBe(false)
  })
})

describe('buildBoard — next departure (sleeping only)', () => {
  it('sleeping with future next_run_at → "in <dur>"', () => {
    const [c] = buildBoard([row({ agent: 'a', status: 'sleeping', next_run_at: NOW + 12 * 60_000 })], NOW)
    expect(c.next_departure).toBe('in 12m')
  })
  it('sleeping past-due → "due"', () => {
    const [c] = buildBoard([row({ agent: 'a', status: 'sleeping', next_run_at: NOW - 1000 })], NOW)
    expect(c.next_departure).toBe('due')
  })
  it('non-sleeping → null even with next_run_at', () => {
    const [c] = buildBoard([row({ agent: 'a', status: 'running', next_run_at: NOW + 60_000 })], NOW)
    expect(c.next_departure).toBeNull()
  })
})

describe('buildBoard — score trend per agent', () => {
  it('compares to the next-older scored flight of the SAME agent', () => {
    // listFlights order = newest first. Agent a: 0.9 (new) then 0.5 (old) → up.
    // Agent b: 0.3 (new) then 0.6 (old) → down. interleaved to prove per-agent.
    const rows = [
      row({ agent: 'a', status: 'landed', score: 0.9, created_at: NOW - 1_000 }),
      row({ agent: 'b', status: 'landed', score: 0.3, created_at: NOW - 2_000 }),
      row({ agent: 'a', status: 'landed', score: 0.5, created_at: NOW - 3_000 }),
      row({ agent: 'b', status: 'landed', score: 0.6, created_at: NOW - 4_000 }),
    ]
    const cards = buildBoard(rows, NOW)
    expect(cards[0]?.trend).toBe('up') // a: 0.9 vs 0.5
    expect(cards[1]?.trend).toBe('down') // b: 0.3 vs 0.6
    expect(cards[2]?.trend).toBeNull() // a oldest → no prior
    expect(cards[3]?.trend).toBeNull() // b oldest → no prior
  })
  it('equal scores → flat', () => {
    const rows = [
      row({ agent: 'a', status: 'running', score: 0.7, created_at: NOW - 1 }),
      row({ agent: 'a', status: 'landed', score: 0.7, created_at: NOW - 2 }),
    ]
    expect(buildBoard(rows, NOW)[0]?.trend).toBe('flat')
  })
  it('skips unscored priors to find the last real score', () => {
    const rows = [
      row({ agent: 'a', status: 'running', score: 0.8, created_at: NOW - 1 }),
      row({ agent: 'a', status: 'held', score: null, created_at: NOW - 2 }),
      row({ agent: 'a', status: 'landed', score: 0.4, created_at: NOW - 3 }),
    ]
    expect(buildBoard(rows, NOW)[0]?.trend).toBe('up') // 0.8 vs 0.4, skipping the null
  })
  it('null score → null trend + null pct', () => {
    const [c] = buildBoard([row({ agent: 'a', status: 'preflight', score: null })], NOW)
    expect(c.trend).toBeNull()
    expect(c.score_pct).toBeNull()
  })
})
