import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSqliteD1 } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')
const PROJECTS_MIGRATION = '0055_projects.sql'
const FIX_MIGRATION = '0056_task_project_access_on_attribution.sql'

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
      expect(() => sqlite.exec(`UPDATE tasks SET project_id = 'missing' WHERE id = 'task-legacy'`)).toThrow(/task project not found/)
      expect(() => sqlite.exec(`UPDATE flights SET project_id = 'missing' WHERE id = 'flight-legacy'`)).toThrow(/flight project not found/)
      expect(() => sqlite.exec(`INSERT INTO tasks (id, squad_id, title, project_id) VALUES ('task-unknown', 'squad-1', 'Unknown project', 'missing')`))
        .toThrow(/task project not found/)
      expect(() => sqlite.exec(`INSERT INTO flights (id, tenant, agent, goal, project_id) VALUES ('flight-unknown', 'tenant', 'agent-1', 'Unknown project', 'missing')`))
        .toThrow(/flight project not found/)
      expect(() => sqlite.exec(`INSERT INTO projects (id, slug, name, parent_project_id) VALUES ('missing-parent', 'missing-parent', 'Missing parent', 'missing')`))
        .toThrow(/parent project not found/)
      sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('root', 'root', 'Root', 'active')`)
      sqlite.exec(`INSERT INTO projects (id, slug, name, parent_project_id) VALUES ('child', 'child', 'Child', 'root')`)
      sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('archived', 'archived', 'Archived', 'archived')`)
      sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('other-root', 'other-root', 'Other root', 'active')`)
      sqlite.exec(`INSERT INTO projects (id, slug, name, status) VALUES ('edge-project', 'edge-project', 'Edge project', 'active')`)
      sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('edge-project', 'squad-1', 'write')`)
      expect(() => sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('root', 'squad-1', 'owner')`))
        .toThrow()
      expect(() => sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'root'`))
        .toThrow(/active child projects/)
      sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'edge-project'`)
      expect(() => sqlite.exec(`INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('edge-project', 'squad-1', 'write')`))
        .toThrow(/archived project squad access/)
      expect(() => sqlite.exec(`UPDATE project_squad_access SET access_level = 'admin' WHERE project_id = 'edge-project' AND squad_id = 'squad-1'`))
        .toThrow(/archived project squad access/)
      expect(() => sqlite.exec(`UPDATE project_squad_access SET project_id = 'other-root' WHERE project_id = 'edge-project' AND squad_id = 'squad-1'`))
        .toThrow(/archived project squad access/)
      expect(() => sqlite.exec(`DELETE FROM project_squad_access WHERE project_id = 'edge-project' AND squad_id = 'squad-1'`))
        .toThrow(/archived project squad access/)
      expect(() => sqlite.exec(`INSERT INTO projects (id, slug, name, parent_project_id) VALUES ('under-child', 'under-child', 'Under child', 'child')`))
        .toThrow(/project hierarchy depth/)
      expect(() => sqlite.exec(`INSERT INTO projects (id, slug, name, parent_project_id) VALUES ('under-archived', 'under-archived', 'Under archived', 'archived')`))
        .toThrow(/archived parent project/)
      expect(() => sqlite.exec(`UPDATE projects SET parent_project_id = 'child' WHERE id = 'root'`))
        .toThrow(/project hierarchy cycle/)
      expect(() => sqlite.exec(`UPDATE projects SET parent_project_id = 'other-root' WHERE id = 'root'`))
        .toThrow(/project hierarchy depth/)
      sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'child'`)
      sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'root'`)
      expect(() => sqlite.exec(`UPDATE projects SET status = 'active' WHERE id = 'child'`))
        .toThrow(/archived parent project/)

      const indexesFor = (table: string) => sqlite.prepare('SELECT name FROM pragma_index_list(?)').all(table)
      expect(indexesFor('projects').map((row) => row.name)).toContain('idx_projects_parent_status')
      expect(indexesFor('project_squad_access').map((row) => row.name)).toContain('idx_project_squad_access_squad_project')
      expect(indexesFor('tasks').map((row) => row.name)).toContain('idx_tasks_project_status')
      expect(indexesFor('flights').map((row) => row.name)).toContain('idx_flights_project_status')
      expect(indexesFor('flights').map((row) => row.name)).toContain('idx_flights_tenant_project_created')
    } finally {
      close()
    }
  })

  it('atomically enforces write-authorized task attribution on insert and attribution updates', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, PROJECTS_MIGRATION), 'utf8'))
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, FIX_MIGRATION), 'utf8'))
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES
          ('squad-1', 'dept-1', 'one', 'One'),
          ('squad-2', 'dept-1', 'two', 'Two');
        INSERT INTO projects (id, slug, name, status) VALUES
          ('project-write', 'write', 'Write', 'active'),
          ('project-read', 'read', 'Read', 'active'),
          ('project-archived', 'archived', 'Archived', 'archived');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
          ('project-write', 'squad-1', 'write'),
          ('project-read', 'squad-1', 'read');
      `)

      expect(() => sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, project_id)
        VALUES ('task-read', 'squad-1', 'Read only', 'project-read')
      `)).toThrow(/task project access denied/)
      expect(() => sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, project_id)
        VALUES ('task-archived', 'squad-1', 'Archived', 'project-archived')
      `)).toThrow(/task project archived/)
      expect(() => sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, project_id)
        VALUES ('task-wrong-squad', 'squad-2', 'Wrong squad', 'project-write')
      `)).toThrow(/task project access denied/)

      sqlite.exec(`
        INSERT INTO tasks (id, squad_id, title, project_id)
        VALUES ('task-write', 'squad-1', 'Write', 'project-write')
      `)
      sqlite.exec(`
        DELETE FROM project_squad_access
        WHERE project_id = 'project-write' AND squad_id = 'squad-1'
      `)
      // #391: status/title/body updates must keep flowing after access downgrade.
      // Access is re-checked only when project_id or squad_id changes.
      sqlite.exec(`UPDATE tasks SET title = 'in-flight mutation', status = 'done' WHERE id = 'task-write'`)
      expect(sqlite.prepare(`SELECT title, status FROM tasks WHERE id = 'task-write'`).get())
        .toEqual({ title: 'in-flight mutation', status: 'done' })
      expect(() => sqlite.exec(`UPDATE tasks SET project_id = 'project-read' WHERE id = 'task-write'`))
        .toThrow(/task project access denied/)
      expect(sqlite.prepare(`SELECT project_id FROM tasks WHERE id = 'task-write'`).get())
        .toEqual({ project_id: 'project-write' })
      sqlite.exec(`UPDATE tasks SET github_issue_url = 'https://github.com/acme/widgets/issues/1' WHERE id = 'task-write'`)
      expect(sqlite.prepare(`SELECT github_issue_url FROM tasks WHERE id = 'task-write'`).get())
        .toEqual({ github_issue_url: 'https://github.com/acme/widgets/issues/1' })

      sqlite.exec(`
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-write', 'squad-1', 'admin');
        UPDATE projects SET status = 'archived' WHERE id = 'project-write';
      `)
      // Non-attribution writes still succeed after archive; re-attribution is blocked.
      sqlite.exec(`UPDATE tasks SET body = 'still flowing after archive' WHERE id = 'task-write'`)
      expect(sqlite.prepare(`SELECT body FROM tasks WHERE id = 'task-write'`).get())
        .toEqual({ body: 'still flowing after archive' })
      expect(() => sqlite.exec(`UPDATE tasks SET project_id = 'project-read' WHERE id = 'task-write'`))
        .toThrow(/task project archived|task project access denied/)
      sqlite.exec(`UPDATE tasks SET github_issue_url = 'https://github.com/acme/widgets/issues/2' WHERE id = 'task-write'`)
      expect(sqlite.prepare(`SELECT github_issue_url FROM tasks WHERE id = 'task-write'`).get())
        .toEqual({ github_issue_url: 'https://github.com/acme/widgets/issues/2' })
    } finally {
      close()
    }
  })

  it('durably keeps governed flights and attributed tasks on the same project in both race orders', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, PROJECTS_MIGRATION), 'utf8'))
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad', 'Squad');
        INSERT INTO projects (id, slug, name, status) VALUES
          ('project-a', 'a', 'A', 'active'),
          ('project-b', 'b', 'B', 'active'),
          ('project-archived', 'archived', 'Archived', 'archived');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
          ('project-a', 'squad-1', 'write'),
          ('project-b', 'squad-1', 'write');
        INSERT INTO tasks (id, squad_id, title, project_id) VALUES
          ('task-flight-first', 'squad-1', 'Flight first', 'project-a'),
          ('task-task-first', 'squad-1', 'Task first', 'project-a'),
          ('task-legacy-meta', 'squad-1', 'Legacy meta', 'project-a');
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES ('flight-legacy-meta', 'tenant', 'agent', 'Legacy meta', 'not-json', 'project-a');
        UPDATE flights SET status = 'running' WHERE id = 'flight-legacy-meta';
        UPDATE tasks SET project_id = 'project-b' WHERE id = 'task-legacy-meta';
      `)

      const flightFirstMeta = JSON.stringify({
        schema: 'mupot.flight.meta/v1',
        goal_id: 'goal-a',
        objective_id: 'objective-a',
        squad_ids: ['squad-1'],
        task_ids: ['task-flight-first'],
        done_when: ['done'],
        artifact_refs: [],
      })
      sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES (?, 'tenant', 'agent', 'Flight first', ?, 'project-a')
      `).run('flight-first', flightFirstMeta)
      expect(() => sqlite.exec(`UPDATE tasks SET project_id = 'project-b' WHERE id = 'task-flight-first'`))
        .toThrow(/task project locked by flight/)
      expect(() => sqlite.exec(`UPDATE tasks SET project_id = NULL WHERE id = 'task-flight-first'`))
        .toThrow(/task project locked by flight/)

      sqlite.exec(`UPDATE tasks SET project_id = 'project-b' WHERE id = 'task-task-first'`)
      const taskFirstMeta = JSON.stringify({
        schema: 'mupot.flight.meta/v1',
        goal_id: 'goal-b',
        objective_id: 'objective-b',
        squad_ids: ['squad-1'],
        task_ids: ['task-task-first'],
        done_when: ['done'],
        artifact_refs: [],
      })
      expect(() => sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES (?, 'tenant', 'agent', 'Task first', ?, 'project-a')
      `).run('task-first', taskFirstMeta)).toThrow(/flight task project mismatch/)

      expect(() => sqlite.exec(`UPDATE flights SET project_id = 'project-b' WHERE id = 'flight-first'`))
        .toThrow(/flight task project mismatch/)
      expect(() => sqlite.exec(`
        INSERT INTO flights (id, tenant, agent, goal, project_id)
        VALUES ('archived-flight', 'tenant', 'agent', 'Archived', 'project-archived')
      `)).toThrow(/flight project archived/)
    } finally {
      close()
    }
  })

  it('rejects governed flight attribution changes but allows lifecycle updates after edge revocation', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, PROJECTS_MIGRATION), 'utf8'))
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad', 'Squad');
        INSERT INTO projects (id, slug, name, status) VALUES
          ('project-a', 'a', 'A', 'active'),
          ('project-b', 'b', 'B', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-a', 'squad-1', 'write');
        INSERT INTO tasks (id, squad_id, title, project_id)
        VALUES ('task-a', 'squad-1', 'Task A', 'project-a');
      `)
      const meta = JSON.stringify({
        schema: 'mupot.flight.meta/v1',
        goal_id: 'goal-a',
        objective_id: 'objective-a',
        squad_ids: ['squad-1'],
        task_ids: ['task-a'],
        done_when: ['done'],
        artifact_refs: [],
      })

      sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES ('flight-before-revoke', 'tenant', 'agent', 'Before revoke', ?, 'project-a')
      `).run(meta)
      sqlite.exec(`DELETE FROM project_squad_access WHERE project_id = 'project-a' AND squad_id = 'squad-1'`)

      expect(() => sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES ('flight-after-revoke', 'tenant', 'agent', 'After revoke', ?, 'project-a')
      `).run(meta)).toThrow(/flight project access denied/)
      sqlite.exec(`
        UPDATE flights SET status = 'running' WHERE id = 'flight-before-revoke';
        UPDATE flights SET status = 'landed', cost_micro_usd = 25 WHERE id = 'flight-before-revoke';
      `)
      expect(sqlite.prepare(`SELECT status, cost_micro_usd FROM flights WHERE id = 'flight-before-revoke'`).get())
        .toEqual({ status: 'landed', cost_micro_usd: 25 })
      expect(() => sqlite.exec(`UPDATE flights SET meta = '{}' WHERE id = 'flight-before-revoke'`))
        .toThrow(/flight project attribution downgrade/)
      expect(() => sqlite.exec(`UPDATE flights SET project_id = NULL WHERE id = 'flight-before-revoke'`))
        .toThrow(/flight project attribution downgrade/)
      expect(() => sqlite.exec(`UPDATE flights SET meta = meta WHERE id = 'flight-before-revoke'`))
        .toThrow(/flight project access denied/)
      expect(() => sqlite.exec(`UPDATE flights SET project_id = 'project-b' WHERE id = 'flight-before-revoke'`))
        .toThrow(/flight project access denied/)

      // Nullable and non-governed legacy rows remain outside the project-edge invariant.
      sqlite.exec(`
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES ('legacy-project', 'tenant', 'agent', 'Legacy', '{}', 'project-a');
        INSERT INTO flights (id, tenant, agent, goal, meta)
        VALUES ('governed-null', 'tenant', 'agent', 'Null project', '${meta.replaceAll("'", "''")}');
        UPDATE flights
           SET project_id = 'project-b', meta = '{"schema":"legacy/v0"}'
         WHERE id = 'legacy-project';
      `)
      expect(sqlite.prepare(`SELECT project_id, meta FROM flights WHERE id = 'legacy-project'`).get())
        .toEqual({ project_id: 'project-b', meta: '{"schema":"legacy/v0"}' })
    } finally {
      close()
    }
  })

  it('rejects malformed governed attribution without restricting legacy flight updates', () => {
    const { sqlite, close } = createSqliteD1()
    try {
      applyPriorMigrations(sqlite)
      sqlite.exec(readFileSync(join(MIGRATIONS_DIR, PROJECTS_MIGRATION), 'utf8'))
      sqlite.exec(`
        INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
        INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'squad', 'Squad');
        INSERT INTO projects (id, slug, name, status) VALUES
          ('project-a', 'a', 'A', 'active'),
          ('project-b', 'b', 'B', 'active');
        INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES
          ('project-a', 'squad-1', 'write'),
          ('project-b', 'squad-1', 'write');
        INSERT INTO tasks (id, squad_id, title, project_id) VALUES
          ('task-a', 'squad-1', 'Task A', 'project-a'),
          ('task-b', 'squad-1', 'Task B', 'project-b');
        DELETE FROM project_squad_access WHERE project_id = 'project-b' AND squad_id = 'squad-1';
      `)
      const governedMeta = (taskId: string) => ({
        schema: 'mupot.flight.meta/v1',
        goal_id: 'goal-a',
        objective_id: 'objective-a',
        squad_ids: ['squad-1'],
        task_ids: [taskId],
        done_when: ['done'],
        artifact_refs: [],
      })
      const metaA = JSON.stringify(governedMeta('task-a'))
      const metaB = JSON.stringify(governedMeta('task-b'))
      const malformed = [
        { schema: 'mupot.flight.meta/v1' },
        { ...governedMeta('task-a'), squad_ids: [] },
        { ...governedMeta('task-a'), squad_ids: Array.from({ length: 9 }, () => 'squad-1') },
        { ...governedMeta('task-a'), squad_ids: [''] },
        { ...governedMeta('task-a'), squad_ids: ['s'.repeat(201)] },
        { ...governedMeta('task-a'), task_ids: [] },
        { ...governedMeta('task-a'), task_ids: Array.from({ length: 201 }, () => 'task-a') },
        { ...governedMeta('task-a'), task_ids: [42] },
        { ...governedMeta('task-a'), task_ids: ['t'.repeat(201)] },
      ]

      for (const [index, invalidMeta] of malformed.entries()) {
        expect(() => sqlite.prepare(`
          INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
          VALUES (?, 'tenant', 'agent', 'Malformed', ?, 'project-a')
        `).run(`malformed-${index}`, JSON.stringify(invalidMeta))).toThrow(/flight meta invalid/)
      }

      sqlite.prepare(`
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES ('governed-a', 'tenant', 'agent', 'Governed', ?, 'project-a')
      `).run(metaA)
      for (const invalidMeta of malformed) {
        expect(() => sqlite.prepare(`
          UPDATE flights SET meta = ? WHERE id = 'governed-a'
        `).run(JSON.stringify(invalidMeta))).toThrow(/flight meta invalid/)
      }
      expect(sqlite.prepare(`SELECT project_id, meta FROM flights WHERE id = 'governed-a'`).get())
        .toEqual({ project_id: 'project-a', meta: metaA })
      expect(() => sqlite.prepare(`
        UPDATE flights SET project_id = 'project-b', meta = ? WHERE id = 'governed-a'
      `).run(metaB)).toThrow(/flight project access denied/)

      sqlite.exec(`
        INSERT INTO project_squad_access (project_id, squad_id, access_level)
        VALUES ('project-b', 'squad-1', 'admin')
      `)
      sqlite.prepare(`
        UPDATE flights SET project_id = 'project-b', meta = ? WHERE id = 'governed-a'
      `).run(metaB)
      expect(sqlite.prepare(`SELECT project_id, meta FROM flights WHERE id = 'governed-a'`).get())
        .toEqual({ project_id: 'project-b', meta: metaB })

      sqlite.exec(`
        INSERT INTO flights (id, tenant, agent, goal, meta, project_id)
        VALUES ('legacy', 'tenant', 'agent', 'Legacy', '{}', 'project-a');
        INSERT INTO flights (id, tenant, agent, goal, meta)
        VALUES ('projectless-schema-only', 'tenant', 'agent', 'Projectless', '{"schema":"mupot.flight.meta/v1"}');
        UPDATE flights
           SET project_id = 'project-b', meta = '{"schema":"legacy/v0"}'
         WHERE id = 'legacy';
      `)
      expect(sqlite.prepare(`SELECT project_id, meta FROM flights WHERE id = 'legacy'`).get())
        .toEqual({ project_id: 'project-b', meta: '{"schema":"legacy/v0"}' })
      expect(sqlite.prepare(`SELECT project_id FROM flights WHERE id = 'projectless-schema-only'`).get())
        .toEqual({ project_id: null })
    } finally {
      close()
    }
  })
})
