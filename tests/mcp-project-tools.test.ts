import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invokeTool, TOOLS } from '../src/mcp'
import type { AuthContext, Env, Task } from '../src/types'
import type { FlightRow } from '../src/flight/service'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const TENANT = 'pot-a'
const MEMBER_ID = 'member-a'
const AGENT_ID = 'agent-a'
const SQUAD_ID = 'squad-a'

const signals = {
  contextComplete: true,
  toolsReachable: true,
  budgetRemainingMicroUsd: 100,
  budgetEstimateMicroUsd: 0,
  recentProgress: 0.9,
  progressPerStep: 0.8,
  wastePerStep: 0.1,
  stepSeconds: 5,
}

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${SQUAD_ID}', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'agent-a', 'Agent A', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-a', 'project-a', 'Project A', 'active'),
      ('project-b', 'project-b', 'Project B', 'active'),
      ('project-read', 'project-read', 'Project Read', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
      ('project-a', '${SQUAD_ID}', 'write'),
      ('project-b', '${SQUAD_ID}', 'admin'),
      ('project-read', '${SQUAD_ID}', 'read');
  `)
  return harness
}

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: MEMBER_ID,
    memberId: MEMBER_ID,
    email: null,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: AGENT_ID,
    capabilities: [
      { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
    ],
    ...overrides,
  }
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function flightMeta(taskId: string): Record<string, unknown> {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal-a',
    objective_id: 'objective-a',
    squad_ids: [SQUAD_ID],
    task_ids: [taskId],
    done_when: ['done'],
    artifact_refs: [],
    receipt_refs: [],
    confidentiality: 'internal',
    publication_target: 'none',
    parent_flight_id: null,
  }
}

describe('MCP project attribution parity', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('documents project_id on every project-aware tool schema', () => {
    for (const name of ['task_create', 'task_update', 'task_list', 'flight_dispatch', 'flight_list']) {
      const tool = TOOLS.find((candidate) => candidate.name === name)
      expect(tool?.inputSchema.additionalProperties).toBe(false)
      expect(tool?.inputSchema.properties).toHaveProperty('project_id')
      expect(tool?.inputSchema.properties.project_id).toMatchObject({ type: ['string', 'null'] })
    }
  })

  it('creates, reassigns, and filters tasks with REST-equivalent project checks', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const created = await invokeTool(auth(), env, 'task_create', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      title: 'MCP project task',
      done_when: 'the MCP project tests pass',
    }, 'https://pot.test')
    expect(created).toMatchObject({ ok: true, result: { task: { project_id: 'project-a' } } })
    const taskId = ((created.result as { task: Task }).task).id

    const reassigned = await invokeTool(auth(), env, 'task_update', {
      task_id: taskId,
      project_id: 'project-b',
    }, 'https://pot.test')
    expect(reassigned).toMatchObject({ ok: true, result: { task: { project_id: 'project-b' } } })

    const listed = await invokeTool(auth(), env, 'task_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-b',
    }, 'https://pot.test')
    expect((listed.result as { tasks: Task[] }).tasks.map((task) => task.id)).toEqual([taskId])

    const readOnly = await invokeTool(auth(), env, 'task_create', {
      squad_id: SQUAD_ID,
      project_id: 'project-read',
      title: 'Denied',
      done_when: 'never inserted',
    }, 'https://pot.test')
    expect(readOnly).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('keeps squad authority mandatory even when the project grants write access', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const noSquadAuthority = auth({ capabilities: [] })

    const taskCreate = await invokeTool(noSquadAuthority, env, 'task_create', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      title: 'Denied',
      done_when: 'never inserted',
    }, 'https://pot.test')
    expect(taskCreate).toMatchObject({ ok: false, status: 403, error: 'forbidden' })

    const dispatch = await invokeTool(noSquadAuthority, env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      goal: 'Denied flight',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(flightMeta('task-not-reached')),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')
    expect(dispatch).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('dispatches and filters attributed flights while keeping project_id outside FlightMetaV1', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-a', '${SQUAD_ID}', 'Task A', 'done', 'in_progress', 'project-a')
    `)
    const meta = flightMeta('task-a')

    const dispatched = await invokeTool(auth(), env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      goal: 'Attributed flight',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(meta),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)
    const flight = (dispatched.result as { flight: FlightRow & { meta: Record<string, unknown> } }).flight
    expect(flight.project_id).toBe('project-a')
    expect(flight.meta).toEqual(meta)
    expect(flight.meta).not.toHaveProperty('project_id')

    const listed = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
    }, 'https://pot.test')
    expect((listed.result as { flights: FlightRow[] }).flights.map((row) => row.id)).toEqual([flight.id])

    const excluded = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-b',
    }, 'https://pot.test')
    expect((excluded.result as { flights: FlightRow[] }).flights).toEqual([])
  })

  it('rejects a project flight whose governed task belongs to another project', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-b', '${SQUAD_ID}', 'Task B', 'done', 'in_progress', 'project-b')
    `)

    const result = await invokeTool(auth(), env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      goal: 'Mixed project flight',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(flightMeta('task-b')),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')
    expect(result).toMatchObject({ ok: false, status: 400, error: 'flight_task_project_mismatch' })
  })
})
