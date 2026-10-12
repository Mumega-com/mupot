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
/** A rotation through this `via` is a HUMAN asking for the link (Telegram initData proved who). */
export const HUMAN_ROTATION_VIA = 'telegram_initdata'
/** After a human-channel rotation, machine (MCP) rotations of that moment are suppressed this long (a passkey ceremony can take minutes). A moment's own expiry ends it sooner: a rotation needs a live moment anyway. */
export const HUMAN_CEREMONY_WINDOW_MS = 10 * 60_000
/** At most this many of the ROTATE_MAX_PER_MOMENT slots go to one member through a human channel, so a bound human cannot spend the agent's share. */
export const HUMAN_MAX_PER_MEMBER = 2

/** Who is asking for the rotation, as the receipt records it. Default (omitted) is the MCP plain-link fallback (W3.1). */
export interface RotationChannel { origin: 'mcp' | 'admin_ui'; handler: string; via?: string }
const MCP_CHANNEL: RotationChannel = { origin: 'mcp', handler: 'mcp_url_elicitation' }

export type RotationReservation = 'ok' | 'throttled' | 'capped' | 'human_active' | 'member_capped' | 'error'

/** Reserve one rotation slot for this moment, atomically. 'ok' means the caller MAY rotate now. */
export async function reserveRotation(
  env: Env,
  input: { momentId: string; memberId: string; agentId: string | null; reason: string; channel?: RotationChannel },
  nowMs: number = Date.now(),
): Promise<RotationReservation> {
  const id = crypto.randomUUID()
  const channel = input.channel ?? MCP_CHANNEL
  const nowIso = new Date(nowMs).toISOString()
  const sinceIso = new Date(nowMs - ROTATE_MIN_INTERVAL_MS).toISOString()
  const humanSinceIso = new Date(nowMs - HUMAN_CEREMONY_WINDOW_MS).toISOString()
  const isHuman = channel.via === HUMAN_ROTATION_VIA ? 1 : 0
  const where = `tenant = ?2 AND operation = ?4 AND target_kind = 'secure_moment' AND target_id = ?5`
  const humanRows = `${where} AND json_extract(evidence_json, '$.via') = '${HUMAN_ROTATION_VIA}'`
  try {
    const r = await env.DB.prepare(
      `INSERT INTO mutation_audit_entries (
         id, tenant, principal_kind, principal_id, member_id, agent_id, origin, handler, operation,
         target_kind, target_id, request_id, idempotency_key, evidence_json, recorded_at)
       SELECT ?1, ?2, CASE WHEN ?10 IS NULL THEN 'member' ELSE 'agent' END, COALESCE(?10, ?3), ?3, ?10, ?11, ?12, ?4, 'secure_moment', ?5, ?1, ?1, ?6, ?7
        WHERE (SELECT COUNT(*) FROM mutation_audit_entries WHERE ${where} AND recorded_at > ?8) = 0
          AND (SELECT COUNT(*) FROM mutation_audit_entries WHERE ${where}) < ?9
          AND (?14 = 1 OR (SELECT COUNT(*) FROM mutation_audit_entries WHERE ${humanRows} AND recorded_at > ?13) = 0)
          AND (?14 = 0 OR (SELECT COUNT(*) FROM mutation_audit_entries WHERE ${humanRows} AND member_id = ?3) < ${HUMAN_MAX_PER_MEMBER})
       ON CONFLICT DO NOTHING`,
    ).bind(
      id, env.TENANT_SLUG, input.memberId, ROTATE_OPERATION, input.momentId,
      JSON.stringify({ moment_id: input.momentId, reason: input.reason, ...(channel.via ? { via: channel.via } : {}) }), nowIso, sinceIso, ROTATE_MAX_PER_MOMENT, input.agentId,
      channel.origin, channel.handler, humanSinceIso, isHuman,
    ).run()
    if (r.meta.changes === 1) return 'ok'
    if (isHuman === 0) {
      // Which guard refused? The human-ceremony window is reported first: it is the one the caller can do nothing about.
      const h = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE ${humanRows} AND recorded_at > ?6`)
        .bind(id, env.TENANT_SLUG, input.memberId, ROTATE_OPERATION, input.momentId, humanSinceIso).first<{ n: number }>()
      if ((h?.n ?? 0) > 0) return 'human_active'
    } else {
      const m = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE ${humanRows} AND member_id = ?3`)
        .bind(id, env.TENANT_SLUG, input.memberId, ROTATE_OPERATION, input.momentId).first<{ n: number }>()
      if ((m?.n ?? 0) >= HUMAN_MAX_PER_MEMBER) return 'member_capped'
    }
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mutation_audit_entries WHERE ${where}`)
      .bind(id, env.TENANT_SLUG, input.memberId, ROTATE_OPERATION, input.momentId).first<{ n: number }>()
    return (total?.n ?? 0) >= ROTATE_MAX_PER_MOMENT ? 'capped' : 'throttled'
  } catch {
    return 'error' // fail closed: no receipt, no rotation
  }
}
