// Workspaces W1 — worktree_open / worktree_list. Thin glue over src/workspaces/service.ts (read that
// file for the authority model: the underlying HUMAN authorises, never the harness's empty capability
// set). Both are `min: 'authenticated'` for the same reason seat_select is: a harness session carries
// zero ambient capability by design, so a capability floor would make worktree_open unreachable by the
// only caller it exists for. The real gates live inside the service (flag, principal, project
// visibility, project write).

import type { ToolSpec, ToolOutcome } from './index'
import { done, fail } from './index'
import { listWorktrees, openWorktree, WORKTREE_KINDS } from '../workspaces/service'

function refusal(error: string, detail?: unknown): ToolOutcome {
  switch (error) {
    case 'workspaces_disabled':
      return fail(403, error, 'Workspaces are not enabled on this pot.')
    case 'principal_required':
      return fail(403, error, 'No active member behind this session.')
    case 'invalid_args':
      return fail(400, error, detail)
    case 'project_not_found':
      return fail(404, error)
    case 'forbidden':
      return fail(403, error, detail)
    case 'repo_not_in_project':
      return fail(403, error, detail)
    case 'harness_required':
      return fail(403, error, 'A thread workspace needs a verified harness on this connection.')
    case 'worktree_cap_reached':
      return fail(409, error, 'Too many workspaces created by this member on this project; archive some or reuse existing ones.')
    case 'worktree_archived':
      return fail(409, error, detail)
    default:
      return fail(500, 'internal_error')
  }
}

const toolWorktreeOpen: ToolSpec = {
  name: 'worktree_open',
  scope: 'project workspace (find-or-create); authorised against the underlying human / the calling agent\'s own project write access',
  min: 'authenticated',
  args: '{ project: string, repo?: string, branch?: string, kind?: "git_branch"|"folder"|"thread", slug?: string, thread?: string, head_sha?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project id or slug.' },
      kind: { type: 'string', enum: [...WORKTREE_KINDS], description: 'git_branch (default): project + repo + branch. folder: a named non-git workspace (slug). thread: a chat thread id inside this harness.' },
      repo: { type: 'string', description: 'git_branch: the repository URL in any spelling. Must be the project\'s repo or one on its allow-list.' },
      branch: { type: 'string', description: 'git_branch: the branch (refs/heads/x or x). A detached HEAD has no workspace identity.' },
      slug: { type: 'string', description: 'folder: a human-chosen name (a-z 0-9 . _ -). Never a machine path.' },
      thread: { type: 'string', description: 'thread: the thread id inside this harness. Needs a verified harness (SEAT_AUTO_ENROLL on); only its owner can list it.' },
      head_sha: { type: 'string', description: 'Optional current HEAD, recorded for display only. Never authority.' },
    },
    required: ['project'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const r = await openWorktree(env, auth, {
      project: args.project, repo: args.repo, branch: args.branch, kind: args.kind,
      slug: args.slug, thread: args.thread, head_sha: args.head_sha,
    })
    if (!r.ok) return refusal(r.error, 'detail' in r ? r.detail : undefined)
    return done({
      worktree_id: r.worktree.id,
      created: r.created,
      kind: r.worktree.kind,
      project_id: r.worktree.project_id,
      repo_key: r.worktree.repo_key || null,
      ref_name: r.worktree.ref_name,
      last_head_sha: r.worktree.last_head_sha,
      last_seen_at: r.worktree.last_seen_at,
    })
  },
}

const toolWorktreeList: ToolSpec = {
  name: 'worktree_list',
  scope: 'project workspaces (read); filtered through the project visibility chokepoint',
  min: 'authenticated',
  args: '{ project: string, include_archived?: boolean, limit?: number, cursor?: string }',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project id or slug.' },
      include_archived: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size (default 100). Branches are listed first, then folders, then your own threads.' },
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
    },
    required: ['project'],
    additionalProperties: false,
  },
  async run(auth, env, args) {
    const r = await listWorktrees(env, auth, { project: args.project, include_archived: args.include_archived, limit: args.limit, cursor: args.cursor })
    if (!r.ok) return refusal(r.error, 'detail' in r ? r.detail : undefined)
    return done({ project_id: r.project_id, worktrees: r.worktrees, next_cursor: r.next_cursor })
  },
}

export const WORKTREE_TOOLS: ToolSpec[] = [toolWorktreeOpen, toolWorktreeList]
