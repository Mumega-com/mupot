// Workspaces W1 (design: mumega-com docs/architecture/harness-seats-worktrees.md §4.1): the worktree
// record and the two tools that touch it. Behind the WORKSPACES flag (strict '1'): off, nothing here
// runs a read or a write.
//
// AUTHORITY. worktree_open is reachable from a harness session, which has an EMPTY capability set by
// design. The harness's own capabilities are therefore never consulted, but ONLY for a VERIFIED harness
// session (isHarnessCredentialSession + a live harnesses row for this member, and for a token harness
// the very token that IS it). For that one door the principal is the UNDERLYING HUMAN, with grants
// re-read live from D1 (resolveCapabilities), the same derivation seat_select uses.
// EVERY OTHER caller (a seat, an agent token, a plain directory session, a consent-bound session) acts
// with its own auth.capabilities exactly as they are: a plain directory context with capabilities [] is
// refused here as it is by project_get, and a consent-bound session whose capabilities were zeroed is
// refused outright (it must never fall back to anything wider).
// Visibility = readableProject (mcp/projects.ts); writability = the predicate project_remember uses:
// org admin, or a directly granted squad (member rank or above) holding write/admin on the project
// (anySquadHasProjectWrite). This module adds no authority predicate of its own.
//
// THREAD kind needs a verified harness, which exists only while SEAT_AUTO_ENROLL is on (an OAuth
// harness is created at consent behind it; a harness token is refused by the bearer doors without it).
// With SEAT_AUTO_ENROLL off, `thread` always answers harness_required; git_branch and folder do not
// depend on it.
//
// last_head_sha / last_seen_at are DISPLAY ONLY: written on open, read by nothing that decides.

import { resolveCapabilities } from '../auth/capability'
import type { AuthContext, Env, Project } from '../types'
import { callerCanWriteProject } from '../projects/access'
import { loadHarness } from '../members/harness'
import { isHarnessCredentialSession } from '../members/harness-credential'
import { readAccess, readableProject } from '../mcp/projects'
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

async function resolvePrincipal(env: Env, auth: AuthContext, opts: { harnessDoor: boolean }): Promise<Principal | null> {
  const memberId = auth.memberId
  if (!memberId) return null

  // THE HARNESS DOOR (the only place the human's grants stand in for the session's own).
  // Two harness shapes reach it, and each must PROVE the pointer belongs to this very credential:
  //  - a token harness: the session carries the harness-credential marker AND the harness row's token_id
  //    is the session's own token;
  //  - an OAuth harness ("Me — auto per workspace" consent): an UNBOUND directory session, not consent-bound
  //    to an agent, whose harness row is credential_kind 'oauth' and whose grant is THIS consent token
  //    (grant_id = 'oauth:<tokenId>'), or a pre-0216 row keyed 'legacy:<id>' (one row per earlier consent).
  // A plain directory session (no harness pointer) or a forged pointer to another credential's harness
  // never gets here; it falls to the caller's own context below.
  const harnessId = auth.harnessId
  const maybeHarness = !auth.boundAgentId && !auth.consentedByMemberId && typeof harnessId === 'string' && harnessId.length > 0
  const harness = maybeHarness ? await loadHarness(env, memberId, harnessId as string) : null
  const tokenDoor = harness !== null && isHarnessCredentialSession(auth)
    && harness.credential_kind === 'token' && harness.token_id === auth.tokenId
  const oauthDoor = harness !== null && !isHarnessCredentialSession(auth) && auth.channel === 'directory'
    && harness.credential_kind === 'oauth' && typeof auth.tokenId === 'string' && auth.tokenId.length > 0
    && (harness.grant_id === `oauth:${auth.tokenId}` || (harness.grant_id ?? '').startsWith('legacy:'))
  // A session that CLAIMS a harness (a pointer, or the token marker) but cannot prove it is refused outright,
  // never downgraded to its own (empty) context, so a forged pointer reads the same as a revoked one.
  if (!auth.boundAgentId && (maybeHarness || isHarnessCredentialSession(auth)) && !(harness && (tokenDoor || oauthDoor))) return null
  // The harness door exists for worktree_open ONLY (design §4.1). Every other caller that is a harness session
  // (OAuth or token) is refused here rather than handed the human's grants: worktree_list is not on the door.
  if (!opts.harnessDoor && !auth.boundAgentId && (maybeHarness || isHarnessCredentialSession(auth))) return null
  if (harness && (tokenDoor || oauthDoor)) {
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
    return { authz, memberId, humanMemberId: memberId, harnessId: harness.id }
  }

  // Everyone else: the caller's OWN context, untouched. A consent-bound session (consentedByMemberId)
  // whose capabilities were zeroed (the human was demoted) is refused: nothing wider may replace them.
  if (auth.consentedByMemberId && (auth.capabilities?.length ?? 0) === 0) return null
  return {
    authz: auth,
    memberId,
    humanMemberId: auth.seatBinding?.humanMemberId ?? memberId,
    harnessId: auth.seatBinding?.harnessId ?? auth.harnessId ?? null,
  }
}

/** Resolve a project by id (preferred) or slug, through the ONE project-read chokepoint. */
async function findProject(env: Env, ref: string, authz: AuthContext): Promise<Project | null> {
  const access = readAccess(authz)
  const byId = await readableProject(env, ref, access)
  if (byId) return byId
  const bySlug = await env.DB.prepare('SELECT id FROM projects WHERE slug = ?1 LIMIT 1').bind(ref).first<{ id: string }>()
  return bySlug ? readableProject(env, bySlug.id, access) : null
}

/** The write predicate project_remember uses: the shared chokepoint (member rank on a write squad, or org admin). */
async function principalCanWriteProject(env: Env, authz: AuthContext, projectId: string): Promise<boolean> {
  return callerCanWriteProject(env, authz, projectId)
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
  | { ok: false; error: 'worktree_cap_reached' }
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

  const principal = await resolvePrincipal(env, auth, { harnessDoor: true })
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

  const identityBinds = [env.TENANT_SLUG, project.id, kind, repoKey, harnessId, refKind, refName] as const
  const findSql = `SELECT ${WORKTREE_COLUMNS} FROM worktrees
      WHERE tenant = ?1 AND project_id = ?2 AND kind = ?3 AND repo_key = ?4 AND harness_id = ?5 AND ref_kind = ?6 AND ref_name = ?7
      LIMIT 1`
  // Find first: reopening an existing workspace must keep working at the creation cap.
  let found = await env.DB.prepare(findSql).bind(...identityBinds).first<WorktreeRow>()
  let created = false
  if (!found) {
    // Create on the UNIQUE identity: two machines / two spellings race to ONE row. The per-member cap is a
    // BEFORE INSERT trigger (migration 0216), so it holds under concurrency.
    try {
      const insert = await env.DB.prepare(
        `INSERT INTO worktrees (id, tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name, created_by_member_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (tenant, project_id, kind, repo_key, harness_id, ref_kind, ref_name) DO NOTHING`,
      ).bind(crypto.randomUUID(), ...identityBinds, principal.memberId).run()
      created = (insert.meta?.changes ?? 0) > 0
    } catch (err) {
      if (err instanceof Error && err.message.includes('worktree_cap_reached')) {
        // A concurrent open of the SAME identity may have inserted it between our lookup and this insert: the
        // BEFORE INSERT cap fires before ON CONFLICT can see the row. That is a reopen, not a new workspace.
        const raced = await env.DB.prepare(findSql).bind(...identityBinds).first<WorktreeRow>()
        if (!raced) return { ok: false, error: 'worktree_cap_reached' }
      } else throw err
    }
    found = await env.DB.prepare(findSql).bind(...identityBinds).first<WorktreeRow>()
  }
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

export const LIST_DEFAULT_LIMIT = 100
export const LIST_MAX_LIMIT = 200

export type ListResult =
  | { ok: true; project_id: string; worktrees: WorktreeRow[]; next_cursor: string | null }
  | { ok: false; error: 'workspaces_disabled' | 'principal_required' | 'project_not_found' }
  | { ok: false; error: 'invalid_args'; detail: string }

const KIND_RANK_SQL = `CASE kind WHEN 'git_branch' THEN 0 WHEN 'folder' THEN 1 ELSE 2 END`

/** Keyset cursor: `<kind rank>|<created_at>|<id>`, URI-encoded per part. Opaque to callers. */
function encodeCursor(rank: number, createdAt: string, id: string): string {
  return [String(rank), createdAt, id].map(encodeURIComponent).join('|')
}
function decodeCursor(raw: string): { rank: number; createdAt: string; id: string } | null {
  const parts = raw.split('|')
  if (parts.length !== 3) return null
  try {
    const [r, createdAt, id] = parts.map(decodeURIComponent)
    const rank = Number(r)
    if (!Number.isInteger(rank) || rank < 0 || rank > 2 || !createdAt || !id) return null
    return { rank, createdAt, id }
  } catch {
    return null
  }
}

export async function listWorktrees(
  env: Env,
  auth: AuthContext,
  args: { project: unknown; include_archived?: unknown; limit?: unknown; cursor?: unknown },
): Promise<ListResult> {
  if (!workspacesEnabled(env)) return { ok: false, error: 'workspaces_disabled' }
  const projectRef = typeof args.project === 'string' ? args.project.trim() : ''
  if (!projectRef || projectRef.length > 200) return { ok: false, error: 'invalid_args', detail: 'project required' }
  let limit = LIST_DEFAULT_LIMIT
  if (args.limit !== undefined && args.limit !== null) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > LIST_MAX_LIMIT) {
      return { ok: false, error: 'invalid_args', detail: `limit must be an integer 1..${LIST_MAX_LIMIT}` }
    }
    limit = args.limit
  }
  let cursor: { rank: number; createdAt: string; id: string } | null = null
  if (args.cursor !== undefined && args.cursor !== null) {
    cursor = typeof args.cursor === 'string' ? decodeCursor(args.cursor) : null
    if (!cursor) return { ok: false, error: 'invalid_args', detail: 'cursor is not one this tool returned' }
  }
  const principal = await resolvePrincipal(env, auth, { harnessDoor: false })
  if (!principal) return { ok: false, error: 'principal_required' }
  // READ gate = the existing project-read chokepoint; a project the principal cannot see is not found.
  const project = await findProject(env, projectRef, principal.authz)
  if (!project) return { ok: false, error: 'project_not_found' }
  const includeArchived = args.include_archived === true
  // THREAD rows belong to the human who owns the harness they name: nobody else sees them, even a
  // project reader (a thread id is a chat-thread identifier, not project metadata).
  const rows = await env.DB.prepare(
    `SELECT ${WORKTREE_COLUMNS} FROM (
       SELECT ${WORKTREE_COLUMNS}, ${KIND_RANK_SQL} AS rk FROM worktrees w
        WHERE w.tenant = ?1 AND w.project_id = ?2
          ${includeArchived ? '' : 'AND w.archived_at IS NULL'}
          AND (w.kind <> 'thread'
               OR EXISTS (SELECT 1 FROM harnesses h WHERE h.id = w.harness_id AND h.tenant = w.tenant AND h.member_id = ?3))
     )
     WHERE (?4 IS NULL OR (rk, created_at, id) > (?4, ?5, ?6))
     ORDER BY rk, created_at, id
     LIMIT ?7`,
  ).bind(env.TENANT_SLUG, project.id, principal.humanMemberId, cursor?.rank ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit + 1)
    .all<WorktreeRow>()
  const page = rows.results ?? []
  const more = page.length > limit
  const out = more ? page.slice(0, limit) : page
  const last = out.at(-1)
  const next = more && last
    ? encodeCursor(last.kind === 'git_branch' ? 0 : last.kind === 'folder' ? 1 : 2, last.created_at, last.id)
    : null
  return { ok: true, project_id: project.id, worktrees: out, next_cursor: next }
}
