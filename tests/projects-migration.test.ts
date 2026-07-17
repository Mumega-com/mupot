import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const PROJECTS_MIGRATION = '0055_projects.sql'

function applyPriorMigrations(sqlite: { exec(sql: string): void }): void {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name < PROJECTS_MIGRATION).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
}

describe('0055_projects migration', () => {
  it('adds project tables and nullable project attribution without losing legacy work', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad', 'Squad');
        INSERT INTO tasks (id, squad_id, title) VALUES ('task-legacy', 'squad-1', 'Legacy task');
        INSERT INTO flights (id, tenant, agent, goal) VALUES ('flight-legacy', 'tenant', 'agent-1', 'Legacy flight');
      `)

      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, PROJECTS_MIGRATION), 'utf8'))

      const projectColumns = sqlite.prepare("SELECT name FROM pragma_table_info('projects')").all()
      expect(projectColumns.map((row) => row.name)).toEqual([
        'id', 'slug', 'name', 'description', 'goal', 'status', 'parent_project_id',
        'target_date', 'created_at', 'updated_at',
      ])
      expect(sqlite.prepare("SELECT \"notnull\" FROM pragma_table_info('tasks') WHERE name = 'project_id'").get())
        .toEqual({ notnull: 0 })
      expect(sqlite.prepare("SELECT \"notnull\" FROM pragma_table_info('flights') WHERE name = 'project_id'").get())
        .toEqual({ notnull: 0 })
      expect(sqlite.prepare("SELECT id FROM tasks WHERE id = 'task-legacy'").get()).toEqual({ id: 'task-legacy' })
      expect(sqlite.prepare("SELECT id FROM flights WHERE id = 'flight-legacy'").get()).toEqual({ id: 'flight-legacy' })

      const projectForeignKeys = sqlite.prepare("SELECT \"table\", \"from\", \"to\", on_delete FROM pragma_foreign_key_list('projects')").all()
      expect(projectForeignKeys).toContainEqual({ table: 'projects', from: 'parent_project_id', to: 'id', on_delete: 'RESTRICT' })
      const accessForeignKeys = sqlite.prepare("SELECT \"table\", \"from\", \"to\", on_delete FROM pragma_foreign_key_list('project_squad_access')").all()
      expect(accessForeignKeys).toEqual(expect.arrayContaining([
        { table: 'projects', from: 'project_id', to: 'id', on_delete: 'CASCADE' },
        { table: 'squads', from: 'squad_id', to: 'id', on_delete: 'CASCADE' },
      ]))
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('tasks') WHERE \"from\" = 'project_id'").get())
        .toEqual({ n: 0 })
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('flights') WHERE \"from\" = 'project_id'").get())
        .toEqual({ n: 0 })

      expect(() => sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('bad', 'bad', 'Bad', 'invalid')`)).toThrow()
      expect(() => sqlite.exec(`INSERT INTO projects (id, slug, name, parent_project_id) VALUES ('self', 'self', 'Self', 'self')`)).toThrow()
      expect(() => sqlite.exec(`UPDATE tasks SET project_id = 'missing' WHERE id = 'task-legacy'`)).toThrow(/unknown project_id/)
      expect(() => sqlite.exec(`UPDATE flights SET project_id = 'missing' WHERE id = 'flight-legacy'`)).toThrow(/unknown project_id/)

      const indexesFor = (table: string) => sqlite.prepare('SELECT name FROM pragma_index_list(?)').all(table)
      expect(indexesFor('projects').map((row) => row.name)).toContain('idx_projects_parent_status')
      expect(indexesFor('project_squad_access').map((row) => row.name)).toContain('idx_project_squad_access_squad_project')
      expect(indexesFor('tasks').map((row) => row.name)).toContain('idx_tasks_project_status')
      expect(indexesFor('flights').map((row) => row.name)).toContain('idx_flights_project_status')
    } finally {
      close()
    }
  })
})
