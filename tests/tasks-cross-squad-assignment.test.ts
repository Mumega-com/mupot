import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runTaskExecution } from '../src/agents/execute'
import { tasksApp } from '../src/tasks'
import type { Agent, BusEvent, Env, ModelPort, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const TARGET_SQUAD_ID = 'squad-target'
const HOME_SQUAD_ID = 'squad-home'
const CROSS_AGENT_ID = 'agent-cross'
const MEMBER_ID = 'member-cross'

const CROSS_AGENT: Agent = {
  id: CROSS_AGENT_ID,
  squad_id: HOME_SQUAD_ID,
  slug: 'cross-agent',
  name: 'Cross Agent',
  role: 'executor',
  model: '@cf/meta/llama-3.3',
  status: 'active',
  okr: null,
  kpi_target: null,
  kpi_progress: 0,
  effort: 'standard',
  autonomy: 'execute',
  budget_cap_cents: null,
  budget_window: 'day',
  created_at: '2026-07-12T00:00:00.000Z',
}

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    CREATE TABLE squads (id TEXT PRIMARY KEY, department_id TEXT NOT NULL, charter TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, squad_id TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE members (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE member_tokens (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tenant TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE capabilities (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      scope_id TEXT,
      capability TEXT NOT NULL
    );
    CREATE TABLE channel_capability_grants (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      squad_id TEXT NOT NULL,
      capability TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      squad_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      done_when TEXT NOT NULL,
      status TEXT NOT NULL,
      assignee_agent_id TEXT,
      github_issue_url TEXT,
      result TEXT,
      completed_at TEXT,
      gate_owner TEXT,
      cost_micro_usd INTEGER NOT NULL DEFAULT 0,
      execution_receipt_id TEXT,
      execution_claim_expires_at INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function addCrossSquadIdentity(sqlite: SqliteD1Harness['sqlite'], capability: 'member' | 'observer'): void {
  sqlite.exec(`
    INSERT INTO squads (id, department_id, charter)
    VALUES ('${HOME_SQUAD_ID}', 'department-home', 'Home squad charter.');
    INSERT INTO squads (id, department_id, charter)
    VALUES ('${TARGET_SQUAD_ID}', 'department-target', 'Target squad charter.');
    INSERT INTO agents (id, squad_id, status) VALUES ('${CROSS_AGENT_ID}', '${HOME_SQUAD_ID}', 'active');
    INSERT INTO members (id, tenant, status) VALUES ('${MEMBER_ID}', '${TENANT}', 'active');
    INSERT INTO member_tokens (id, member_id, agent_id, tenant, revoked_at)
    VALUES ('token-cross', '${MEMBER_ID}', '${CROSS_AGENT_ID}', '${TENANT}', NULL);
  `)
  sqlite.prepare(
    'INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)',
  ).run('grant-cross', MEMBER_ID, 'squad', TARGET_SQUAD_ID, capability)
}

function ownerEnv(harness: SqliteD1Harness): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Test',
    DB: harness.db,
    SESSIONS: {
      get: vi.fn(async (key: string) => key === 'sess:owner-session'
        ? JSON.stringify({ userId: 'owner-1', email: 'owner@test.invalid', role: 'owner', createdAt: '2026-07-12T00:00:00.000Z' })
        : null),
      delete: vi.fn(async () => undefined),
    },
    BUS: { send: vi.fn(async () => undefined) },
  } as unknown as Env
}

function request(method: 'POST' | 'PATCH', path: string, body: Record<string, unknown>): Request {
  return new Request(`https://pot.test${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      Cookie: 'mupot_session=owner-session',
      Origin: 'https://pot.test',
    },
    body: JSON.stringify(body),
  })
}

describe('cross-squad task assignment over HTTP', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    createSchema(harness.sqlite)
    env = ownerEnv(harness)
  })

  afterEach(() => harness.close())

  it('persists a capability-granted cross-squad assignee through POST and PATCH', async () => {
    addCrossSquadIdentity(harness.sqlite, 'member')

    const created = await tasksApp.fetch(request('POST', '/', {
      squad_id: TARGET_SQUAD_ID,
      title: 'Create cross-squad assignment',
      done_when: 'The cross-squad assignment is stored.',
      assignee_agent_id: CROSS_AGENT_ID,
    }), env)
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { task: Task }
    expect(createdBody.task.assignee_agent_id).toBe(CROSS_AGENT_ID)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get(createdBody.task.id))
      .toEqual({ assignee_agent_id: CROSS_AGENT_ID })

    const existingTaskId = 'task-patch'
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      existingTaskId,
      TARGET_SQUAD_ID,
      'Patch cross-squad assignment',
      '',
      'The cross-squad assignment is stored.',
      'open',
      null,
      null,
      null,
      null,
      null,
      '2026-07-12T00:00:00.000Z',
      '2026-07-12T00:00:00.000Z',
    )

    const patched = await tasksApp.fetch(request('PATCH', `/${existingTaskId}`, {
      assignee_agent_id: CROSS_AGENT_ID,
    }), env)
    expect(patched.status).toBe(200)
    const patchedBody = await patched.json() as { task: Task }
    expect(patchedBody.task.assignee_agent_id).toBe(CROSS_AGENT_ID)
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get(existingTaskId))
      .toEqual({ assignee_agent_id: CROSS_AGENT_ID })
  })

  it('rejects an observer-only cross-squad assignment without changing the task', async () => {
    addCrossSquadIdentity(harness.sqlite, 'observer')
    harness.sqlite.prepare(
      `INSERT INTO tasks (id, squad_id, title, body, done_when, status, assignee_agent_id, github_issue_url, result, completed_at, gate_owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'task-observer',
      TARGET_SQUAD_ID,
      'Observer cannot own task',
      '',
      'The assignment stays unchanged.',
      'open',
      null,
      null,
      null,
      null,
      null,
      '2026-07-12T00:00:00.000Z',
      '2026-07-12T00:00:00.000Z',
    )

    const response = await tasksApp.fetch(request('PATCH', '/task-observer', {
      assignee_agent_id: CROSS_AGENT_ID,
    }), env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'assignee_not_in_squad' })
    expect(harness.sqlite.prepare('SELECT assignee_agent_id FROM tasks WHERE id = ?').get('task-observer'))
      .toEqual({ assignee_agent_id: null })
  })

  it('executes a dispatched capability-granted cross-squad task from its agent.wake task ID', async () => {
    addCrossSquadIdentity(harness.sqlite, 'member')
    const queued: BusEvent[] = []
    env.BUS = { send: vi.fn(async (event: BusEvent) => { queued.push(event) }) } as unknown as Env['BUS']

    const created = await tasksApp.fetch(request('POST', '/', {
      squad_id: TARGET_SQUAD_ID,
      title: 'Execute cross-squad assignment',
      done_when: 'The execution result is persisted.',
      assignee_agent_id: CROSS_AGENT_ID,
      dispatch: true,
    }), env)
    expect(created.status).toBe(201)
    const createdBody = await created.json() as { task: Task; dispatched: boolean }
    expect(createdBody.dispatched).toBe(true)

    const wake = queued.find((event) => event.type === 'agent.wake')
    expect(wake).toMatchObject({
      squad_id: TARGET_SQUAD_ID,
      agent_id: CROSS_AGENT_ID,
      payload: { task_id: createdBody.task.id },
    })
    const taskId = (wake?.payload as { task_id: string }).task_id

    const model: ModelPort = { chat: vi.fn(async () => 'Cross-squad work completed.') }
    const checkAndReserve = vi.fn(async () => ({
      ok: true as const,
      windowKey: '2026-07-12',
      count: 1,
      tokens: 0,
    }))
    const recordTokens = vi.fn(async () => {})
    const remember = vi.fn(async () => 'engram-cross')
    const executionEvents: BusEvent[] = []

    const result = await runTaskExecution(env, CROSS_AGENT, taskId, {
      model,
      meter: { checkAndReserve, recordTokens },
      remember,
      emit: async (event) => { executionEvents.push(event) },
    })

    expect(result).toMatchObject({ ok: true, task_id: taskId, task_status: 'done' })
    expect(model.chat).toHaveBeenCalledOnce()
    expect(model.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system', content: expect.stringContaining('Target squad charter.') }),
      ]),
      expect.anything(),
    )
    expect(executionEvents.map((event) => event.type)).toEqual(['task.completed'])
    expect(remember).toHaveBeenCalledOnce()
    expect(recordTokens).toHaveBeenCalledOnce()
    expect(harness.sqlite.prepare(
      'SELECT status, assignee_agent_id, result, completed_at FROM tasks WHERE id = ?',
    ).get(taskId)).toEqual({
      status: 'done',
      assignee_agent_id: CROSS_AGENT_ID,
      result: 'Cross-squad work completed.',
      completed_at: expect.any(String),
    })
  })

  it('fails closed when the last effective capability is revoked after assignment', async () => {
    addCrossSquadIdentity(harness.sqlite, 'member')
    const created = await tasksApp.fetch(request('POST', '/', {
      squad_id: TARGET_SQUAD_ID,
      title: 'Revoke before execution',
      done_when: 'The execution result is persisted.',
      assignee_agent_id: CROSS_AGENT_ID,
    }), env)
    expect(created.status).toBe(201)
    const { task } = await created.json() as { task: Task }
    const before = harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)
    harness.sqlite.prepare('DELETE FROM capabilities WHERE id = ?').run('grant-cross')

    const model: ModelPort = { chat: vi.fn(async () => 'must not run') }
    const checkAndReserve = vi.fn()
    const result = await runTaskExecution(env, CROSS_AGENT, task.id, {
      model,
      meter: { checkAndReserve, recordTokens: vi.fn() },
      remember: vi.fn(),
      emit: vi.fn(),
    })

    expect(result).toMatchObject({ ok: false, task_id: task.id, error: 'task_not_found' })
    expect(model.chat).not.toHaveBeenCalled()
    expect(checkAndReserve).not.toHaveBeenCalled()
    expect(harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)).toEqual(before)
  })

  it('fails closed for an unassigned cross-squad task without mutation', async () => {
    addCrossSquadIdentity(harness.sqlite, 'member')
    const created = await tasksApp.fetch(request('POST', '/', {
      squad_id: TARGET_SQUAD_ID,
      title: 'Unassigned cross-squad task',
      done_when: 'The task remains untouched.',
    }), env)
    expect(created.status).toBe(201)
    const { task } = await created.json() as { task: Task }
    const before = harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)
    const model: ModelPort = { chat: vi.fn(async () => 'must not run') }

    const result = await runTaskExecution(env, CROSS_AGENT, task.id, {
      model,
      meter: { checkAndReserve: vi.fn(), recordTokens: vi.fn() },
      remember: vi.fn(),
      emit: vi.fn(),
    })

    expect(result).toMatchObject({ ok: false, task_id: task.id, error: 'task_not_found' })
    expect(model.chat).not.toHaveBeenCalled()
    expect(harness.sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id)).toEqual(before)
  })
})
