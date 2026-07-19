import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const PROJECTS_MIGRATION = '0055_projects.sql'
const FIX_MIGRATION = '0061_task_project_access_on_attribution.sql'

function applyThrough(sqlite: { exec(sql: string): void }, throughFile: string): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name <= throughFile).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

describe('0061 task project access on attribution only', () => {
  it('lets in-flight status updates survive squad access downgrade after 0061', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyThrough(sqlite, FIX_MIGRATION)
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'one', 'One');
        INSERT INTO projects (id, slug, name, status) VALUES ('project-write', 'write', 'Write', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
          VALUES ('project-write', 'squad-1', 'write');
        INSERT INTO tasks (id, squad_id, title, project_id, status)
          VALUES ('task-1', 'squad-1', 'Work', 'project-write', 'in_progress');
        DELETE FROM project_squad_access
          WHERE project_id = 'project-write' AND squad_id = 'squad-1';
      `)

      sqlite.exec(`UPDATE tasks SET status = 'done', result = 'ok' WHERE id = 'task-1'`)
      expect(sqlite.prepare(`SELECT status, result FROM tasks WHERE id = 'task-1'`).get())
        .toEqual({ status: 'done', result: 'ok' })

      expect(() => sqlite.exec(`
        UPDATE tasks SET project_id = NULL WHERE id = 'task-1'
      `)).not.toThrow()
      sqlite.exec(`
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
          VALUES ('project-write', 'squad-1', 'read');
      `)
      expect(() => sqlite.exec(`
        UPDATE tasks SET project_id = 'project-write' WHERE id = 'task-1'
      `)).toThrow(/task project access denied/)
    } finally {
      close()
    }
  })

  it('replaces the 0055 wide-column trigger without breaking insert guards', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyThrough(sqlite, PROJECTS_MIGRATION)
      // Reproduce pre-fix footgun, then apply 0061 and prove recovery path.
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'one', 'One');
        INSERT INTO projects (id, slug, name, status) VALUES ('project-write', 'write', 'Write', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
          VALUES ('project-write', 'squad-1', 'write');
        INSERT INTO tasks (id, squad_id, title, project_id, status)
          VALUES ('task-1', 'squad-1', 'Work', 'project-write', 'in_progress');
        DELETE FROM project_squad_access
          WHERE project_id = 'project-write' AND squad_id = 'squad-1';
      `)
      expect(() => sqlite.exec(`UPDATE tasks SET status = 'done' WHERE id = 'task-1'`))
        .toThrow(/task project access denied/)

      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, FIX_MIGRATION), 'utf8'))
      sqlite.exec(`UPDATE tasks SET status = 'done' WHERE id = 'task-1'`)
      expect(sqlite.prepare(`SELECT status FROM tasks WHERE id = 'task-1'`).get())
        .toEqual({ status: 'done' })
    } finally {
      close()
    }
  })
})
