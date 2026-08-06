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

function envFor(harness: SqliteD1Harness, events?: unknown[]): Env {
  const sessions = new Map<string, string>()
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BUS: { send: vi.fn(async (event: unknown) => { events?.push(event) }) },
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

  it('resolve_agent / get_agent_profile enforce the observer floor — no grantless read', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    // A grantless member (valid token, ZERO capability grants). min:'observer' opts these
    // tools into the AAGATE floor, so a grantless token is rejected BEFORE the handler —
    // closing the pot-wide agent-inventory read that min:'authenticated' left open.
    const grantless = auth({ capabilities: [] })
    const rl = await invokeTool(grantless, env, 'resolve_agent', { query: 'agent' }, 'https://pot.example')
    expect(rl.ok).toBe(false)
    expect(rl.status).toBe(403)
    const gp = await invokeTool(grantless, env, 'get_agent_profile', { agent_id: 'agent-a' }, 'https://pot.example')
    expect(gp.ok).toBe(false)
    expect(gp.status).toBe(403)
    // A member (member ≥ observer) clears the floor and reads normally.
    const ok = await invokeTool(auth(), env, 'resolve_agent', { query: 'agent' }, 'https://pot.example')
    expect(ok.ok).toBe(true)
    expect((ok.result as { matches: unknown[] }).matches.length).toBeGreaterThanOrEqual(1)
  })

  it('project_context composes meta + situation + roster + data_map for a project reader', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    // one ONLINE module on project-a, and one external board binding. last_heartbeat is
    // an ISO string parsed via Date.parse; seed the current instant so it's within the
    // PRESENCE_STALE_SECONDS window (staleness is derived at read time vs real `now`).
    const nowIso = new Date().toISOString()
    harness.sqlite
      .prepare(
        `INSERT INTO module_registry (id, tenant, kind, adapter, project_id, identity, status, capabilities, last_heartbeat, registered_at)
         VALUES (?, ?, 'agent_system', 'claude-code', 'project-a', 'kasra', 'online', ?, ?, ?)`,
      )
      .run('mod-1', TENANT, JSON.stringify(['build']), nowIso, nowIso)
    harness.sqlite
      .prepare(
        `INSERT INTO project_provider_bindings (project_id, provider, external_id, meta_json)
         VALUES ('project-a', 'github_projects', 'PVT_kw123', '{}')`,
      )
      .run()

    const res = await invokeTool(auth(), env, 'project_context', { project_id: 'project-a' }, 'https://pot.example')
    expect(res.ok).toBe(true)
    const r = res.result as {
      project: { id: string }
      situation: { health: string }
      roster: Array<{ identity: string; status: string }>
      data_map: { board_bindings: Array<{ provider: string; external_id: string }>; memory_scope: string }
    }
    expect(r.project.id).toBe('project-a')
    expect(r.situation).toHaveProperty('health') // situation composed
    expect(r.roster.map((m) => m.identity)).toContain('kasra')
    expect(r.roster.find((m) => m.identity === 'kasra')?.status).toBe('online')
    expect(r.data_map.board_bindings).toEqual([expect.objectContaining({ provider: 'github_projects', external_id: 'PVT_kw123' })])
    expect(r.data_map.memory_scope).toBe('project:project-a')
  })

  it('project_context refuses a project the caller cannot read (404, no leak)', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const res = await invokeTool(auth(), env, 'project_context', { project_id: 'project-no-edge' }, 'https://pot.example')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
    expect(res.error).toBe('project_not_found')
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

    harness.sqlite.prepare(`
      INSERT INTO task_verdicts (id, task_id, verdict, decided_by, decided_at)
      VALUES (?, ?, 'approved', ?, ?)
    `).run('verdict-project-lock', taskId, MEMBER_ID, '2026-07-19T03:00:00Z')
    const locked = await invokeTool(auth(), env, 'task_update', {
      task_id: taskId,
      project_id: 'project-a',
    }, 'https://pot.test')
    expect(locked).toMatchObject({ ok: false, status: 409, error: 'task_project_locked' })

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

  // #400: mirrors the REST parity test in tests/tasks-project-filter.test.ts —
  // a receipt-less task_update detach must be blocked when the task already
  // carries a non-empty result (evidence-board gap), while an empty-result
  // detach and a live-project reassignment both stay legal.
  it('blocks a task_update detach when the task already carries a non-empty result', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, result, project_id)
      VALUES ('task-evidenced', '${SQUAD_ID}', 'Evidenced', 'done', 'done', 'Verified output', 'project-a');
      INSERT INTO tasks (id, squad_id, title, done_when, status, result, project_id)
      VALUES ('task-empty-result', '${SQUAD_ID}', 'No evidence yet', 'done', 'open', NULL, 'project-a');
    `)

    const detachBlocked = await invokeTool(auth(), env, 'task_update', {
      task_id: 'task-evidenced',
      project_id: null,
    }, 'https://pot.test')
    expect(detachBlocked).toMatchObject({ ok: false, status: 409, error: 'detach_locked_result_present' })
    expect(harness.sqlite.prepare(`SELECT project_id FROM tasks WHERE id = 'task-evidenced'`).get())
      .toEqual({ project_id: 'project-a' })

    const reassigned = await invokeTool(auth(), env, 'task_update', {
      task_id: 'task-evidenced',
      project_id: 'project-b',
    }, 'https://pot.test')
    expect(reassigned).toMatchObject({ ok: true, result: { task: { project_id: 'project-b' } } })

    const detachAllowed = await invokeTool(auth(), env, 'task_update', {
      task_id: 'task-empty-result',
      project_id: null,
    }, 'https://pot.test')
    expect(detachAllowed).toMatchObject({ ok: true, result: { task: { project_id: null } } })
  })

  // Adversarial-gate LOW fix: JS `.trim()` (app-layer emptiness check) and
  // SQLite's `trim()` (migration 0065 trigger guard, ASCII-space only)
  // disagree on a whitespace-only result like "\t\n" — the app layer treats
  // it as empty and lets task_update proceed to persistTaskUpdate, but the
  // DB trigger still sees non-empty bytes and ABORTs. That raw ABORT must
  // map to the same 409 detach_locked_result_present the app-layer path
  // returns above, never an uncaught 500.
  it('maps the trigger-layer ABORT to a clean 409 (not a 500) for a whitespace-only result', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, done_when, status, result, project_id)
      VALUES ('task-whitespace-result', '${SQUAD_ID}', 'Whitespace only', 'done', 'done', ?, 'project-a')
    `).run('\t\n')

    const detachBlocked = await invokeTool(auth(), env, 'task_update', {
      task_id: 'task-whitespace-result',
      project_id: null,
    }, 'https://pot.test')
    expect(detachBlocked).toMatchObject({ ok: false, status: 409, error: 'detach_locked_result_present' })
    expect(harness.sqlite.prepare(`SELECT project_id FROM tasks WHERE id = 'task-whitespace-result'`).get())
      .toEqual({ project_id: 'project-a' })
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
    await expect(dispatchFor('project-read', 'missing-task')).resolves.toMatchObject({
      ok: false, status: 403, error: 'forbidden', detail: { need: 'project_write' },
    })
    await expect(dispatchFor('project-a', 'missing-task')).resolves.toMatchObject({
      ok: false, status: 404, error: 'flight_task_not_found',
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

describe('MCP project lifecycle control', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('registers the complete project lifecycle and squad-access surface', () => {
    const expected = [
      'project_create',
      'project_list',
      'project_get',
      'project_update',
      'project_squad_list',
      'project_squad_set',
      'project_squad_remove',
    ]

    for (const name of expected) {
      const tool = TOOLS.find((candidate) => candidate.name === name)
      expect(tool, `${name} must be discoverable over MCP`).toBeDefined()
      expect(tool?.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('lets an org admin control a project through archive, restore, and access changes', async () => {
    harness = makeHarness()
    const events: unknown[] = []
    const env = envFor(harness, events)
    const admin = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
    })

    const created = await invokeTool(admin, env, 'project_create', {
      slug: 'mcp-managed',
      name: 'MCP Managed',
      description: 'Controlled entirely through MCP',
      goal: 'Prove control-plane parity',
      status: 'planned',
      target_date: '2026-08-31',
    }, 'https://pot.test')
    expect(created).toMatchObject({ ok: true, result: { project: { slug: 'mcp-managed', status: 'planned' } } })
    const projectId = ((created.result as { project: { id: string } }).project).id

    await expect(invokeTool(admin, env, 'project_squad_set', {
      project_id: projectId,
      squad_id: SQUAD_ID,
      access_level: 'write',
    }, 'https://pot.test')).resolves.toMatchObject({
      ok: true,
      result: { squad: { project_id: projectId, squad_id: SQUAD_ID, access_level: 'write' } },
    })

    const listed = await invokeTool(auth(), env, 'project_list', {}, 'https://pot.test')
    expect((listed.result as { projects: Array<{ id: string }> }).projects.map(project => project.id)).toContain(projectId)
    await expect(invokeTool(auth(), env, 'project_get', { project_id: projectId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { project: { id: projectId } } })
    await expect(invokeTool(auth(), env, 'project_squad_list', { project_id: projectId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: true, result: { squads: [{ squad_id: SQUAD_ID, access_level: 'write' }] } })

    await expect(invokeTool(admin, env, 'project_update', {
      project_id: projectId,
      status: 'archived',
    }, 'https://pot.test')).resolves.toMatchObject({ ok: true, result: { project: { status: 'archived' } } })
    await expect(invokeTool(admin, env, 'project_update', {
      project_id: projectId,
      status: 'planned',
    }, 'https://pot.test')).resolves.toMatchObject({ ok: true, result: { project: { status: 'planned' } } })

    await expect(invokeTool(admin, env, 'project_squad_remove', {
      project_id: projectId,
      squad_id: SQUAD_ID,
    }, 'https://pot.test')).resolves.toMatchObject({ ok: true, result: { removed: true } })
    await expect(invokeTool(auth(), env, 'project_get', { project_id: projectId }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 404, error: 'project_not_found' })

    expect(events).toMatchObject([
      { type: 'project.mutated', actor: { kind: 'member', id: MEMBER_ID }, payload: { operation: 'created', project_id: projectId } },
      { type: 'project.mutated', actor: { kind: 'member', id: MEMBER_ID }, payload: { operation: 'squad_access_set', project_id: projectId, squad_id: SQUAD_ID } },
      { type: 'project.mutated', actor: { kind: 'member', id: MEMBER_ID }, payload: { operation: 'updated', project_id: projectId, status: 'archived' } },
      { type: 'project.mutated', actor: { kind: 'member', id: MEMBER_ID }, payload: { operation: 'updated', project_id: projectId, status: 'planned' } },
      { type: 'project.mutated', actor: { kind: 'member', id: MEMBER_ID }, payload: { operation: 'squad_access_removed', project_id: projectId, squad_id: SQUAD_ID } },
    ])
  })

  it('restores archived projects directly to planned and reports invalid transitions as conflicts', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const admin = auth({
      capabilities: [{ member_id: MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' }],
    })

    await expect(invokeTool(admin, env, 'project_update', {
      project_id: 'project-a',
      status: 'planned',
    }, 'https://pot.test')).resolves.toMatchObject({
      ok: false, status: 409, error: 'invalid_status_transition',
    })
    await expect(invokeTool(admin, env, 'project_update', {
      project_id: 'project-archived',
      status: 'planned',
    }, 'https://pot.test')).resolves.toMatchObject({
      ok: true, result: { project: { id: 'project-archived', status: 'planned' } },
    })
  })

  it('keeps project mutations admin-only and project reads edge-scoped', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    for (const [tool, args] of [
      ['project_create', { slug: 'denied', name: 'Denied' }],
      ['project_update', { project_id: 'project-a', name: 'Denied' }],
      ['project_squad_set', { project_id: 'project-a', squad_id: OTHER_SQUAD_ID, access_level: 'read' }],
      ['project_squad_remove', { project_id: 'project-a', squad_id: SQUAD_ID }],
    ] as const) {
      await expect(invokeTool(auth(), env, tool, args, 'https://pot.test'))
        .resolves.toMatchObject({ ok: false, status: 403, error: 'forbidden' })
    }

    const projects = await invokeTool(auth(), env, 'project_list', {}, 'https://pot.test')
    expect((projects.result as { projects: Array<{ id: string }> }).projects.map(project => project.id).sort())
      .toEqual(['project-a', 'project-b', 'project-read'])
    await expect(invokeTool(auth(), env, 'project_get', { project_id: 'project-no-edge' }, 'https://pot.test'))
      .resolves.toMatchObject({ ok: false, status: 404, error: 'project_not_found' })
  })

  it('resolves department grants to concrete readable squads for project_get situation', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('project-a', '${OTHER_SQUAD_ID}', 'write');
      INSERT INTO tasks (id, squad_id, title, status, project_id)
      VALUES
        ('department-review', '${OTHER_SQUAD_ID}', 'Department review', 'review', 'project-a'),
        ('visible-open', '${SQUAD_ID}', 'Visible open', 'open', 'project-a');
    `)
    const departmentReader = auth({
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'department', scope_id: 'dept-a', capability: 'observer' },
      ],
    })

    await expect(invokeTool(departmentReader, env, 'project_get', {
      project_id: 'project-a',
    }, 'https://pot.test')).resolves.toMatchObject({
      ok: true,
      result: {
        project: { id: 'project-a' },
        situation: {
          health: 'review',
          pending_reviews: [{ id: 'department-review', squad_id: OTHER_SQUAD_ID }],
          active_work_count: 2,
          next_action: { type: 'review_task', task: { id: 'department-review' } },
        },
      },
    })
  })

  it('keeps the last department-granted squad readable beyond 1000 squads', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('bulk-dept', 'bulk-dept', 'Bulk Department');
      WITH RECURSIVE seq(n) AS (
        VALUES(0) UNION ALL SELECT n + 1 FROM seq WHERE n < 1000
      )
      INSERT INTO squads (id, department_id, slug, name)
      SELECT 'bulk-' || printf('%04d', n), 'bulk-dept', 'bulk-' || printf('%04d', n), 'Bulk ' || n FROM seq;
      INSERT INTO projects (id, slug, name, status) VALUES ('bulk-project', 'bulk-project', 'Bulk Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('bulk-project', 'bulk-1000', 'write');
      INSERT INTO tasks (id, squad_id, title, status, project_id)
      VALUES ('bulk-last-task', 'bulk-1000', 'Last readable task', 'open', 'bulk-project');
    `)
    const reader = auth({
      capabilities: [
        { member_id: MEMBER_ID, scope_type: 'department', scope_id: 'bulk-dept', capability: 'observer' },
      ],
    })

    await expect(invokeTool(reader, env, 'project_get', {
      project_id: 'bulk-project',
    }, 'https://pot.test')).resolves.toMatchObject({
      ok: true,
      result: {
        situation: {
          health: 'active',
          active_work_count: 1,
          next_action: { type: 'start_task', task: { id: 'bulk-last-task' } },
        },
      },
    })
  })

  it('includes safe parent context for a visible nested project', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO projects (id, slug, name, status)
      VALUES ('context-parent', 'context-parent', 'Context Parent', 'active');
      INSERT INTO projects (id, slug, name, status, parent_project_id)
      VALUES ('context-child', 'context-child', 'Context Child', 'active', 'context-parent');
      INSERT INTO project_squad_access (project_id, squad_id, access_level)
      VALUES ('context-child', '${SQUAD_ID}', 'read');
    `)

    const listed = await invokeTool(auth(), env, 'project_list', {
      parent_project_id: 'context-parent',
    }, 'https://pot.test')
    expect(listed).toMatchObject({
      ok: true,
      result: {
        projects: [
          { id: 'context-parent', parent_context: true },
          { id: 'context-child', parent_project_id: 'context-parent' },
        ],
      },
    })
  })
})
