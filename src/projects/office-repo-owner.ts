// mupot — which live project(s) of this pot own a repository, from D1. Shared by the main Worker (intake: who gets the
// notice) and the ProjectOffice Worker (the office re-asks D1 whether it still owns what it holds), so both read
// ownership through ONE function. No Env, no KV: a D1 handle in, owners out.
//
// Ownership has two sources: the project's own `repo_url` and the `project_repos` allow-list. Archived projects own
// nothing. Both are looked up by CANONICAL KEY (repoKeyFromUrl), never by a substring of the URL: a substring filter that
// runs before canonicalization misses spellings it did not think of (percent-encoding, scp form) and a LIMIT on it can
// cut the real owner off behind unrelated rows (#2137 item 3).
//
// projects.repo_key (migration 0253) is the stored canonical key. A row whose repo_url is set but whose key was never
// written is PENDING: it is canonicalized here, in JS, and written back, and it counts as an owner while it waits, so
// pending rows can neither hide an owner nor be skipped by a page limit.

import { repoKeyFromUrl } from '../workspaces/repo-key'

const PENDING_PAGE = 200

/** Value stored in projects.repo_key for a repo_url that has no network identity (so it is never re-scanned). */
export const NO_REPO_IDENTITY = ''

/**
 * The value every writer of projects.repo_url stores in projects.repo_key beside it: the canonical key, '' when the URL
 * has no network identity, NULL when there is no URL at all. A writer that skips this is caught by the migration's
 * trigger (a changed repo_url with an untouched key goes back to PENDING) and healed by canonicalizePendingProjectRepos.
 */
export function storedRepoKey(repoUrl: string | null | undefined): string | null {
  if (repoUrl === null || repoUrl === undefined) return null
  return repoKeyFromUrl(repoUrl) ?? NO_REPO_IDENTITY
}

export type RepoOwners = { ok: true; owners: string[] } | { ok: false; reason: 'unavailable' }

interface IdRow {
  id: string
}

interface PendingRow {
  id: string
  repo_url: string
}

const LIVE = `p.archived_at IS NULL AND p.status != 'archived'`

/**
 * Canonicalize projects whose repo_url has no stored key yet. Keyset-paged over the whole pending set (never a LIMIT
 * that stops early). Writes each answer back compare-and-set on repo_url and a still-NULL key, so a concurrent writer's
 * newer value is never overwritten. Returns the pending rows whose canonical key is `repoKey` (all pending rows when
 * `repoKey` is null) so the caller can count them as owners.
 */
export async function canonicalizePendingProjectRepos(
  db: D1Database,
  repoKey: string | null,
): Promise<{ matching: string[]; healed: number }> {
  const matching: string[] = []
  let healed = 0
  let after = ''
  for (;;) {
    const page = await db
      .prepare(
        `SELECT p.id AS id, p.repo_url AS repo_url FROM projects p
          WHERE p.repo_url IS NOT NULL AND p.repo_key IS NULL AND p.id > ?1 AND ${LIVE}
          ORDER BY p.id LIMIT ${PENDING_PAGE}`,
      )
      .bind(after)
      .all<PendingRow>()
    const rows = page.results ?? []
    for (const row of rows) {
      const key = repoKeyFromUrl(row.repo_url)
      if (repoKey !== null && key === repoKey) matching.push(row.id)
      const res = await db
        .prepare('UPDATE projects SET repo_key = ?1 WHERE id = ?2 AND repo_url = ?3 AND repo_key IS NULL')
        .bind(key ?? NO_REPO_IDENTITY, row.id, row.repo_url)
        .run()
      if ((res.meta?.changes ?? 0) > 0) healed++
    }
    if (rows.length < PENDING_PAGE) break
    after = rows[rows.length - 1]?.id ?? ''
    if (after === '') break
  }
  return { matching, healed }
}

/** The live projects of this pot that own `repoKey`, deduplicated. Never throws: a D1 error is `unavailable`. */
export async function projectsOwningRepo(db: D1Database, repoKey: string): Promise<RepoOwners> {
  try {
    const owners = new Set<string>()
    const byKey = await db
      .prepare(`SELECT p.id AS id FROM projects p WHERE p.repo_key = ?1 AND ${LIVE}`)
      .bind(repoKey)
      .all<IdRow>()
    for (const row of byKey.results ?? []) owners.add(row.id)
    const byList = await db
      .prepare(
        `SELECT p.id AS id FROM project_repos r JOIN projects p ON p.id = r.project_id
          WHERE r.repo_key = ?1 AND ${LIVE}`,
      )
      .bind(repoKey)
      .all<IdRow>()
    for (const row of byList.results ?? []) owners.add(row.id)
    for (const id of (await canonicalizePendingProjectRepos(db, repoKey)).matching) owners.add(id)
    return { ok: true, owners: [...owners].sort() }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
