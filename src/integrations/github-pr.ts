// mupot — own-fleet PR primitives (the sovereign execution backend).
//
// GitHub's Copilot coding agent is ONE way to turn a pot task into a PR (assignIssueToCopilot,
// paid). This module is the OTHER way: the pot's OWN agents do the work and open the PR
// themselves, via the App installation token — no GitHub Copilot, no per-seat cost, runs on
// the models the pot already pays for. The flow a pot agent runs:
//
//   createBranch → putFile (one or more) → openPullRequest
//
// SECURITY SURFACE — external write under the pot's token (App installation token App-first,
// static GITHUB_TOKEN PAT as fallback — same as github-repo-write.ts). Discipline: fail-closed,
// no path traversal, no host/ref injection, no token/detail leaks. All three gate on the
// `repo_file_write` capability (free tier, kill-switchable) — parity with writeAgentDef, so an
// operator can disable own-fleet repo writes independently.

import type { Env } from '../types'
import { resolveOutboundGitHubToken } from './github-app'
import { githubCan } from './github-capabilities'
import { isValidRepo } from './github-repo-write'

const GITHUB_API = 'https://api.github.com'

// ── validation ──────────────────────────────────────────────────────────────────

// Git branch/ref name: safe subset. No '..' (ref-spec traversal), no leading/trailing slash,
// no control/space/git-special chars (~ ^ : ? * [ \). Length-capped.
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/
export function isValidBranch(b: string): boolean {
  if (b.includes('..') || b.startsWith('/') || b.endsWith('/') || b.startsWith('.') || b.endsWith('.lock')) return false
  return BRANCH_RE.test(b)
}

// Repo file path: relative, no leading slash, no '..' segment, safe chars, bounded depth.
const PATH_SEG_RE = /^[A-Za-z0-9._-]+$/
export function isValidRepoPath(p: string): boolean {
  if (!p || p.startsWith('/') || p.length > 512) return false
  const segs = p.split('/')
  if (segs.length > 20) return false
  return segs.every((s) => s.length > 0 && s !== '.' && s !== '..' && PATH_SEG_RE.test(s))
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mupot',
    'Content-Type': 'application/json',
  }
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0)
  return btoa(bin)
}

interface ActionOpts {
  fetchImpl?: typeof fetch
}

export type CreateBranchResult = { ok: true; ref: string } | { ok: false; error: string }
export type PutFileResult = { ok: true; commitUrl: string | null; updated: boolean } | { ok: false; error: string }
export type OpenPrResult = { ok: true; number: number; url: string } | { ok: false; error: string }

// ── createBranch ──────────────────────────────────────────────────────────────────

/**
 * Create `newBranch` off the tip of `fromBranch`. Idempotent-ish: a 422 (ref exists) is
 * surfaced as `branch_exists` so a caller can proceed to put files on it.
 */
export async function createBranch(
  env: Env,
  params: { repo: string; fromBranch: string; newBranch: string },
  opts: ActionOpts = {},
): Promise<CreateBranchResult> {
  const { repo, fromBranch, newBranch } = params
  if (!isValidRepo(repo)) return { ok: false, error: 'invalid_repo' }
  if (!isValidBranch(fromBranch) || !isValidBranch(newBranch)) return { ok: false, error: 'invalid_branch' }
  if (!(await githubCan(env, 'repo_file_write'))) return { ok: false, error: 'capability_disabled' }

  const token = await resolveOutboundGitHubToken(env, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined)
  if (!token) return { ok: false, error: 'no_token' }
  const doFetch = opts.fetchImpl ?? fetch

  // Resolve the base branch tip SHA.
  let sha: string
  try {
    const r = await doFetch(`${GITHUB_API}/repos/${repo}/git/ref/heads/${encodeURIComponent(fromBranch)}`, {
      headers: ghHeaders(token),
    })
    if (!r.ok) return { ok: false, error: `base_ref_failed_${r.status}` }
    const b = (await r.json()) as { object?: { sha?: string } }
    if (!b.object?.sha) return { ok: false, error: 'base_sha_missing' }
    sha = b.object.sha
  } catch {
    return { ok: false, error: 'base_ref_threw' }
  }

  try {
    const r = await doFetch(`${GITHUB_API}/repos/${repo}/git/refs`, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({ ref: `refs/heads/${newBranch}`, sha }),
    })
    if (r.status === 422) return { ok: false, error: 'branch_exists' }
    if (!r.ok) return { ok: false, error: `create_failed_${r.status}` }
    return { ok: true, ref: `refs/heads/${newBranch}` }
  } catch {
    return { ok: false, error: 'create_threw' }
  }
}

// ── putFile ──────────────────────────────────────────────────────────────────────

/**
 * Create/update a file at `path` on `branch`. Update-safe (fetches the existing blob SHA).
 * Generic sibling of writeAgentDef — for the pot agent to write arbitrary source files.
 */
export async function putFile(
  env: Env,
  params: { repo: string; path: string; content: string; branch: string; message: string },
  opts: ActionOpts = {},
): Promise<PutFileResult> {
  const { repo, path, content, branch, message } = params
  if (!isValidRepo(repo)) return { ok: false, error: 'invalid_repo' }
  if (!isValidRepoPath(path)) return { ok: false, error: 'invalid_path' }
  if (!isValidBranch(branch)) return { ok: false, error: 'invalid_branch' }
  if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'empty_content' }
  if (content.length > 1_000_000) return { ok: false, error: 'content_too_large' }
  if (!(await githubCan(env, 'repo_file_write'))) return { ok: false, error: 'capability_disabled' }

  const token = await resolveOutboundGitHubToken(env, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined)
  if (!token) return { ok: false, error: 'no_token' }
  const doFetch = opts.fetchImpl ?? fetch
  const url = `${GITHUB_API}/repos/${repo}/contents/${path}`

  let sha: string | undefined
  try {
    const g = await doFetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders(token) })
    if (g.ok) {
      const b = (await g.json()) as { sha?: string }
      if (typeof b.sha === 'string') sha = b.sha
    } else if (g.status !== 404) {
      return { ok: false, error: `read_failed_${g.status}` }
    }
  } catch {
    return { ok: false, error: 'read_threw' }
  }

  try {
    const r = await doFetch(url, {
      method: 'PUT',
      headers: ghHeaders(token),
      body: JSON.stringify({ message, content: toBase64(content), branch, ...(sha ? { sha } : {}) }),
    })
    if (!r.ok) return { ok: false, error: `write_failed_${r.status}` }
    const b = (await r.json()) as { commit?: { html_url?: string } }
    return { ok: true, commitUrl: b.commit?.html_url ?? null, updated: Boolean(sha) }
  } catch {
    return { ok: false, error: 'write_threw' }
  }
}

// ── openPullRequest ─────────────────────────────────────────────────────────────────

/**
 * Open a PR from `head` into `base`. Title required; body optional. Returns the PR number +
 * url. The pot does NOT merge — a human (or the review gate) approves. Fail-closed.
 */
export async function openPullRequest(
  env: Env,
  params: { repo: string; head: string; base: string; title: string; body?: string },
  opts: ActionOpts = {},
): Promise<OpenPrResult> {
  const { repo, head, base, title, body } = params
  if (!isValidRepo(repo)) return { ok: false, error: 'invalid_repo' }
  if (!isValidBranch(head) || !isValidBranch(base)) return { ok: false, error: 'invalid_branch' }
  if (typeof title !== 'string' || title.trim().length === 0) return { ok: false, error: 'title_required' }
  if (title.length > 256) return { ok: false, error: 'title_too_long' }
  if (!(await githubCan(env, 'repo_file_write'))) return { ok: false, error: 'capability_disabled' }

  const token = await resolveOutboundGitHubToken(env, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : undefined)
  if (!token) return { ok: false, error: 'no_token' }
  const doFetch = opts.fetchImpl ?? fetch

  try {
    const r = await doFetch(`${GITHUB_API}/repos/${repo}/pulls`, {
      method: 'POST',
      headers: ghHeaders(token),
      body: JSON.stringify({ title: title.trim(), head, base, body: typeof body === 'string' ? body.slice(0, 60_000) : '' }),
    })
    if (!r.ok) return { ok: false, error: `open_failed_${r.status}` }
    const b = (await r.json()) as { number?: number; html_url?: string }
    if (typeof b.number !== 'number' || typeof b.html_url !== 'string') return { ok: false, error: 'bad_response' }
    return { ok: true, number: b.number, url: b.html_url }
  } catch {
    return { ok: false, error: 'open_threw' }
  }
}
