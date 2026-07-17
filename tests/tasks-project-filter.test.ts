import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthContext, Env, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const authState = vi.hoisted(() => ({ current: null as AuthContext | null }))

vi.mock('../src/auth', () => ({
  requireAuth: async (
    c: { set: (key: 'auth', value: AuthContext) => void; json: (body: unknown, status: 401) => Response },
    next: () => Promise<void>,
  ) => {
    if (!authState.current) return c.json({ error: 'unauthenticated' }, 401)
    c.set('auth', authState.current)
    await next()
  },
}))

const { tasksApp } = await import('../src/tasks')
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO departments (id, slug, name) VALUES ('dept-b', 'dept-b', 'Department B');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-b', 'squad-b', 'Squad B');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-write', 'project-write', 'Write project', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-read', 'project-read', 'Read project', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-hidden', 'project-hidden', 'Hidden project', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-archived', 'project-archived', 'Archived project', 'archived');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-write', 'squad-a', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-read', 'squad-a', 'read');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-hidden', 'squad-b', 'admin');
  `)
  return harness
}

function actor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'member-a',
    memberId: 'member-a',
    email: null,
    role: 'member',
    tenant: 'pot-a',
    capabilities: [
      { member_id: 'member-a', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' },
    ],
    ...overrides,
  }
}

function envFor(
  harness: SqliteD1Harness,
  queries?: string[],
  beforeTaskUpdate?: () => void,
): Env {
  const db = queries
    ? {
        prepare(sql: string) {
          queries.push(sql)
          return wrapTaskUpdate(harness.db.prepare(sql), sql, beforeTaskUpdate)
        },
        batch: harness.db.batch.bind(harness.db),
      }
    : beforeTaskUpdate
      ? {
          prepare(sql: string) {
            return wrapTaskUpdate(harness.db.prepare(sql), sql, beforeTaskUpdate)
          },
          batch: harness.db.batch.bind(harness.db),
        }
      : harness.db
  return {
    DB: db,
    TENANT_SLUG: 'pot-a',
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function wrapTaskUpdate<T extends object>(statement: T, sql: string, beforeTaskUpdate?: () => void): T {
  if (!beforeTaskUpdate || !/^UPDATE tasks\s+SET title =/m.test(sql)) return statement
  let fired = false
  const wrap = (target: object): object => new Proxy(target, {
    get(current, property) {
      if (property === 'bind') {
        return (...values: unknown[]) => wrap((current as { bind(...args: unknown[]): object }).bind(...values))
      }
      if (property === 'run') {
        return async () => {
          if (!fired) {
            fired = true
            beforeTaskUpdate()
          }
          return (current as { run(): Promise<unknown> }).run()
        }
      }
      const value = Reflect.get(current, property)
      return typeof value === 'function' ? value.bind(current) : value
    },
  })
  return wrap(statement) as T
}

function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { Origin: 'https://pot.test' }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function fetch(harness: SqliteD1Harness, path: string, method = 'GET', body?: unknown, queries?: string[]): Promise<Response> {
  return tasksApp.fetch(request(path, method, body), envFor(harness, queries))
}

function taskBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    squad_id: 'squad-a',
    title: 'Project work',
    done_when: 'the project task is complete',
    ...overrides,
  }
}

describe('task project attribution', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    authState.current = null
    harness?.close()
    harness = undefined
  })

  it('preserves legacy creation and listing with null project attribution', async () => {
    harness = makeHarness()
    authState.current = actor()

    const created = await fetch(harness, '/', 'POST', taskBody())
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { task: Task }
    expect(createdBody.task.project_id).toBeNull()

    const listed = await fetch(harness, '/')
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toMatchObject({
      tasks: [{ id: createdBody.task.id, project_id: null }],
    })
  })

  it('persists an authorized project and includes it in the created event', async () => {
    harness = makeHarness()
    authState.current = actor()
    const events: unknown[] = []
    const env = envFor(harness)
    env.BUS = { send: vi.fn(async (event: unknown) => { events.push(event) }) } as Env['BUS']

    const response = await tasksApp.fetch(request('/', 'POST', taskBody({ project_id: 'project-write' })), env)
    expect(response.status).toBe(201)
    const task = (await response.json() as { task: Task }).task
    expect(task.project_id).toBe('project-write')
    expect(harness.sqlite.prepare('SELECT project_id FROM tasks WHERE id = ?').get(task.id)).toEqual({ project_id: 'project-write' })
    expect(events).toContainEqual(expect.objectContaining({
      type: 'task.created',
      payload: expect.objectContaining({ task_id: task.id, project_id: 'project-write' }),
    }))
  })

  it('requires both existing squad authority and an explicit write/admin project edge', async () => {
    harness = makeHarness()
    authState.current = actor({ capabilities: [] })
    expect((await fetch(harness, '/', 'POST', taskBody({ project_id: 'project-write' }))).status).toBe(403)

    authState.current = actor()
    const readOnly = await fetch(harness, '/', 'POST', taskBody({ project_id: 'project-read' }))
    expect(readOnly.status).toBe(403)
    await expect(readOnly.json()).resolves.toEqual({ error: 'forbidden', need: 'project_write' })

    const hidden = await fetch(harness, '/', 'POST', taskBody({ project_id: 'project-hidden' }))
    expect(hidden.status).toBe(403)
    await expect(hidden.json()).resolves.toEqual({ error: 'forbidden', need: 'project_write' })
  })

  it('rejects missing and archived project targets with stable errors', async () => {
    harness = makeHarness()
    authState.current = actor()

    const missing = await fetch(harness, '/', 'POST', taskBody({ project_id: 'missing' }))
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: 'project_not_found' })

    const archived = await fetch(harness, '/', 'POST', taskBody({ project_id: 'project-archived' }))
    expect(archived.status).toBe(400)
    await expect(archived.json()).resolves.toEqual({ error: 'archived_project' })
  })

  it('filters inside the existing bounded readable-squad queries without changing the absent-filter path', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      UPDATE project_squad_access SET access_level = 'write'
       WHERE project_id = 'project-read' AND squad_id = 'squad-a';
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id) VALUES ('task-write', 'squad-a', 'Write work', 'done', 'open', 'project-write');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id) VALUES ('task-read', 'squad-a', 'Read work', 'done', 'open', 'project-read');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id) VALUES ('task-hidden', 'squad-b', 'Hidden work', 'done', 'open', 'project-hidden');
      INSERT INTO tasks (id, squad_id, title, done_when, status) VALUES ('task-unassigned', 'squad-a', 'Unassigned', 'done', 'open');
      UPDATE project_squad_access SET access_level = 'read'
       WHERE project_id = 'project-read' AND squad_id = 'squad-a';
    `)
    authState.current = actor()

    const filteredQueries: string[] = []
    const filtered = await fetch(harness, '/?project_id=project-write', 'GET', undefined, filteredQueries)
    expect(filtered.status).toBe(200)
    expect((await filtered.json() as { tasks: Task[] }).tasks.map((task) => task.id)).toEqual(['task-write'])
    const filteredTaskQueries = filteredQueries.filter((sql) => sql.includes('FROM tasks'))
    expect(filteredTaskQueries).toHaveLength(2)
    expect(filteredTaskQueries.every((sql) => sql.includes('project_id = ?') && /LIMIT \d+/.test(sql))).toBe(true)

    const legacyQueries: string[] = []
    const legacy = await fetch(harness, '/', 'GET', undefined, legacyQueries)
    expect((await legacy.json() as { tasks: Task[] }).tasks.map((task) => task.id).sort()).toEqual(['task-read', 'task-unassigned', 'task-write'])
    expect(legacyQueries.filter((sql) => sql.includes('FROM tasks')).every((sql) => !sql.includes('project_id = ?'))).toBe(true)
  })

  it('returns the same 404 for unknown and inaccessible project filters', async () => {
    harness = makeHarness()
    authState.current = actor()

    for (const projectId of ['missing', 'project-hidden']) {
      const response = await fetch(harness, `/?project_id=${projectId}`)
      expect(response.status).toBe(404)
      await expect(response.json()).resolves.toEqual({ error: 'project_not_found' })
    }
  })

  it('reassigns and removes project attribution using the task data-derived squad', async () => {
    harness = makeHarness()
    harness.sqlite.exec("INSERT INTO tasks (id, squad_id, title, done_when, status) VALUES ('task-a', 'squad-a', 'Task A', 'done', 'open')")
    authState.current = actor()

    const assigned = await fetch(harness, '/task-a', 'PATCH', { project_id: 'project-write' })
    expect(assigned.status).toBe(200)
    await expect(assigned.json()).resolves.toMatchObject({ task: { id: 'task-a', project_id: 'project-write' } })

    const denied = await fetch(harness, '/task-a', 'PATCH', { project_id: 'project-hidden' })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toEqual({ error: 'forbidden', need: 'project_write' })

    const removed = await fetch(harness, '/task-a', 'PATCH', { project_id: null })
    expect(removed.status).toBe(200)
    await expect(removed.json()).resolves.toMatchObject({ task: { id: 'task-a', project_id: null } })
  })

  it('returns a stable conflict and emits no event when a concurrent reassignment wins', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-race', 'squad-a', 'Original', 'done', 'open', 'project-write')
    `)
    authState.current = actor()
    const events: unknown[] = []
    const env = envFor(harness, undefined, () => {
      harness!.sqlite.exec(`
        UPDATE tasks
           SET project_id = NULL, updated_at = 'concurrent-update'
         WHERE id = 'task-race'
      `)
    })
    env.BUS = { send: vi.fn(async (event: unknown) => { events.push(event) }) } as Env['BUS']

    const response = await tasksApp.fetch(request('/task-race', 'PATCH', { title: 'Stale title' }), env)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'task_update_conflict' })
    expect(harness.sqlite.prepare(`SELECT title, project_id FROM tasks WHERE id = 'task-race'`).get())
      .toEqual({ title: 'Original', project_id: null })
    expect(events).toEqual([])
  })

  it('revalidates the effective project on every patch and maps an archive race to conflict', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-archive-race', 'squad-a', 'Original', 'done', 'open', 'project-write')
    `)
    authState.current = actor()
    const env = envFor(harness, undefined, () => {
      harness!.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'project-write'`)
    })

    const response = await tasksApp.fetch(request('/task-archive-race', 'PATCH', { body: 'stale body' }), env)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'task_update_conflict' })
    expect(harness.sqlite.prepare(`SELECT body FROM tasks WHERE id = 'task-archive-race'`).get())
      .toEqual({ body: '' })
  })

  it('maps durable attributed-flight task locks to a stable project conflict', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-locked', 'squad-a', 'Locked', 'done', 'open', 'project-write');
      INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
      VALUES (
        'flight-lock', 'pot-a', 'agent', 'Lock task',
        '{"schema":"mupot.flight.meta/v1","goal_id":"goal","objective_id":"objective","squad_ids":["squad-a"],"task_ids":["task-locked"],"done_when":["done"],"artifact_refs":[]}',
        'project-write'
      );
    `)
    authState.current = actor()

    const response = await fetch(harness, '/task-locked', 'PATCH', { project_id: null })
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'task_project_locked' })
    expect(harness.sqlite.prepare(`SELECT project_id FROM tasks WHERE id = 'task-locked'`).get())
      .toEqual({ project_id: 'project-write' })
  })
})
