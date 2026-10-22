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
  OFFICE_ITEM_CAP,
  NOTICE_SEEN_RETENTION_MS,
  applyNotice,
  ensureOfficeSchema,
  isPermanentBindingFailure,
  rebuildWorkingSet,
  verifyOfficeBinding,
  type OfficeBinding,
  type OfficeEnv,
  type OfficeSql,
} from '../src/projects/office-core'
import { buildNotice, type Notice, type NoticeFields } from '../src/projects/office-contract'
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

// ── applyNotice: the office records what it is told (real SQLite, the office's own schema) ──────────────

describe('applyNotice', () => {
  const T = (s: number) => new Date(Date.parse('2026-10-22T08:00:00.000Z') + s * 1000).toISOString()
  const NOW = Date.parse('2026-10-22T09:00:00.000Z')
  const fields = (over: Partial<NoticeFields> = {}): NoticeFields => ({
    tenant: TENANT, connection: 'inst-1', provider: 'github', item_id: 'PR_1', event_id: 'd-1', version: 'sha-a',
    kind: 'pr', url: 'https://github.com/o/r/pull/1', title: 'Title', actor: 'octo', updated_at: T(0), ...over,
  })
  const notice = (over: Partial<NoticeFields> = {}): Promise<Notice> => buildNotice(fields(over))
  const items = (sql: OfficeSql) => sql.all('SELECT item_id, version, updated_at, title, conflict_version FROM office_items ORDER BY item_id')
  const meta = (sql: OfficeSql) => Object.fromEntries(sql.all('SELECT key, value FROM office_meta').map((r) => [r.key, r.value]))
  const fresh = () => {
    const { sql } = officeStore()
    ensureOfficeSchema(sql)
    return sql
  }

  it('first sight is applied: item row, delivery id, cursor, counter', async () => {
    const sql = fresh()
    expect(applyNotice(sql, await notice(), NOW)).toBe('applied')
    expect(items(sql)).toEqual([{ item_id: 'PR_1', version: 'sha-a', updated_at: T(0), title: 'Title', conflict_version: null }])
    expect(sql.all('SELECT provider, connection, event_id FROM office_seen')).toEqual([{ provider: 'github', connection: 'inst-1', event_id: 'd-1' }])
    expect(sql.all('SELECT cursor FROM office_cursor')).toEqual([{ cursor: T(0) }])
    expect(meta(sql)).toEqual({ notice_applied: '1' })
  })

  it('replaying the same delivery is a no-op (delivery is at-least-once)', async () => {
    const sql = fresh()
    const n = await notice()
    expect(applyNotice(sql, n, NOW)).toBe('applied')
    const before = JSON.stringify([items(sql), sql.all('SELECT * FROM office_seen'), sql.all('SELECT * FROM office_cursor')])
    for (let i = 0; i < 3; i++) expect(applyNotice(sql, n, NOW + 1000)).toBe('duplicate')
    expect(JSON.stringify([items(sql), sql.all('SELECT * FROM office_seen'), sql.all('SELECT * FROM office_cursor')])).toBe(before)
    expect(meta(sql)).toEqual({ notice_applied: '1', notice_duplicate: '3' })
  })

  it('a replay is a no-op even after the delivery id was forgotten: the version check still holds', async () => {
    const sql = fresh()
    const n = await notice()
    applyNotice(sql, n, NOW)
    sql.exec('DELETE FROM office_seen')
    expect(applyNotice(sql, n, NOW)).toBe('duplicate') // same instant, same version, new delivery bookkeeping only
    expect(items(sql)).toHaveLength(1)
  })

  it('a newer notice replaces the item and moves the cursor forward', async () => {
    const sql = fresh()
    applyNotice(sql, await notice(), NOW)
    expect(applyNotice(sql, await notice({ event_id: 'd-2', version: 'sha-b', updated_at: T(60), title: 'Retitled' }), NOW)).toBe('applied')
    expect(items(sql)).toEqual([{ item_id: 'PR_1', version: 'sha-b', updated_at: T(60), title: 'Retitled', conflict_version: null }])
    expect(sql.all('SELECT cursor FROM office_cursor')).toEqual([{ cursor: T(60) }])
  })

  it('an OLDER version never overwrites a newer one, and never moves the cursor back', async () => {
    const sql = fresh()
    applyNotice(sql, await notice({ event_id: 'd-new', version: 'sha-new', updated_at: T(120), title: 'Newest' }), NOW)
    expect(applyNotice(sql, await notice({ event_id: 'd-old', version: 'sha-old', updated_at: T(10), title: 'Stale' }), NOW)).toBe('stale')
    expect(items(sql)).toEqual([{ item_id: 'PR_1', version: 'sha-new', updated_at: T(120), title: 'Newest', conflict_version: null }])
    expect(sql.all('SELECT cursor FROM office_cursor')).toEqual([{ cursor: T(120) }])
    expect(meta(sql)).toMatchObject({ notice_applied: '1', notice_stale: '1' })
  })

  it('arrival order does not change the end state when the instants differ', async () => {
    const a = await notice({ event_id: 'd-a', version: 'sha-a', updated_at: T(0) })
    const b = await notice({ event_id: 'd-b', version: 'sha-b', updated_at: T(30) })
    const c = await notice({ event_id: 'd-c', version: 'sha-c', updated_at: T(60) })
    const ends = new Set<string>()
    for (const order of [[a, b, c], [c, b, a], [b, c, a], [a, c, b]]) {
      const sql = fresh()
      for (const n of order) applyNotice(sql, n, NOW)
      ends.add(JSON.stringify(items(sql)))
    }
    expect(ends.size).toBe(1)
  })

  it('same instant, different version is a TIE: the held row stays, the competing version is only noted', async () => {
    const sql = fresh()
    // 'zzz' would sort ahead of 'aaa'; the old rule would have let the later (larger) one win. It must not.
    applyNotice(sql, await notice({ event_id: 'd-1', version: 'aaa' }), NOW)
    expect(applyNotice(sql, await notice({ event_id: 'd-2', version: 'zzz', title: 'Attacker title' }), NOW)).toBe('tie_kept')
    expect(items(sql)).toEqual([{ item_id: 'PR_1', version: 'aaa', updated_at: T(0), title: 'Title', conflict_version: 'zzz' }])
    // ...and the other way round keeps the first arrival too
    const sql2 = fresh()
    applyNotice(sql2, await notice({ event_id: 'd-2', version: 'zzz' }), NOW)
    expect(applyNotice(sql2, await notice({ event_id: 'd-1', version: 'aaa' }), NOW)).toBe('tie_kept')
    expect(items(sql2)[0]).toMatchObject({ version: 'zzz', conflict_version: 'aaa' })
    // a strictly newer notice resolves the tie and clears the note
    expect(applyNotice(sql, await notice({ event_id: 'd-3', version: 'ccc', updated_at: T(5) }), NOW)).toBe('applied')
    expect(items(sql)[0]).toMatchObject({ version: 'ccc', conflict_version: null })
  })

  it('items are scoped by provider and connection', async () => {
    const sql = fresh()
    applyNotice(sql, await notice(), NOW)
    applyNotice(sql, await notice({ connection: 'inst-2', event_id: 'd-9' }), NOW)
    applyNotice(sql, await notice({ provider: 'linear', event_id: 'd-9' }), NOW)
    expect(sql.all('SELECT count(*) AS n FROM office_items')).toEqual([{ n: 3 }])
  })

  it('forgets delivery ids past the retention window, nothing else', async () => {
    const sql = fresh()
    applyNotice(sql, await notice({ event_id: 'd-old' }), NOW)
    applyNotice(sql, await notice({ event_id: 'd-late', item_id: 'PR_2' }), NOW + NOTICE_SEEN_RETENTION_MS + 1000)
    expect(sql.all('SELECT event_id FROM office_seen ORDER BY event_id')).toEqual([{ event_id: 'd-late' }])
    expect(sql.all('SELECT count(*) AS n FROM office_items')).toEqual([{ n: 2 }])
  })

  it('caps the items an office holds, dropping the least recently updated', async () => {
    const sql = fresh()
    for (let i = 0; i < OFFICE_ITEM_CAP + 3; i++) {
      sql.exec(
        `INSERT INTO office_items (provider, connection, item_id, kind, version, url, title, actor, updated_at, hash, last_event_id, applied_at)
         VALUES ('github', 'inst-1', ?, 'pr', 'v', 'https://x.test/1', 't', 'a', ?, 'h', 'e', 'x')`,
        `seed-${i}`,
        T(i),
      )
    }
    applyNotice(sql, await notice({ item_id: 'brand-new', updated_at: T(100000) }), NOW)
    expect(Number(sql.all('SELECT count(*) AS n FROM office_items')[0]?.n)).toBe(OFFICE_ITEM_CAP)
    expect(sql.all(`SELECT 1 FROM office_items WHERE item_id = 'brand-new'`)).toHaveLength(1)
    expect(sql.all(`SELECT 1 FROM office_items WHERE item_id = 'seed-0'`)).toHaveLength(0)
  })

  it('is the working set only: rebuildWorkingSet leaves notice state alone, and the D1-derived part is untouched by it', async () => {
    const { sql } = officeStore()
    ensureOfficeSchema(sql)
    applyNotice(sql, await notice(), NOW)
    await rebuildWorkingSet(envFor(), sql, { ok: true, tenant: TENANT, projectId: 'p1' }, '2026-10-22T10:00:00.000Z')
    expect(items(sql)).toHaveLength(1)
    expect(sql.all('SELECT task_id FROM office_tasks ORDER BY task_id').length).toBeGreaterThan(0)
  })
})
