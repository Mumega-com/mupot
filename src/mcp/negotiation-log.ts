// src/mcp/negotiation-log.ts — record what protocolVersion each client requests on initialize / server/discover and what we
// negotiated, so a connector that "stopped seeing events" can be explained (mupot observability). Observability only: nothing here
// changes a response, and a fault never fails the request.
//
// Never stored or logged: any token, header value, or param other than the bounded version string and a bounded client label.
import type { Env } from '../types'

export const NEGOTIATION_RATE_WINDOW_MS = 60_000
export const NEGOTIATION_RETENTION_MS = 7 * 24 * 60 * 60_000
export const NEGOTIATION_TENANT_ROW_CEILING = 5_000
/** One principal inside the retention window: a caller cycling version strings cannot crowd out the others. */
export const NEGOTIATION_PRINCIPAL_ROW_CAP = 200
export const REQUESTED_VERSION_MAX = 64
export const CLIENT_NAME_MAX = 64

/** Bounded, printable-ASCII-only copy of a client-supplied string (verbatim otherwise). */
export function boundText(s: string, max: number): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, max)
}

/** The version a client asked for: a string is kept verbatim (bounded); absent / non-string become a marker. */
export function describeRequestedVersion(v: unknown): string {
  if (v === undefined || v === null) return '<absent>'
  if (typeof v !== 'string') return `<${typeof v}>`
  return boundText(v, REQUESTED_VERSION_MAX)
}

export interface NegotiationRecord {
  method: 'initialize' | 'server/discover'
  requested: string
  negotiated: string
  eventsReturned: boolean
  /** Resolved principal; absent for an unauthenticated caller (console line only). */
  principal?: { harnessId?: string | null; memberId?: string | null } | null
  /** clientInfo.name from the request, used only when the harness row has no label. */
  clientInfoName?: unknown
}

export async function recordNegotiation(env: Env, nowMs: number, r: NegotiationRecord): Promise<void> {
  const harnessId = r.principal?.harnessId ?? null
  const memberId = r.principal?.memberId ?? null
  // Unauthenticated free text is never stored or logged (same rule as requestedProtocolVersionForLog's callers): clientInfo.name only counts for a resolved principal.
  const infoName = (harnessId || memberId) && typeof r.clientInfoName === 'string' ? boundText(r.clientInfoName, CLIENT_NAME_MAX) : null
  let clientName = infoName
  try {
    if (harnessId) {
      const h = await env.DB.prepare(`SELECT client_name FROM harnesses WHERE tenant = ?1 AND id = ?2`).bind(env.TENANT_SLUG, harnessId).first<{ client_name: string }>()
      if (h?.client_name) clientName = boundText(h.client_name, CLIENT_NAME_MAX)
    }
  } catch {
    // label lookup is best effort
  }
  console.info('[mcp:negotiation]', {
    method: r.method, harness_id: harnessId, client_name: clientName, requested: r.requested, negotiated: r.negotiated, events_returned: r.eventsReturned,
  })
  // No principal => nothing to rate-limit against: log only, never an unbounded anonymous write.
  if (!harnessId && !memberId) return
  try {
    const now = new Date(nowMs).toISOString()
    const windowStart = new Date(nowMs - NEGOTIATION_RATE_WINDOW_MS).toISOString()
    const retentionStart = new Date(nowMs - NEGOTIATION_RETENTION_MS).toISOString()
    const ins = await env.DB.prepare(
      `INSERT INTO mcp_negotiation_log (id, tenant, at, method, harness_id, member_id, client_name, requested_version, negotiated_version, events_returned)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
        WHERE NOT EXISTS (SELECT 1 FROM mcp_negotiation_log
                           WHERE tenant = ?2 AND COALESCE(harness_id, '') = COALESCE(?5, '') AND COALESCE(member_id, '') = COALESCE(?6, '')
                             AND method = ?4 AND requested_version = ?8 AND at > ?11)
          AND (SELECT COUNT(*) FROM mcp_negotiation_log
                WHERE tenant = ?2 AND COALESCE(harness_id, '') = COALESCE(?5, '') AND COALESCE(member_id, '') = COALESCE(?6, '')
                  AND at > ?12) < ?13`,
    ).bind(crypto.randomUUID(), env.TENANT_SLUG, now, r.method, harnessId, memberId, clientName, r.requested, r.negotiated, r.eventsReturned ? 1 : 0,
      windowStart, retentionStart, NEGOTIATION_PRINCIPAL_ROW_CAP).run()
    if ((ins.meta?.changes ?? 0) === 0) return
    await env.DB.prepare(`DELETE FROM mcp_negotiation_log WHERE tenant = ?1 AND at <= ?2`).bind(env.TENANT_SLUG, retentionStart).run()
    await env.DB.prepare(
      `DELETE FROM mcp_negotiation_log WHERE rowid IN (
         SELECT rowid FROM mcp_negotiation_log WHERE tenant = ?1 ORDER BY at DESC, rowid DESC LIMIT -1 OFFSET ?2)`,
    ).bind(env.TENANT_SLUG, NEGOTIATION_TENANT_ROW_CEILING).run()
  } catch (e) {
    console.error('[mcp:negotiation] record failed', e instanceof Error ? e.message : String(e))
  }
}
