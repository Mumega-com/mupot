// mupot#1937 — per-ATTACHMENT "handled" receipts on the agent inbox.
//
// An attached chat (W2) is peek-only on the agent inbox so it is never the agent's host. This module is the ONE write an
// attached chat gets: "I handled message X". It records (attachment_id, message_id, handled_at) in
// agent_attachment_handled and NOTHING else: no read_at, no lease columns, no delivery_attempts, no dead letter, no
// fence, no presence, no fleet heartbeat. The host's cursor and queue cannot be moved from here.
//
// WHAT MAY BE MARKED. Exactly the rows the attachment's OWN peek can see (readAgentInboxForReader, bearer reader):
// to_agent = the attachment's agent, still unread (read_at IS NULL), in the attachment's seat partition
// (target_seat IS NULL OR target_seat = the attachment token's label), and the agent's consumer fence in bearer_only.
// Anything else (another agent's mail, another seat's mail, an already-consumed row, an unknown id) is reported as
// `not_visible`, one indistinguishable answer, so the tool is not an existence oracle for ids.
//
// VISIBILITY. The attachment's own peek HIDES what it has marked handled (and `remaining` excludes it). Other
// attachments and the host still see the message: handled is per attachment, never global.

import { attachDesignatedClause } from './attach-designated'
import type { Env } from '../types'

export const MAX_MARK_HANDLED_IDS = 50

export interface MarkHandledResult {
  handled: string[]
  not_visible: string[]
}

export type MarkHandledFailure = { ok: false; error: 'invalid_ids' | 'db_error' }

/** Pure arg check: 1..MAX distinct non-empty strings (<=128 chars). Returns the deduped list or null. */
export function normalizeHandledIds(ids: unknown): string[] | null {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MARK_HANDLED_IDS) return null
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string') return null
    const t = id.trim()
    if (t.length === 0 || t.length > 128) return null
    if (!out.includes(t)) out.push(t)
  }
  return out
}

export async function markMessagesHandledByAttachment(
  env: Env,
  p: { attachmentId: string; agentId: string; seat: string | null; ids: string[] },
  nowIso: string = new Date().toISOString(),
): Promise<({ ok: true } & MarkHandledResult) | MarkHandledFailure> {
  const ids = normalizeHandledIds(p.ids)
  if (!ids) return { ok: false, error: 'invalid_ids' }
  const tenant = env.TENANT_SLUG
  // ?1 tenant ?2 attachment ?3 agent ?4 now ?5 seat (nullable) ; ids from ?6
  const idPlaceholders = ids.map((_, i) => `?${i + 6}`).join(', ')
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_attachment_handled (attachment_id, tenant, message_id, handled_at)
       SELECT ?2, ?1, m.id, ?4 FROM agent_messages m
        WHERE m.tenant = ?1 AND m.to_agent = ?3 AND m.read_at IS NULL
          AND m.id IN (${idPlaceholders})
          AND (m.target_seat IS NULL OR (?5 IS NOT NULL AND m.target_seat = ?5))
          AND COALESCE((SELECT mode FROM agent_inbox_fences WHERE tenant = ?1 AND agent_id = ?3), 'bearer_only') = 'bearer_only'
          AND EXISTS (SELECT 1 FROM agent_seat_attachments a
                       WHERE a.id = ?2 AND a.tenant = ?1 AND a.agent_id = ?3 AND a.detached_at IS NULL
                         AND EXISTS (SELECT 1 FROM agents ag WHERE ag.id = a.agent_id ${attachDesignatedClause(env, 'ag', 'a.human_member_id')}))`,
    ).bind(tenant, p.attachmentId, p.agentId, nowIso, p.seat, ...ids).run()
    const rows = await env.DB.prepare(
      `SELECT message_id FROM agent_attachment_handled
        WHERE attachment_id = ?1 AND tenant = ?2 AND message_id IN (${ids.map((_, i) => `?${i + 3}`).join(', ')})`,
    ).bind(p.attachmentId, tenant, ...ids).all<{ message_id: string }>()
    const have = new Set((rows.results ?? []).map((r) => r.message_id))
    return { ok: true, handled: ids.filter((i) => have.has(i)), not_visible: ids.filter((i) => !have.has(i)) }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}
