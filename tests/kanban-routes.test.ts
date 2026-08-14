import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { loadKanbanData } from '../src/dashboard/kanban-routes'
import type { Env, AuthContext } from '../src/types'

describe('Multi-Perspective Squad & Project Kanban (Real Schema)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { DB: harness.db } as unknown as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept-eng', 'Engineering');
    `)
  })

  afterEach(() => {
    harness.close()
  })

  it('loads squad-centric kanban with prioritized status lanes', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name, charter) VALUES
        ('sq-1', 'dept-1', 'mmhq', 'Mumega HQ', 'Coordination');

      INSERT INTO agents (id, name, slug, status, squad_id) VALUES
        ('a-loom', 'Loom', 'loom', 'active', 'sq-1'),
        ('a-river', 'River', 'river', 'active', 'sq-1');

      INSERT INTO projects (id, slug, name, goal, status) VALUES
        ('p-1', 'bridge', 'Hermes Bridge', 'Direct push', 'planned');

      INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at) VALUES
        ('p-1', 'sq-1', 'write', '2026-08-14T00:00:00.000Z');

      INSERT INTO tasks (id, squad_id, project_id, priority, title, done_when, status, assignee_agent_id, created_at, updated_at) VALUES
        ('t-1', 'sq-1', 'p-1', 'P0', 'Critical Security Fix', 'Fixed and verified', 'open', 'a-loom', '2026-08-14T10:00:00.000Z', '2026-08-14T10:00:00.000Z'),
        ('t-2', 'sq-1', NULL, 'P1', 'Routine Maintenance', 'Cleaned up', 'in_progress', 'a-river', '2026-08-14T10:05:00.000Z', '2026-08-14T10:05:00.000Z');
    `)

    const auth: AuthContext = {
      role: 'owner',
      tenant: 'mumega',
      userId: 'u-1',
    }

    const data = await loadKanbanData(env, auth, { squadIdOrSlug: 'sq-1' })

    expect(data.mode).toBe('squad')
    expect(data.squad?.id).toBe('sq-1')
    expect(data.squad?.slug).toBe('mmhq')
    expect(data.lanes).toHaveLength(4)
    expect(data.lanes[0].key).toBe('open')
    expect(data.lanes[0].tasks).toHaveLength(1)
    expect(data.lanes[0].tasks[0].title).toBe('Critical Security Fix')
    expect(data.lanes[0].tasks[0].assignee_name).toBe('Loom')
    expect(data.lanes[1].key).toBe('in_progress')
    expect(data.lanes[1].tasks).toHaveLength(1)
    expect(data.lanes[1].tasks[0].title).toBe('Routine Maintenance')
  })

  it('loads project-centric kanban grouped by contributing squad swimlanes', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('sq-1', 'dept-1', 'mmhq', 'Mumega HQ'),
        ('sq-2', 'dept-1', 'squad-core', 'Squad Core');

      INSERT INTO agents (id, name, slug, status, squad_id) VALUES
        ('a-loom', 'Loom', 'loom', 'active', 'sq-1'),
        ('a-kasra', 'Kasra', 'kasra', 'active', 'sq-2');

      INSERT INTO projects (id, slug, name, goal, status) VALUES
        ('p-1', 'bridge', 'Hermes Bridge', 'Direct push', 'planned');

      INSERT INTO project_squad_access (project_id, squad_id, access_level, granted_at) VALUES
        ('p-1', 'sq-1', 'admin', '2026-08-14T00:00:00.000Z'),
        ('p-1', 'sq-2', 'write', '2026-08-14T00:00:00.000Z');

      INSERT INTO tasks (id, squad_id, project_id, priority, title, done_when, status, assignee_agent_id, created_at, updated_at) VALUES
        ('t-1', 'sq-1', 'p-1', 'P0', 'Gateway Receiver', 'Live on 8644', 'open', 'a-loom', '2026-08-14T11:00:00.000Z', '2026-08-14T11:00:00.000Z'),
        ('t-2', 'sq-2', 'p-1', 'P1', 'D1 Task Persistence', 'Tables created', 'done', 'a-kasra', '2026-08-14T11:05:00.000Z', '2026-08-14T11:05:00.000Z');
    `)

    const auth: AuthContext = {
      role: 'owner',
      tenant: 'mumega',
      userId: 'u-1',
    }

    const data = await loadKanbanData(env, auth, { projectIdOrSlug: 'bridge' })

    expect(data.mode).toBe('project')
    expect(data.project?.slug).toBe('bridge')
    expect(data.swimlanes).toHaveLength(2)
    expect(data.swimlanes![0].label).toBe('Mumega HQ')
    expect(data.swimlanes![0].lanes[0].tasks[0].title).toBe('Gateway Receiver')
    expect(data.swimlanes![1].label).toBe('Squad Core')
    expect(data.swimlanes![1].lanes[3].tasks[0].title).toBe('D1 Task Persistence')
  })

  it('fails closed for a grant-less member (empty board, no fallback leak)', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('sq-leak', 'dept-1', 'leak-squad', 'Confidential Squad');

      INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, created_at, updated_at) VALUES
        ('t-secret', 'sq-leak', NULL, 'Secret Work', 'Done', 'open', '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z');
    `)

    const auth: AuthContext = {
      role: 'member',
      tenant: 'mumega',
      userId: 'user-2',
      memberId: 'm-2',
      capabilities: [],
    }

    const data = await loadKanbanData(env, auth, {})

    expect(data.mode).toBe('squad')
    expect(data.squad).toBeNull()
    expect(data.lanes).toHaveLength(0)
  })

  it('blocks squad-A member from accessing squad-B board directly (anti-leak)', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES
        ('sq-a', 'dept-1', 'squad-a', 'Squad A'),
        ('sq-b', 'dept-1', 'squad-b', 'Squad B');

      INSERT INTO tasks (id, squad_id, project_id, title, done_when, status, created_at, updated_at) VALUES
        ('t-a', 'sq-a', NULL, 'Public A Work', 'Done', 'open', '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z'),
        ('t-b', 'sq-b', NULL, 'Confidential B Work', 'Done', 'open', '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z');
    `)

    const auth: AuthContext = {
      role: 'member',
      tenant: 'mumega',
      userId: 'user-3',
      memberId: 'm-3',
      capabilities: [
        { member_id: 'm-3', scope_type: 'squad', scope_id: 'sq-a', capability: 'member' },
      ],
    }

    const data = await loadKanbanData(env, auth, { squadIdOrSlug: 'sq-b' })

    expect(data.mode).toBe('squad')
    expect(data.squad).toBeNull()
    expect(data.lanes).toHaveLength(0)
  })
})
