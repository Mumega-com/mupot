// mupot - who may provide or revoke a credential for an agent: an ACTIVE HUMAN member who is admin on the agent's
// squad or an org admin. Reuses the existing predicates (hasWorkspaceAdmin, canOnSquadAuth); a passkey or a bearer
// proves WHO, never WHAT, so the standing is re-derived from the member's CURRENT grants at decision time.
import type { AuthContext, Env } from '../types'
import { canOnSquadAuth, hasWorkspaceAdmin } from '../auth/capability'

export interface AgentRow { id: string; squad_id: string; slug: string; name: string; status: string }

export async function loadAgent(env: Env, agentId: string): Promise<AgentRow | null> {
  const row = await env.DB.prepare('SELECT id, squad_id, slug, name, status FROM agents WHERE id = ?1 LIMIT 1').bind(agentId).first<AgentRow>()
  return row ?? null
}

export async function mayGovernAgent(env: Env, auth: AuthContext, agent: AgentRow): Promise<boolean> {
  if (hasWorkspaceAdmin(auth)) return true
  return canOnSquadAuth(env, auth, agent.squad_id, 'admin')
}
