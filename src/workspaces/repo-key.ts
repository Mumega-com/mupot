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
  if (id.kind === 'github') return id.repo === null ? null : `github:${id.owner}/${id.repo}`
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
    let decoded: string
    try { decoded = decodeURIComponent(piece) } catch { return null }
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
