// mupot — bounded re-issue of a pending moment's link (W3.1). The link token is stored only as a hash, so a link a
// client discarded cannot be shown again; the only way to hand the human a working link is to ROTATE the moment's
// token (createMoment's existing rotation, which kills the old link). That is a write an agent-side retry can
// trigger, so it is bounded: at most one rotation per moment per ROTATE_MIN_INTERVAL_MS and ROTATE_MAX_PER_MOMENT
// in total. The bound is a single atomic INSERT into mutation_audit_entries that doubles as the receipt and as the
// counter (so there is no migration and a throttled call writes nothing). Nothing here ever stores a token.
import type { Env } from '../types'

export const ROTATE_MIN_INTERVAL_MS = 60_000
export const ROTATE_MAX_PER_MOMENT = 5
export const ROTATE_OPERATION = 'moment_link_rotate'

export type RotationReservation = 'ok' | 'throttled' | 'capped' | 'error'

/** Reserve one rotation slot for this moment, atomically. 'ok' means the caller MAY rotate now. */
export async function reserveRotation(
  env: Env,
  input: { momentId: string; memberId: string; reason: string },
  nowMs: number = Date.now(),
): Promise<RotationReservation> {
  const id = crypto.randomUUID()
  const nowIso = new Date(nowMs).toISOString()
  const sinceIso = new Date(nowMs - ROTATE_MIN_INTERVAL_MS).toISOString()
  const where = `tenant = ?2 AND operation = ?4 AND target_kind = 'secure_moment' AND target_id = ?5`
  try {
    const r = await env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       SELECT ?1, ?2, 'member', ?3, ?3, 'mcp', 'mcp_url_elicitation', ?4, 'secure_moment', ?5, ?1, ?1, ?6, ?7
        WHERE (SELECT COUNT(*) FROM mutation_audit_entries WHERE ${where} AND recorded_at > ?8) = 0
          AND (SELECT COUNT(*) FROM mutation_audit_entries WHERE ${where}) < ?9
       ON CONFLICT DO NOTHING`,
    ).bind(
      id, env.TENANT_SLUG, input.memberId, ROTATE_OPERATION, input.momentId,
      JSON.stringify({ moment_id: input.momentId, reason: input.reason }), nowIso, sinceIso, ROTATE_MAX_PER_MOMENT,
    ).run()
    if (r.meta.changes === 1) return 'ok'
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE ${where}`)
      .bind(id, env.TENANT_SLUG, input.memberId, ROTATE_OPERATION, input.momentId).first<{ n: number }>()
    return (total?.n ?? 0) >= ROTATE_MAX_PER_MOMENT ? 'capped' : 'throttled'
  } catch {
    return 'error' // fail closed: no receipt, no rotation
  }
}
