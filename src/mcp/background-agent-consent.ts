import type { Env } from '../types'

/** An additional consent condition, never a substitute for the existing squad-admin floor. */
export function backgroundAgentHumanClause(agent: string, human: string): string {
  return `(${agent}.owner_member_id = ${human} OR ${agent}.attach_designated_member_id = ${human})`
}

export async function backgroundAgentIdsForHuman(env: Env, memberId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT a.id FROM agents a
       JOIN members h ON h.id = ?1 AND h.tenant = ?2 AND h.status = 'active'
      WHERE ${backgroundAgentHumanClause('a', '?1')}`,
  ).bind(memberId, env.TENANT_SLUG).all<{ id: string }>()
  return new Set((rows.results ?? []).map((r) => r.id))
}

/** Hints and pending requests suggest a choice; the ordinary consent POST still validates it live. */
export async function defaultBackgroundAgent(
  env: Env,
  memberId: string,
  clientId: unknown,
  hint: unknown,
  eligible: readonly { id: string; slug: string }[],
): Promise<string | null> {
  if (typeof hint === 'string' && hint) {
    if (hint.length > 128) return null
    const matches = eligible.filter((a) => a.id === hint || a.slug === hint)
    // A stale or unavailable explicit hint must not silently choose a different agent.
    return matches.length === 1 ? matches[0].id : null
  }
  if (typeof clientId !== 'string' || !clientId) return null
  const rows = await env.DB.prepare(
    `SELECT DISTINCT a.id, h.id AS harness_id
       FROM agent_seat_admissions p
       JOIN agents a ON a.id = p.agent_id AND a.attach_designated_member_id = ?1
       JOIN harnesses h ON h.id = p.harness_id AND h.tenant = ?2 AND h.member_id = ?1
      WHERE p.tenant = ?2 AND p.human_member_id = ?1 AND p.status = 'pending'
        AND julianday(p.expires_at) > julianday('now') AND h.credential_kind = 'oauth'
        AND (h.oauth_client_id = ?3
          OR substr(h.oauth_client_id, 1, length(?3) + 7) = ?3 || '#oauth:')`,
  ).bind(memberId, env.TENANT_SLUG, clientId).all<{ id: string; harness_id: string }>()
  const pending = rows.results ?? []
  // Shared client names cannot distinguish two installs. Leave that choice to the human.
  if (new Set(pending.map((r) => r.harness_id)).size !== 1) return null
  const ids = new Set(pending.filter((r) => eligible.some((a) => a.id === r.id)).map((r) => r.id))
  return ids.size === 1 ? [...ids][0] : null
}
