import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, mirrorTaskUpdate } from '../src/tasks/service'

function makeTaskEnv() {
  const inserts: unknown[][] = []
  const events: unknown[] = []

  const env = {
    TENANT_SLUG: 'test-tenant',
    GITHUB_TOKEN: 'gh-token',
    GITHUB_REPO: 'acme/widgets',
    BUS: {
      send: vi.fn(async (event: unknown) => {
        events.push(event)
      }),
    },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async run() {
                if (sql.includes('INSERT INTO tasks')) inserts.push(args)
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  }

  return { env: env as never, inserts, events }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createTask', () => {
  it('persists once, mirrors to GitHub, and emits an attributed notification', async () => {
    const { env, inserts, events } = makeTaskEnv()
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ html_url: 'https://github.com/acme/widgets/issues/7' }), {
        status: 201,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const task = await createTask(
      env,
      {
        squad_id: 'squad-1',
        title: '  Ship channel tasks  ',
        body: 'durable work',
      },
      { actor: { kind: 'agent', id: 'agent-1' } },
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/widgets/issues',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(task.title).toBe('Ship channel tasks')
    expect(task.github_issue_url).toBe('https://github.com/acme/widgets/issues/7')

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toEqual([
      task.id,
      'squad-1',
      'Ship channel tasks',
      'durable work',
      'open',
      null,
      'https://github.com/acme/widgets/issues/7',
      null, // result — unset on create
      null, // completed_at — unset on create
      null, // gate_owner — unset on create
      task.created_at,
      task.updated_at,
    ])

    expect(events).toEqual([
      expect.objectContaining({
        type: 'task.created',
        tenant: 'test-tenant',
        squad_id: 'squad-1',
        agent_id: 'agent-1',
        actor: { kind: 'agent', id: 'agent-1' },
        payload: expect.objectContaining({ task_id: task.id, title: task.title }),
      }),
    ])
  })
})

describe('mirrorTaskUpdate', () => {
  const baseTask = {
    id: 'task-1',
    squad_id: 'squad-1',
    title: 'A task',
    body: '',
    status: 'open' as const,
    assignee_agent_id: null,
    result: null,
    completed_at: null,
    created_at: '2026-06-06T00:00:00.000Z',
    updated_at: '2026-06-06T00:00:00.000Z',
  }

  it('does NOT create an issue for a never-mirrored task (closes the reflection side-door)', async () => {
    // Security: update must never create. A null issue = never mirrored (no token at
    // create, or skipMirror for a webhook-origin task). Creating here would reflect
    // attacker-influenced webhook fields out under our token (P1).
    const { env } = makeTaskEnv()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const url = await mirrorTaskUpdate(env, { ...baseTask, github_issue_url: null })

    expect(url).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled() // never creates on update
  })

  it('PATCHes an already-mirrored task', async () => {
    const { env } = makeTaskEnv()
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ html_url: 'https://github.com/acme/widgets/issues/8' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const url = await mirrorTaskUpdate(env, {
      ...baseTask,
      github_issue_url: 'https://github.com/acme/widgets/issues/8',
    })

    expect(url).toBe('https://github.com/acme/widgets/issues/8')
    expect(fetchMock).toHaveBeenCalledTimes(1) // PATCH, not create
  })
})
