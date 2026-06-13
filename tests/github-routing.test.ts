// Tests for B5 (label→squad routing) + D3 (CI→task) helpers.

import { describe, it, expect } from 'vitest'
import { parseLabelSquadMap, squadForLabels } from '../src/integrations/github-routes'
import { syncCiResultToTask } from '../src/tasks/service'
import type { Env } from '../src/types'

describe('parseLabelSquadMap (B5)', () => {
  it('parses a valid JSON label→squad map (case-insensitive keys)', () => {
    const m = parseLabelSquadMap('{"Bug":"sq1","feature":"sq2"}')
    expect(m).toEqual({ bug: 'sq1', feature: 'sq2' })
  })
  it('returns {} for absent/invalid', () => {
    expect(parseLabelSquadMap(undefined)).toEqual({})
    expect(parseLabelSquadMap('{bad')).toEqual({})
    expect(parseLabelSquadMap('')).toEqual({})
  })
  it('drops non-string values', () => {
    expect(parseLabelSquadMap('{"a":"sq","b":5}')).toEqual({ a: 'sq' })
  })
})

describe('squadForLabels (B5)', () => {
  const map = { bug: 'sq-bug', urgent: 'sq-urgent' }
  it('returns the first matching squad (case-insensitive)', () => {
    expect(squadForLabels(map, ['Bug'])).toBe('sq-bug')
    expect(squadForLabels(map, ['x', 'URGENT'])).toBe('sq-urgent')
  })
  it('returns null when no label matches', () => {
    expect(squadForLabels(map, ['docs', 'chore'])).toBeNull()
    expect(squadForLabels(map, [])).toBeNull()
  })
})

describe('syncCiResultToTask (D3)', () => {
  function dbEnv(changes: number) {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            run: async () => {
              calls.push({ sql, args })
              return { meta: { changes } }
            },
          }),
        }),
      },
    } as unknown as Env
    return { env, calls }
  }

  it('failure conclusion bumps a review task back to in_progress', async () => {
    const { env, calls } = dbEnv(1)
    const res = await syncCiResultToTask(env, 42, 'failure')
    expect(res.updated).toBe(true)
    expect(calls[0].sql).toContain("status = 'in_progress'")
    expect(calls[0].sql).toContain("status = 'review'") // only flips review tasks
    expect(calls[0].args).toContain('%/pull/42')
    expect(calls[0].args).toContain('CI: failure')
  })

  it('success records the note without changing a gate state', async () => {
    const { env, calls } = dbEnv(1)
    const res = await syncCiResultToTask(env, 7, 'success')
    expect(res.updated).toBe(true)
    expect(calls[0].sql).not.toContain("status = 'in_progress'")
    expect(calls[0].sql).toContain("status IN ('review','in_progress','open')")
  })

  it('no matching task → updated:false', async () => {
    const { env } = dbEnv(0)
    expect((await syncCiResultToTask(env, 9, 'failure')).updated).toBe(false)
  })

  it('invalid pr number → no-op', async () => {
    const { env, calls } = dbEnv(1)
    expect((await syncCiResultToTask(env, 0, 'failure')).updated).toBe(false)
    expect(calls.length).toBe(0)
  })
})
