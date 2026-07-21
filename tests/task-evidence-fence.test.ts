// #399 — post-downgrade automation writes must not land (or refresh) evidence in a
// project's evidence feed after the task's owning squad drops below write/admin on
// that project.
//
// Policy (issue #399, decided): migration 0061 correctly narrows the task-access
// trigger to fire only on UPDATE OF squad_id/project_id (that narrowing fixed #391 —
// in-flight status transitions must not abort post-downgrade). The trade-off is that
// automation writes whose SET clause never touches those columns bypass the trigger
// entirely. This suite proves the app-layer fence added to the three affected paths
// (syncCiResultToTask, syncTaskStatusFromIssue, writeVerdict — src/tasks/service.ts)
// closes that gap, using the real evidence-surface query (listProjectEvidence) as the
// assertion — not a reimplementation of the keyset predicate.
//
// #455 adds the 4th instance: closeGitHubPrMirrorTasks (same SET-clause-never-touches-
// squad_id/project_id shape). Its fix is a WHERE-clause scope (`AND project_id IS NULL`)
// rather than the per-row filterProjectWritableTaskIds fence used by the other three —
// see that suite below for why a scope is sufficient here.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  syncCiResultToTask,
  syncTaskStatusFromIssue,
  writeVerdict,
  closeGitHubPrMirrorTasks,
  TaskEvidenceFenceError,
} from '../src/tasks/service'
import { listProjectEvidence } from '../src/projects/projections'
import type { Env, Task } from '../src/types'
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
    INSERT INTO projects (id, slug, name, status) VALUES ('project-x', 'project-x', 'Project X', 'active');
  `)
  return h
}

function grantAccess(h: SqliteD1Harness, level: 'write' | 'admin' | 'read'): void {
  h.sqlite.exec(
    `INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-x', 'squad-a', '${level}')`,
  )
}

// Simulates an owner downgrading (or fully revoking) the squad's project access
// AFTER the task already exists — the #399 scenario. The 0055 INSERT trigger
// requires write/admin at task-creation time, so tests must grant write first,
// insert the task, then call one of these to move the squad below write —
// exactly the "owner downgrades squad S while S has an in-flight task" story.
function downgradeAccess(h: SqliteD1Harness): void {
  h.sqlite.exec(`UPDATE project_squad_access SET access_level = 'read' WHERE project_id = 'project-x' AND squad_id = 'squad-a'`)
}
function removeAccess(h: SqliteD1Harness): void {
  h.sqlite.exec(`DELETE FROM project_squad_access WHERE project_id = 'project-x' AND squad_id = 'squad-a'`)
}

function envFor(h: SqliteD1Harness): Env {
  return { DB: h.db, TENANT_SLUG: 'tenant', BUS: { send: async () => undefined } } as unknown as Env
}

async function evidenceTaskResultRows(env: Env, taskId: string): Promise<unknown[]> {
  const page = await listProjectEvidence(env, { projectId: 'project-x', readableSquadIds: null })
  return page.rows.filter((row) => row.source_type === 'task_result' && row.source_id === taskId)
}

async function evidenceVerdictRows(env: Env, verdictId: string): Promise<unknown[]> {
  const page = await listProjectEvidence(env, { projectId: 'project-x', readableSquadIds: null })
  return page.rows.filter((row) => row.source_type === 'task_verdict' && row.source_id === verdictId)
}

describe('#399 — syncCiResultToTask evidence fence', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  function insertTask(h: SqliteD1Harness, id: string, projectId: string | null): void {
    h.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, github_issue_url, project_id, created_at, updated_at)
       VALUES ('${id}', 'squad-a', 'PR task', 'CI passes', 'review', 'https://github.com/o/r/pull/42',
               ${projectId ? `'${projectId}'` : 'NULL'}, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')`,
    )
  }

  it('squad still write → CI result lands normally and shows in project evidence', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    insertTask(harness, 'task-write', 'project-x')
    const env = envFor(harness)

    const res = await syncCiResultToTask(env, 42, 'failure')
    expect(res.updated).toBe(true)
    expect(harness.sqlite.prepare('SELECT result FROM tasks WHERE id = ?').get('task-write'))
      .toEqual({ result: 'CI: failure' })
    expect(await evidenceTaskResultRows(env, 'task-write')).toHaveLength(1)
  })

  it('squad downgraded write→read → CI result is fenced, does NOT land in project evidence', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write') // squad had write when the task was created...
    insertTask(harness, 'task-downgraded', 'project-x')
    downgradeAccess(harness) // ...then the owner downgraded it while the PR was in flight
    const env = envFor(harness)

    const res = await syncCiResultToTask(env, 42, 'failure')
    expect(res.updated).toBe(false)
    expect(harness.sqlite.prepare('SELECT result, status FROM tasks WHERE id = ?').get('task-downgraded'))
      .toEqual({ result: null, status: 'review' }) // untouched — no partial write either
    expect(await evidenceTaskResultRows(env, 'task-downgraded')).toHaveLength(0)
  })

  it('squad access removed entirely → fenced same as downgrade', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    insertTask(harness, 'task-removed', 'project-x')
    removeAccess(harness)
    const env = envFor(harness)

    const res = await syncCiResultToTask(env, 42, 'failure')
    expect(res.updated).toBe(false)
    expect(await evidenceTaskResultRows(env, 'task-removed')).toHaveLength(0)
  })

  it('detached task (no project_id) → automation unaffected regardless of squad access', async () => {
    harness = makeHarness()
    // No grantAccess call — would fence a project-attached task, but this one is detached.
    insertTask(harness, 'task-detached', null)
    const env = envFor(harness)

    const res = await syncCiResultToTask(env, 42, 'failure')
    expect(res.updated).toBe(true)
    expect(harness.sqlite.prepare('SELECT result FROM tasks WHERE id = ?').get('task-detached'))
      .toEqual({ result: 'CI: failure' })
  })
})

describe('#399 — syncTaskStatusFromIssue evidence fence', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  function insertTask(h: SqliteD1Harness, id: string, projectId: string | null, result: string | null): void {
    h.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, github_issue_url, result, project_id, created_at, updated_at)
       VALUES ('${id}', 'squad-a', 'Mirrored issue', 'issue closed', 'in_progress',
               'https://github.com/o/r/issues/5', ${result ? `'${result}'` : 'NULL'},
               ${projectId ? `'${projectId}'` : 'NULL'}, '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z')`,
    )
  }

  it('squad still write → issue-close sync lands normally', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    insertTask(harness, 'task-write', 'project-x', 'earlier CI note')
    const env = envFor(harness)

    const res = await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/5', 'closed')
    expect(res.updated).toBe(true)
    const row = harness.sqlite.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get('task-write') as {
      status: string; completed_at: string | null
    }
    expect(row.status).toBe('done')
    expect(row.completed_at).not.toBeNull()
  })

  it('squad downgraded write→read → close sync is fenced, does not refresh evidence ordering', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    // This task already carries a result from earlier (legitimate) work — closing the
    // mirrored issue must not bump completed_at and re-sort it in the evidence feed.
    insertTask(harness, 'task-downgraded', 'project-x', 'earlier CI note')
    downgradeAccess(harness)
    const env = envFor(harness)

    const before = harness.sqlite.prepare('SELECT status, completed_at, updated_at FROM tasks WHERE id = ?').get('task-downgraded')
    const res = await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/5', 'closed')
    expect(res.updated).toBe(false)
    expect(harness.sqlite.prepare('SELECT status, completed_at, updated_at FROM tasks WHERE id = ?').get('task-downgraded'))
      .toEqual(before) // completely untouched — no refresh of the evidence-ordering fields
  })

  it('squad access removed entirely → fenced', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    insertTask(harness, 'task-removed', 'project-x', 'earlier CI note')
    removeAccess(harness)
    const env = envFor(harness)

    const res = await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/5', 'closed')
    expect(res.updated).toBe(false)
  })

  it('detached task (no project_id) → unaffected regardless of squad access', async () => {
    harness = makeHarness()
    insertTask(harness, 'task-detached', null, null)
    const env = envFor(harness)

    const res = await syncTaskStatusFromIssue(env, 'https://github.com/o/r/issues/5', 'closed')
    expect(res.updated).toBe(true)
    expect(harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-detached')).toEqual({ status: 'done' })
  })
})

describe('#399 — writeVerdict (verdict flip) evidence fence', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: 'task-verdict-1',
      squad_id: 'squad-a',
      project_id: 'project-x',
      title: 'Gate me',
      body: '',
      done_when: 'verdict recorded',
      status: 'review',
      assignee_agent_id: null,
      github_issue_url: null,
      result: null,
      completed_at: null,
      gate_owner: 'gate:outreach',
      created_at: '2026-07-21T00:00:00Z',
      updated_at: '2026-07-21T00:00:00Z',
      ...overrides,
    }
  }

  function insertTaskRow(h: SqliteD1Harness, task: Task): void {
    h.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, gate_owner, project_id, created_at, updated_at)
       VALUES ('${task.id}', '${task.squad_id}', '${task.title}', '${task.done_when}', '${task.status}',
               '${task.gate_owner}', ${task.project_id ? `'${task.project_id}'` : 'NULL'},
               '${task.created_at}', '${task.updated_at}')`,
    )
  }

  it('squad still write → verdict lands normally and shows in project evidence', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    const task = makeTask()
    insertTaskRow(harness, task)
    const env = envFor(harness)

    const result = await writeVerdict(env, { task, verdict: 'approved', note: 'LGTM', decidedBy: 'member-1' })
    expect(result.task.status).toBe('approved')
    expect(await evidenceVerdictRows(env, result.verdict.id)).toHaveLength(1)
  })

  it('squad downgraded write→read → verdict is fenced (throws, no status flip, no verdict row)', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    const task = makeTask({ id: 'task-verdict-2' })
    insertTaskRow(harness, task)
    downgradeAccess(harness)
    const env = envFor(harness)

    await expect(writeVerdict(env, { task, verdict: 'approved', note: 'LGTM', decidedBy: 'member-1' }))
      .rejects.toThrow(TaskEvidenceFenceError)
    expect(harness.sqlite.prepare('SELECT status FROM tasks WHERE id = ?').get('task-verdict-2'))
      .toEqual({ status: 'review' }) // no partial flip
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS c FROM task_verdicts WHERE task_id = ?').get('task-verdict-2'))
      .toEqual({ c: 0 })
  })

  it('squad access removed entirely → fenced', async () => {
    harness = makeHarness()
    grantAccess(harness, 'write')
    const task = makeTask({ id: 'task-verdict-3' })
    insertTaskRow(harness, task)
    removeAccess(harness)
    const env = envFor(harness)

    await expect(writeVerdict(env, { task, verdict: 'rejected', note: null, decidedBy: 'member-1' }))
      .rejects.toThrow(TaskEvidenceFenceError)
  })

  it('detached task (no project_id) → unaffected regardless of squad access', async () => {
    harness = makeHarness()
    // No grantAccess call — would fence a project-attached task, but this one is detached.
    const task = makeTask({ id: 'task-verdict-4', project_id: null })
    insertTaskRow(harness, task)
    const env = envFor(harness)

    const result = await writeVerdict(env, { task, verdict: 'approved', note: null, decidedBy: 'member-1' })
    expect(result.task.status).toBe('approved')
  })
})

describe('#455 — closeGitHubPrMirrorTasks project fence', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  // Mirror tasks are minted DETACHED (github-routes.ts's createTask call omits
  // project_id) with title `[GH <repo>] PR #<n> <action>: …` — see taskFromGitHubEvent.
  function insertMirrorTask(h: SqliteD1Harness, id: string, projectId: string | null, title: string): void {
    h.sqlite.exec(
      `INSERT INTO tasks (id, squad_id, title, done_when, status, project_id, created_at, updated_at)
       VALUES ('${id}', 'squad-a', '${title}', 'GitHub event resolved', 'open',
               ${projectId ? `'${projectId}'` : 'NULL'}, '2026-07-21T00:00:00Z', '2026-07-21T00:00:00Z')`,
    )
  }

  it('detached mirror (project_id NULL) matching title+gate_owner → still auto-closed on PR close (existing behavior preserved)', async () => {
    harness = makeHarness()
    insertMirrorTask(harness, 'mirror-detached', null, '[GH o/r] PR #7 opened: Fix thing')
    const env = envFor(harness)

    const res = await closeGitHubPrMirrorTasks(env, 'o/r', 7)
    expect(res.closed).toBe(1)
    const row = harness.sqlite.prepare('SELECT status, result, completed_at FROM tasks WHERE id = ?').get('mirror-detached') as {
      status: string; result: string | null; completed_at: string | null
    }
    expect(row.status).toBe('done')
    expect(row.result).toBe('github_pr_closed')
    expect(row.completed_at).not.toBeNull()
  })

  it('project-ATTACHED task with the same title shape → NOT closed by this path (the #455 fix); no status/result/evidence write, even though the owning squad still holds write', async () => {
    harness = makeHarness()
    // Squad still has write on project-x — proves this isn't the per-row access fence
    // (which would let a still-writable squad's row through); the WHERE-clause scope
    // excludes ANY project-attached row from this bulk auto-close path, full stop.
    grantAccess(harness, 'write')
    insertMirrorTask(harness, 'mirror-attached', 'project-x', '[GH o/r] PR #7 opened: Fix thing')
    const env = envFor(harness)

    const res = await closeGitHubPrMirrorTasks(env, 'o/r', 7)
    expect(res.closed).toBe(0)
    const row = harness.sqlite.prepare('SELECT status, result, completed_at FROM tasks WHERE id = ?').get('mirror-attached') as {
      status: string; result: string | null; completed_at: string | null
    }
    expect(row.status).toBe('open') // untouched — no partial write
    expect(row.result).toBeNull()
    expect(row.completed_at).toBeNull()
    // Assert against the real evidence-surface query, not a reimplementation of the
    // keyset predicate — the untouched `result` column means it never enters
    // idx_tasks_project_evidence_keyset in the first place.
    expect(await evidenceTaskResultRows(env, 'mirror-attached')).toHaveLength(0)
  })
})
