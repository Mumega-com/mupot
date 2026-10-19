import type { AuthContext } from '../types'
import type { GatePrincipalType } from './grants'
import { attachedAuthority } from '../auth/attached-ceiling'

export interface GatePrincipal {
  id: string
  type: GatePrincipalType
}

export function resolveGatePrincipal(auth: AuthContext): GatePrincipal | null {
  // W2: an attached seat is neither the agent nor its member for gate / surface purposes (gate authority is a separate, opt-in path: verdictPrincipal + attachedGateAgent).
  if (attachedAuthority(auth)) return null
  if (auth.boundAgentId) return { id: auth.boundAgentId, type: 'agent' }
  if (auth.memberId) return { id: auth.memberId, type: 'member' }
  if (auth.userId) return { id: auth.userId, type: 'agent' }
  return null
}
