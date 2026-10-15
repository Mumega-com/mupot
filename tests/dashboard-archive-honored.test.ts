// /approvals + status counts + the other dashboard task readers must honor task
// archive (tasks_archive_state). Real sqlite D1 + all migrations; archive then
// unarchive the same row and assert it leaves and returns.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadApprovals, loadPublishable } from '../src/dashboard/approvals'
import { loadTaskStatusCounts } from '../src/dashboard/operator-counts'
import { loadRecentTasks, loadSwimlaneBars } from '../src/dashboard/observatory'
import { CONTENT_GATE_OWNER } from '../src/agents/execute'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'
const owner = { userId: 'u', email: null, role: 'owner', tenant: TENANT, capabilities: [] } as unknown as AuthContext

let h: SqliteD1Harness
let env: Env
const archive = (id: string) =>
  h.sqlite.exec(`INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status, created_at)
    VALUES ('${id}', datetime('now'), 'test', 'm-op', 'review', datetime('now'))`)
const unarchive = (id: string) => h.sqlite.exec(`DELETE FROM tasks_archive_state WHERE task_id = '${id}'`)

beforeEach(() => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { TENANT_SLUG: TENANT, DB: h.db } as unknown as Env
  h.sqlite.exec(`
    INSERT INTO members (id, tenant, email, display_name, status) VALUES ('m-op', '${TENANT}', 'op@example.com', 'Op', 'active');
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 'sq-one', 'Squad One');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('a1', 's1', 'ag1', 'Agent', 'inactive');
    INSERT INTO tasks (id, squad_id, title, status, done_when, gate_owner, assignee_agent_id) VALUES
      ('t-review', 's1', 'Review me', 'review', 'x', 'gate:hadi', 'a1'),
      ('t-pub', 's1', 'Publish me', 'approved', 'x', '${CONTENT_GATE_OWNER}', 'a1'),
      ('t-keep', 's1', 'Other review', 'review', 'x', 'gate:hadi', 'a1');
  `)
})
afterEach(() => h.close())

describe('dashboard honors task archive', () => {
  it('/approvals queue drops an archived review task and returns it on unarchive', async () => {
    expect((await loadApprovals(env, owner)).items.map((i) => i.id).sort()).toEqual(['t-keep', 't-review'])
    archive('t-review')
    expect((await loadApprovals(env, owner)).items.map((i) => i.id)).toEqual(['t-keep'])
    unarchive('t-review')
    expect((await loadApprovals(env, owner)).items.map((i) => i.id).sort()).toEqual(['t-keep', 't-review'])
  })

  it('/approvals publishable list drops an archived approved gate:content task', async () => {
    expect((await loadPublishable(env, owner)).map((i) => i.id)).toEqual(['t-pub'])
    archive('t-pub')
    expect(await loadPublishable(env, owner)).toEqual([])
    unarchive('t-pub')
    expect((await loadPublishable(env, owner)).map((i) => i.id)).toEqual(['t-pub'])
  })

  it('loadTaskStatusCounts (home Needs-decision KPI) excludes archived tasks', async () => {
    expect((await loadTaskStatusCounts(env)).get('review')).toBe(2)
    archive('t-review')
    expect((await loadTaskStatusCounts(env)).get('review')).toBe(1)
    unarchive('t-review')
    expect((await loadTaskStatusCounts(env)).get('review')).toBe(2)
  })

  it('observatory recent-tasks and swimlane readers exclude archived tasks', async () => {
    expect((await loadRecentTasks(env)).map((t) => t.id)).toContain('t-review')
    expect((await loadSwimlaneBars(env)).map((t) => t.id)).toContain('t-review')
    archive('t-review')
    expect((await loadRecentTasks(env)).map((t) => t.id)).not.toContain('t-review')
    expect((await loadSwimlaneBars(env)).map((t) => t.id)).not.toContain('t-review')
    unarchive('t-review')
    expect((await loadRecentTasks(env)).map((t) => t.id)).toContain('t-review')
  })

  // Readers whose full render needs heavier fixtures: pin the predicate in source.
  it.each([
    ['health.ts', /status IN \('blocked', 'rejected'\)[\s\S]{0,200}TASK_NOT_ARCHIVED_SQL\(\)/],
    ['projects.ts', /\$\{TASK_NOT_ARCHIVED_SQL\(\)\}\) AS open_work/],
    ['projects.ts', /t\.project_id = \?1 AND \$\{TASK_NOT_ARCHIVED_SQL\('t'\)\}/],
    ['projects.ts', /project_id = \?1 AND \$\{TASK_NOT_ARCHIVED_SQL\(\)\}\$\{squadFilter\}\) AS direct_tasks/],
    ['agents-admin.ts', /LEFT JOIN tasks t ON t\.assignee_agent_id = a\.id AND \$\{TASK_NOT_ARCHIVED_SQL\('t'\)\}/],
    ['agent-profile.ts', /assignee_agent_id = \?1 AND \$\{TASK_NOT_ARCHIVED_SQL\(\)\}/],
    ['index.ts', /FROM tasks WHERE squad_id = \? AND \$\{TASK_NOT_ARCHIVED_SQL\(\)\}/],
  ])('%s keeps the archive predicate on its task read', (file, re) => {
    const src = readFileSync(join(__dirname, '..', 'src', 'dashboard', file), 'utf8')
    expect(src).toMatch(re)
  })
})
