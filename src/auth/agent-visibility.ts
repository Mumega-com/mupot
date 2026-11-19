import type { AuthContext, Env } from '../types'
import { canOnSquad, isOrgAdmin } from './capability'

// Directory visibility (board a90ff195, P0 2026-11-10). The directory used to read the
// whole `agents` table for any caller holding observer on ANY scope, which a stranger's
// OAuth home squad satisfies. The rule now:
//   - an org admin (isOrgAdmin) sees every agent, as before;
//   - everyone else sees an agent only if they hold observer-or-above on THAT agent's
//     squad through canOnSquad, the same primitive squad_member_list and peers use, so a
//     home squad grant unlocks only that home squad (planeCoversScope), and observer
//     means what it means for those reads: it may read the squad roster;
//   - a bound agent always sees itself.
// Callers answer "not visible" exactly as "not found".
export function agentVisibility(env: Env, auth: AuthContext): (agent: { id: string; squad_id: string }) => Promise<boolean> {
  if (isOrgAdmin(auth)) return async () => true
  const grants = auth.capabilities ?? []
  const bySquad = new Map<string, Promise<boolean>>()
  return async (agent) => {
    if (auth.boundAgentId && agent.id === auth.boundAgentId) return true
    let verdict = bySquad.get(agent.squad_id)
    if (!verdict) {
      verdict = canOnSquad(env, grants, agent.squad_id, 'observer')
      bySquad.set(agent.squad_id, verdict)
    }
    return verdict
  }
}
