import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import type { FlightRow } from '../src/flight/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

vi.mock('../src/auth/member-bearer', () => ({
  resolveOrgAdmin: vi.fn(async () => ({ ok: true, id: { memberId: 'admin-1' } })),
}))

const { flightsApp, parseDispatchBody } = await import('../src/flight/routes')
const { applyPreflight, createFlight, failFlight, landFlight } = await import('../src/flight/service')
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

const signals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 1_000_000,
  budgetEstimateMicroUsd: 200_000,
  recentProgress: 0.8,
  progressPerStep: 0.5,
  wastePerStep: 0.1,
  stepSeconds: 20,
}

const meta = {
  schema: 'mupot.flight.meta/v1',
  goal_id: 'goal-1',
  objective_id: 'objective-1',
  squad_ids: ['squad-a'],
  task_ids: ['task-a'],
  done_when: ['the task is done'],
  artifact_refs: [],
  receipt_refs: [],
  confidentiality: 'internal',
  publication_target: 'none',
  parent_flight_id: null,
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'project-a', 'Project A', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-b', 'project-b', 'Project B', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES ('project-archived', 'project-archived', 'Archived', 'archived');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-b', 'squad-a', 'write');
    INSERT INTO tasks (id, squad_id, title, done_when, status, project_id) VALUES ('task-a', 'squad-a', 'Task A', 'done', 'open', 'project-a');
    INSERT INTO tasks (id, squad_id, title, done_when, status, project_id) VALUES ('task-b', 'squad-a', 'Task B', 'done', 'open', 'project-b');
    INSERT INTO tasks (id, squad_id, title, done_when, status) VALUES ('task-unassigned', 'squad-a', 'Unassigned', 'done', 'open');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness, queries?: string[], beforeFlightInsert?: () => void): Env {
  const db = queries
    ? {
        prepare(sql: string) {
          queries.push(sql)
          return wrapFlightInsert(harness.db.prepare(sql), sql, beforeFlightInsert)
        },
        batch: harness.db.batch.bind(harness.db),
      }
    : beforeFlightInsert
      ? {
          prepare(sql: string) {
            return wrapFlightInsert(harness.db.prepare(sql), sql, beforeFlightInsert)
          },
          batch: harness.db.batch.bind(harness.db),
        }
      : harness.db
  return { DB: db, TENANT_SLUG: 'pot-a' } as unknown as Env
}

function wrapFlightInsert<T extends object>(statement: T, sql: string, beforeFlightInsert?: () => void): T {
  if (!beforeFlightInsert || !sql.includes('INSERT INTO flights (')) return statement
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
            beforeFlightInsert()
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

function dispatchBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { agent: 'agent-a', goal: 'Ship project work', signals, ...overrides }
}

async function dispatch(harness: SqliteD1Harness, body: Record<string, unknown>): Promise<Response> {
  return flightsApp.request('https://pot.test/', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, envFor(harness))
}

async function list(harness: SqliteD1Harness, query = '', queries?: string[]): Promise<Response> {
  return flightsApp.request(`https://pot.test/${query}`, {
    headers: { authorization: 'Bearer admin' },
  }, envFor(harness, queries))
}

describe('flight project attribution', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('parses project_id as a top-level field without adding it to FlightMetaV1', () => {
    const parsed = parseDispatchBody(dispatchBody({ project_id: 'project-a', meta }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.flight.project_id).toBe('project-a')
    expect(parsed.value.flight.meta).toEqual(meta)
    expect(parsed.value.flight.meta).not.toHaveProperty('project_id')
  })

  it('rejects malformed project identifiers at the REST boundary', () => {
    expect(parseDispatchBody(dispatchBody({ project_id: '' }))).toEqual({ ok: false, error: 'invalid_project_id' })
    expect(parseDispatchBody(dispatchBody({ project_id: 42 }))).toEqual({ ok: false, error: 'invalid_project_id' })
    expect(parseDispatchBody(dispatchBody({ project_id: 'x'.repeat(201) }))).toEqual({ ok: false, error: 'invalid_project_id' })
  })

  it('keeps legacy flight creation valid with null attribution', async () => {
    harness = makeHarness()
    const response = await dispatch(harness, dispatchBody())
    expect(response.status).toBe(201)
    const id = (await response.json() as { id: string }).id
    expect(harness.sqlite.prepare('SELECT project_id FROM flights WHERE id = ?').get(id)).toEqual({ project_id: null })
  })

  it('persists an active project outside metadata', async () => {
    harness = makeHarness()
    const response = await dispatch(harness, dispatchBody({ project_id: 'project-a', meta }))
    expect(response.status).toBe(201)
    const id = (await response.json() as { id: string }).id
    const row = harness.sqlite.prepare('SELECT project_id, meta FROM flights WHERE id = ?').get(id) as { project_id: string; meta: string }
    expect(row.project_id).toBe('project-a')
    expect(JSON.parse(row.meta)).toEqual(meta)
  })

  it('rejects missing and archived projects before insertion', async () => {
    harness = makeHarness()
    const missing = await dispatch(harness, dispatchBody({ project_id: 'missing' }))
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: 'project_not_found' })

    const archived = await dispatch(harness, dispatchBody({ project_id: 'project-archived' }))
    expect(archived.status).toBe(400)
    await expect(archived.json()).resolves.toEqual({ error: 'archived_project' })
    expect(harness.sqlite.prepare('SELECT count(*) AS count FROM flights').get()).toEqual({ count: 0 })
  })

  it('rejects mixed and unassigned governed tasks before insertion', async () => {
    harness = makeHarness()
    for (const taskIds of [['task-a', 'task-b'], ['task-a', 'task-unassigned']]) {
      const response = await dispatch(harness, dispatchBody({
        project_id: 'project-a',
        meta: { ...meta, task_ids: taskIds },
      }))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: 'flight_task_project_mismatch' })
    }
    expect(harness.sqlite.prepare('SELECT count(*) AS count FROM flights').get()).toEqual({ count: 0 })
  })

  it('returns flight_task_not_found for a missing governed task', async () => {
    harness = makeHarness()
    const response = await dispatch(harness, dispatchBody({
      project_id: 'project-a',
      meta: { ...meta, task_ids: ['missing-task'] },
    }))
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'flight_task_not_found' })
    expect(harness.sqlite.prepare('SELECT count(*) AS count FROM flights').get()).toEqual({ count: 0 })
  })

  it('filters the bounded list query by project while preserving the absent-filter query', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at) VALUES ('flight-a', 'pot-a', 'a', 'A', 'landed', 'project-a', 3);
      INSERT INTO flights (id, tenant, agent, goal, status, project_id, created_at) VALUES ('flight-b', 'pot-a', 'b', 'B', 'landed', 'project-b', 2);
      INSERT INTO flights (id, tenant, agent, goal, status, created_at) VALUES ('flight-null', 'pot-a', 'c', 'C', 'landed', 1);
    `)

    const filteredQueries: string[] = []
    const filtered = await list(harness, '?project_id=project-a', filteredQueries)
    expect(filtered.status).toBe(200)
    expect((await filtered.json() as { flights: FlightRow[] }).flights).toEqual([
      expect.objectContaining({ id: 'flight-a', project_id: 'project-a' }),
    ])
    expect(filteredQueries.some((sql) => sql.includes('project_id=?2') && sql.includes('LIMIT ?3'))).toBe(true)

    const legacyQueries: string[] = []
    const legacy = await list(harness, '', legacyQueries)
    expect((await legacy.json() as { flights: FlightRow[] }).flights.map((flight) => flight.id)).toEqual(['flight-a', 'flight-b', 'flight-null'])
    expect(legacyQueries.some((sql) => sql.includes('FROM flights WHERE tenant=?1 ORDER BY created_at DESC LIMIT ?2'))).toBe(true)
  })

  it('maps final project trigger failures to stable service errors', async () => {
    for (const [message, code] of [
      ['flight project not found', 'project_not_found'],
      ['flight project archived', 'archived_project'],
      ['flight task not found', 'flight_task_not_found'],
      ['flight task project mismatch', 'flight_task_project_mismatch'],
      ['flight project access denied', 'project_access_forbidden'],
    ] as const) {
      const env = {
        TENANT_SLUG: 'pot-a',
        DB: {
          prepare(sql: string) {
            return {
              bind() {
                return {
                  async first() {
                    if (sql.includes('SELECT status FROM projects')) return { status: 'active' }
                    return null
                  },
                  async run() {
                    throw new Error(message)
                  },
                }
              },
            }
          },
        },
      } as unknown as Env

      await expect(createFlight(env, { agent: 'agent-a', goal: 'g', project_id: 'project-a' }))
        .rejects.toMatchObject({ code })
    }
  })

  it('refuses governed landing when a legacy drifted task no longer matches the flight project', async () => {
    harness = makeHarness()
    harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, project_id)
      VALUES ('flight-drift', 'pot-a', 'agent-a', 'Drifted', 'running', 10, ?, 'project-a')
    `).run(JSON.stringify(meta))
    // Model a legacy/directly-corrupted row that predates the durable task lock.
    harness.sqlite.exec(`
      DROP TRIGGER validate_tasks_project_id_update;
      UPDATE tasks SET project_id = 'project-b', status = 'done' WHERE id = 'task-a';
    `)

    const response = await flightsApp.request('https://pot.test/flight-drift/land', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 1 }),
    }, envFor(harness))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'flight_task_project_conflict',
      task_ids: ['task-a'],
    })
    expect(harness.sqlite.prepare(`SELECT status FROM flights WHERE id = 'flight-drift'`).get())
      .toEqual({ status: 'running' })
  })

  it('maps an edge revoked after validation but before insert to stable project access denial', async () => {
    harness = makeHarness()
    const env = envFor(harness, undefined, () => {
      harness!.sqlite.exec(`
        DELETE FROM project_squad_access
         WHERE project_id = 'project-a' AND squad_id = 'squad-a'
      `)
    })

    await expect(createFlight(env, {
      agent: 'agent-a',
      goal: 'Revoked edge race',
      project_id: 'project-a',
      meta: meta as never,
    })).rejects.toMatchObject({ code: 'project_access_forbidden' })
    expect(harness.sqlite.prepare(`SELECT count(*) AS count FROM flights`).get()).toEqual({ count: 0 })
  })

  it('maps a task deleted after validation but before insert to stable task not found', async () => {
    harness = makeHarness()
    const env = envFor(harness, undefined, () => {
      harness!.sqlite.exec(`DELETE FROM tasks WHERE id = 'task-a'`)
    })

    await expect(createFlight(env, {
      agent: 'agent-a',
      goal: 'Deleted task race',
      project_id: 'project-a',
      meta: meta as never,
    })).rejects.toMatchObject({ code: 'flight_task_not_found' })
    expect(harness.sqlite.prepare(`SELECT count(*) AS count FROM flights`).get()).toEqual({ count: 0 })
  })

  it('allows authorized governed flights to settle after their project edge is revoked', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const landedId = await createFlight(env, {
      agent: 'agent-a',
      goal: 'Land after revoke',
      project_id: 'project-a',
      meta: meta as never,
    })
    const failedId = await createFlight(env, {
      agent: 'agent-a',
      goal: 'Fail after revoke',
      project_id: 'project-a',
      meta: meta as never,
    })
    harness.sqlite.exec(`
      DELETE FROM project_squad_access
       WHERE project_id = 'project-a' AND squad_id = 'squad-a'
    `)

    await applyPreflight(env, landedId, { go: true, score: 1, checks: {} as never, reasons: [] })
    await landFlight(env, landedId, { cost_micro_usd: 25, score: 1 })
    await failFlight(env, failedId, 'settled failure')

    expect(harness.sqlite.prepare(`
      SELECT status, cost_micro_usd FROM flights WHERE id = ?
    `).get(landedId)).toEqual({ status: 'landed', cost_micro_usd: 25 })
    expect(harness.sqlite.prepare(`
      SELECT status, gate_reason FROM flights WHERE id = ?
    `).get(failedId)).toEqual({ status: 'failed', gate_reason: 'settled failure' })
  })

  it('returns stable project_write denial when the durable route insert lacks an edge', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      DELETE FROM project_squad_access
       WHERE project_id = 'project-a' AND squad_id = 'squad-a'
    `)

    const response = await dispatch(harness, dispatchBody({ project_id: 'project-a', meta }))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden', need: 'project_write' })
    expect(harness.sqlite.prepare(`SELECT count(*) AS count FROM flights`).get()).toEqual({ count: 0 })
  })
})
