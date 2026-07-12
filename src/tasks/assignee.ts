import { hasCapability, resolveCapabilities } from '../auth/capability'
import { resolveActiveAgentMember } from '../members/service'
import type { Agent, Env } from '../types'

export interface AssigneeResult {
  value: string | null
  error?: 'invalid_assignee' | 'assignee_not_in_squad'
}

/** Resolve whether an agent is currently assignable on a task's squad. */
export async function resolveTaskAssignee(
  env: Env,
  raw: unknown,
  squadId: string,
): Promise<AssigneeResult> {
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw !== 'string' || raw.length === 0) {
    return { value: null, error: 'invalid_assignee' }
  }

  const agent = await env.DB.prepare(
    'SELECT id, squad_id, status FROM agents WHERE id = ?1 LIMIT 1',
  )
    .bind(raw)
    .first<Pick<Agent, 'id' | 'squad_id' | 'status'>>()

  if (!agent) return { value: null, error: 'invalid_assignee' }
  if (agent.status !== 'active') return { value: null, error: 'assignee_not_in_squad' }
  if (agent.squad_id === squadId) return { value: agent.id }

  const memberId = await resolveActiveAgentMember(env, agent.id)
  if (memberId === 'unminted' || memberId === 'ambiguous') {
    return { value: null, error: 'assignee_not_in_squad' }
  }

  const squad = await env.DB.prepare(
    'SELECT department_id FROM squads WHERE id = ?1 LIMIT 1',
  )
    .bind(squadId)
    .first<{ department_id: string }>()
  if (!squad) return { value: null, error: 'assignee_not_in_squad' }

  const grants = await resolveCapabilities(env, memberId)
  return hasCapability(grants, 'squad', squadId, 'member', squad.department_id)
    ? { value: agent.id }
    : { value: null, error: 'assignee_not_in_squad' }
}
