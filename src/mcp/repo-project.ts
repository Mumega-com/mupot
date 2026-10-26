// The `repo_project` answer shared by boot_context and seat_select: "which project am I part of, from the repo I work in".
// Thin glue over workspaces/repo-project.ts (read that file for the rule). Never throws; never returns a project the
// caller cannot read.

import type { AuthContext, Env } from '../types'
import { resolveCallerRepoProject } from '../workspaces/repo-project'
import { normalizeBranch } from '../workspaces/service'

export const REPO_ARG_INSTRUCTION =
  'Pass repo = the output of `git remote get-url origin` and branch = your current branch (git branch --show-current) to boot_context, seat_select and worktree_open; the project you are part of comes back as repo_project.'

export async function repoProjectAnswer(env: Env, auth: AuthContext, repo: unknown, branch: unknown): Promise<Record<string, unknown>> {
  const r = await resolveCallerRepoProject(env, auth, repo)
  const b = normalizeBranch(branch)
  if (r.project === null) return { project: null, reason: r.reason, hint: r.hint, repo_key: r.repo_key, branch: b }
  return {
    project: r.project,
    repo_key: r.repo_key,
    branch: b,
    next_step: b
      ? `You are part of project ${r.project.slug}. Call worktree_open { repo, branch } to get your clone URL and working folder.`
      : `You are part of project ${r.project.slug}. Pass branch too, then call worktree_open { repo, branch } for your clone URL and working folder.`,
  }
}
