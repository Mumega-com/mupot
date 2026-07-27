import { describe, expect, it } from 'vitest'
import {
  nextRoutineOccurrence,
  routineOccurrenceKey,
  validateRoutineSchedule,
} from '../src/routines/schedule'
import type { RoutineSchedule } from '../src/routines/types'

describe('routine schedule validation', () => {
  it('accepts manual, once, and five-field cron schedules', () => {
    expect(validateRoutineSchedule({ kind: 'manual', timezone: 'UTC' })).toEqual({ ok: true })
    expect(validateRoutineSchedule({
      kind: 'once', timezone: 'UTC', runOnceAt: '2026-07-20T13:00:00.000Z',
    })).toEqual({ ok: true })
    expect(validateRoutineSchedule({
      kind: 'cron', timezone: 'America/Toronto', cronExpression: '0 9 * * 1-5',
    })).toEqual({ ok: true })
  })

  it('rejects invalid trigger fields, six-field cron, aliases, and unknown timezones', () => {
    expect(validateRoutineSchedule({
      kind: 'cron', timezone: 'UTC', cronExpression: '* * * * * *',
    })).toEqual({ ok: false, error: 'invalid_cron_expression' })
    expect(validateRoutineSchedule({
      kind: 'cron', timezone: 'UTC', cronExpression: '@daily',
    })).toEqual({ ok: false, error: 'invalid_cron_expression' })
    expect(validateRoutineSchedule({
      kind: 'manual', timezone: 'UTC', cronExpression: '* * * * *',
    })).toEqual({ ok: false, error: 'invalid_trigger_fields' })
    expect(validateRoutineSchedule({
      kind: 'once', timezone: 'Mars/Olympus', runOnceAt: '2026-07-20T13:00:00.000Z',
    })).toEqual({ ok: false, error: 'invalid_timezone' })
  })
})

describe('nextRoutineOccurrence', () => {
  it('returns null for manual and exhausted once schedules', () => {
    expect(nextRoutineOccurrence(
      { kind: 'manual', timezone: 'UTC' },
      new Date('2026-07-19T13:00:00.000Z'),
    )).toBeNull()
    expect(nextRoutineOccurrence(
      { kind: 'once', timezone: 'UTC', runOnceAt: '2026-07-19T12:00:00.000Z' },
      new Date('2026-07-19T13:00:00.000Z'),
    )).toBeNull()
  })

  it('calculates a UTC five-field cron occurrence at minute precision', () => {
    const schedule: RoutineSchedule = {
      kind: 'cron', timezone: 'UTC', cronExpression: '15 9 * * 1-5',
    }
    expect(nextRoutineOccurrence(schedule, new Date('2026-07-17T09:16:00.000Z'))?.toISOString())
      .toBe('2026-07-20T09:15:00.000Z')
  })

  it('skips a nonexistent Toronto spring-forward wall minute', () => {
    const schedule: RoutineSchedule = {
      kind: 'cron', timezone: 'America/Toronto', cronExpression: '30 2 * * *',
    }
    expect(nextRoutineOccurrence(schedule, new Date('2026-03-08T05:00:00.000Z'))?.toISOString())
      .toBe('2026-03-09T06:30:00.000Z')
  })

  it('fires a repeated Toronto fall-back wall minute only at its first occurrence', () => {
    const schedule: RoutineSchedule = {
      kind: 'cron', timezone: 'America/Toronto', cronExpression: '30 1 * * *',
    }
    expect(nextRoutineOccurrence(schedule, new Date('2026-11-01T04:00:00.000Z'))?.toISOString())
      .toBe('2026-11-01T05:30:00.000Z')
    expect(nextRoutineOccurrence(schedule, new Date('2026-11-01T05:31:00.000Z'))?.toISOString())
      .toBe('2026-11-02T06:30:00.000Z')
  })
})

describe('routineOccurrenceKey', () => {
  it('uses a canonical local cron occurrence and timezone', () => {
    expect(routineOccurrenceKey(
      { kind: 'cron', timezone: 'America/Toronto', cronExpression: '30 1 * * *' },
      new Date('2026-11-01T05:30:00.000Z'),
    )).toBe('cron:2026-11-01T01:30:00[America/Toronto]')
  })

  it('uses the UTC instant for once and the caller key for manual runs', () => {
    const instant = new Date('2026-07-20T13:00:00.000Z')
    expect(routineOccurrenceKey(
      { kind: 'once', timezone: 'UTC', runOnceAt: instant.toISOString() }, instant,
    )).toBe('once:2026-07-20T13:00:00.000Z')
    expect(routineOccurrenceKey({ kind: 'manual', timezone: 'UTC' }, instant, 'manual-key-1'))
      .toBe('manual:manual-key-1')
  })
})
