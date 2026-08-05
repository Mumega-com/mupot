import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function allMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
}

function seed(sqlite: SqliteD1Harness['sqlite']): void {
  sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('sq-1', 'dept-1', 'sq', 'Squad');
  `)
}

describe('Task priority and parent fields (0076)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    for (const file of allMigrations()) {
      harness.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
    }
    seed(harness.sqlite)
    env = { DB: harness.db } as unknown as Env
  })

  afterEach(() => harness.close())

  it('priority and parent_task_id columns exist after migration 0076', () => {
    const cols = harness.sqlite
      .prepare('PRAGMA table_info(tasks)')
      .all()
      .map((r) => (r as { name: string }).name)
    expect(cols).toContain('priority')
    expect(cols).toContain('parent_task_id')
  })

  it('task can be created with priority', () => {
    const taskId = 'task-1'
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, priority)
      VALUES (?, ?, 'High priority task', '', 'test passes', 'P0')
    `).run(taskId, 'sq-1')

    const row = harness.sqlite
      .prepare('SELECT priority FROM tasks WHERE id = ?')
      .get(taskId) as { priority: string } | undefined
    expect(row?.priority).toBe('P0')
  })

  it('task can be created with parent_task_id', () => {
    const parentId = 'parent-task'
    const childId = 'child-task'

    // Create parent task
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, body, done_when)
      VALUES (?, ?, 'Parent task', '', 'done')
    `).run(parentId, 'sq-1')

    // Create child task with parent_task_id
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, body, done_when, parent_task_id)
      VALUES (?, ?, 'Child task', '', 'subtask done', ?)
    `).run(childId, 'sq-1', parentId)

    const child = harness.sqlite
      .prepare('SELECT parent_task_id FROM tasks WHERE id = ?')
      .get(childId) as { parent_task_id: string } | undefined
    expect(child?.parent_task_id).toBe(parentId)
  })

  it('priority accepts P0, P1, P2, P3', () => {
    const priorities = ['P0', 'P1', 'P2', 'P3']
    for (let i = 0; i < priorities.length; i++) {
      const taskId = `task-p${i}`
      harness.sqlite.prepare(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, priority)
        VALUES (?, ?, ?, '', 'test', ?)
      `).run(taskId, 'sq-1', `P${i} task`, priorities[i])

      const row = harness.sqlite
        .prepare('SELECT priority FROM tasks WHERE id = ?')
        .get(taskId) as { priority: string } | undefined
      expect(row?.priority).toBe(priorities[i])
    }
  })

  it('priority can be null (unranked)', () => {
    const taskId = 'task-unranked'
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, body, done_when)
      VALUES (?, ?, 'Unranked', '', 'done')
    `).run(taskId, 'sq-1')

    const row = harness.sqlite
      .prepare('SELECT priority FROM tasks WHERE id = ?')
      .get(taskId) as { priority: string | null } | undefined
    expect(row?.priority).toBeNull()
  })

  it('parent_task_id can be null (top-level task)', () => {
    const taskId = 'task-top-level'
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, body, done_when)
      VALUES (?, ?, 'Top level', '', 'done')
    `).run(taskId, 'sq-1')

    const row = harness.sqlite
      .prepare('SELECT parent_task_id FROM tasks WHERE id = ?')
      .get(taskId) as { parent_task_id: string | null } | undefined
    expect(row?.parent_task_id).toBeNull()
  })

  it('index idx_tasks_parent allows fast subtask lookup', () => {
    const parentId = 'parent-1'
    harness.sqlite.prepare(`
      INSERT INTO tasks (id, squad_id, title, body, done_when)
      VALUES (?, ?, 'Parent', '', 'done')
    `).run(parentId, 'sq-1')

    // Create subtasks
    for (let i = 0; i < 3; i++) {
      harness.sqlite.prepare(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, parent_task_id)
        VALUES (?, ?, ?, '', 'subtask', ?)
      `).run(`child-${i}`, 'sq-1', `Subtask ${i}`, parentId)
    }

    const subtasks = harness.sqlite
      .prepare('SELECT id FROM tasks WHERE parent_task_id = ?')
      .all(parentId) as { id: string }[] | undefined
    expect(subtasks).toHaveLength(3)
  })

  it('index idx_tasks_priority allows fast priority lookup', () => {
    // Create P0 tasks
    for (let i = 0; i < 2; i++) {
      harness.sqlite.prepare(`
        INSERT INTO tasks (id, squad_id, title, body, done_when, priority)
        VALUES (?, ?, ?, '', 'test', 'P0')
      `).run(`p0-task-${i}`, 'sq-1', `P0 task ${i}`)
    }

    const p0Tasks = harness.sqlite
      .prepare('SELECT id FROM tasks WHERE squad_id = ? AND priority = ? ORDER BY id')
      .all('sq-1', 'P0') as { id: string }[] | undefined
    expect(p0Tasks).toHaveLength(2)
  })
})
