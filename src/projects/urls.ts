/** Shared URL / worker-name checks for the project worker platform. */

const MAX_URL_LENGTH = 500
const WORKER_NAME_RE = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/

export function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 8 || value.length > MAX_URL_LENGTH) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.length > 0 && !url.username && !url.password
  } catch {
    return false
  }
}

export function isValidWorkerName(value: unknown): value is string {
  return typeof value === 'string' && WORKER_NAME_RE.test(value)
}

export function githubRepoSlug(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null
  try {
    const url = new URL(repoUrl)
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
    const parts = url.pathname.replace(/\.git$/i, '').split('/').filter(Boolean)
    if (parts.length < 2) return null
    return `${parts[0]}/${parts[1]}`
  } catch {
    return null
  }
}

export function studioDispatchPath(repoUrl: string): string {
  return `/studio?repo=${encodeURIComponent(repoUrl)}`
}

export const PROJECT_WORKER_SUBDOMAIN_ROOT = 'mupot.mumega.com'

/** Lowercase hyphenated slug from a display name. Empty when nothing usable remains. */
export function slugFromProjectName(name: unknown): string {
  if (typeof name !== 'string') return ''
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug
}

export function projectWorkerSubdomain(slug: string): string {
  return `https://${slug}.${PROJECT_WORKER_SUBDOMAIN_ROOT}`
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'api.github.com', 'codeload.github.com'])

const MAX_DECODE_PASSES = 3

/**
 * Percent-decode one piece, at most MAX_DECODE_PASSES passes. `ok` is false when a piece has a bad
 * escape (`%zz`, a lone `%`, a truncated multi-byte sequence) or is STILL changing after the last pass,
 * i.e. its spelling cannot be settled; the caller then treats the whole identity as unsure.
 */
function decodePiece(value: string): { value: string; ok: boolean } {
  let out = value
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next: string
    try { next = decodeURIComponent(out) } catch { return { value: out, ok: false } }
    if (next === out) return { value: out, ok: true }
    out = next
  }
  try { return { value: out, ok: decodeURIComponent(out) === out } } catch { return { value: out, ok: false } }
}

function stripGitSuffixes(segment: string): string {
  let s = segment
  for (;;) {
    const next = s.replace(/\.git$/i, '')
    if (next === s) return s
    s = next
  }
}

/**
 * A comparable identity for a repository URL, for POLICY matching (never display). It folds every
 * spelling of one repository to one key: scheme, userinfo, port, host case, trailing-dot host, percent
 * encoding (each path segment decoded separately, at most 3 passes, so `%65xample` and `%2F` fold and a
 * bad escape in one segment cannot undo the folding of another), repeated trailing slashes and `.git`,
 * `ssh://` and scp-style (`git@github.com:o/r.git`), and for GitHub (github.com, www., api., codeload.)
 * anything after owner/repo (`/tree/main`, `/repos/o/r`). When unsure (a segment whose escapes cannot
 * be decoded, or is still changing after 3 passes) it returns a coarser identity that MATCHES, so a
 * policy that refuses on a match errs toward refusing.
 *   { kind: 'github', owner, repo | null }  repo is null when the URL names only an owner
 *   { kind: 'url', key }                    any other host: `host/path`
 *   { kind: 'github-unsure' }               a GitHub host with an undecodable segment: matches any GitHub repo
 *   { kind: 'url-unsure', host }            any other host with one: matches anything on that host
 *   null                                    not parseable at all
 */
export type RepoIdentity =
  | { kind: 'github'; owner: string; repo: string | null }
  | { kind: 'url'; key: string }
  | { kind: 'github-unsure' }
  | { kind: 'url-unsure'; host: string }

export function repoIdentity(repoUrl: string | null | undefined): RepoIdentity | null {
  if (!repoUrl) return null
  let raw = repoUrl.trim()
  const scp = /^[^/@\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(raw) // git@github.com:owner/repo.git
  if (scp) raw = `ssh://${scp[1]}/${scp[2]}`
  let url: URL
  try { url = new URL(raw) } catch { return null }
  const decodedHost = decodePiece(url.hostname)
  let host = decodedHost.value.toLowerCase()
  while (host.endsWith('.')) host = host.slice(0, -1)
  // Per segment: split on the RAW separators first, decode each piece on its own, then re-split what
  // decoding produced (an encoded slash is a separator). A failing piece is kept as-is and flagged.
  let unsure = !decodedHost.ok
  const segments: string[] = []
  for (const piece of url.pathname.replace(/\\/g, '/').split('/')) {
    const d = decodePiece(piece)
    if (!d.ok) unsure = true
    for (const part of d.value.replace(/\\/g, '/').split('/')) {
      if (part !== '' && part !== '.') segments.push(part)
    }
  }
  if (GITHUB_HOSTS.has(host)) {
    if (unsure) return { kind: 'github-unsure' }
    const parts = host === 'api.github.com' && segments[0]?.toLowerCase() === 'repos' ? segments.slice(1) : segments
    const owner = parts[0]?.toLowerCase()
    if (!owner) return null
    const repo = parts[1] === undefined ? null : stripGitSuffixes(parts[1]).toLowerCase()
    return { kind: 'github', owner, repo: repo === '' ? null : repo }
  }
  if (unsure) return { kind: 'url-unsure', host }
  if (segments.length > 0) segments[segments.length - 1] = stripGitSuffixes(segments[segments.length - 1]!)
  return { kind: 'url', key: `${host}/${segments.filter((s) => s !== '').join('/').toLowerCase()}` }
}

/** Do two repository URLs name the same repository (or, when one names only a GitHub owner, the same owner)? */
export function sameRepository(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = repoIdentity(a)
  const y = repoIdentity(b)
  if (!x || !y) return false
  // An identity that could not be settled matches anything it could have been.
  if (x.kind === 'github-unsure') return y.kind === 'github' || y.kind === 'github-unsure'
  if (y.kind === 'github-unsure') return x.kind === 'github'
  if (x.kind === 'url-unsure') return (y.kind === 'url' && y.key.split('/')[0] === x.host) || (y.kind === 'url-unsure' && y.host === x.host)
  if (y.kind === 'url-unsure') return x.kind === 'url' && x.key.split('/')[0] === y.host
  if (x.kind !== y.kind) return false
  if (x.kind === 'url' && y.kind === 'url') return x.key === y.key
  if (x.kind === 'github' && y.kind === 'github') {
    if (x.owner !== y.owner) return false
    return x.repo === null || y.repo === null || x.repo === y.repo
  }
  return false
}
