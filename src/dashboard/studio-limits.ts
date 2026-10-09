// #1762 (a): atomic per-member / per-repo bound on Studio dispatches that launch a Cursor agent (the only HOLD-capable
// Studio write). One conditional INSERT...SELECT reserves a slot; D1 executes a single statement atomically, so N
// concurrent requests cannot all pass (unlike KV/SELECT-then-INSERT). See migrations/0197_studio_dispatch_slots.sql.
import type { Env } from '../types'

export const DEFAULT_STUDIO_MEMBER_LIMIT = 3
export const DEFAULT_STUDIO_REPO_LIMIT = 1
export const DEFAULT_STUDIO_WINDOW_MINUTES = 90

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback
}

export function studioLimits(env: Env): { member: number; repo: number; windowMs: number } {
  return {
    member: envInt(env.STUDIO_DISPATCH_MEMBER_LIMIT, DEFAULT_STUDIO_MEMBER_LIMIT, 1, 1000),
    repo: envInt(env.STUDIO_DISPATCH_REPO_LIMIT, DEFAULT_STUDIO_REPO_LIMIT, 1, 1000),
    windowMs: envInt(env.STUDIO_DISPATCH_WINDOW_MINUTES, DEFAULT_STUDIO_WINDOW_MINUTES, 1, 24 * 60) * 60_000,
  }
}

/** Canonical repo key so case / trailing slash / .git cannot dodge the per-repo bound. */
export function studioRepoKey(repoUrl: string): string {
  return repoUrl.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '')
}

export type StudioSlot = { id: string }
export type StudioSlotRefusal = 'studio_member_limit' | 'studio_repo_limit'

/**
 * Reserve a slot atomically. Member bound counts every slot in the window; repo bound counts only slots that are
 * 'reserved' (a launch in flight) or 'maybe' (uncertain): those are what plant a HOLD with no known agent. Returns null
 * when over limit; the second query only classifies WHICH limit refused (the decision itself was the atomic INSERT).
 */
export async function reserveStudioSlot(
  env: Env,
  memberKey: string,
  repoUrl: string,
): Promise<{ ok: true; slot: StudioSlot } | { ok: false; error: StudioSlotRefusal }> {
  const { member, repo, windowMs } = studioLimits(env)
  const now = Date.now()
  const since = now - windowMs
  const id = crypto.randomUUID()
  const repoKey = studioRepoKey(repoUrl)
  const res = await env.DB.prepare(
    `INSERT INTO studio_dispatch_slots (id, member_key, repo_key, state, created_at)
     SELECT ?, ?, ?, 'reserved', ?
     WHERE (SELECT COUNT(*) FROM studio_dispatch_slots WHERE member_key = ? AND created_at > ?) < ?
       AND (SELECT COUNT(*) FROM studio_dispatch_slots WHERE repo_key = ? AND state IN ('reserved','maybe') AND created_at > ?) < ?`,
  ).bind(id, memberKey, repoKey, now, memberKey, since, member, repoKey, since, repo).run()
  if ((res.meta?.changes ?? 0) > 0) return { ok: true, slot: { id } }
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM studio_dispatch_slots WHERE member_key = ? AND created_at > ?',
  ).bind(memberKey, since).first<{ n: number }>()
  return { ok: false, error: (row?.n ?? 0) >= member ? 'studio_member_limit' : 'studio_repo_limit' }
}

export async function settleStudioSlot(env: Env, slot: StudioSlot, state: 'launched' | 'maybe' | 'released'): Promise<void> {
  if (state === 'released') {
    await env.DB.prepare('DELETE FROM studio_dispatch_slots WHERE id = ?').bind(slot.id).run()
    return
  }
  await env.DB.prepare('UPDATE studio_dispatch_slots SET state = ? WHERE id = ?').bind(state, slot.id).run()
}
