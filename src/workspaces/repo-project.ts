// "What project am I part of?" from the repository an agent works in.
//
// The agent passes `repo` (the output of `git remote get-url origin`) and `branch`; this module folds the remote to a
// canonical repo_key (repoKeyFromUrl), asks which live projects own it (projectsOwningRepo: stored key, allow-list and
// pending rows), and answers a project ONLY when exactly one project the CALLER CAN READ owns it. Same rule as
// resolveRepoProject (projects/office-intake.ts) with one addition: readability. An ambiguous or unknown repo is
// `project: null` plus a reason and a hint to ask the owner; it never guesses.
//
// A project the caller cannot read is never returned, and its existence is never hinted at: an unreadable owner is
// dropped before counting, so a repo owned only by unreadable projects reads as `unknown_repo`.
//
// The clone spec is DATA ONLY: a URL with no userinfo, derived from the repo_key prefix (a table, not a branch on a
// provider name). Credentials are never part of it; the agent clones with its own identity.

import { resolveCapabilities } from '../auth/capability'
import { projectsOwningRepo } from '../projects/office-repo-owner'
import { readAccess, readableProject } from '../mcp/projects'
import type { AuthContext, Env } from '../types'
import { repoKeyFromUrl } from './repo-key'

export type RepoProjectReason = 'repo_required' | 'invalid_repo' | 'unknown_repo' | 'ambiguous_repo' | 'unavailable'

export interface RepoProjectRef {
  id: string
  slug: string
  name: string
}

export type RepoProjectResolution =
  | { project: RepoProjectRef; repo_key: string }
  | { project: null; reason: RepoProjectReason; hint: string; repo_key: string | null }

const HINT: Record<RepoProjectReason, string> = {
  repo_required: 'Pass repo = the output of `git remote get-url origin`, and branch = your current branch.',
  invalid_repo: 'That remote is not one network repository (a local path or an unparseable URL). Pass the output of `git remote get-url origin`.',
  unknown_repo: 'No project you can read owns this repository. Ask your owner which project this repo belongs to; do not guess one.',
  ambiguous_repo: 'More than one project you can read claims this repository. Ask your owner which project you are working on; do not guess one.',
  unavailable: 'The project lookup is unavailable right now. Retry, or ask your owner which project this repo belongs to.',
}

function miss(reason: RepoProjectReason, repoKey: string | null): RepoProjectResolution {
  return { project: null, reason, hint: HINT[reason], repo_key: repoKey }
}

/** Resolve the one project, among those `auth` can read, that owns `repoUrl`. Never throws. */
export async function resolveCallerRepoProject(
  env: Env,
  auth: AuthContext,
  repoUrl: unknown,
): Promise<RepoProjectResolution> {
  if (typeof repoUrl !== 'string' || repoUrl.trim() === '') return miss('repo_required', null)
  const repoKey = repoKeyFromUrl(repoUrl)
  if (!repoKey) return miss('invalid_repo', null)
  try {
    const found = await projectsOwningRepo(env.DB, repoKey)
    if (!found.ok) return miss('unavailable', repoKey)
    const access = readAccess(auth)
    const readable: RepoProjectRef[] = []
    for (const id of found.owners) {
      const p = await readableProject(env, id, access)
      if (p) readable.push({ id: p.id, slug: p.slug, name: p.name })
    }
    if (readable.length === 0) return miss('unknown_repo', repoKey)
    if (readable.length > 1) return miss('ambiguous_repo', repoKey)
    return { project: readable[0] as RepoProjectRef, repo_key: repoKey } // length is exactly 1 here
  } catch {
    return miss('unavailable', repoKey)
  }
}

/**
 * The context a harness / seat session reads projects with: the HUMAN's live grants (the session's own capability set is
 * empty by design). Same derivation worktree_open's harness door uses.
 */
export async function humanReadAuth(env: Env, memberId: string): Promise<AuthContext> {
  const grants = await resolveCapabilities(env, memberId)
  return { userId: memberId, email: null, role: 'member', tenant: env.TENANT_SLUG, memberId, channel: 'directory', capabilities: grants }
}

// ── clone spec ─────────────────────────────────────────────────────────────────────────

/** repo_key prefix -> URL prefix. Data, not a branch on a provider name; a new host family is a new row. */
const CLONE_URL_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ['github:', 'https://github.com/'],
  ['url:', 'https://'],
]

export interface CloneSpec {
  repo_key: string
  /** https clone URL, no userinfo, no token. null when the key prefix has no known template. */
  clone_url: string | null
  /** Not stored per project yet: null rather than a guess. */
  default_branch: string | null
  /** `<project-slug>/<branch>`: a relative folder name, never a machine path. */
  suggested_dir: string
}

export function cloneSpecFor(repoKey: string, projectSlug: string, branch: string): CloneSpec {
  const row = CLONE_URL_PREFIX.find(([prefix]) => repoKey.startsWith(prefix))
  // The key holds DECODED path segments: re-encode each so a reserved character (# ? %) cannot turn into a fragment/query.
  const clone = row ? `${row[1]}${repoKey.slice(row[0].length).split('/').map((seg, i) => (row[0] === 'url:' && i === 0 ? seg : encodeURIComponent(seg))).join('/')}.git` : null
  return { repo_key: repoKey, clone_url: clone, default_branch: null, suggested_dir: `${projectSlug}/${branch}` }
}
