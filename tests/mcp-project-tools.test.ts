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
const OTHER_SQUAD_ID = 'squad-b'

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
    INSERT INTO squads (id, department_id, slug, name) VALUES ('${OTHER_SQUAD_ID}', 'dept-a', 'squad-b', 'Squad B');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('${AGENT_ID}', '${SQUAD_ID}', 'agent-a', 'Agent A', 'active');
    INSERT INTO projects (id, slug, name, status) VALUES
      ('project-a', 'project-a', 'Project A', 'active'),
      ('project-b', 'project-b', 'Project B', 'active'),
      ('project-read', 'project-read', 'Project Read', 'active'),
      ('project-no-edge', 'project-no-edge', 'Project No Edge', 'active'),
      ('project-archived', 'project-archived', 'Project Archived', 'archived');
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
  const sessions = new Map<string, string>()
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: vi.fn(async () => undefined) },
    SESSIONS: {
      async get(key: string, type?: string) {
        const value = sessions.get(key) ?? null
        return type === 'json' && value ? JSON.parse(value) : value
      },
      async put(key: string, value: string) {
        sessions.set(key, value)
      },
    },
  } as unknown as Env
}

function flightMeta(taskId: string, squadIds = [SQUAD_ID]): Record<string, unknown> {
  return {
    schema: 'mupot.flight.meta/v1',
    goal_id: 'goal-a',
    objective_id: 'objective-a',
    squad_ids: squadIds,
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

  it('requires project write/admin edges for dispatch and rejects read-only access', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-write', '${SQUAD_ID}', 'Write', 'done', 'in_progress', 'project-a');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-admin', '${SQUAD_ID}', 'Admin', 'done', 'in_progress', 'project-b');
      UPDATE project_squad_access SET access_level = 'write'
       WHERE project_id = 'project-read' AND squad_id = '${SQUAD_ID}';
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-read', '${SQUAD_ID}', 'Read', 'done', 'in_progress', 'project-read');
      UPDATE project_squad_access SET access_level = 'read'
       WHERE project_id = 'project-read' AND squad_id = '${SQUAD_ID}';
    `)

    for (const [projectId, taskId] of [['project-a', 'task-write'], ['project-b', 'task-admin']] as const) {
      const allowed = await invokeTool(auth(), env, 'flight_dispatch', {
        squad_id: SQUAD_ID,
        project_id: projectId,
        goal: `Allowed ${projectId}`,
        budget_micro_usd: 0,
        meta_json: JSON.stringify(flightMeta(taskId)),
        signals_json: JSON.stringify(signals),
      }, 'https://pot.test')
      expect(allowed.ok, JSON.stringify(allowed)).toBe(true)
    }

    const denied = await invokeTool(auth(), env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: 'project-read',
      goal: 'Read-only denied',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(flightMeta('task-read')),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')
    expect(denied).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
      detail: { need: 'project_write' },
    })

    harness.sqlite.exec(`
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-a', '${OTHER_SQUAD_ID}', 'write');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-other-squad', '${OTHER_SQUAD_ID}', 'Other squad', 'done', 'in_progress', 'project-a');
      DELETE FROM project_squad_access
       WHERE project_id = 'project-a' AND squad_id = '${OTHER_SQUAD_ID}';
    `)
    const multiSquadAuth = auth({
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: SQUAD_ID, capability: 'member' },
        { member_id: MEMBER_ID, scope_type: 'squad', scope_id: OTHER_SQUAD_ID, capability: 'member' },
      ],
    })
    const missingReferencedEdge = await invokeTool(multiSquadAuth, env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      goal: 'Missing referenced edge',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(flightMeta('task-other-squad', [SQUAD_ID, OTHER_SQUAD_ID])),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')
    expect(missingReferencedEdge).toMatchObject({
      ok: false,
      status: 403,
      error: 'forbidden',
      detail: { need: 'project_write' },
    })

    harness.sqlite.exec(`
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-a', '${OTHER_SQUAD_ID}', 'admin')
    `)
    const allReferencedEdges = await invokeTool(multiSquadAuth, env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      goal: 'All referenced edges',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(flightMeta('task-other-squad', [SQUAD_ID, OTHER_SQUAD_ID])),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')
    expect(allReferencedEdges.ok, JSON.stringify(allReferencedEdges)).toBe(true)
  })

  it('preserves legacy owner and org-admin bypass while restricting defined empty capabilities', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const noEdgeMeta = JSON.stringify(flightMeta('task-owner')).replaceAll("'", "''")
    harness.sqlite.exec(`
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-no-edge', '${SQUAD_ID}', 'write');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-owner', '${SQUAD_ID}', 'Owner', 'done', 'in_progress', 'project-no-edge');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-admin', '${SQUAD_ID}', 'Admin', 'done', 'in_progress', 'project-no-edge');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-owner-dispatch', '${SQUAD_ID}', 'Owner dispatch', 'done', 'in_progress', 'project-a');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-admin-dispatch', '${SQUAD_ID}', 'Admin dispatch', 'done', 'in_progress', 'project-a');
      INSERT INTO flights (id, tenant, agent, goal, status, meta, project_id)
      VALUES ('flight-no-edge', '${TENANT}', '${AGENT_ID}', 'No edge read', 'running', '${noEdgeMeta}', 'project-no-edge');
      DELETE FROM project_squad_access
       WHERE project_id = 'project-no-edge' AND squad_id = '${SQUAD_ID}';
    `)
    const legacyOwner = auth({ role: 'owner', capabilities: undefined })
    const restrictedOwner = auth({ role: 'owner', capabilities: [] })
    const orgAdmin = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
    })

    for (const [principal, taskId] of [[legacyOwner, 'task-owner-dispatch'], [orgAdmin, 'task-admin-dispatch']] as const) {
      const dispatched = await invokeTool(principal, env, 'flight_dispatch', {
        squad_id: SQUAD_ID,
        project_id: 'project-a',
        goal: `Workspace bypass ${taskId}`,
        budget_micro_usd: 0,
        meta_json: JSON.stringify(flightMeta(taskId)),
        signals_json: JSON.stringify(signals),
      }, 'https://pot.test')
      expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true)

      const tasks = await invokeTool(principal, env, 'task_list', {
        squad_id: SQUAD_ID,
        project_id: 'project-no-edge',
      }, 'https://pot.test')
      expect((tasks.result as { tasks: Task[] }).tasks.map((task) => task.id).sort())
        .toEqual(['task-admin', 'task-owner'])

      const flights = await invokeTool(principal, env, 'flight_list', {
        squad_id: SQUAD_ID,
        project_id: 'project-no-edge',
      }, 'https://pot.test')
      expect((flights.result as { flights: FlightRow[] }).flights.map((flight) => flight.id))
        .toContain('flight-no-edge')
    }

    const restrictedDispatch = await invokeTool(restrictedOwner, env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      goal: 'Restricted owner',
      budget_micro_usd: 0,
      meta_json: JSON.stringify(flightMeta('task-owner-dispatch')),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')
    expect(restrictedDispatch).toMatchObject({ ok: false, status: 403, error: 'forbidden' })

    const memberTasks = await invokeTool(auth(), env, 'task_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-no-edge',
    }, 'https://pot.test')
    expect(memberTasks).toMatchObject({ ok: false, status: 404, error: 'project_not_found' })
    const memberFlights = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-no-edge',
    }, 'https://pot.test')
    expect(memberFlights).toMatchObject({ ok: false, status: 404, error: 'project_not_found' })
    const restrictedRead = await invokeTool(restrictedOwner, env, 'task_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-no-edge',
    }, 'https://pot.test')
    expect(restrictedRead).toMatchObject({ ok: false, status: 403, error: 'forbidden' })
  })

  it('orders project target, edge authorization, and task consistency checks', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-no-edge', '${SQUAD_ID}', 'write');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-no-edge', '${SQUAD_ID}', 'No edge', 'done', 'in_progress', 'project-no-edge');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-mismatch', '${SQUAD_ID}', 'Mismatch', 'done', 'in_progress', 'project-b');
      DELETE FROM project_squad_access
       WHERE project_id = 'project-no-edge' AND squad_id = '${SQUAD_ID}';
    `)
    const dispatchFor = (projectId: string, taskId: string) => invokeTool(auth(), env, 'flight_dispatch', {
      squad_id: SQUAD_ID,
      project_id: projectId,
      goal: `Validate ${projectId}`,
      budget_micro_usd: 0,
      meta_json: JSON.stringify(flightMeta(taskId)),
      signals_json: JSON.stringify(signals),
    }, 'https://pot.test')

    await expect(dispatchFor('missing-project', 'missing-task')).resolves.toMatchObject({
      ok: false, status: 404, error: 'project_not_found',
    })
    await expect(dispatchFor('project-archived', 'missing-task')).resolves.toMatchObject({
      ok: false, status: 400, error: 'archived_project',
    })
    await expect(dispatchFor('project-read', 'task-mismatch')).resolves.toMatchObject({
      ok: false, status: 403, error: 'forbidden', detail: { need: 'project_write' },
    })
    await expect(dispatchFor('project-a', 'task-mismatch')).resolves.toMatchObject({
      ok: false, status: 400, error: 'flight_task_project_mismatch',
    })
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

  it('binds flight list cursors to the exact project filter including unfiltered mode', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-cursor-a', '${SQUAD_ID}', 'Cursor A', 'done', 'in_progress', 'project-a');
      INSERT INTO tasks (id, squad_id, title, done_when, status, project_id)
      VALUES ('task-cursor-b', '${SQUAD_ID}', 'Cursor B', 'done', 'in_progress', 'project-b');
    `)
    const metaA = JSON.stringify(flightMeta('task-cursor-a'))
    const metaB = JSON.stringify(flightMeta('task-cursor-b'))
    for (let index = 1; index <= 3; index += 1) {
      harness.sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, status, created_at, meta, project_id)
        VALUES (?, '${TENANT}', '${AGENT_ID}', 'Cursor A', 'running', ?, ?, 'project-a')
      `).run(`flight-a-${index}`, index + 10, metaA)
      harness.sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, status, created_at, meta, project_id)
        VALUES (?, '${TENANT}', '${AGENT_ID}', 'Cursor B', 'running', ?, ?, 'project-b')
      `).run(`flight-b-${index}`, index, metaB)
    }

    const firstProjectPage = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      limit: 1,
    }, 'https://pot.test')
    const projectCursor = (firstProjectPage.result as { cursor: string }).cursor
    expect(projectCursor).toEqual(expect.any(String))

    const sameProject = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      limit: 1,
      cursor: projectCursor,
    }, 'https://pot.test')
    expect(sameProject.ok).toBe(true)
    for (const projectId of ['project-b', null] as const) {
      const reused = await invokeTool(auth(), env, 'flight_list', {
        squad_id: SQUAD_ID,
        project_id: projectId,
        limit: 1,
        cursor: projectCursor,
      }, 'https://pot.test')
      expect(reused).toMatchObject({ ok: false, status: 400, error: 'invalid_flight_cursor' })
    }

    const firstUnfilteredPage = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      limit: 1,
    }, 'https://pot.test')
    const unfilteredCursor = (firstUnfilteredPage.result as { cursor: string }).cursor
    expect(unfilteredCursor).toEqual(expect.any(String))
    const explicitNullReuse = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      project_id: null,
      limit: 1,
      cursor: unfilteredCursor,
    }, 'https://pot.test')
    expect(explicitNullReuse.ok).toBe(true)
    const filteredReuse = await invokeTool(auth(), env, 'flight_list', {
      squad_id: SQUAD_ID,
      project_id: 'project-a',
      limit: 1,
      cursor: unfilteredCursor,
    }, 'https://pot.test')
    expect(filteredReuse).toMatchObject({ ok: false, status: 400, error: 'invalid_flight_cursor' })
  })
})
