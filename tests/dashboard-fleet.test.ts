import { describe, it, expect } from 'vitest'
import { classify, humanAge, busConfigured } from '../src/dashboard/fleet'
import type { Env } from '../src/types'

const NOW = 1_780_000_000_000

describe('classify', () => {
  it('null → never', () => expect(classify(null, NOW)).toBe('never'))
  it('5m ago → active', () => expect(classify(NOW - 5 * 60_000, NOW)).toBe('active'))
  it('exactly 10m → active boundary', () => expect(classify(NOW - 10 * 60_000, NOW)).toBe('active'))
  it('2h ago → idle', () => expect(classify(NOW - 2 * 3_600_000, NOW)).toBe('idle'))
  it('3d ago → dead', () => expect(classify(NOW - 3 * 86_400_000, NOW)).toBe('dead'))
})

describe('humanAge', () => {
  it('never on null', () => expect(humanAge(null, NOW)).toBe('never'))
  it('just now under a minute', () => expect(humanAge(NOW - 10_000, NOW)).toBe('just now'))
  it('minutes', () => expect(humanAge(NOW - 7 * 60_000, NOW)).toBe('7m ago'))
  it('hours', () => expect(humanAge(NOW - 5 * 3_600_000, NOW)).toBe('5h ago'))
  it('days past 48h', () => expect(humanAge(NOW - 3 * 86_400_000, NOW)).toBe('3d ago'))
})

describe('busConfigured', () => {
  it('false without token', () => {
    expect(busConfigured({} as Env)).toBe(false)
  })
  it('true with token (default URL)', () => {
    expect(busConfigured({ BUS_TOKEN: 'x' } as Env)).toBe(true)
  })
})
