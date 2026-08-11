import { describe, it, expect } from 'vitest'
import { scheduleStates, attachSchedule } from '../src/fleet/schedule-state'
import type { FlightRow, FlightStatus } from '../src/flight/service'

function fr(agent: string, status: FlightStatus, created_at = 0): FlightRow {
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
    created_at,
    started_at: null,
    ended_at: null,
    meta: '{}',
  }
}

describe('scheduleStates', () => {
  it('in-air (preflight or running) → flying, and beats a terminal flight', () => {
    expect(scheduleStates([fr('opus', 'landed'), fr('opus', 'running')]).get('opus')).toEqual({ state: 'flying' })
    expect(scheduleStates([fr('opus', 'failed'), fr('opus', 'preflight')]).get('opus')).toEqual({ state: 'flying' })
  })

  it('only terminal flights → done (a resting session agent, NOT dead)', () => {
    const m = scheduleStates([fr('opus', 'landed'), fr('opus', 'failed'), fr('opus', 'held')])
    expect(m.get('opus')).toEqual({ state: 'done' })
  })

  it('keeps agents independent', () => {
    const m = scheduleStates([fr('a', 'running'), fr('b', 'landed')])
    expect(m.get('a')?.state).toBe('flying')
    expect(m.get('b')?.state).toBe('done')
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
    const states = new Map([['flight-by-id', { state: 'done' as const }]])
    const out = attachSchedule(rows, states)
    expect(out[2]?.schedule?.state).toBe('done')
  })

  it('no flights → schedule null (cheap always-on, keeps heartbeat liveness)', () => {
    const out = attachSchedule(rows, scheduleStates([fr('opus', 'running')]))
    expect(out[1]?.schedule).toBeNull() // cheapbot has no flights
  })
})
