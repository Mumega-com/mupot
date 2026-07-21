// Tests for B3 inbound status sync (syncTaskStatusFromIssue in tasks/service.ts).
//
// Real-SQL harness (not a hand-rolled query-shape mock) — #399 fencing work made
// this a SELECT-then-UPDATE two-step (per-row project access re-check), so a mock
// stubbing only `.run()` can no longer stand in for the DB.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { syncTaskStatusFromIssue } from '../src/tasks/service'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function makeHarness(): SqliteD1Harness {
  const h = createSqliteD1()
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    h.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Dept');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept', 'squad-a', 'Squad A');
  `)
  return h
}

function insertTask(h: SqliteD1Harness, overrides: {
  id: string; status: string; issueUrl: string; projectId?: string | null
}): void {
  h.sqlite.exec(
    `INSERT INTO tasks (id, squad_id, title, done_when, status, github_issue_url, project_id, created_at, updated_at)
     VALUES ('${overrides.id}', 'squad-a', 'Mirrored issue', 'issue closed', '${overrides.status}',
             '${overrides.issueUrl}', ${overrides.projectId ? `'${overrides.projectId}'` : 'NULL'},
             '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')`,
  )
}

function envFor(h: SqliteD1Harness): Env {
  return { DB: h.db } as unknown as Env
}

describe('syncTaskStatusFromIssue', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('closed → marks the mirrored task done (open/in_progress only)', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'task-1', status: 'in_progress', issueUrl: 'https://github.com/o/r/issues/5' })

    const res = await syncTaskStatusFromIssue(envFor(harness), 'https://github.com/o/r/issues/5', 'closed')
    expect(res.updated).toBe(true)
    const row = harness.sqlite.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get('task-1') as {
      status: string; completed_at: string | null
    }
    expect(row.status).toBe('done')
    expect(row.completed_at).not.toBeNull()
  })

  it('never clobbers a gate state (review is not open/in_progress)', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'task-gate', status: 'review', issueUrl: 'https://github.com/o/r/issues/6' })

    const res = await syncTaskStatusFromIssue(envFor(harness), 'https://github.com/o/r/issues/6', 'closed')
    expect(res.updated).toBe(false)
    expect(harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-gate'))
      .toEqual({ status: 'review' })
  })

  it('reopened → flips a done task back to open', async () => {
    harness = makeHarness()
    insertTask(harness, { id: 'task-2', status: 'done', issueUrl: 'https://github.com/o/r/issues/5' })

    const res = await syncTaskStatusFromIssue(envFor(harness), 'https://github.com/o/r/issues/5', 'reopened')
    expect(res.updated).toBe(true)
    const row = harness.sqlite.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get('task-2') as {
      status: string; completed_at: string | null
    }
    expect(row.status).toBe('open')
    expect(row.completed_at).toBeNull()
  })

  it('no matching task → updated:false', async () => {
    harness = makeHarness()
    expect((await syncTaskStatusFromIssue(envFor(harness), 'https://github.com/o/r/issues/9', 'closed')).updated).toBe(false)
  })

  it('empty issue url → no-op', async () => {
    harness = makeHarness()
    expect((await syncTaskStatusFromIssue(envFor(harness), '', 'closed')).updated).toBe(false)
  })
})
