import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tasksApp } from '../src/tasks'
import type { Env, Task } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'tenant-a'
const TARGET_SQUAD_ID = 'squad-target'
const HOME_SQUAD_ID = 'squad-home'
const CROSS_AGENT_ID = 'agent-cross'
const MEMBER_ID = 'member-cross'

function createSchema(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    CREATE TABLE squads (id TEXT PRIMARY KEY, department_id TEXT NOT NULL);
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function addCrossSquadIdentity(sqlite: SqliteD1Harness['sqlite'], capability: 'member' | 'observer'): void {
  sqlite.exec(`
    INSERT INTO squads (id, department_id) VALUES ('${HOME_SQUAD_ID}', 'department-home');
    INSERT INTO squads (id, department_id) VALUES ('${TARGET_SQUAD_ID}', 'department-target');
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
})
