import { describe, expect, it } from 'vitest'
import * as metaModule from '../src/flight/meta'
import type { Env } from '../src/types'

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

  it('validates the maximum task set with at most two D1 reads', async () => {
    if (!validate) return
    let reads = 0
    const env = {
      TENANT_SLUG: 'test',
      DB: {
        prepare(sql: string) {
          reads += 1
          return {
            bind(...ids: string[]) {
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
    expect(reads).toBeLessThanOrEqual(2)
  })
})
