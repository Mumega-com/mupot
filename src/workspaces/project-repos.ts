// Guarded writer for the `project_repos` allow-list (the repositories a git_branch worktree may name besides the
// project's own repo_url). Reached from project_update { add_repo | remove_repo }.
//
//  - the caller must READ the project (404 otherwise) and WRITE it (callerCanWriteProject, the predicate
//    project_remember and worktree_open use);
//  - the URL must fold to one network repository (repoKeyFromUrl);
//  - a repository another live project already owns is refused: adding it would make resolution ambiguous for both
//    (a takeover / denial lever), and the answer names no other project;
//  - every change writes a mutation_audit_entries receipt in the same batch, anchored on the change (changes() = 1),
//    so an idempotent repeat writes no second receipt.

import { callerCanWriteProject } from '../projects/access'
import { projectsOwningRepo } from '../projects/office-repo-owner'
import { readAccess, readableProject } from '../mcp/projects'
import type { AuthContext, Env } from '../types'
import { repoKeyFromUrl } from './repo-key'

export const PROJECT_REPOS_CAP = 20

export type ProjectRepoOp = 'add' | 'remove'

export type ProjectRepoResult =
  | { ok: true; changed: boolean; repo_key: string; repos: string[]; receipt_id: string | null }
  | { ok: false; status: 400 | 403 | 404 | 409 | 500; error: string }

export async function setProjectRepo(
  env: Env,
  auth: AuthContext,
  input: { project_id: string; op: ProjectRepoOp; repo: unknown },
): Promise<ProjectRepoResult> {
  const memberId = auth.memberId
  if (!memberId) return { ok: false, status: 403, error: 'forbidden' }
  const project = await readableProject(env, input.project_id, readAccess(auth))
  if (!project) return { ok: false, status: 404, error: 'project_not_found' }
  if (!(await callerCanWriteProject(env, auth, project.id))) return { ok: false, status: 403, error: 'forbidden' }
  const repoKey = repoKeyFromUrl(typeof input.repo === 'string' ? input.repo : null)
  if (!repoKey) return { ok: false, status: 400, error: 'invalid_repo' }

  const now = new Date().toISOString()
  const receiptId = crypto.randomUUID()
  const principalKind = auth.boundAgentId ? 'agent' : 'member'
  const evidence = JSON.stringify({ project_id: project.id, repo_key: repoKey, op: input.op })
  const receipt = env.DB.prepare(
    `INSERT INTO mutation_audit_entries (
       id, tenant, principal_kind, principal_id, member_id, agent_id,
       credential_id, origin, handler, operation, target_kind, target_id,
       task_id, request_id, idempotency_key, evidence_json, recorded_at
     )
     SELECT ?1, ?2, ?3, ?4, ?5, ?6,
            NULL, 'mcp', 'project_repos', ?7, 'project', ?8,
            NULL, ?1, NULL, ?9, ?10
      WHERE changes() = 1`,
  ).bind(receiptId, env.TENANT_SLUG, principalKind, auth.boundAgentId ?? memberId, memberId, auth.boundAgentId ?? null, input.op, project.id, evidence, now)

  let changed: boolean
  if (input.op === 'add') {
    const owners = await projectsOwningRepo(env.DB, repoKey)
    if (!owners.ok) return { ok: false, status: 500, error: 'unavailable' }
    if (owners.owners.some((id) => id !== project.id)) return { ok: false, status: 409, error: 'repo_already_owned' }
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM project_repos WHERE project_id = ?1').bind(project.id).first<{ n: number }>()
    if (Number(count?.n ?? 0) >= PROJECT_REPOS_CAP) return { ok: false, status: 409, error: 'project_repos_cap_reached' }
    const results = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO project_repos (project_id, repo_key, added_by_member_id) VALUES (?1, ?2, ?3)').bind(project.id, repoKey, memberId),
      receipt,
    ])
    changed = (results[0]?.meta as { changes?: number } | undefined)?.changes === 1
  } else {
    const results = await env.DB.batch([
      env.DB.prepare('DELETE FROM project_repos WHERE project_id = ?1 AND repo_key = ?2').bind(project.id, repoKey),
      receipt,
    ])
    changed = (results[0]?.meta as { changes?: number } | undefined)?.changes === 1
  }
  const rows = await env.DB.prepare('SELECT repo_key FROM project_repos WHERE project_id = ?1 ORDER BY repo_key').bind(project.id).all<{ repo_key: string }>()
  return { ok: true, changed, repo_key: repoKey, repos: (rows.results ?? []).map((r) => r.repo_key), receipt_id: changed ? receiptId : null }
}
