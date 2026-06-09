import { describe, it, expect } from 'vitest'
import { scheduleStates, attachSchedule, formatHm } from '../src/fleet/schedule-state'
import type { FlightRow, FlightStatus } from '../src/flight/service'

function fr(agent: string, status: FlightStatus, next_run_at: number | null = null, created_at = 0): FlightRow {
  return {
    id: crypto.randomUUID(),
    tenant: 'test',
    agent,
    goal: 'g',
    status,
    trigger_source: 'manual',
    gate_verdict: null,
    gate_reason: '',
    score: null,
    budget_micro_usd: null,
    cost_micro_usd: 0,
    next_run_at,
    created_at,
    started_at: null,
    ended_at: null,
    meta: '{}',
  }
}

// 2026-01-01T14:05:00Z = 1767276300000
const T_1405 = Date.UTC(2026, 0, 1, 14, 5, 0)
const T_0930 = Date.UTC(2026, 0, 1, 9, 30, 0)

describe('formatHm', () => {
  it('Unix ms → HH:MM UTC, zero-padded', () => {
    expect(formatHm(T_1405)).toBe('14:05')
    expect(formatHm(T_0930)).toBe('09:30')
  })
})

describe('scheduleStates', () => {
  it('in-air (running/waiting/preflight) → flying, beats sleeping', () => {
    const m = scheduleStates([fr('opus', 'sleeping', T_1405), fr('opus', 'running')])
    expect(m.get('opus')).toEqual({ state: 'flying', next_at: null, next_label: null })
  })

  it('sleeping with next_run_at → sleeping + "next HH:MM"', () => {
    const m = scheduleStates([fr('opus', 'sleeping', T_1405)])
    expect(m.get('opus')).toEqual({ state: 'sleeping', next_at: T_1405, next_label: 'next 14:05' })
  })

  it('multiple sleeping flights → earliest departure wins', () => {
    const m = scheduleStates([fr('opus', 'sleeping', T_1405), fr('opus', 'sleeping', T_0930)])
    expect(m.get('opus')?.next_at).toBe(T_0930)
    expect(m.get('opus')?.next_label).toBe('next 09:30')
  })

  it('sleeping without next_run_at is ignored → done', () => {
    const m = scheduleStates([fr('opus', 'sleeping', null), fr('opus', 'landed')])
    expect(m.get('opus')?.state).toBe('done')
  })

  it('only terminal flights → done', () => {
    const m = scheduleStates([fr('opus', 'landed'), fr('opus', 'failed')])
    expect(m.get('opus')).toEqual({ state: 'done', next_at: null, next_label: null })
  })

  it('keeps agents independent', () => {
    const m = scheduleStates([fr('a', 'running'), fr('b', 'sleeping', T_1405)])
    expect(m.get('a')?.state).toBe('flying')
    expect(m.get('b')?.state).toBe('sleeping')
  })
})

describe('attachSchedule', () => {
  const rows = [
    { member_id: 'm1', display_name: 'opus' },
    { member_id: 'm2', display_name: 'cheapbot' },
    { member_id: 'flight-by-id', display_name: 'noname' },
  ]

  it('matches by display_name first', () => {
    const states = scheduleStates([fr('opus', 'running')])
    const out = attachSchedule(rows, states)
    expect(out[0]?.schedule?.state).toBe('flying')
  })

  it('falls back to member_id when no name match', () => {
    const states = new Map([['flight-by-id', { state: 'sleeping' as const, next_at: T_1405, next_label: 'next 14:05' }]])
    const out = attachSchedule(rows, states)
    expect(out[2]?.schedule?.state).toBe('sleeping')
  })

  it('no flights → schedule null (cheap always-on, keeps heartbeat liveness)', () => {
    const out = attachSchedule(rows, scheduleStates([fr('opus', 'running')]))
    expect(out[1]?.schedule).toBeNull() // cheapbot has no flights
  })
})
