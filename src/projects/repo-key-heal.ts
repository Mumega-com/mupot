// mupot — canonicalize projects.repo_key for rows that were never given one (migration 0253 leaves every existing row
// PENDING). The ONLY writer of the key besides the project writers themselves; the request paths never call it:
//   - the main Worker's maintenance cron runs `healProjectRepoKeys` with a small `limit` (a bounded slice per tick);
//   - scripts/backfill-repo-key.mjs is the one-time, operator-run backfill (same canonicalizer, same statement).
// The ProjectOffice Worker never imports this file: the office does not write D1.
//
// Compare-and-set on (repo_url, repo_key IS NULL): a row a writer changed since it was read, or one another healer
// already filled, is left exactly as it is.

import { storedRepoKey } from './office-repo-owner'

/** Rows one maintenance tick heals. Each heartbeat runs about once an hour per slot, so this is a trickle, not a sweep. */
export const REPO_KEY_HEAL_PER_TICK = 50

interface PendingRow {
  id: string
  repo_url: string
}

export interface HealResult {
  scanned: number
  healed: number
  /** True when fewer rows than `limit` were pending: nothing is left to do (for rows this call could read). */
  drained: boolean
}

/** Heal at most `limit` pending rows, lowest id first. Idempotent; safe to run concurrently. Throws on a D1 error. */
export async function healProjectRepoKeys(db: D1Database, opts: { limit: number }): Promise<HealResult> {
  const limit = Math.max(1, Math.floor(opts.limit))
  const page = await db
    .prepare(
      `SELECT id, repo_url FROM projects WHERE repo_url IS NOT NULL AND repo_key IS NULL ORDER BY id LIMIT ?1`,
    )
    .bind(limit)
    .all<PendingRow>()
  const rows = page.results ?? []
  let healed = 0
  for (const row of rows) {
    const res = await db
      .prepare('UPDATE projects SET repo_key = ?1 WHERE id = ?2 AND repo_url = ?3 AND repo_key IS NULL')
      .bind(storedRepoKey(row.repo_url), row.id, row.repo_url)
      .run()
    if ((res.meta?.changes ?? 0) > 0) healed++
  }
  return { scanned: rows.length, healed, drained: rows.length < limit }
}
