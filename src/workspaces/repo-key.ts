// Canonical repo key for worktree identity (workspaces W1, design §4.1).
//
// ONE function folds every spelling of a repository URL (https / ssh / scp-style, .git suffix, trailing
// slash, api.github.com/repos/...) to one string. GitHub is classified by repoIdentity()
// (src/projects/urls.ts, the same fold deploy-policy and seeds use), which lowercases owner and repo
// because GitHub names are case-insensitive. Every OTHER host keeps its path CASE: Gitea, GitLab
// self-hosted and plain git servers are case-sensitive, so `Team/Repo` and `team/repo` are different
// repositories and must not collide into one workspace.
//
// Only a network repository has an identity. file:// URLs, absolute / relative / home / Windows paths
// and anything without a host return null (a machine path is never identity), as does an identity that
// cannot be settled to ONE repository (a "matches anything it could have been" key must never become the
// stored identity of a record).

import { repoIdentity } from '../projects/urls'

const GIT_SUFFIX_RE = /(\.git)+$/i

/** `github:<owner>/<repo>` or `url:<host>/<path>`; null when the URL does not settle to one network repo. */
export function repoKeyFromUrl(repoUrl: string | null | undefined): string | null {
  if (typeof repoUrl !== 'string') return null
  const raw = repoUrl.trim()
  if (raw === '' || raw.length > 2048) return null
  // Local paths and file URLs: refused before anything parses them.
  if (/^file:/i.test(raw) || /^[/\\.~]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) return null

  const id = repoIdentity(raw)
  if (!id) return null
  if (id.kind === 'github') {
    // A GitHub hostname on a non-default port is not GitHub's endpoint: refuse it rather than fold it into the
    // github:owner/repo identity of the real repository (review thread, 2026-10-13).
    // Read the port the way the URL parser does (it normalises backslashes, missing slashes and whitespace),
    // and accept only the default port OF THAT SCHEME: https 443, http 80, ssh/git+ssh 22. An scp-style
    // `git@github.com:owner/repo` has no port. Anything else is a different endpoint: refused.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/@\s]+@[^:/\s]+:(?!\/\/)/.test(raw)) {
      let parsed: URL
      try { parsed = new URL(raw) } catch { return null }
      const scheme = parsed.protocol.toLowerCase()
      const defaults: Record<string, string> = { 'https:': '443', 'http:': '80', 'ssh:': '22', 'git+ssh:': '22' }
      if (parsed.port !== '' && defaults[scheme] !== String(Number(parsed.port))) return null
    }
    return id.repo === null ? null : `github:${id.owner}/${id.repo}`
  }
  if (id.kind !== 'url') return null // github-unsure / url-unsure: not one repository

  // Non-GitHub: re-derive host + path from the raw URL, preserving path case.
  let text = raw
  const scp = /^[^/@\s]+@([^:/\s]+):(?!\/\/)(.+)$/.exec(text) // git@host:owner/repo.git
  if (scp) text = `ssh://${scp[1]}/${scp[2]}`
  let url: URL
  try { url = new URL(text) } catch { return null }
  if (url.protocol === 'file:') return null
  let host = url.hostname.toLowerCase()
  while (host.endsWith('.')) host = host.slice(0, -1)
  if (host === '') return null
  const segments: string[] = []
  for (const piece of url.pathname.replace(/\\/g, '/').split('/')) {
    // Settle percent-encoding fully (bounded), so `%2541` and `A` spell the same segment.
    let decoded = piece
    for (let i = 0; i < 4; i++) {
      let next: string
      try { next = decodeURIComponent(decoded) } catch { return null }
      if (next === decoded) break
      decoded = next
      if (i === 3) return null // still changing: refuse rather than guess
    }
    for (const part of decoded.replace(/\\/g, '/').split('/')) {
      if (part !== '' && part !== '.') segments.push(part)
    }
  }
  if (segments.length === 0) return null
  segments[segments.length - 1] = segments[segments.length - 1]!.replace(GIT_SUFFIX_RE, '')
  if (segments.some((s) => s === '' || s === '..')) return null
  // A non-default port is part of the identity: two services on one hostname are two repositories.
  const port = url.port && !(url.protocol === 'https:' && url.port === '443') && !(url.protocol === 'http:' && url.port === '80') && !(url.protocol === 'ssh:' && url.port === '22') ? `:${url.port}` : ''
  return `url:${host}${port}/${segments.join('/')}`
}
