// mupot — scheduled board sync (maintenance cron heartbeat). Runs the EXISTING per-binding syncIntoProject
// (the same call the dashboard "sync" button makes), so cron import has exactly the manual import's safety
// contract: inbound only, UNASSIGNED tasks, admin-configured squad.
//
// Rate limits (both must pass): a binding is picked only if synced_at is older than BOARD_SYNC_MIN_INTERVAL_MS,
// and a KV marker (TTL = the interval) is written BEFORE the attempt, so a binding whose sync never stamps
// synced_at (e.g. no default squad) is still attempted at most once per interval. At most BOARD_SYNC_PER_TICK
// bindings per run.

import type { Env } from '../types'
import type { ProjectProviderBinding } from './providers/port'
import { getTaskBoardPort, isProjectBoardProvider } from './providers/registry'

export const BOARD_SYNC_MIN_INTERVAL_MS = 15 * 60 * 1000
export const BOARD_SYNC_PER_TICK = 3

interface KvLike {
  get(k: string): Promise<string | null>
  put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void>
}

export async function runBoardSyncTick(env: Env, now: number = Date.now()): Promise<{ attempted: number }> {
  const kv = (env as unknown as { SESSIONS?: KvLike }).SESSIONS
  // Without a rate-limit store the tick does nothing rather than hammer a provider.
  if (!kv) return { attempted: 0 }
  const cutoff = new Date(now - BOARD_SYNC_MIN_INTERVAL_MS).toISOString()
  const rows = await env.DB.prepare(
    `SELECT project_id, provider, external_id, connector_id, meta_json, synced_at, created_at, updated_at
       FROM project_provider_bindings
      WHERE connector_id IS NOT NULL AND (synced_at IS NULL OR synced_at < ?1)
      ORDER BY synced_at ASC
      LIMIT ?2`,
  )
    .bind(cutoff, BOARD_SYNC_PER_TICK * 3)
    .all<ProjectProviderBinding>()

  let attempted = 0
  for (const binding of rows.results ?? []) {
    if (attempted >= BOARD_SYNC_PER_TICK) break
    if (!isProjectBoardProvider(binding.provider)) continue
    const marker = `boardsync:${binding.project_id}:${binding.provider}`
    try {
      if (await kv.get(marker)) continue
      await kv.put(marker, '1', { expirationTtl: Math.ceil(BOARD_SYNC_MIN_INTERVAL_MS / 1000) })
    } catch {
      continue
    }
    attempted++
    try {
      await getTaskBoardPort(env, binding.provider).syncIntoProject(binding, { project_id: binding.project_id, dryRun: false })
    } catch {
      // next interval
    }
  }
  return { attempted }
}
