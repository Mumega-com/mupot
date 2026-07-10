import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, mirrorTaskCreate, mirrorTaskUpdate } from '../src/tasks/service'

function makeTaskEnv(opts: { insertChanges?: number; linkChanges?: number } = {}) {
  const inserts: unknown[][] = []
  const linkUpdates: unknown[][] = []
  const events: unknown[] = []
  const insertChanges = opts.insertChanges ?? 1
  const linkChanges = opts.linkChanges ?? 1

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
                if (sql.includes('INSERT INTO tasks')) return { meta: { changes: insertChanges } }
                if (sql.includes('UPDATE tasks SET github_issue_url')) {
                  linkUpdates.push(args)
                  return { meta: { changes: linkChanges } }
                }
                return { meta: { changes: 1 } }
              },
            }
          },
        }
      },
    },
  }

  return { env: env as never, inserts, linkUpdates, events }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createTask', () => {
  it('persists once, mirrors to GitHub, and emits an attributed notification', async () => {
    const { env, inserts, linkUpdates, events } = makeTaskEnv()
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
        done_when: 'channel tasks test passes',
        body: 'durable work',
      },
      { actor: { kind: 'agent', id: 'agent-1' } },
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/widgets/issues',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(task.title).toBe('Ship channel tasks')
    expect(task.done_when).toBe('channel tasks test passes')
    expect(task.github_issue_url).toBe('https://github.com/acme/widgets/issues/7')

    expect(inserts).toHaveLength(1)
    expect(inserts[0]).toEqual([
      task.id,
      'squad-1',
      'Ship channel tasks',
      'durable work',
      'channel tasks test passes',
      'open',
      null,
      null,
      null, // result — unset on create
      null, // completed_at — unset on create
      null, // gate_owner — unset on create
      task.created_at,
      task.updated_at,
    ])
    expect(linkUpdates).toEqual([['https://github.com/acme/widgets/issues/7', task.id]])

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

  it('does not mirror to GitHub when the task insert receipt fails', async () => {
    const { env, inserts, linkUpdates, events } = makeTaskEnv({ insertChanges: 0 })
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ html_url: 'https://github.com/acme/widgets/issues/9' }), {
        status: 201,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(createTask(env, {
      squad_id: 'squad-1',
      title: 'No orphan issue',
      done_when: 'task insert failure does not create a GitHub issue',
    })).rejects.toThrow(/receipt_failed: tasks\.insert/)

    expect(inserts).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(linkUpdates).toEqual([])
    expect(events).toEqual([])
  })
})

describe('mirrorTaskUpdate', () => {
  const baseTask = {
    id: 'task-1',
    squad_id: 'squad-1',
    title: 'A task',
    body: '',
    done_when: 'task verified complete',
    status: 'open' as const,
    assignee_agent_id: null,
    result: null,
    completed_at: null,
    gate_owner: null,
    github_issue_url: null,
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

describe('mirrorTaskCreate timeout', () => {
  it('fails soft when GitHub never completes the issue response', async () => {
    vi.useFakeTimers()
    try {
      const { env } = makeTaskEnv()
      const fetchMock = vi.fn((_: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal as AbortSignal
          signal.addEventListener('abort', () => reject(new Error('request_aborted')))
        }))
      vi.stubGlobal('fetch', fetchMock)

      const pending = mirrorTaskCreate(env, {
        id: 'task-timeout',
        squad_id: 'squad-1',
        title: 'Bound GitHub mirror',
        body: '',
        done_when: 'the request returns without hanging',
        status: 'open',
        assignee_agent_id: null,
        github_issue_url: null,
        result: null,
        completed_at: null,
        gate_owner: null,
        created_at: '2026-07-10T00:00:00.000Z',
        updated_at: '2026-07-10T00:00:00.000Z',
      })

      await vi.advanceTimersByTimeAsync(5_001)
      await expect(pending).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/acme/widgets/issues',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
