// mupot — task <-> board item links (migration 0258 board_item_links) and per-binding meta readers.
// Provider-agnostic: nothing here names a provider.

import type { Env } from '../../types'
import type { BoardItemRef } from './port'

export interface ItemLink {
  task_id: string
  project_id: string
  provider: string
  item: BoardItemRef
}

export async function recordItemLink(
  env: Env,
  input: { taskId: string; projectId: string; provider: string; nativeId: string; ref: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO board_item_links (tenant, task_id, project_id, provider, item_native_id, item_ref, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(env.TENANT_SLUG, input.taskId, input.projectId, input.provider, input.nativeId, input.ref, new Date().toISOString())
    .run()
}

interface LinkRow {
  task_id: string
  project_id: string
  provider: string
  item_native_id: string
  item_ref: string
}

function toLink(row: LinkRow): ItemLink {
  return { task_id: row.task_id, project_id: row.project_id, provider: row.provider, item: { native_id: row.item_native_id, ref: row.item_ref } }
}

export async function linkForTask(env: Env, taskId: string): Promise<ItemLink | null> {
  const row = await env.DB.prepare(
    `SELECT task_id, project_id, provider, item_native_id, item_ref FROM board_item_links WHERE tenant = ?1 AND task_id = ?2`,
  )
    .bind(env.TENANT_SLUG, taskId)
    .first<LinkRow>()
  return row ? toLink(row) : null
}

export async function linkForItem(env: Env, provider: string, nativeId: string): Promise<ItemLink | null> {
  const row = await env.DB.prepare(
    `SELECT task_id, project_id, provider, item_native_id, item_ref FROM board_item_links
      WHERE tenant = ?1 AND provider = ?2 AND item_native_id = ?3`,
  )
    .bind(env.TENANT_SLUG, provider, nativeId)
    .first<LinkRow>()
  return row ? toLink(row) : null
}

/** Per-binding write-back opt-in. Strictly `true`: a string "true" or 1 does not enable writes. */
export function writebackEnabledFromMeta(metaJson: string): boolean {
  try {
    return (JSON.parse(metaJson) as { writeback?: unknown }).writeback === true
  } catch {
    return false
  }
}
