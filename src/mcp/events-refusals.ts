// src/mcp/events-refusals.ts — record WHY an events/subscribe was refused, so "client never asked" is distinguishable from
// "refused early". Observability only: nothing here changes who may subscribe or what a refusal returns, and a fault in
// this module can never fail the request (every path swallows its own error after logging it).
//
// Never stored or logged: the callback secret, the callback URL (host only), any token, any param value.
import type { AuthContext, Env } from '../types'

export const REFUSAL_RATE_WINDOW_MS = 60_000
export const REFUSAL_RETENTION_MS = 7 * 24 * 60 * 60_000
export const REFUSAL_TENANT_ROW_CEILING = 5_000

export interface SubscribeRefusal {
  reason: string
  auth?: Pick<AuthContext, 'boundAgentId' | 'memberId' | 'harnessId' | 'seatBinding'> | null
  /** Raw delivery.url from the request; only its hostname is ever kept. */
  rawUrl?: unknown
}

/** Bounded, charset-restricted reason: server constants only, never free text from the client. */
export function sanitizeReason(r: string): string {
  return r.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'unknown'
}

export function callbackHostOnly(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  try {
    return new URL(raw).hostname.toLowerCase().slice(0, 253)
  } catch {
    return null
  }
}

/** The reason for an EventsFailure-shaped refusal: its message, qualified by a server-constant data.reason / data.field. */
export function reasonOfFailure(f: { message: string; data?: unknown }): string {
  const d = typeof f.data === 'object' && f.data !== null ? f.data as Record<string, unknown> : {}
  const sub = typeof d.reason === 'string' ? d.reason : typeof d.field === 'string' ? d.field : null
  return sanitizeReason(sub ? `${f.message}:${sub}` : f.message)
}

export async function recordSubscribeRefusal(env: Env, nowMs: number, r: SubscribeRefusal): Promise<void> {
  const reason = sanitizeReason(r.reason)
  const agentId = r.auth?.boundAgentId ?? null
  const memberId = r.auth?.memberId ?? null
  const harnessId = r.auth?.harnessId ?? null
  const seatId = r.auth?.seatBinding?.seatId ?? null
  const host = callbackHostOnly(r.rawUrl)
  console.info('[mcp:events/subscribe] refused', { reason, agent_id: agentId, member_id: memberId, harness_id: harnessId, seat_id: seatId, host })
  // No principal => nothing to rate-limit against: log only, never an unbounded anonymous write.
  if (!agentId && !memberId) return
  try {
    const now = new Date(nowMs).toISOString()
    const windowStart = new Date(nowMs - REFUSAL_RATE_WINDOW_MS).toISOString()
    // ONE atomic guarded INSERT: skipped when this principal+reason already has a row inside the window, or the tenant is at its ceiling.
    await env.DB.prepare(
      `INSERT INTO event_subscribe_refusals (id, tenant, agent_id, member_id, harness_id, seat_id, reason, host, at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
        WHERE NOT EXISTS (SELECT 1 FROM event_subscribe_refusals
                           WHERE tenant = ?2 AND COALESCE(agent_id, '') = COALESCE(?3, '') AND COALESCE(member_id, '') = COALESCE(?4, '')
                             AND reason = ?7 AND at > ?10)
          AND (SELECT COUNT(*) FROM event_subscribe_refusals WHERE tenant = ?2) < ?11`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, agentId, memberId, harnessId, seatId, reason, host, now, windowStart, REFUSAL_TENANT_ROW_CEILING).run()
    await env.DB.prepare(`DELETE FROM event_subscribe_refusals WHERE tenant = ?1 AND at <= ?2`)
      .bind(env.TENANT_SLUG, new Date(nowMs - REFUSAL_RETENTION_MS).toISOString()).run()
  } catch (e) {
    console.error('[mcp:events/subscribe] refusal record failed', e instanceof Error ? e.message : String(e))
  }
}
