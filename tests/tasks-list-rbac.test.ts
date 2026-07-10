import { describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env, Task } from '../src/types'

const tasks: Task[] = [
  {
    id: 'task-growth',
    squad_id: 'sq-growth',
    title: 'Growth task',
    body: '',
    done_when: 'growth work is complete',
    status: 'open',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
  },
  {
    id: 'task-ops',
    squad_id: 'sq-ops',
    title: 'Ops task',
    body: '',
    done_when: 'ops work is complete',
    status: 'blocked',
    assignee_agent_id: null,
    github_issue_url: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    created_at: '2026-07-08T00:00:00.000Z',
    updated_at: '2026-07-08T00:00:00.000Z',
  },
]

function makeEnv(role: 'owner' | 'admin' | 'member') {
  const taskQueries: Array<{ sql: string; args: unknown[] }> = []
  const env = {
    TENANT_SLUG: 'test',
    BRAND: 'Test',
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'sess:sess1') return null
        return JSON.stringify({
          userId: `${role}-1`,
          email: `${role}@test.example`,
          role,
          createdAt: '2026-07-09T00:00:00.000Z',
        })
      }),
      delete: vi.fn(async () => undefined),
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>() {
                if (sql.includes('SELECT department_id FROM squads')) {
                  const [squadId] = args as [string]
                  if (squadId === 'sq-growth') return { department_id: 'dept-growth' } as T
                  if (squadId === 'sq-ops') return { department_id: 'dept-ops' } as T
                }
                return null as T
              },
              async all<T>() {
                if (sql.includes('FROM tasks')) {
                  taskQueries.push({ sql, args })
                  let rows = [...tasks]
                  if (sql.includes('squad_id = ?')) {
                    const [squadId] = args as [string]
                    rows = rows.filter((task) => task.squad_id === squadId)
                  }
                  if (sql.includes('status = ?')) {
                    const status = args[args.length - 1]
                    rows = rows.filter((task) => task.status === status)
                  }
                  return { results: rows } as { results: T[] }
                }
                return { results: [] } as { results: T[] }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
  return { env, taskQueries }
}

function getTasks(env: Env, path = 'https://pot.test/') {
  return tasksApp.fetch(
    new Request(path, {
      headers: { Cookie: 'mupot_session=sess1' },
    }),
    env,
  )
}

describe('GET /api/tasks RBAC', () => {
  it('owner can list all task rows', async () => {
    const { env, taskQueries } = makeEnv('owner')
    const res = await getTasks(env)
    const body = await res.json() as { tasks: Task[] }

    expect(res.status).toBe(200)
    expect(body.tasks.map((task) => task.id)).toEqual(['task-growth', 'task-ops'])
    expect(taskQueries).toHaveLength(1)
    expect(taskQueries[0].sql).not.toContain('squad_id IN')
  })

  it('member session without a resolved member id cannot list every squad by omission', async () => {
    const { env, taskQueries } = makeEnv('member')
    const res = await getTasks(env)
    const body = await res.json() as { tasks: Task[] }

    expect(res.status).toBe(200)
    expect(body.tasks).toEqual([])
    expect(taskQueries).toHaveLength(0)
  })

  it('member session without squad authority is denied on explicit squad list', async () => {
    const { env, taskQueries } = makeEnv('member')
    const res = await getTasks(env, 'https://pot.test/?squad_id=sq-growth')
    const body = await res.json() as { error: string; need: string }

    expect(res.status).toBe(403)
    expect(body).toEqual({ error: 'forbidden', need: 'member' })
    expect(taskQueries).toHaveLength(0)
  })
})
