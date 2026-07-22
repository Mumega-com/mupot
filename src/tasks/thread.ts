// mupot — work-item = thread (Buzz pattern, borrowed — no Buzz dependency).
//
// A task and its discussion are the same object. The task opens a scoped thread;
// a branch auto-links that thread (the "channel"); merge archives it. Lifecycle
// transitions and discussion posts are append-only receipts — same primitive
// shape as task_verdicts. See docs/architecture/work-item-thread.md.

import type { Env } from '../types'
import { assertWritten } from '../lib/receipt'

export type ThreadStatus = 'open' | 'archived'
export type ThreadReceiptKind = 'opened' | 'branch_linked' | 'post' | 'archived'

export interface TaskThreadReceipt {
  id: string
  task_id: string
  kind: ThreadReceiptKind
  body: string
  actor_id: string
  ref: string | null
  created_at: string
}

export interface TaskThreadView {
  task_id: string
  thread_status: ThreadStatus
  git_branch: string | null
  github_issue_url: string | null
  receipts: TaskThreadReceipt[]
}

export type ThreadFailure =
  | { ok: false; reason: 'task_not_found' }
  | { ok: false; reason: 'thread_archived' }
  | { ok: false; reason: 'invalid_branch' }
  | { ok: false; reason: 'invalid_body' }
  | { ok: false; reason: 'invalid_actor' }

export type ThreadOk<T> = { ok: true } & T
export type ThreadResult<T> = ThreadOk<T> | ThreadFailure

const MAX_BODY_CHARS = 8000
const MAX_BRANCH_CHARS = 255
const MAX_ACTOR_CHARS = 128
// Git branch/ref: same safe subset as github-pr.ts (no '..', no leading/trailing slash).
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,255}(?<![./])$/

interface ThreadOpts {
  now?: () => string
  idGen?: () => string
}

function isActor(v: string): boolean {
  return v.length > 0 && v.length <= MAX_ACTOR_CHARS
}

export function isValidThreadBranch(branch: string): boolean {
  return BRANCH_RE.test(branch)
}

async function loadThreadRow(
  env: Env,
  taskId: string,
): Promise<{ id: string; thread_status: ThreadStatus; git_branch: string | null; github_issue_url: string | null } | null> {
  return env.DB.prepare(
    `SELECT id, thread_status, git_branch, github_issue_url FROM tasks WHERE id = ?1 LIMIT 1`,
  )
    .bind(taskId)
    .first<{ id: string; thread_status: ThreadStatus; git_branch: string | null; github_issue_url: string | null }>()
}

async function insertReceipt(
  env: Env,
  input: {
    taskId: string
    kind: ThreadReceiptKind
    body: string
    actorId: string
    ref: string | null
  },
  opts: ThreadOpts,
): Promise<TaskThreadReceipt> {
  const now = (opts.now ?? (() => new Date().toISOString()))()
  const id = (opts.idGen ?? (() => crypto.randomUUID()))()
  const receipt: TaskThreadReceipt = {
    id,
    task_id: input.taskId,
    kind: input.kind,
    body: input.body,
    actor_id: input.actorId,
    ref: input.ref,
    created_at: now,
  }
  const written = await env.DB.prepare(
    `INSERT INTO task_thread_receipts (id, task_id, kind, body, actor_id, ref, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(receipt.id, receipt.task_id, receipt.kind, receipt.body, receipt.actor_id, receipt.ref, receipt.created_at)
    .run()
  assertWritten(written, 'task_thread_receipts.insert')
  return receipt
}

/**
 * Open the scoped discussion thread for a freshly created task.
 * Idempotent: a second call with an already-open thread that already has an
 * `opened` receipt is a no-op (returns the existing view).
 */
export async function openTaskThread(
  env: Env,
  taskId: string,
  actorId: string,
  opts: ThreadOpts = {},
): Promise<ThreadResult<{ receipt: TaskThreadReceipt | null; thread_status: ThreadStatus }>> {
  if (!isActor(actorId)) return { ok: false, reason: 'invalid_actor' }
  const row = await loadThreadRow(env, taskId)
  if (!row) return { ok: false, reason: 'task_not_found' }

  const existing = await env.DB.prepare(
    `SELECT id FROM task_thread_receipts WHERE task_id = ?1 AND kind = 'opened' LIMIT 1`,
  )
    .bind(taskId)
    .first<{ id: string }>()
  if (existing) {
    return { ok: true, receipt: null, thread_status: row.thread_status }
  }

  // Ensure status is open even if a prior path left it elsewhere (defensive).
  if (row.thread_status !== 'open') {
    const flipped = await env.DB.prepare(
      `UPDATE tasks SET thread_status = 'open', updated_at = ?1 WHERE id = ?2 AND thread_status != 'open'`,
    )
      .bind((opts.now ?? (() => new Date().toISOString()))(), taskId)
      .run()
    assertWritten(flipped, 'tasks.thread_status.open')
  }

  const receipt = await insertReceipt(
    env,
    { taskId, kind: 'opened', body: 'thread opened', actorId, ref: null },
    opts,
  )
  return { ok: true, receipt, thread_status: 'open' }
}

/**
 * Bind a git branch to the task's thread (Buzz: "branch creates/links a channel").
 * Optionally stamps github_issue_url when a PR url is supplied and the column is empty.
 */
export async function linkTaskBranch(
  env: Env,
  taskId: string,
  branch: string,
  actorId: string,
  opts: ThreadOpts & { prUrl?: string | null } = {},
): Promise<ThreadResult<{ git_branch: string; receipt: TaskThreadReceipt | null }>> {
  if (!isActor(actorId)) return { ok: false, reason: 'invalid_actor' }
  const trimmed = branch.trim()
  if (!isValidThreadBranch(trimmed) || trimmed.length > MAX_BRANCH_CHARS) {
    return { ok: false, reason: 'invalid_branch' }
  }

  const row = await loadThreadRow(env, taskId)
  if (!row) return { ok: false, reason: 'task_not_found' }
  if (row.thread_status === 'archived') return { ok: false, reason: 'thread_archived' }

  const now = (opts.now ?? (() => new Date().toISOString()))()
  const prUrl = typeof opts.prUrl === 'string' && opts.prUrl.trim() ? opts.prUrl.trim() : null

  // Idempotent re-link of the same branch: skip write + receipt when nothing changes.
  const sameBranch = row.git_branch === trimmed
  const needsPr = prUrl !== null && row.github_issue_url === null
  if (sameBranch && !needsPr) {
    return { ok: true, git_branch: trimmed, receipt: null }
  }

  const updated = await env.DB.prepare(
    `UPDATE tasks
        SET git_branch = ?1,
            github_issue_url = CASE
              WHEN github_issue_url IS NULL AND ?2 IS NOT NULL THEN ?2
              ELSE github_issue_url
            END,
            updated_at = ?3
      WHERE id = ?4 AND thread_status = 'open'`,
  )
    .bind(trimmed, prUrl, now, taskId)
    .run()
  if ((updated.meta?.changes ?? 0) === 0) {
    const again = await loadThreadRow(env, taskId)
    if (!again) return { ok: false, reason: 'task_not_found' }
    if (again.thread_status === 'archived') return { ok: false, reason: 'thread_archived' }
  }

  const receipt = await insertReceipt(
    env,
    {
      taskId,
      kind: 'branch_linked',
      body: prUrl ? `branch linked with PR` : 'branch linked',
      actorId,
      ref: trimmed,
    },
    opts,
  )
  return { ok: true, git_branch: trimmed, receipt }
}

/**
 * Append a discussion post to an open task thread. Rejects archived threads.
 */
export async function postTaskThread(
  env: Env,
  taskId: string,
  body: string,
  actorId: string,
  opts: ThreadOpts = {},
): Promise<ThreadResult<{ receipt: TaskThreadReceipt }>> {
  if (!isActor(actorId)) return { ok: false, reason: 'invalid_actor' }
  if (typeof body !== 'string' || body.length === 0) return { ok: false, reason: 'invalid_body' }
  if (body.length > MAX_BODY_CHARS) return { ok: false, reason: 'invalid_body' }

  const row = await loadThreadRow(env, taskId)
  if (!row) return { ok: false, reason: 'task_not_found' }
  if (row.thread_status === 'archived') return { ok: false, reason: 'thread_archived' }

  const receipt = await insertReceipt(
    env,
    { taskId, kind: 'post', body, actorId, ref: row.git_branch },
    opts,
  )
  return { ok: true, receipt }
}

/**
 * Archive the task thread (Buzz: "merge archives the channel"). Idempotent when
 * already archived.
 */
export async function archiveTaskThread(
  env: Env,
  taskId: string,
  actorId: string,
  opts: ThreadOpts & { reason?: string } = {},
): Promise<ThreadResult<{ archived: boolean; receipt: TaskThreadReceipt | null }>> {
  if (!isActor(actorId)) return { ok: false, reason: 'invalid_actor' }
  const row = await loadThreadRow(env, taskId)
  if (!row) return { ok: false, reason: 'task_not_found' }
  if (row.thread_status === 'archived') {
    return { ok: true, archived: false, receipt: null }
  }

  const now = (opts.now ?? (() => new Date().toISOString()))()
  const flipped = await env.DB.prepare(
    `UPDATE tasks SET thread_status = 'archived', updated_at = ?1
      WHERE id = ?2 AND thread_status = 'open'`,
  )
    .bind(now, taskId)
    .run()

  if ((flipped.meta?.changes ?? 0) === 0) {
    return { ok: true, archived: false, receipt: null }
  }

  const reason = typeof opts.reason === 'string' && opts.reason.trim() ? opts.reason.trim() : 'thread archived'
  const receipt = await insertReceipt(
    env,
    {
      taskId,
      kind: 'archived',
      body: reason,
      actorId,
      ref: row.git_branch ?? row.github_issue_url,
    },
    opts,
  )
  return { ok: true, archived: true, receipt }
}

/**
 * On PR merge: archive every open task thread whose github_issue_url points at
 * that PR number. Reuses the PR-url suffix match used by syncCiResultToTask.
 */
export async function archiveTaskThreadsForMergedPr(
  env: Env,
  prNumber: number,
  opts: ThreadOpts & { actorId?: string } = {},
): Promise<{ archived: number }> {
  if (!Number.isInteger(prNumber) || prNumber <= 0) return { archived: 0 }
  const suffix = `%/pull/${prNumber}`
  const candidates = await env.DB.prepare(
    `SELECT id FROM tasks
      WHERE thread_status = 'open'
        AND github_issue_url LIKE ?1`,
  )
    .bind(suffix)
    .all<{ id: string }>()

  const actorId = opts.actorId ?? 'github:webhook'
  let archived = 0
  for (const row of candidates.results ?? []) {
    const res = await archiveTaskThread(env, row.id, actorId, {
      ...opts,
      reason: `PR #${prNumber} merged`,
    })
    if (res.ok && res.archived) archived += 1
  }
  return { archived }
}

export async function listTaskThreadReceipts(env: Env, taskId: string): Promise<TaskThreadReceipt[]> {
  const res = await env.DB.prepare(
    `SELECT id, task_id, kind, body, actor_id, ref, created_at
       FROM task_thread_receipts
      WHERE task_id = ?1
      ORDER BY created_at ASC, id ASC`,
  )
    .bind(taskId)
    .all<TaskThreadReceipt>()
  return res.results ?? []
}

export async function getTaskThread(env: Env, taskId: string): Promise<ThreadResult<TaskThreadView>> {
  const row = await loadThreadRow(env, taskId)
  if (!row) return { ok: false, reason: 'task_not_found' }
  const receipts = await listTaskThreadReceipts(env, taskId)
  return {
    ok: true,
    task_id: row.id,
    thread_status: row.thread_status,
    git_branch: row.git_branch,
    github_issue_url: row.github_issue_url,
    receipts,
  }
}
