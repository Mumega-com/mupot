// mupot — own-fleet task executor (D1, the sovereign path).
//
// The deterministic harness a pot agent calls AFTER doing its work, to ship it as a PR:
// branch → write files → open PR → link the PR back to the task. The code-writing itself is
// the agent's job at runtime; this composes the reviewed github-pr.ts primitives into one
// task-linked transaction. No GitHub Copilot involved — the pot's own fleet executes.
//
// On success the task moves to `review` (a PR is open, awaiting human/gate merge — the pot
// never merges) and its github_issue_url holds the PR url. Gated `repo_file_write`,
// fail-closed, returns the stage that failed.

import type { Env } from '../types'
import { createBranch, putFile, openPullRequest, isValidRepoPath, type CommitIdentity } from './github-pr'
import { githubCan } from './github-capabilities'
import { isValidRepo } from './github-repo-write'

/**
 * Resolve a named pot agent's git commit identity (#21). The agent authors its own commits as
 * `Name <slug@agents.mumega.com>`. Returns undefined if the agent can't be resolved (commit
 * then falls back to the App identity). slug is sanitized to a safe email local-part.
 */
export async function resolveAgentIdentity(env: Env, agentId: string): Promise<CommitIdentity | undefined> {
  const row = await env.DB.prepare(`SELECT slug, name FROM agents WHERE id = ?1 LIMIT 1`)
    .bind(agentId)
    .first<{ slug: string; name: string }>()
  if (!row) return undefined
  const local = (row.slug || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (!local) return undefined
  return { name: row.name?.trim() || row.slug, email: `${local}@agents.mumega.com` }
}

export interface ExecuteFile {
  path: string
  content: string
}

export type ExecuteTaskResult =
  | { ok: true; prNumber: number; prUrl: string; filesWritten: number }
  | { ok: false; error: string; stage: 'validate' | 'capability' | 'task' | 'branch' | 'file' | 'pr' }

export async function executeTaskAsPR(
  env: Env,
  params: {
    taskId: string
    repo: string
    baseBranch?: string
    branchName: string
    files: ExecuteFile[]
    title: string
    body?: string
  },
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ExecuteTaskResult> {
  const { taskId, repo, branchName, files, title } = params
  const baseBranch = params.baseBranch?.trim() || 'main'

  // ── validate ────────────────────────────────────────────────────────────────
  if (!taskId) return { ok: false, error: 'task_id_required', stage: 'validate' }
  if (!isValidRepo(repo)) return { ok: false, error: 'invalid_repo', stage: 'validate' }
  if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'no_files', stage: 'validate' }
  if (files.length > 100) return { ok: false, error: 'too_many_files', stage: 'validate' }
  for (const f of files) {
    if (!f || !isValidRepoPath(f.path)) return { ok: false, error: `invalid_path:${f?.path ?? ''}`, stage: 'validate' }
    if (typeof f.content !== 'string' || f.content.length === 0) return { ok: false, error: `empty:${f.path}`, stage: 'validate' }
  }
  if (typeof title !== 'string' || title.trim().length === 0) return { ok: false, error: 'title_required', stage: 'validate' }

  // ── capability ──────────────────────────────────────────────────────────────
  if (!(await githubCan(env, 'repo_file_write'))) return { ok: false, error: 'capability_disabled', stage: 'capability' }

  // ── task must exist (this pot's D1) ───────────────────────────────────────────
  const task = await env.DB.prepare(`SELECT id, status, assignee_agent_id FROM tasks WHERE id = ?1 LIMIT 1`)
    .bind(taskId)
    .first<{ id: string; status: string; assignee_agent_id: string | null }>()
  if (!task) return { ok: false, error: 'task_not_found', stage: 'task' }

  // Per-agent authorship (#21): the task's assigned agent authors the commits as itself.
  // Falls back to the App identity if the task has no agent or it can't be resolved.
  const author = task.assignee_agent_id ? await resolveAgentIdentity(env, task.assignee_agent_id) : undefined

  const fetchOpt = opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}

  // ── branch ────────────────────────────────────────────────────────────────────
  const br = await createBranch(env, { repo, fromBranch: baseBranch, newBranch: branchName }, fetchOpt)
  // branch_exists is fine — we proceed to put files on it (e.g. a retried execution).
  if (!br.ok && br.error !== 'branch_exists') return { ok: false, error: br.error, stage: 'branch' }

  // ── files ──────────────────────────────────────────────────────────────────────
  let written = 0
  for (const f of files) {
    const r = await putFile(
      env,
      { repo, path: f.path, content: f.content, branch: branchName, message: `${title} — ${f.path}`, author },
      fetchOpt,
    )
    if (!r.ok) return { ok: false, error: `${f.path}:${r.error}`, stage: 'file' }
    written++
  }

  // ── PR ───────────────────────────────────────────────────────────────────────
  const pr = await openPullRequest(
    env,
    { repo, head: branchName, base: baseBranch, title, body: params.body },
    fetchOpt,
  )
  if (!pr.ok) return { ok: false, error: pr.error, stage: 'pr' }

  // ── link the PR to the task: status → review (awaiting human/gate merge) ───────
  const now = new Date().toISOString()
  await env.DB.prepare(
    `UPDATE tasks SET status = 'review', github_issue_url = ?1, updated_at = ?2 WHERE id = ?3`,
  )
    .bind(pr.url, now, taskId)
    .run()

  return { ok: true, prNumber: pr.number, prUrl: pr.url, filesWritten: written }
}
