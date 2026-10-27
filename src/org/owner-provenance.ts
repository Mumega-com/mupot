import type { Env } from '../types'

/** Shared audit selector, also used in the designation CAS to fence a replacement assignment of the same owner. */
export const LAST_OWNER_CHANGE_SQL = `SELECT id FROM agent_audit
  WHERE agent_id = agents.id AND json_valid(before_state) AND json_valid(after_state)
    AND json_extract(before_state, '$.owner_member_id') IS NOT json_extract(after_state, '$.owner_member_id')
  ORDER BY rowid DESC LIMIT 1`

export async function independentlyAssignedOwner(env: Env, agentId: string, memberId: string): Promise<{ id: string } | null> {
  return env.DB.prepare(`SELECT audit.id FROM agents
    JOIN agent_audit audit ON audit.id = (${LAST_OWNER_CHANGE_SQL})
    WHERE agents.id = ?1 AND agents.owner_member_id = ?2
      AND audit.actor_type = 'user' AND audit.actor_id != ?2
      AND json_extract(audit.after_state, '$.owner_member_id') = ?2
      AND json_extract(audit.after_state, '$._owner_assignment_org_admin') = 1`)
    .bind(agentId, memberId).first<{ id: string }>()
}
