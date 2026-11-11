// mupot — web-route visibility for org-chart reads (board aa25736e, P0 2026-11-11).
//
// The MCP directory tools were scoped in #2382 (agentVisibility in src/mcp/provision.ts); the
// WEB routes under /api/org and /api/agents still returned the same rows to any signed-in
// member of the tenant. This module is the web twin of that rule and reuses its primitive:
// canOnSquadAuth, which wraps canOnSquad (src/auth/capability.ts).
//
// The rule: a caller sees a squad (and the agents and memberships inside it) only with
// observer-or-above on THAT squad. Org and department grants and the legacy owner/admin role
// cover every WORK squad by inheritance, so an org admin sees all of them. A kind='home' squad
// is never covered by an inherited plane (planeCoversScope), so an org admin is refused on
// another member's home squad, exactly as squad_member_list, peers and resolveScopedSquad
// refuse them. Only an exact squad grant (the owner of that home) opens it.
//
// Callers answer "not visible" exactly as "not found": same status, same body.

import { canOnSquadAuth } from '../auth/capability'
import type { AuthContext, Env, OrgKind } from '../types'

export interface SquadScopeFields {
  id: string
  department_id: string
  kind: OrgKind
}

/** Per-request squad visibility check, memoised by squad id. */
export function squadVisibility(env: Env, auth: AuthContext): (squad: SquadScopeFields) => Promise<boolean> {
  const bySquad = new Map<string, Promise<boolean>>()
  return (squad) => {
    let verdict = bySquad.get(squad.id)
    if (!verdict) {
      verdict = canOnSquadAuth(env, auth, squad, 'observer')
      bySquad.set(squad.id, verdict)
    }
    return verdict
  }
}
