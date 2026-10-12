// Canonical repo key for worktree identity (workspaces W1, design §4.1).
//
// ONE function folds every spelling of a repository URL (https / ssh / scp-style, .git suffix, case,
// trailing slash, api.github.com/repos/...) to one string, by delegating to repoIdentity()
// (src/projects/urls.ts), the same fold deploy-policy and seeds already use. An identity that cannot
// be settled to ONE repository returns null: the caller refuses it, because a key that "matches
// anything it could have been" must never become the stored identity of a record.

import { repoIdentity } from '../projects/urls'

/** `github:<owner>/<repo>` or `url:<host>/<path>`; null when the URL does not settle to one repo. */
export function repoKeyFromUrl(repoUrl: string | null | undefined): string | null {
  const id = repoIdentity(repoUrl)
  if (!id) return null
  if (id.kind === 'github') return id.repo === null ? null : `github:${id.owner}/${id.repo}`
  if (id.kind === 'url') return id.key.includes('/') && !id.key.endsWith('/') ? `url:${id.key}` : null
  return null // github-unsure / url-unsure: not one repository
}
