// mupot — which live project(s) of this pot own a repository, from D1. Shared by the main Worker (intake: who gets the
// notice) and the ProjectOffice Worker (the office re-asks D1 whether it still owns what it holds), so both read
// ownership through ONE module. No Env, no KV: a D1 handle in, owners out.
//
// STRICTLY READ-ONLY. Nothing in this file writes to D1, and the office Worker imports it: the office never writes D1
// (tests/office-repo-owner.test.ts pins that). Canonicalizing stored rows is the job of repo-key-heal.ts (a bounded
// maintenance-cron heal) and scripts/backfill-repo-key.mjs (the one-time backfill), never of a request path.
//
// Ownership has two sources: the project's own `repo_url` and the `project_repos` allow-list. Archived projects own
// nothing. Both are looked up by CANONICAL KEY (repoKeyFromUrl), never by a substring of the URL: a substring filter that
// runs before canonicalization misses spellings it did not think of (percent-encoding, scp form) and a LIMIT on it can
// cut the real owner off behind unrelated rows (#2137 item 3).
//
// projects.repo_key (migration 0253) is the stored canonical key. A row whose repo_url is set but whose key was never
// written is PENDING. A pending row still COUNTS here: its URL is canonicalized in JS at read time, so a row nobody has
// healed yet can neither hide an owner nor be skipped.
//
// CONSISTENCY. Every answer is built from reads issued as ONE `db.batch`, which D1 runs as a single implicit
// transaction, i.e. one snapshot. Separate round trips could straddle a concurrent heal (a pending row healed between the
// key read and the pending read is in neither result) and report "no owner" for a real owner. Callers must still never
// DESTROY on a single answer: the office purges only after two sweeps a TTL apart agree (office-core.ts).

import { repoKeyFromUrl } from '../workspaces/repo-key'

/** Most pending rows one lookup will read. Beyond it the answer is `unavailable` (fail closed), not a truncated list. */
export const PENDING_SCAN_CAP = 1000

/** Value stored in projects.repo_key for a repo_url that has no network identity (so it is never re-scanned). */
export const NO_REPO_IDENTITY = ''

/**
 * The value every writer of projects.repo_url stores in projects.repo_key beside it: the canonical key, '' when the URL
 * has no network identity, NULL when there is no URL at all. A writer that skips this is caught by the migration's
 * trigger (a changed repo_url with an untouched key goes back to PENDING) and healed by repo-key-heal.ts.
 */
export function storedRepoKey(repoUrl: string | null | undefined): string | null {
  if (repoUrl === null || repoUrl === undefined) return null
  return repoKeyFromUrl(repoUrl) ?? NO_REPO_IDENTITY
}

export type RepoOwners = { ok: true; owners: string[] } | { ok: false; reason: 'unavailable' }
export type OwnedRepos = { ok: true; keys: Set<string> } | { ok: false; reason: 'unavailable' }

interface IdRow {
  id: string
}
interface PendingRow {
  id: string
  repo_url: string
}
interface OwnRow {
  repo_key: string | null
  repo_url: string | null
}
interface KeyRow {
  repo_key: string
}

const LIVE = `p.archived_at IS NULL AND p.status != 'archived'`

/**
 * The live projects of this pot that own `repoKey`, deduplicated and sorted. One batch of three reads (stored key,
 * allow-list, pending rows). Never throws: a D1 error, or more pending rows than PENDING_SCAN_CAP, is `unavailable`.
 */
export async function projectsOwningRepo(db: D1Database, repoKey: string): Promise<RepoOwners> {
  try {
    const [byKey, byList, pending] = await db.batch([
      db.prepare(`SELECT p.id AS id FROM projects p WHERE p.repo_key = ?1 AND ${LIVE}`).bind(repoKey),
      db
        .prepare(
          `SELECT p.id AS id FROM project_repos r JOIN projects p ON p.id = r.project_id
            WHERE r.repo_key = ?1 AND ${LIVE}`,
        )
        .bind(repoKey),
      db
        .prepare(
          `SELECT p.id AS id, p.repo_url AS repo_url FROM projects p
            WHERE p.repo_url IS NOT NULL AND p.repo_key IS NULL AND ${LIVE}
            ORDER BY p.id LIMIT ${PENDING_SCAN_CAP + 1}`,
        )
        .bind(),
    ])
    const pendingRows = (pending?.results ?? []) as PendingRow[]
    if (pendingRows.length > PENDING_SCAN_CAP) return { ok: false, reason: 'unavailable' }
    const owners = new Set<string>()
    for (const row of (byKey?.results ?? []) as IdRow[]) owners.add(row.id)
    for (const row of (byList?.results ?? []) as IdRow[]) owners.add(row.id)
    for (const row of pendingRows) if (repoKeyFromUrl(row.repo_url) === repoKey) owners.add(row.id)
    return { ok: true, owners: [...owners].sort() }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/**
 * Every repository key ONE project owns, from D1: its own repo_url (stored key, or canonicalized here while pending) and
 * its `project_repos` rows. An archived or unknown project owns nothing. One batch of two reads, constant in the number
 * of repositories an office holds, so the office asks once per sweep rather than once per scope. Never throws.
 */
export async function reposOwnedByProject(db: D1Database, projectId: string): Promise<OwnedRepos> {
  try {
    const [own, listed] = await db.batch([
      db
        .prepare(`SELECT p.repo_key AS repo_key, p.repo_url AS repo_url FROM projects p WHERE p.id = ?1 AND ${LIVE}`)
        .bind(projectId),
      db.prepare(`SELECT r.repo_key AS repo_key FROM project_repos r WHERE r.project_id = ?1`).bind(projectId),
    ])
    const row = ((own?.results ?? []) as OwnRow[])[0]
    const keys = new Set<string>()
    if (!row) return { ok: true, keys } // archived or unknown: owns nothing, whatever the allow-list says
    if (row.repo_key !== null && row.repo_key !== NO_REPO_IDENTITY) keys.add(row.repo_key)
    else if (row.repo_key === null && row.repo_url !== null) {
      const k = repoKeyFromUrl(row.repo_url) // pending: canonicalize at read time, write nothing
      if (k !== null) keys.add(k)
    }
    for (const r of (listed?.results ?? []) as KeyRow[]) keys.add(r.repo_key)
    return { ok: true, keys }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
