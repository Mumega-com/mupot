import { describe, expect, it } from 'vitest'
import * as metaModule from '../src/flight/meta'
import { canonicalFlightMetaSql } from '../src/flight/meta-sql'
import type { Env } from '../src/types'
import { createSqliteD1 } from './helpers/sqlite-d1'

const meta = {
  schema: 'mupot.flight.meta/v1' as const,
  goal_id: 'goal-1',
  objective_id: 'objective-1',
  squad_ids: ['squad-1'],
  task_ids: ['task-1'],
  done_when: ['the receipt verifies'],
  artifact_refs: [],
  receipt_refs: [],
  confidentiality: 'internal' as const,
  publication_target: 'none' as const,
  parent_flight_id: null,
}

function makeEnv(opts: { squad?: boolean; task?: boolean; taskSquad?: string } = {}): Env {
  const squad = opts.squad ?? true
  const task = opts.task ?? true
  const taskSquad = opts.taskSquad ?? 'squad-1'
  return {
    TENANT_SLUG: 'test',
    DB: {
      prepare(sql: string) {
        return {
          bind(id: string) {
            return {
              async first() {
                if (sql.includes('FROM squads')) return squad && id === 'squad-1' ? { id } : null
                if (sql.includes('FROM tasks')) return task && id === 'task-1' ? { id, squad_id: taskSquad } : null
                return null
              },
              async all() {
                if (sql.includes('FROM squads')) return { results: squad ? [{ id: 'squad-1' }] : [] }
                if (sql.includes('FROM tasks')) return { results: task ? [{ id: 'task-1', squad_id: taskSquad }] : [] }
                return { results: [] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
}

const validate = (metaModule as Record<string, unknown>).validateFlightMetaReferences as
  | ((env: Env, value: typeof meta) => Promise<{ ok: boolean; error?: string }>)
  | undefined

describe('parseFlightMetaV1', () => {
  it('applies field limits in UTF-8 bytes', () => {
    const persianCharacter = '\u06a9'
    expect(metaModule.parseFlightMetaV1({ ...meta, goal_id: persianCharacter.repeat(100) })).not.toBeNull()
    expect(metaModule.parseFlightMetaV1({ ...meta, goal_id: persianCharacter.repeat(101) })).toBeNull()
  })

  it('applies the canonical envelope limit in UTF-8 bytes', () => {
    const persianCharacter = '\u06a9'
    expect(metaModule.parseFlightMetaV1({
      ...meta,
      artifact_refs: Array.from({ length: 9 }, () => persianCharacter.repeat(1000)),
    })).toBeNull()
  })

  it('matches the SQL predicate at multilingual byte boundaries', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      sqlite.exec('CREATE TABLE flights (meta TEXT NOT NULL)')
      const insert = sqlite.prepare('INSERT INTO flights (meta) VALUES (?)')
      const accepted = { ...meta, goal_id: '\u06a9'.repeat(100) }
      const rejected = { ...meta, goal_id: '\u06a9'.repeat(101) }
      for (const [value, expected] of [[accepted, true], [rejected, false]] as const) {
        sqlite.exec('DELETE FROM flights')
        insert.run(JSON.stringify(value))
        const row = sqlite.prepare(`
          SELECT COUNT(*) AS count FROM flights f WHERE 1 = 1 ${canonicalFlightMetaSql('f')}
        `).get() as { count: number }
        expect(metaModule.parseFlightMetaV1(value) !== null).toBe(expected)
        expect(row.count === 1).toBe(expected)
      }
    } finally {
      close()
    }
  })
})

describe('validateFlightMetaReferences', () => {
  it('is part of the flight domain contract', () => {
    expect(typeof validate).toBe('function')
  })

  it('accepts existing tasks in declared squads', async () => {
    if (!validate) return
    await expect(validate(makeEnv(), meta)).resolves.toEqual({ ok: true })
  })

  it('rejects a missing squad or task', async () => {
    if (!validate) return
    await expect(validate(makeEnv({ squad: false }), meta)).resolves.toMatchObject({ ok: false, error: 'flight_squad_not_found' })
    await expect(validate(makeEnv({ task: false }), meta)).resolves.toMatchObject({ ok: false, error: 'flight_task_not_found' })
  })

  it('rejects a task outside the declared flight squads', async () => {
    if (!validate) return
    await expect(validate(makeEnv({ taskSquad: 'squad-other' }), meta)).resolves.toMatchObject({ ok: false, error: 'flight_task_scope_mismatch' })
  })

  it('validates the maximum task set without exceeding the D1 bind budget', async () => {
    if (!validate) return
    let reads = 0
    const bindCounts: number[] = []
    const env = {
      TENANT_SLUG: 'test',
      DB: {
        prepare(sql: string) {
          reads += 1
          return {
            bind(...ids: string[]) {
              bindCounts.push(ids.length)
              if (ids.length > 100) throw new Error(`D1 bind budget exceeded: ${ids.length}`)
              return {
                async first() {
                  const id = ids[0]
                  return sql.includes('FROM squads') ? { id } : { id, squad_id: 'squad-1' }
                },
                async all() {
                  return {
                    results: ids.map((id) => sql.includes('FROM squads') ? { id } : { id, squad_id: 'squad-1' }),
                  }
                },
              }
            },
          }
        },
      },
    } as unknown as Env
    const large = { ...meta, task_ids: Array.from({ length: 200 }, (_, index) => `task-${index}`) }

    await expect(validate(env, large)).resolves.toEqual({ ok: true })
    expect(reads).toBe(4)
    expect(Math.max(...bindCounts)).toBeLessThanOrEqual(90)
  })
})
