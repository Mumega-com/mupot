// tests/task-work-thread.test.ts — work-item = thread (Buzz pattern, borrowed).
//
// Proves the lifecycle on real SQLite migrations:
//   create → thread opens
//   branch → channel links
//   post → receipt appends
//   merge → thread archives (and further posts 409)

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  openTaskThread,
  linkTaskBranch,
  postTaskThread,
  archiveTaskThread,
  archiveTaskThreadsForMergedPr,
  getTaskThread,
  ensureTaskThreadOpened,
  THREAD_ARCHIVE_BACKFILL_STATUSES,
  TASK_STATUS_ENUM,
  threadArchiveBackfillStatusInSql,
} from '../src/tasks/thread'
import { createTask } from '../src/tasks/service'
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

function envFor(h: SqliteD1Harness): Env {
  return {
    DB: h.db,
    TENANT_SLUG: 'test',
    BUS: { send: async () => {} },
  } as unknown as Env
}

describe('task work-item thread', () => {
  let harness: SqliteD1Harness | undefined

  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('createTask opens a scoped thread with an opened receipt', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    const task = await createTask(
      env,
      { squad_id: 'squad-a', title: 'Ship thread', done_when: 'thread tests pass' },
      { skipMirror: true, actor: { kind: 'agent', id: 'agent-1' } },
    )

    const row = harness.sqlite
      .prepare(`SELECT thread_status, git_branch FROM tasks WHERE id = ?`)
      .get(task.id) as { thread_status: string; git_branch: string | null }
    expect(row.thread_status).toBe('open')
    expect(row.git_branch).toBeNull()

    const opened = harness.sqlite
      .prepare(`SELECT kind, actor_id FROM task_thread_receipts WHERE task_id = ? AND kind = 'opened'`)
      .get(task.id) as { kind: string; actor_id: string }
    expect(opened).toEqual({ kind: 'opened', actor_id: 'agent-1' })
  })

  it('branch link binds the channel; posts append; merge archives', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    let tick = 0
    const now = () => `2026-07-22T00:00:${String(tick++).padStart(2, '0')}.000Z`
    const idGen = (() => {
      let n = 0
      return () => `receipt-${++n}`
    })()

    const task = await createTask(
      env,
      { squad_id: 'squad-a', title: 'Feature X', done_when: 'PR merged' },
      { skipMirror: true },
    )
    // createTask's open receipt used wall clock; replace timeline for subsequent steps.
    harness.sqlite.exec(`DELETE FROM task_thread_receipts WHERE task_id = '${task.id}'`)
    await openTaskThread(env, task.id, 'system:task_create', { now, idGen })

    const linked = await linkTaskBranch(env, task.id, 'cursor/task-x', 'agent-1', {
      prUrl: 'https://github.com/o/r/pull/42',
      now,
      idGen,
    })
    expect(linked.ok).toBe(true)
    if (!linked.ok) return

    const bound = harness.sqlite
      .prepare(`SELECT git_branch, github_issue_url, thread_status FROM tasks WHERE id = ?`)
      .get(task.id) as { git_branch: string; github_issue_url: string; thread_status: string }
    expect(bound).toEqual({
      git_branch: 'cursor/task-x',
      github_issue_url: 'https://github.com/o/r/pull/42',
      thread_status: 'open',
    })

    const posted = await postTaskThread(env, task.id, 'CI green — ready for review', 'agent-2', {
      now,
      idGen,
    })
    expect(posted.ok).toBe(true)

    const { archived } = await archiveTaskThreadsForMergedPr(env, 42, { now, idGen })
    expect(archived).toBe(1)

    const after = harness.sqlite
      .prepare(`SELECT thread_status FROM tasks WHERE id = ?`)
      .get(task.id) as { thread_status: string }
    expect(after.thread_status).toBe('archived')

    const blocked = await postTaskThread(env, task.id, 'too late', 'agent-2')
    expect(blocked).toEqual({ ok: false, reason: 'thread_archived' })

    const view = await getTaskThread(env, task.id)
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.thread_status).toBe('archived')
    expect(view.receipts.map((r) => r.kind)).toEqual([
      'opened',
      'branch_linked',
      'post',
      'archived',
    ])
  })

  it('open/link/archive are idempotent; invalid branch is rejected', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, thread_status, created_at, updated_at)
       VALUES ('t1', 'squad-a', 'T', 'done', 'open', 'open', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
    )

    const first = await openTaskThread(env, 't1', 'sys')
    const second = await openTaskThread(env, 't1', 'sys')
    expect(first.ok && first.receipt !== null).toBe(true)
    expect(second.ok && second.receipt === null).toBe(true)

    expect(await linkTaskBranch(env, 't1', '../evil', 'sys')).toEqual({
      ok: false,
      reason: 'invalid_branch',
    })

    const linked = await linkTaskBranch(env, 't1', 'feat/ok', 'sys')
    expect(linked.ok).toBe(true)
    const again = await linkTaskBranch(env, 't1', 'feat/ok', 'sys')
    expect(again.ok && again.receipt === null).toBe(true)

    const a1 = await archiveTaskThread(env, 't1', 'sys', { reason: 'merged' })
    const a2 = await archiveTaskThread(env, 't1', 'sys')
    expect(a1.ok && a1.archived).toBe(true)
    expect(a2.ok && a2.archived === false).toBe(true)
  })

  it('migration backfills terminal tasks as archived threads', () => {
    harness = makeHarness()
    // Insert as done after migrations already ran — simulate pre-0068 terminal row
    // by writing thread_status open then re-applying the backfill predicate.
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, thread_status, created_at, updated_at)
       VALUES ('done-1', 'squad-a', 'Old', 'done', 'done', 'open', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
    )
    harness.sqlite.exec(
      `UPDATE tasks SET thread_status = 'archived'
       WHERE status IN (${threadArchiveBackfillStatusInSql()})`,
    )
    expect(
      harness.sqlite.prepare(`SELECT thread_status FROM tasks WHERE id = 'done-1'`).get(),
    ).toEqual({ thread_status: 'archived' })
  })

  it('backfill statuses enumerate the full task enum with no cancelled gap', () => {
    // Full enum — there is no cancelled. Adding a status must update the classify map.
    expect([...TASK_STATUS_ENUM].sort()).toEqual(
      ['approved', 'blocked', 'done', 'in_progress', 'open', 'rejected', 'review'].sort(),
    )
    expect([...THREAD_ARCHIVE_BACKFILL_STATUSES].sort()).toEqual(
      ['approved', 'done', 'rejected'].sort(),
    )
    // Migration 0068 WHERE list must match the TS constant (lockstep).
    expect(threadArchiveBackfillStatusInSql()).toBe("'approved', 'rejected', 'done'")
  })

  it('merge archives the thread while task.status may still be review', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, thread_status, github_issue_url, created_at, updated_at)
       VALUES ('rev-1', 'squad-a', 'Gated', 'CI green', 'review', 'open',
               'https://github.com/o/r/pull/99', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
    )
    const { archived } = await archiveTaskThreadsForMergedPr(env, 99)
    expect(archived).toBe(1)
    const row = harness.sqlite
      .prepare(`SELECT status, thread_status FROM tasks WHERE id = 'rev-1'`)
      .get() as { status: string; thread_status: string }
    expect(row).toEqual({ status: 'review', thread_status: 'archived' })
    expect(await postTaskThread(env, 'rev-1', 'late note', 'agent-1')).toEqual({
      ok: false,
      reason: 'thread_archived',
    })
  })

  it('ensureTaskThreadOpened is best-effort: create succeeds even if receipt write fails', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, thread_status, created_at, updated_at)
       VALUES ('t-miss', 'squad-a', 'T', 'done', 'open', 'open', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
    )
    // Break receipt inserts by dropping the table — openTaskThread throws via assertWritten/SQL.
    harness.sqlite.exec(`DROP TABLE task_thread_receipts`)
    const result = await ensureTaskThreadOpened(env, 't-miss', 'agent-1')
    expect(result).toEqual({ opened: false, best_effort_miss: true })
    // Task row still present (no rollback).
    expect(
      harness.sqlite.prepare(`SELECT id FROM tasks WHERE id = 't-miss'`).get(),
    ).toEqual({ id: 't-miss' })
  })

  it('ensureTaskThreadOpened normalizes oversized actors and opens the receipt', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, thread_status, created_at, updated_at)
       VALUES ('t-actor', 'squad-a', 'T', 'done', 'open', 'open', '2026-07-22T00:00:00Z', '2026-07-22T00:00:00Z')`,
    )
    const huge = 'x'.repeat(200)
    const result = await ensureTaskThreadOpened(env, 't-actor', huge)
    expect(result).toEqual({ opened: true, best_effort_miss: false })
    const opened = harness.sqlite
      .prepare(`SELECT actor_id FROM task_thread_receipts WHERE task_id = 't-actor' AND kind = 'opened'`)
      .get() as { actor_id: string }
    expect(opened.actor_id).toBe('system:task_create')
  })
})
