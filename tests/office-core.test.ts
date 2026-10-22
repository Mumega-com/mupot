// ProjectOffice core (src/projects/office-core.ts) under the default Node pool, real migrated schema:
// the flag, the naming rule, project → tenant verification from D1, and the working-set rebuild
// (destroy-and-rebuild scaffold, the workerd version of which is tests/composition/project-office.test.ts).

import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  OFFICE_FUNCTIONS,
  isProjectOfficeEnabled,
  parseProjectOfficeName,
  projectOfficeName,
  ensureOfficeSchema,
  isPermanentBindingFailure,
  rebuildWorkingSet,
  verifyOfficeBinding,
  type OfficeBinding,
  type OfficeEnv,
  type OfficeSql,
} from '../src/projects/office-core'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const NS = {} as DurableObjectNamespace // presence is all the flag check looks at

let harness: SqliteD1Harness

function envFor(over: Partial<Pick<OfficeEnv, 'PROJECT_OFFICE' | 'PROJECT_OFFICE_DO'>> = {}): OfficeEnv {
  return { DB: harness.db, TENANT_SLUG: TENANT, PROJECT_OFFICE: '1', PROJECT_OFFICE_DO: NS, ...over }
}

function officeStore(): { sql: OfficeSql; db: DatabaseSync } {
  const db = new DatabaseSync(':memory:')
  const sql: OfficeSql = {
    exec: (q, ...b) => void db.prepare(q).run(...b),
    all: (q, ...b) => db.prepare(q).all(...b) as Record<string, unknown>[],
  }
  return { sql, db }
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Department A');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'squad-a', 'Squad A');
    INSERT INTO projects (id, slug, name, goal, status) VALUES ('p1', 'p1', 'Project One', 'Ship', 'active');
    INSERT INTO projects (id, slug, name, goal, status) VALUES ('p2', 'p2', 'Project Two', 'Other', 'active');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p1', 'squad-a', 'write');
    INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('p2', 'squad-a', 'write');
    INSERT INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-open', 'squad-a', 'p1', 'Open', 'b', 'open');
    INSERT INTO tasks (id, squad_id, project_id, title, body, status, gate_owner) VALUES ('t-rev', 'squad-a', 'p1', 'Review', 'b', 'review', 'gate:athena');
    INSERT INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-done', 'squad-a', 'p1', 'Done', 'b', 'done');
    INSERT INTO members (id, tenant, email, display_name, status) VALUES ('mem-1', '${TENANT}', 'm1@example.test', 'Member One', 'active');
    INSERT INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-appr', 'squad-a', 'p1', 'Approved', 'b', 'approved');
    INSERT INTO tasks (id, squad_id, project_id, title, body, status, assignee_member_id) VALUES ('t-human', 'squad-a', 'p1', 'Human', 'b', 'in_progress', 'mem-1');
    INSERT INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-arch', 'squad-a', 'p1', 'Archived', 'b', 'open');
    INSERT INTO tasks_archive_state (task_id, archived_at, archived_reason, archived_by_member_id, prior_status) VALUES ('t-arch', '2026-10-01T00:00:00Z', 'x', 'mem-1', 'open');
    INSERT INTO tasks (id, squad_id, project_id, title, body, status) VALUES ('t-p2', 'squad-a', 'p2', 'Elsewhere', 'b', 'open');
  `)
})

describe('the flag', () => {
  it('is off by default, and needs the binding as well', () => {
    expect(isProjectOfficeEnabled({ PROJECT_OFFICE: undefined, PROJECT_OFFICE_DO: NS })).toBe(false)
    expect(isProjectOfficeEnabled({ PROJECT_OFFICE: '0', PROJECT_OFFICE_DO: NS })).toBe(false)
    expect(isProjectOfficeEnabled({ PROJECT_OFFICE: 'true', PROJECT_OFFICE_DO: NS })).toBe(false) // only the exact "1"
    expect(isProjectOfficeEnabled({ PROJECT_OFFICE: '1', PROJECT_OFFICE_DO: undefined })).toBe(false)
    expect(isProjectOfficeEnabled({ PROJECT_OFFICE: '1', PROJECT_OFFICE_DO: NS })).toBe(true)
  })

  it('flag off refuses before touching D1', async () => {
    const env = { ...envFor({ PROJECT_OFFICE: undefined }), DB: {} as D1Database } // a DB that would throw if read
    expect(await verifyOfficeBinding(env, projectOfficeName(TENANT, 'p1'))).toEqual({ ok: false, reason: 'flag_off' })
  })
})

describe('naming', () => {
  it('is <tenant>:<project>, and round-trips', () => {
    expect(projectOfficeName('pot-a', 'p1')).toBe('pot-a:p1')
    expect(parseProjectOfficeName('pot-a:p1')).toEqual({ tenant: 'pot-a', projectId: 'p1' })
  })
  it('refuses tenants that would make the name ambiguous', () => {
    expect(() => projectOfficeName('a:b', 'p1')).toThrow('project_office_tenant_invalid')
    expect(() => projectOfficeName('', 'p1')).toThrow()
    expect(() => projectOfficeName('pot-a', ' ')).toThrow()
  })
  it.each(['', 'nocolon', ':p1', 'pot-a:'])('parse(%j) is null', (name) => {
    expect(parseProjectOfficeName(name)).toBeNull()
  })
})

describe('verifyOfficeBinding: D1 is the authority', () => {
  it('accepts a live project of this pot', async () => {
    expect(await verifyOfficeBinding(envFor(), 'pot-a:p1')).toEqual({ ok: true, tenant: 'pot-a', projectId: 'p1' })
  })
  it('refuses another pot name even for a real project id', async () => {
    expect(await verifyOfficeBinding(envFor(), 'pot-b:p1')).toEqual({ ok: false, reason: 'tenant_mismatch' })
  })
  it('refuses an unknown project, and a malformed name', async () => {
    expect(await verifyOfficeBinding(envFor(), 'pot-a:nope')).toEqual({ ok: false, reason: 'project_not_found' })
    expect(await verifyOfficeBinding(envFor(), 'garbage')).toEqual({ ok: false, reason: 'bad_name' })
  })
  it('refuses an archived project, by status and by archived_at', async () => {
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE id = 'p1'`)
    expect(await verifyOfficeBinding(envFor(), 'pot-a:p1')).toEqual({ ok: false, reason: 'project_archived' })
    harness.sqlite.exec(`UPDATE projects SET status = 'active', archived_at = '2026-10-01T00:00:00Z' WHERE id = 'p1'`)
    expect(await verifyOfficeBinding(envFor(), 'pot-a:p1')).toEqual({ ok: false, reason: 'project_archived' })
  })
})

describe('destroy-and-rebuild (scaffold)', () => {
  const binding: Extract<OfficeBinding, { ok: true }> = { ok: true, tenant: TENANT, projectId: 'p1' }
  const NOW = '2026-10-22T10:00:00.000Z'

  it('rebuilds only this project’s live work from D1 (approved kept; done, archived and foreign excluded)', async () => {
    const { sql } = officeStore()
    expect(await rebuildWorkingSet(envFor(), sql, binding, NOW)).toEqual({ tasks: 4 })
    // live work: open, review, APPROVED (not terminal: it becomes done only after its post-verdict work), human-owned.
    // not: done, archived, another project's.
    expect(sql.all('SELECT task_id FROM office_tasks ORDER BY task_id')).toEqual([
      { task_id: 't-appr' }, { task_id: 't-human' }, { task_id: 't-open' }, { task_id: 't-rev' },
    ])
    expect(sql.all('SELECT project_id, name, goal, synced_at FROM office_project_view')).toEqual([
      { project_id: 'p1', name: 'Project One', goal: 'Ship', synced_at: NOW },
    ])
  })

  it('wipe → rebuild yields the same working set, and D1 is untouched', async () => {
    const { sql, db } = officeStore()
    await rebuildWorkingSet(envFor(), sql, binding, NOW)
    const before = { v: sql.all('SELECT * FROM office_project_view'), t: sql.all('SELECT * FROM office_tasks ORDER BY task_id') }
    const d1Before = harness.sqlite.prepare('SELECT id, status, gate_owner, updated_at FROM tasks ORDER BY id').all()

    for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]) {
      db.exec(`DROP TABLE ${name}`) // DESTROY: the office keeps nothing outside its own storage
    }
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all()).toEqual([])

    await rebuildWorkingSet(envFor(), sql, binding, NOW)
    expect({ v: sql.all('SELECT * FROM office_project_view'), t: sql.all('SELECT * FROM office_tasks ORDER BY task_id') }).toEqual(before)
    expect(harness.sqlite.prepare('SELECT id, status, gate_owner, updated_at FROM tasks ORDER BY id').all()).toEqual(d1Before)
  })

  it('rebuild replaces, never merges: a task D1 no longer has live disappears from the office', async () => {
    const { sql } = officeStore()
    await rebuildWorkingSet(envFor(), sql, binding, NOW)
    harness.sqlite.exec(`UPDATE tasks SET status = 'done' WHERE id = 't-open'`)
    await rebuildWorkingSet(envFor(), sql, binding, NOW)
    expect(sql.all('SELECT task_id FROM office_tasks ORDER BY task_id').map((r) => r.task_id)).toEqual(['t-appr', 't-human', 't-rev'])
  })

  it('does not rebuild dedup or cursors from D1 (those come from the source tool)', async () => {
    const { sql } = officeStore()
    await rebuildWorkingSet(envFor(), sql, binding, NOW)
    expect(sql.all('SELECT * FROM office_seen')).toEqual([])
    expect(sql.all('SELECT * FROM office_cursor')).toEqual([])
  })
})

describe('the seven functions', () => {
  it('are the plan’s seven, in order', () => {
    expect([...OFFICE_FUNCTIONS]).toEqual(['notice', 'prepare', 'dispatch', 'followUp', 'gate', 'remember', 'report'])
  })
})

describe('verify fails closed', () => {
  it('a D1 error is verify_unavailable, not an exception and not ok', async () => {
    const down = { prepare: () => { throw new Error('d1 down') } } as unknown as D1Database
    expect(await verifyOfficeBinding({ ...envFor(), DB: down }, 'pot-a:p1')).toEqual({ ok: false, reason: 'verify_unavailable' })
    const rejects = { prepare: () => ({ bind: () => ({ first: () => Promise.reject(new Error('boom')) }) }) } as unknown as D1Database
    expect(await verifyOfficeBinding({ ...envFor(), DB: rejects }, 'pot-a:p1')).toEqual({ ok: false, reason: 'verify_unavailable' })
  })
  it('only the transient refusal is not permanent (the clock survives an outage, not an archive)', () => {
    expect(isPermanentBindingFailure('verify_unavailable')).toBe(false)
    for (const r of ['flag_off', 'bad_name', 'tenant_mismatch', 'project_not_found', 'project_archived', 'sub_agent'] as const) {
      expect(isPermanentBindingFailure(r), r).toBe(true)
    }
  })
  it('an undefined object name (an id minted without a name) is refused', async () => {
    expect(await verifyOfficeBinding(envFor(), undefined)).toEqual({ ok: false, reason: 'bad_name' })
  })
  it('the SDK’s sub-agent identity prefix is never an office name, even for this pot', async () => {
    expect(parseProjectOfficeName('cf-agents:v2:pot-a:p1')).toBeNull()
    expect(await verifyOfficeBinding(envFor(), 'cf-agents:v2:p1')).toEqual({ ok: false, reason: 'bad_name' })
  })
})

describe('working-set schema', () => {
  it('scopes dedup and cursors by provider; the tick counter has its own table', () => {
    const { sql } = officeStore()
    ensureOfficeSchema(sql)
    for (const p of ['github', 'linear']) {
      sql.exec(`INSERT INTO office_seen (provider, connection, event_id, seen_at) VALUES (?, 'c', 'same', 'x')`, p)
      sql.exec(`INSERT INTO office_cursor (provider, connection, cursor) VALUES (?, 'c', ?)`, p, p)
    }
    expect(sql.all('SELECT provider FROM office_seen ORDER BY provider')).toEqual([{ provider: 'github' }, { provider: 'linear' }])
    expect(() => sql.exec(`INSERT INTO office_seen (provider, connection, event_id, seen_at) VALUES ('github', 'c', 'same', 'y')`)).toThrow()
    expect(() => sql.exec(`INSERT INTO office_cursor (provider, connection, cursor) VALUES ('linear', 'c', 'z')`)).toThrow()
    sql.exec(`INSERT INTO office_meta (key, value) VALUES ('ticks', '1')`)
    expect(sql.all('SELECT value FROM office_meta')).toEqual([{ value: '1' }])
  })
  it('a human-owned task keeps its member, so it never looks unassigned', async () => {
    const { sql } = officeStore()
    await rebuildWorkingSet(envFor(), sql, { ok: true, tenant: TENANT, projectId: 'p1' }, '2026-10-22T10:00:00.000Z')
    expect(sql.all(`SELECT assignee_agent_id, assignee_member_id FROM office_tasks WHERE task_id = 't-human'`)).toEqual([
      { assignee_agent_id: null, assignee_member_id: 'mem-1' },
    ])
  })
  it('rebuild excludes archived tasks (mutating the archive filter fails this)', async () => {
    const { sql } = officeStore()
    await rebuildWorkingSet(envFor(), sql, { ok: true, tenant: TENANT, projectId: 'p1' }, '2026-10-22T10:00:00.000Z')
    expect(sql.all(`SELECT task_id FROM office_tasks WHERE task_id = 't-arch'`)).toEqual([])
  })
})
