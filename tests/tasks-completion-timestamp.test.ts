import { describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env, Task } from '../src/types'

const approvedTask: Task = {
  id: 'task-approved',
  squad_id: 'squad-1',
  project_id: null,
  title: 'Land the governed flight',
  body: 'Complete after the owner verdict.',
  done_when: 'The owner verdict is approved and the flight can land.',
  status: 'approved',
  assignee_agent_id: 'agent-product',
  github_issue_url: null,
  result: null,
  completed_at: null,
  gate_owner: 'gate:m0-census',
  created_at: '2026-07-12T01:00:00.000Z',
  updated_at: '2026-07-12T02:00:00.000Z',
}

function makeEnv(task: Task = approvedTask) {
  const updates: Array<{ sql: string; args: unknown[] }> = []
  const env = {
    TENANT_SLUG: 'mumega',
    BRAND: 'Mupot',
    SESSIONS: {
      get: vi.fn(async (key: string) => {
        if (key !== 'sess:owner-session') return null
        return JSON.stringify({
          userId: 'owner-1',
          email: 'owner@mupot.test',
          role: 'owner',
          createdAt: '2026-07-12T00:00:00.000Z',
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
                if (sql.includes('FROM tasks')) return task as T
                return null as T
              },
              async run() {
                if (sql.includes('UPDATE tasks')) updates.push({ sql, args })
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env

  return { env, updates }
}

describe('PATCH /:id completion timestamp', () => {
  it('records completion time when an approved task transitions to done', async () => {
    const { env, updates } = makeEnv()
    const res = await tasksApp.fetch(
      new Request('https://pot.test/task-approved', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          Cookie: 'mupot_session=owner-session',
          Origin: 'https://pot.test',
        },
        body: JSON.stringify({ status: 'done' }),
      }),
      env,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { task: Task }
    expect(body.task.completed_at).toBe(body.task.updated_at)
    expect(body.task.completed_at).not.toBeNull()
    expect(updates).toHaveLength(1)
    expect(updates[0].sql).toContain('completed_at = ?')
    expect(updates[0].args).toContain(body.task.completed_at)
  })

  it('preserves completion time when editing an already-completed task', async () => {
    const completedAt = '2026-07-12T03:00:00.000Z'
    const { env } = makeEnv({
      ...approvedTask,
      status: 'done',
      completed_at: completedAt,
    })
    const res = await tasksApp.fetch(
      new Request('https://pot.test/task-approved', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          Cookie: 'mupot_session=owner-session',
          Origin: 'https://pot.test',
        },
        body: JSON.stringify({ title: 'Clarify the landed flight title' }),
      }),
      env,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { task: Task }
    expect(body.task.updated_at).not.toBe(approvedTask.updated_at)
    expect(body.task.completed_at).toBe(completedAt)
  })

  it('records completion time for an ordinary in-progress task', async () => {
    const { env } = makeEnv({
      ...approvedTask,
      status: 'in_progress',
      gate_owner: null,
    })
    const res = await tasksApp.fetch(
      new Request('https://pot.test/task-approved', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          Cookie: 'mupot_session=owner-session',
          Origin: 'https://pot.test',
        },
        body: JSON.stringify({ status: 'done' }),
      }),
      env,
    )

    expect(res.status).toBe(200)
    const body = await res.json() as { task: Task }
    expect(body.task.completed_at).toBe(body.task.updated_at)
  })
})
