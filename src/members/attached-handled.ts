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
import { continuityScopeAuthoritySql, resolveAttachmentContinuity, type ContinuityRequest } from './attachment-continuity'
import { LIVE_ATTACHMENT_FROM_SQL, liveAttachmentConditionsSql, seatTokenLiveSql, type LivePh } from './attach-live-sql'
import { attachmentPhysicalVisibleSql, continuityGroupVisibleSql } from './attachment-inbox'
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
  p: { attachmentId: string; agentId: string; seat: string | null; ids: string[]; continuity?: ContinuityRequest },
  nowIso: string = new Date().toISOString(),
): Promise<({ ok: true } & MarkHandledResult) | MarkHandledFailure> {
  const ids = normalizeHandledIds(p.ids)
  if (!ids) return { ok: false, error: 'invalid_ids' }
  const tenant = env.TENANT_SLUG
  // A known but no-longer-live continuity scope is a refusal, never a legacy
  // fallback.  The scoped branch below repeats this check in both its INSERT
  // and its result readback, so a revoke between this lookup and either SQL
  // statement cannot reveal or write a receipt.
  if (p.continuity) {
    if (p.continuity.attachmentId !== p.attachmentId || p.continuity.agentId !== p.agentId)
      return { ok: true, handled: [], not_visible: ids }
    const continuity = await resolveAttachmentContinuity(env, p.continuity)
    if (continuity.kind === 'refused') return { ok: true, handled: [], not_visible: ids }
    if (continuity.kind === 'scope')
      return markScopedMessagesHandled(env, p, ids, continuity.scope.id)
  }
  // ?1 tenant ?2 attachment ?3 agent ?4 now ?5 seat (nullable) ; ids from ?6
  const idPlaceholders = ids.map((_, i) => `?${i + 6}`).join(', ')
  // Production attached callers always carry continuity context.  Even when
  // that context resolves to legacy, a non-null logical target never falls
  // into the historic per-attachment receipt table.
  const unscopedOnly = p.continuity ? 'AND m.target_continuity_scope_id IS NULL' : ''
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_attachment_handled (attachment_id, tenant, message_id, handled_at)
       SELECT ?2, ?1, m.id, ?4 FROM agent_messages m
        WHERE m.tenant = ?1 AND m.to_agent = ?3 AND m.read_at IS NULL
          AND m.id IN (${idPlaceholders})
          ${unscopedOnly}
          AND (m.target_seat IS NULL OR (?5 IS NOT NULL AND m.target_seat = ?5))
          AND COALESCE((SELECT mode FROM agent_inbox_fences WHERE tenant = ?1 AND agent_id = ?3), 'bearer_only') = 'bearer_only'
          AND EXISTS (SELECT 1 FROM agent_seat_attachments a
                       WHERE a.id = ?2 AND a.tenant = ?1 AND a.agent_id = ?3 AND a.detached_at IS NULL
                         AND EXISTS (SELECT 1 FROM agents ag WHERE ag.id = a.agent_id ${attachDesignatedClause(env, 'ag', 'a.human_member_id')}))`,
    ).bind(tenant, p.attachmentId, p.agentId, nowIso, p.seat, ...ids).run()
    const rows = await env.DB.prepare(
      `SELECT h.message_id FROM agent_attachment_handled h
        JOIN agent_messages m ON m.id = h.message_id AND m.tenant = h.tenant
        WHERE h.attachment_id = ?1 AND h.tenant = ?2 AND h.message_id IN (${ids.map((_, i) => `?${i + 3}`).join(', ')})
          ${p.continuity ? 'AND m.target_continuity_scope_id IS NULL' : ''}`,
    ).bind(p.attachmentId, tenant, ...ids).all<{ message_id: string }>()
    const have = new Set((rows.results ?? []).map((r) => r.message_id))
    return { ok: true, handled: ids.filter((i) => have.has(i)), not_visible: ids.filter((i) => !have.has(i)) }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}

/** The scoped form is deliberately separate from legacy per-attachment rows.
 * The placeholders are stable so the exact same live attachment/scope proof
 * is used by INSERT and readback. */
async function markScopedMessagesHandled(
  env: Env,
  p: { attachmentId: string; agentId: string; seat: string | null; continuity?: ContinuityRequest },
  ids: string[],
  scopeId: string,
): Promise<({ ok: true } & MarkHandledResult) | MarkHandledFailure> {
  const c = p.continuity!
  // ?1 tenant ?2 attachment ?3 agent ?4 seat ?5 grant ?6 human ?7 scope; ids from ?8.
  // Authority time is SQLite's own `datetime('now')`, evaluated in every write/read statement.
  const ph: LivePh = (key) => ({ tenant: '?1', seat: '?4', grantToken: '?5', human: '?6', now: "'now'" })[key]
  const idsSql = ids.map((_, i) => `?${i + 8}`).join(', ')
  const liveScope = continuityScopeAuthoritySql(env, ph, 'cs')
  const liveFrom = `${LIVE_ATTACHMENT_FROM_SQL} JOIN member_tokens t ON ${seatTokenLiveSql(ph)} JOIN attachment_continuity_scopes cs ON cs.id = ?7`
  const groupVisible = continuityGroupVisibleSql('m', 'cs')
  const binds = [env.TENANT_SLUG, p.attachmentId, p.agentId, c.seatId, c.sourceGrantTokenId, c.humanMemberId, scopeId, ...ids]
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_continuity_handled (scope_id, message_id, tenant, handled_at, source_attachment_id)
       SELECT cs.id, m.id, ?1, datetime('now'), ?2
         FROM agent_messages m JOIN ${liveFrom}
        WHERE att.id = ?2 AND att.agent_id = ?3 AND m.tenant = ?1 AND m.to_agent = ?3 AND m.read_at IS NULL
          AND m.id IN (${idsSql}) AND ${groupVisible}
          AND COALESCE((SELECT mode FROM agent_inbox_fences WHERE tenant = ?1 AND agent_id = ?3), 'bearer_only') = 'bearer_only'
          AND ${liveScope}`,
    ).bind(...binds).run()
    // A scope does not turn physical mail into a group resource.  The same
    // caller may handle its own physical target in this request, but it stays
    // attachment-local and excludes every logical target.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO agent_attachment_handled (attachment_id, tenant, message_id, handled_at)
       SELECT ?2, ?1, m.id, datetime('now')
         FROM agent_messages m JOIN ${LIVE_ATTACHMENT_FROM_SQL} JOIN member_tokens t ON ${seatTokenLiveSql(ph)}
        WHERE att.id = ?2 AND att.agent_id = ?3 AND m.tenant = ?1 AND m.to_agent = ?3 AND m.read_at IS NULL
          AND m.id IN (${idsSql}) AND ${attachmentPhysicalVisibleSql('m', 't.label')}
          AND COALESCE((SELECT mode FROM agent_inbox_fences WHERE tenant = ?1 AND agent_id = ?3), 'bearer_only') = 'bearer_only'
          AND ${liveAttachmentConditionsSql(env, ph)}`,
    ).bind(...binds).run()
    // Source attachment is provenance only.  This joins the CURRENT caller's
    // physical attachment, so another live chat in the same scope can read a
    // group receipt even after the original chat detached.
    const rows = await env.DB.prepare(
      `SELECT h.message_id FROM agent_continuity_handled h
         JOIN agent_messages m ON m.id = h.message_id AND m.tenant = h.tenant
         JOIN ${liveFrom}
        WHERE h.scope_id = cs.id AND h.tenant = ?1 AND att.id = ?2 AND att.agent_id = ?3
          AND m.id IN (${idsSql}) AND ${groupVisible}
          AND m.to_agent = ?3 AND m.read_at IS NULL
          AND COALESCE((SELECT mode FROM agent_inbox_fences WHERE tenant = ?1 AND agent_id = ?3), 'bearer_only') = 'bearer_only'
          AND ${liveScope}`,
    ).bind(...binds).all<{ message_id: string }>()
    const physical = await env.DB.prepare(
      `SELECT h.message_id FROM agent_attachment_handled h JOIN agent_messages m ON m.id = h.message_id AND m.tenant = h.tenant
         JOIN ${LIVE_ATTACHMENT_FROM_SQL} JOIN member_tokens t ON ${seatTokenLiveSql(ph)}
        WHERE h.attachment_id = ?2 AND h.tenant = ?1 AND att.id = ?2 AND att.agent_id = ?3
          AND m.id IN (${idsSql}) AND ${attachmentPhysicalVisibleSql('m', 't.label')} AND m.to_agent = ?3 AND m.read_at IS NULL
          AND COALESCE((SELECT mode FROM agent_inbox_fences WHERE tenant = ?1 AND agent_id = ?3), 'bearer_only') = 'bearer_only'
          AND ${liveAttachmentConditionsSql(env, ph)}`,
    ).bind(...binds).all<{ message_id: string }>()
    const have = new Set([...(rows.results ?? []), ...(physical.results ?? [])].map((r) => r.message_id))
    return { ok: true, handled: ids.filter((id) => have.has(id)), not_visible: ids.filter((id) => !have.has(id)) }
  } catch {
    return { ok: false, error: 'db_error' }
  }
}
