import { describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env, Task } from '../src/types'

const baseTask: Task = {
  id: 'task-smoke-1',
  squad_id: 'sq-growth',
  title: 'Browser workflow smoke',
  body: 'Verify local browser completion.',
  done_when: 'The browser smoke result is visible on the send page.',
  status: 'open',
  assignee_agent_id: 'agent-hermes',
  github_issue_url: null,
  result: null,
  completed_at: null,
  gate_owner: null,
  created_at: '2026-07-08T00:00:00.000Z',
  updated_at: '2026-07-08T00:00:00.000Z',
}

function makeEnv(opts: {
  localAuth?: string
  task?: Task | null
  updateChanges?: number
} = {}) {
  const task = opts.task ?? baseTask
  const updates: { sql: string; args: unknown[] }[] = []
  const busEvents: unknown[] = []

  const env = {
    TENANT_SLUG: 'local',
    BRAND: 'Mupot Local',
    LOCAL_TEST_AUTH: opts.localAuth,
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'sess:sess1') return null
        return JSON.stringify({
          userId: 'owner-1',
          email: 'local-owner@mupot.test',
          role: 'owner',
          createdAt: '2026-07-08T00:00:00.000Z',
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
                if (sql.includes('FROM tasks')) return (task as unknown as T) ?? null
                return null as T
              },
              async run() {
                updates.push({ sql, args })
                return { meta: { changes: opts.updateChanges ?? 1 } }
              },
            }
          },
        }
      },
    },
    BUS: {
      send: vi.fn(async (event: unknown) => {
        busEvents.push(event)
      }),
    },
  } as unknown as Env

  return { env, updates, busEvents }
}

async function postLocalSmokeComplete(env: Env, result = 'Local browser smoke completed.') {
  return tasksApp.fetch(
    new Request('https://pot.test/task-smoke-1/local-smoke-complete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: 'mupot_session=sess1',
        Origin: 'https://pot.test',
      },
      body: JSON.stringify({ result }),
    }),
    env,
  )
}

describe('POST /:id/local-smoke-complete', () => {
  it('is sealed with a 404 unless LOCAL_TEST_AUTH=1', async () => {
    const { env, updates, busEvents } = makeEnv({ localAuth: undefined })

    const res = await postLocalSmokeComplete(env)
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json).toEqual({ error: 'not_found' })
    expect(updates).toHaveLength(0)
    expect(busEvents).toHaveLength(0)
  })

  it('moves an open local smoke task to done and emits a terminal task update', async () => {
    const { env, updates, busEvents } = makeEnv({ localAuth: '1' })

    const res = await postLocalSmokeComplete(env, 'Visible browser result.')
    const json = await res.json() as { task: Task; local_smoke: boolean }

    expect(res.status).toBe(200)
    expect(json.local_smoke).toBe(true)
    expect(json.task.status).toBe('done')
    expect(json.task.result).toBe('Visible browser result.')
    expect(json.task.completed_at).toBeTruthy()

    expect(updates).toHaveLength(2)
    expect(updates[0].sql).toMatch(/SET status = 'in_progress'/)
    expect(updates[1].sql).toMatch(/SET status = 'done'/)
    expect(updates[1].args[0]).toBe('Visible browser result.')

    expect(busEvents).toHaveLength(1)
    expect(busEvents[0]).toMatchObject({
      type: 'task.updated',
      tenant: 'local',
      squad_id: 'sq-growth',
      agent_id: 'agent-hermes',
      payload: {
        task_id: 'task-smoke-1',
        status: 'done',
        title: 'Browser workflow smoke',
      },
    })
  })

  it('refuses to complete a smoke task whose done_when is still a placeholder', async () => {
    const { env, updates, busEvents } = makeEnv({
      localAuth: '1',
      task: { ...baseTask, done_when: '(set via task update)' },
    })

    const res = await postLocalSmokeComplete(env)
    const json = await res.json()

    expect(res.status).toBe(409)
    expect(json).toMatchObject({ error: 'done_when_placeholder' })
    expect(updates).toHaveLength(0)
    expect(busEvents).toHaveLength(0)
  })
})
