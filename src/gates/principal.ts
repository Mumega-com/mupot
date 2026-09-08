import type { AuthContext } from '../types'
import type { GatePrincipalType } from './grants'

export interface GatePrincipal {
  id: string
  type: GatePrincipalType
}

export function resolveGatePrincipal(auth: AuthContext): GatePrincipal | null {
  if (auth.boundAgentId) return { id: auth.boundAgentId, type: 'agent' }
  if (auth.memberId) return { id: auth.memberId, type: 'member' }
  if (auth.userId) return { id: auth.userId, type: 'agent' }
  return null
}
