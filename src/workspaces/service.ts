// Workspaces W1 (design: mumega-com docs/architecture/harness-seats-worktrees.md §4.1): the worktree
// record and the two tools that touch it. Behind the WORKSPACES flag (strict '1'): off, nothing here
// runs a read or a write.
//
// AUTHORITY. worktree_open is reachable from a harness session, which has an EMPTY capability set by
// design. The harness's own capabilities are therefore never consulted. The principal is:
//   * an agent-bound caller (a seat or an agent token): its OWN live context (auth.capabilities), the
//     same ceiling every other tool sees, so it can open workspaces only on projects its squad writes;
//   * anyone else (the human behind a harness, or a plain directory session): the UNDERLYING HUMAN,
//     with grants re-read live from D1 (resolveCapabilities), the same derivation seat_select uses.
// Visibility is the existing chokepoint (projectReadAccessFromGrants + projectVisibilityClause);
// writability is the existing resolveAccessibleSquadIds(min 'member') + anySquadHasProjectWrite. No new
// predicate is written here.
//
// last_head_sha / last_seen_at are DISPLAY ONLY: written on open, read by nothing that decides.

import type { AuthContext, Env, Project } from '../types'
import { resolveAccessibleSquadIds } from '../projects/readable-squads'
import { resolveCapabilities } from '../auth/capability'
import {
  anySquadHasProjectWrite,
  projectReadAccessFromGrants,
  projectVisibilityClause,
} from '../projects/access'
import { projectSelectSql } from '../projects/columns'
import { loadHarness } from '../members/harness'
import { repoKeyFromUrl } from './repo-key'
import { workspacesEnabled } from './flag'

export { workspacesEnabled }

export type WorktreeKind = 'git_branch' | 'folder' | 'thread'
export const WORKTREE_KINDS: readonly WorktreeKind[] = ['git_branch', 'folder', 'thread']

export interface WorktreeRow {
  id: string
  tenant: string
  project_id: string
  kind: WorktreeKind
  repo_key: string
  harness_id: string
  ref_kind: 'branch' | 'slug' | 'thread'
  ref_name: string
  created_by_member_id: string
  created_at: string
  archived_at: string | null
  last_head_sha: string | null
  last_seen_at: string | null
}

const WORKTREE_COLUMNS =
  'id, tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name, created_by_member_id, created_at, archived_at, last_head_sha, last_seen_at'

// ── identity normalisation (a local path is NEVER identity) ─────────────────────────────

/** `refs/heads/x` -> `x`. Null for anything that is not a usable branch name: empty, detached HEAD,
 *  a remote or tag ref, control characters, `..`, a trailing `/`, `.lock`, over 255 chars. */
export function normalizeBranch(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let name = raw.trim()
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length)
  if (name === '' || name === 'HEAD' || name.length > 255) return null
  if (name.startsWith('refs/') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock') || name.endsWith('.')) return null
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f\s~^:?*[\\]/.test(name) || name.includes('..') || name.includes('//') || name.includes('@{')) return null
  return name
}

/** A human-chosen workspace name: lowercase `[a-z0-9._-]`, 1..64, never a path. */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s)) return null
  if (s.includes('..')) return null
  return s
}

/** A chat thread id inside one harness: opaque printable text, 1..128, no whitespace or separators. */
export function normalizeThreadId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (s.length < 1 || s.length > 128) return null
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(s)) return null
  return s
}

const HEAD_SHA_RE = /^[0-9a-f]{7,64}$/

// ── principal ───────────────────────────────────────────────────────────────────────────

interface Principal {
  /** The context every access primitive reads. */
  authz: AuthContext
  /** The member recorded as creator. */
  memberId: string
  /** The human whose harness this is (thread kind). */
  humanMemberId: string
  harnessId: string | null
}

async function resolvePrincipal(env: Env, auth: AuthContext): Promise<Principal | null> {
  const memberId = auth.memberId
  if (!memberId) return null
  const claimedHarness = auth.seatBinding?.harnessId ?? auth.harnessId ?? null
  if (auth.boundAgentId) {
    // An agent-bound caller acts with its own (already clamped, per-request re-derived) context.
    return { authz: auth, memberId, humanMemberId: auth.seatBinding?.humanMemberId ?? memberId, harnessId: claimedHarness }
  }
  const member = await env.DB.prepare(
    `SELECT id FROM members WHERE id = ?1 AND status = 'active' AND tenant = ?2 LIMIT 1`,
  ).bind(memberId, env.TENANT_SLUG).first<{ id: string }>()
  if (!member) return null
  // The HUMAN's live grants, never auth.capabilities (empty for a harness by design).
  const grants = await resolveCapabilities(env, memberId)
  const authz: AuthContext = {
    userId: memberId,
    email: null,
    role: 'member',
    tenant: env.TENANT_SLUG,
    memberId,
    channel: 'directory',
    capabilities: grants,
  }
  return { authz, memberId, humanMemberId: memberId, harnessId: claimedHarness }
}

async function findProject(env: Env, ref: string, authz: AuthContext): Promise<Project | null> {
  const access = projectReadAccessFromGrants(authz, authz.capabilities ?? [])
  const visibility = projectVisibilityClause(access)
  return env.DB.prepare(
    `SELECT ${projectSelectSql('p')} FROM projects p WHERE (p.id = ? OR p.slug = ?) AND ${visibility.sql} LIMIT 1`,
  ).bind(ref, ref, ...visibility.binds).first<Project>()
}

async function principalCanWriteProject(env: Env, authz: AuthContext, projectId: string): Promise<boolean> {
  const squads = await resolveAccessibleSquadIds(env, authz, 'member')
  if (squads === null) return true // org-scope authority at member rank or above
  return anySquadHasProjectWrite(env, projectId, squads)
}

// ── worktree_open ───────────────────────────────────────────────────────────────────────

export interface OpenArgs {
  project: unknown
  repo?: unknown
  branch?: unknown
  kind?: unknown
  slug?: unknown
  thread?: unknown
  head_sha?: unknown
}

export type OpenFailure =
  | { ok: false; error: 'workspaces_disabled' }
  | { ok: false; error: 'principal_required' }
  | { ok: false; error: 'invalid_args'; detail: string }
  | { ok: false; error: 'project_not_found' }
  | { ok: false; error: 'forbidden'; detail: { need: 'project_write'; scope: 'project' } }
  | { ok: false; error: 'repo_not_in_project'; detail: string }
  | { ok: false; error: 'harness_required' }
  | { ok: false; error: 'worktree_archived'; detail: { worktree_id: string } }
  | { ok: false; error: 'write_failed' }

export type OpenResult = { ok: true; created: boolean; worktree: WorktreeRow } | OpenFailure

export async function openWorktree(env: Env, auth: AuthContext, args: OpenArgs): Promise<OpenResult> {
  if (!workspacesEnabled(env)) return { ok: false, error: 'workspaces_disabled' }

  const projectRef = typeof args.project === 'string' ? args.project.trim() : ''
  if (!projectRef || projectRef.length > 200) return { ok: false, error: 'invalid_args', detail: 'project required' }
  const kindRaw = args.kind === undefined || args.kind === null ? 'git_branch' : args.kind
  if (typeof kindRaw !== 'string' || !(WORKTREE_KINDS as readonly string[]).includes(kindRaw)) {
    return { ok: false, error: 'invalid_args', detail: `kind must be one of ${WORKTREE_KINDS.join(', ')}` }
  }
  const kind = kindRaw as WorktreeKind // narrowed by the includes() check on the line above
  const has = (v: unknown): boolean => v !== undefined && v !== null
  // Shape per kind, validated BEFORE any read: a field that does not belong to the kind is refused,
  // so a path or branch can never ride along in a folder or thread identity.
  if (kind === 'git_branch' && (has(args.slug) || has(args.thread))) {
    return { ok: false, error: 'invalid_args', detail: 'git_branch takes repo + branch only' }
  }
  if (kind === 'folder' && (has(args.repo) || has(args.branch) || has(args.thread))) {
    return { ok: false, error: 'invalid_args', detail: 'folder takes slug only' }
  }
  if (kind === 'thread' && (has(args.repo) || has(args.branch) || has(args.slug))) {
    return { ok: false, error: 'invalid_args', detail: 'thread takes thread only' }
  }
  let refName: string | null = null
  let refKind: WorktreeRow['ref_kind'] = 'branch'
  let repoKeyIn: string | null = null
  if (kind === 'git_branch') {
    if (typeof args.repo !== 'string' || args.repo.trim() === '') return { ok: false, error: 'invalid_args', detail: 'repo required' }
    repoKeyIn = repoKeyFromUrl(args.repo)
    if (!repoKeyIn) return { ok: false, error: 'invalid_args', detail: 'repo must name exactly one repository' }
    refName = normalizeBranch(args.branch)
    if (!refName) return { ok: false, error: 'invalid_args', detail: 'branch required (a detached HEAD has no workspace identity: pick a branch)' }
  } else if (kind === 'folder') {
    refKind = 'slug'
    refName = normalizeSlug(args.slug)
    if (!refName) return { ok: false, error: 'invalid_args', detail: 'slug must be 1..64 of a-z 0-9 . _ - (a name, never a path)' }
  } else {
    refKind = 'thread'
    refName = normalizeThreadId(args.thread)
    if (!refName) return { ok: false, error: 'invalid_args', detail: 'thread id required (1..128 of A-Z a-z 0-9 . _ : @ -)' }
  }
  let headSha: string | null = null
  if (has(args.head_sha)) {
    const h = typeof args.head_sha === 'string' ? args.head_sha.trim().toLowerCase() : ''
    if (!HEAD_SHA_RE.test(h)) return { ok: false, error: 'invalid_args', detail: 'head_sha must be 7..64 lowercase hex' }
    headSha = h
  }

  const principal = await resolvePrincipal(env, auth)
  if (!principal) return { ok: false, error: 'principal_required' }

  // 404 for a project the principal cannot even see; 403 for one it can read but not write.
  const project = await findProject(env, projectRef, principal.authz)
  if (!project) return { ok: false, error: 'project_not_found' }
  if (!(await principalCanWriteProject(env, principal.authz, project.id))) {
    return { ok: false, error: 'forbidden', detail: { need: 'project_write', scope: 'project' } }
  }

  let repoKey = ''
  let harnessId = ''
  if (kind === 'git_branch') {
    repoKey = repoKeyIn ?? '' // set above for this kind
    const own = repoKeyFromUrl(project.repo_url)
    let allowed = own !== null && own === repoKey
    if (!allowed) {
      const row = await env.DB.prepare(
        'SELECT 1 AS ok FROM project_repos WHERE project_id = ?1 AND repo_key = ?2 LIMIT 1',
      ).bind(project.id, repoKey).first<{ ok: number }>()
      allowed = row !== null
    }
    if (!allowed) return { ok: false, error: 'repo_not_in_project', detail: 'this repository is not the project\'s repo and is not in its allow-list' }
  } else if (kind === 'thread') {
    // The harness must be the caller's own, verified live (a pointer alone proves nothing).
    if (!principal.harnessId) return { ok: false, error: 'harness_required' }
    const harness = await loadHarness(env, principal.humanMemberId, principal.harnessId)
    if (!harness) return { ok: false, error: 'harness_required' }
    harnessId = harness.id
  }

  const id = crypto.randomUUID()
  const identityBinds = [env.TENANT_SLUG, project.id, kind, repoKey, harnessId, refKind, refName] as const
  // Find-or-create on the UNIQUE identity: two machines / two spellings race to ONE row.
  const insert = await env.DB.prepare(
    `INSERT INTO worktrees (id, tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name, created_by_member_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name) DO NOTHING`,
  ).bind(id, ...identityBinds, principal.memberId).run()
  const created = (insert.meta?.changes ?? 0) > 0

  const found = await env.DB.prepare(
    `SELECT ${WORKTREE_COLUMNS} FROM worktrees
      WHERE tenant = ?1 AND project_id = ?2 AND kind = ?3 AND repo_key = ?4 AND harness_id = ?5 AND ref_kind = ?6 AND ref_name = ?7
      LIMIT 1`,
  ).bind(...identityBinds).first<WorktreeRow>()
  if (!found) return { ok: false, error: 'write_failed' }
  if (found.archived_at !== null) return { ok: false, error: 'worktree_archived', detail: { worktree_id: found.id } }

  // Display-only boot stamp. Never read by an authority decision.
  const stamped = await env.DB.prepare(
    `UPDATE worktrees SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_head_sha = COALESCE(?2, last_head_sha)
      WHERE id = ?1 AND archived_at IS NULL`,
  ).bind(found.id, headSha).run()
  if ((stamped.meta?.changes ?? 0) === 0) return { ok: false, error: 'write_failed' }
  const row = await env.DB.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE id = ?1`).bind(found.id).first<WorktreeRow>()
  return { ok: true, created, worktree: row ?? found }
}

// ── worktree_list ───────────────────────────────────────────────────────────────────────

export type ListResult =
  | { ok: true; project_id: string; worktrees: WorktreeRow[] }
  | { ok: false; error: 'workspaces_disabled' | 'principal_required' | 'project_not_found' }
  | { ok: false; error: 'invalid_args'; detail: string }

export async function listWorktrees(env: Env, auth: AuthContext, args: { project: unknown; include_archived?: unknown }): Promise<ListResult> {
  if (!workspacesEnabled(env)) return { ok: false, error: 'workspaces_disabled' }
  const projectRef = typeof args.project === 'string' ? args.project.trim() : ''
  if (!projectRef || projectRef.length > 200) return { ok: false, error: 'invalid_args', detail: 'project required' }
  const principal = await resolvePrincipal(env, auth)
  if (!principal) return { ok: false, error: 'principal_required' }
  // READ gate = the existing visibility chokepoint; a project the principal cannot see is not found.
  const project = await findProject(env, projectRef, principal.authz)
  if (!project) return { ok: false, error: 'project_not_found' }
  const includeArchived = args.include_archived === true
  const rows = await env.DB.prepare(
    `SELECT ${WORKTREE_COLUMNS} FROM worktrees
      WHERE tenant = ?1 AND project_id = ?2 ${includeArchived ? '' : 'AND archived_at IS NULL'}
      ORDER BY created_at, id LIMIT 500`,
  ).bind(env.TENANT_SLUG, project.id).all<WorktreeRow>()
  return { ok: true, project_id: project.id, worktrees: rows.results ?? [] }
}
