import { describe, expect, it, vi } from 'vitest'
import { handleImMessage } from '../src/im'
import type { Env } from '../src/types'

function makeEnv() {
  const inserts: unknown[][] = []
  const busEvents: unknown[] = []

  const member = {
    id: 'mbr-hermes-user',
    email: 'hermes@mupot.test',
    display_name: 'Hermes Test Operator',
    telegram_chat_id: '123456789',
    status: 'active',
    created_at: '2026-07-07T00:00:00.000Z',
  }
  const squad = {
    id: 'sq-growth',
    department_id: 'dept-growth',
    slug: 'growth',
    name: 'Growth Local',
    charter: 'Local smoke squad',
    created_at: '2026-07-07T00:00:00.000Z',
  }
  const grants = [
    { member_id: member.id, scope_type: 'org', scope_id: null, capability: 'admin' },
  ]

  const DB = {
    prepare(sql: string) {
      const api = {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes('FROM members') && sql.includes('telegram_chat_id')) return member as T
              if (sql.includes('SELECT department_id FROM squads')) return { department_id: squad.department_id } as T
              return null as T | null
            },
            async all<T>() {
              if (sql.includes('FROM capabilities')) return { results: grants } as { results: T[] }
              if (sql.includes('FROM squads') && sql.includes('slug = ?1')) return { results: [squad] } as { results: T[] }
              return { results: [] } as { results: T[] }
            },
            async run() {
              if (sql.includes('INSERT INTO tasks')) inserts.push(args)
              return { meta: { changes: 1 } }
            },
          }
        },
      }
      return api
    },
  }

  const env = {
    TENANT_SLUG: 'local',
    DB,
    BUS: {
      send: vi.fn(async (event: unknown) => {
        busEvents.push(event)
      }),
    },
  } as unknown as Env

  return { env, inserts, busEvents }
}

describe('Hermes IM control', () => {
  it('quick-add creates a task with a real done_when predicate', async () => {
    const { env, inserts, busEvents } = makeEnv()

    const reply = await handleImMessage(env, 123456789, 'task: Ship local smoke @growth')

    expect(reply).toBe('Added to Growth Local: "Ship local smoke".')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][1]).toBe('sq-growth')
    expect(inserts[0][2]).toBe('Ship local smoke')
    expect(inserts[0][4]).toBe(
      'A task result or linked artifact provides evidence that the requested IM task is complete.',
    )
    expect(inserts[0][4]).not.toBe('(set via task update)')
    expect(busEvents).toEqual([
      expect.objectContaining({
        type: 'task.created',
        tenant: 'local',
        squad_id: 'sq-growth',
        actor: { kind: 'member', id: 'mbr-hermes-user' },
      }),
    ])
  })
})
