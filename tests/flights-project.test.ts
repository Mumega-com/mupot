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

interface BindObservation {
  sql: string
  count: number
}

function enforceBindBudget<T extends object>(
  statement: T,
  sql: string,
  observations: BindObservation[],
  maxBinds = 100,
): T {
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'bind') {
        return (...values: unknown[]) => {
          observations.push({ sql, count: values.length })
          if (values.length > maxBinds) throw new Error(`D1 bind budget exceeded: ${values.length}`)
          const bound = (target as { bind(...args: unknown[]): object }).bind(...values)
          return enforceBindBudget(bound, sql, observations, maxBinds)
        }
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

function envWithBindBudget(harness: SqliteD1Harness): { env: Env; observations: BindObservation[] } {
  const observations: BindObservation[] = []
  const db = {
    prepare(sql: string) {
      return enforceBindBudget(harness.db.prepare(sql), sql, observations)
    },
    batch: harness.db.batch.bind(harness.db),
  }
  return { env: { DB: db, TENANT_SLUG: 'pot-a' } as unknown as Env, observations }
}

function seedBulkTasks(
  harness: SqliteD1Harness,
  count: number,
  override: (index: number) => Partial<{
    projectId: string
    status: string
    gateOwner: string | null
    verdict: 'approved' | 'rejected' | null
  }> = () => ({}),
): string[] {
  const taskIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    const id = `task-bulk-${String(index).padStart(3, '0')}`
    const values = {
      projectId: 'project-a',
      status: 'done',
      gateOwner: null as string | null,
      verdict: null as 'approved' | 'rejected' | null,
      ...override(index),
    }
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id, gate_owner)
      VALUES (?, 'squad-a', ?, 'verified', ?, ?, ?)
    `).run(id, `Bulk task ${index}`, values.status, values.projectId, values.gateOwner)
    if (values.verdict) {
      harness.sqlite.prepare(`
        INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at)
        VALUES (?, ?, ?, 'reviewer', ?)
      `).run(`verdict-${id}`, id, values.verdict, `2026-07-17T00:${String(index).padStart(2, '0')}:00.000Z`)
    }
    taskIds.push(id)
  }
  return taskIds
}

function insertGovernedFlight(harness: SqliteD1Harness, id: string, taskIds: string[]): void {
  harness.sqlite.exec('DROP TRIGGER validate_flights_project_id_insert')
  harness.sqlite.prepare(`
    INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, project_id)
    VALUES (?, 'pot-a', 'agent-a', 'Bulk governed flight', 'running', 10, ?, 'project-a')
  `).run(id, JSON.stringify({ ...meta, task_ids: taskIds }))
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

async function dispatch(
  harness: SqliteD1Harness,
  body: Record<string, unknown>,
  env: Env = envFor(harness),
): Promise<Response> {
  return flightsApp.request('https://pot.test/', {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env)
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

  it('dispatches the maximum task set without exceeding the D1 bind budget', async () => {
    harness = makeHarness()
    const taskIds = seedBulkTasks(harness, 200)
    const { env, observations } = envWithBindBudget(harness)

    const response = await dispatch(harness, dispatchBody({
      project_id: 'project-a',
      meta: { ...meta, task_ids: taskIds },
    }), env)

    expect(response.status).toBe(201)
    const taskReads = observations.filter(({ sql }) => sql.includes('FROM tasks WHERE id IN'))
    expect(taskReads).toHaveLength(6)
    expect(Math.max(...taskReads.map(({ count }) => count))).toBeLessThanOrEqual(90)
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
      ['flight meta invalid', 'invalid_flight_meta'],
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

  it('fails closed when an existing v1 flight exceeds the newer UTF-8 contract', async () => {
    harness = makeHarness()
    const legacyUtf16Meta = { ...meta, goal_id: '\u06a9'.repeat(101) }
    harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, project_id)
      VALUES ('flight-legacy-utf16', 'pot-a', 'agent-a', 'Legacy UTF-16 metadata', 'running', 10, ?, 'project-a')
    `).run(JSON.stringify(legacyUtf16Meta))

    const response = await flightsApp.request('https://pot.test/flight-legacy-utf16/land', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 1 }),
    }, envFor(harness))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'flight_meta_incompatible' })
    expect(harness.sqlite.prepare(`SELECT status FROM flights WHERE id = 'flight-legacy-utf16'`).get())
      .toEqual({ status: 'running' })
  })

  it('fails closed when duplicate schema keys disagree across JSON parsers', async () => {
    harness = makeHarness()
    const duplicateSchemaMeta = `${JSON.stringify(meta).slice(0, -1)},"schema":"legacy/v0"}`
    harness.sqlite.prepare(`
      INSERT INTO flights (id, tenant, agent, goal, status, budget_micro_usd, meta, project_id)
      VALUES ('flight-duplicate-schema', 'pot-a', 'agent-a', 'Duplicate schema metadata', 'running', 10, ?, 'project-a')
    `).run(duplicateSchemaMeta)

    const response = await flightsApp.request('https://pot.test/flight-duplicate-schema/land', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 1 }),
    }, envFor(harness))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'flight_meta_incompatible' })
    expect(harness.sqlite.prepare(`SELECT status FROM flights WHERE id = 'flight-duplicate-schema'`).get())
      .toEqual({ status: 'running' })
  })

  it('reports large project-mismatch sets in input order within the D1 bind budget', async () => {
    harness = makeHarness()
    const mismatchIndexes = new Set([5, 150])
    const taskIds = seedBulkTasks(harness, 200, (index) => (
      mismatchIndexes.has(index) ? { projectId: 'project-b' } : {}
    ))
    insertGovernedFlight(harness, 'flight-bulk-mismatch', taskIds)
    const { env, observations } = envWithBindBudget(harness)

    const response = await flightsApp.request('https://pot.test/flight-bulk-mismatch/land', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 1 }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'flight_task_project_conflict',
      task_ids: [taskIds[5], taskIds[150]],
    })
    const taskReads = observations.filter(({ sql }) => sql.includes('SELECT id, project_id FROM tasks WHERE id IN'))
    expect(taskReads).toHaveLength(3)
    expect(Math.max(...taskReads.map(({ count }) => count))).toBeLessThanOrEqual(90)
  })

  it('reports large incomplete and gated task sets in input order within the D1 bind budget', async () => {
    harness = makeHarness()
    const taskIds = seedBulkTasks(harness, 200, (index) => {
      if (index === 5) return { status: 'in_progress' }
      if (index === 150) return { gateOwner: 'gate:bulk', verdict: 'rejected' }
      return {}
    })
    insertGovernedFlight(harness, 'flight-bulk-incomplete', taskIds)
    const { env, observations } = envWithBindBudget(harness)

    const response = await flightsApp.request('https://pot.test/flight-bulk-incomplete/land', {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ cost_micro_usd: 1 }),
    }, env)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'flight_tasks_incomplete',
      task_ids: [taskIds[5], taskIds[150]],
    })
    const mismatchReads = observations.filter(({ sql }) => sql.includes('SELECT id, project_id FROM tasks WHERE id IN'))
    const completionReads = observations.filter(({ sql }) => sql.includes('SELECT id, status, gate_owner'))
    expect(mismatchReads).toHaveLength(3)
    expect(completionReads).toHaveLength(3)
    expect(Math.max(...[...mismatchReads, ...completionReads].map(({ count }) => count))).toBeLessThanOrEqual(90)
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
