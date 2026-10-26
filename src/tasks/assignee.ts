import { canOnSquadAuth, hasCapability, loadSquadScope, resolveCapabilities } from '../auth/capability'
import { resolveActiveAgentMember } from '../members/service'
import { actorOf, relaxes } from '../policy/bar'
import type { Agent, AuthContext, Env } from '../types'

/**
 * Security Bar context for an assignment (rules task.assign.*). Pass it from a caller that has an authenticated
 * principal; without it the resolver is exactly today's strict behaviour (system callers: dispatch, concierge,
 * runtime receipts). FLOORS the bar cannot move, enforced below regardless of level: the id must exist
 * (invalid_assignee), an agent outside the task's squad must be one the CALLER can see (member on its home
 * squad), and an agent with no minted/unambiguous member identity is never assignable. Tenant is structural:
 * one pot = one DB, ids resolve only inside it.
 */
export interface AssignBar {
  auth: AuthContext
  /** 'task:<id>' or 'squad:<id>' - ids only. */
  scopeRef: string
}

export interface AssigneeResult {
  value: string | null
  error?: 'invalid_assignee' | 'assignee_not_in_squad'
}

/** Resolve whether an agent is currently assignable on a task's squad. */
export async function resolveTaskAssignee(
  env: Env,
  raw: unknown,
  squadId: string,
  bar?: AssignBar,
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
  // FLOOR (task.assign.agent-not-visible): through the bar, an agent homed on ANOTHER squad is assignable only if the
  // caller can see that squad. Checked before any relaxation below so no level can widen it.
  const visibleToCaller = async (): Promise<boolean> =>
    !bar || agent.squad_id === squadId || (await canOnSquadAuth(env, bar.auth, agent.squad_id, 'member'))
  if (agent.status !== 'active') {
    // task.create.assignee-agent-resolvable.inactive: onboarding lets work wait for a paused agent.
    if (!bar || !(await visibleToCaller())) return { value: null, error: 'assignee_not_in_squad' }
    if (!(await relaxes(env, 'task.create.assignee-agent-resolvable.inactive', { actor: actorOf(bar.auth), scopeRef: bar.scopeRef, detail: 'agent inactive' }))) {
      return { value: null, error: 'assignee_not_in_squad' }
    }
  }
  if (agent.squad_id === squadId) return { value: agent.id }

  const memberId = await resolveActiveAgentMember(env, agent.id)
  if (memberId === 'unminted' || memberId === 'ambiguous') {
    return { value: null, error: 'assignee_not_in_squad' }
  }

  const scope = await loadSquadScope(env, squadId)
  if (!scope) return { value: null, error: 'assignee_not_in_squad' }

  const grants = await resolveCapabilities(env, memberId)
  if (hasCapability(grants, 'squad', scope, 'member')) return { value: agent.id }
  // task.create.assignee-agent-resolvable.cross-squad: relaxed below under_attack, and only for an agent the caller can see (floor above).
  if (bar && (await visibleToCaller())
    && (await relaxes(env, 'task.create.assignee-agent-resolvable.cross-squad', { actor: actorOf(bar.auth), scopeRef: bar.scopeRef, detail: 'cross-squad agent' }))) {
    return { value: agent.id }
  }
  return { value: null, error: 'assignee_not_in_squad' }
}

/**
 * Resolve whether a MEMBER (a human) is currently assignable on a task's squad —
 * migrations/0150, squad-core task 676ae5db.
 *
 * The bar is deliberately IDENTICAL to the agent side: active, and holding at
 * least `member` on the task's squad with department inheritance resolved the
 * same way. A human is not privileged here just for being a human. Two things
 * follow from keeping the bars equal that are worth stating, because the obvious
 * shortcut breaks both:
 *
 *   - Assignment stays a statement about who may act on this squad, not about
 *     which identity table the assignee happens to live in. A reader deciding
 *     "may this owner do this work" asks one question, not two different ones.
 *   - It cannot become a side channel for visibility. Naming someone the owner of
 *     a task on a squad they cannot see would put work on a board they cannot
 *     open — which is precisely the invisibility this column exists to end.
 *
 * The agent-side resolver has one extra hop this one does not need: it maps
 * agent -> member before it can ask about grants, because grants are a MEMBER
 * concept and an agent may be unminted or ambiguous. Here we already hold the
 * member id, so that hop and its two failure modes simply do not exist.
 */
export async function resolveTaskAssigneeMember(
  env: Env,
  raw: unknown,
  squadId: string,
  bar?: AssignBar,
): Promise<AssigneeResult> {
  if (raw === undefined || raw === null) return { value: null }
  if (typeof raw !== 'string' || raw.length === 0) {
    return { value: null, error: 'invalid_assignee' }
  }

  const member = await env.DB.prepare(
    'SELECT id, status FROM members WHERE id = ?1 LIMIT 1',
  )
    .bind(raw)
    .first<{ id: string; status: string }>()

  // A member id that does not exist and a member id that is suspended are
  // deliberately DIFFERENT answers, matching the agent side: `invalid_assignee`
  // says the id is wrong, `assignee_not_in_squad` says the id is right but the
  // principal may not hold this work. Collapsing them would make a typo and a
  // revoked colleague indistinguishable to whoever is trying to hand off.
  if (!member) return { value: null, error: 'invalid_assignee' }
  if (member.status !== 'active') return { value: null, error: 'assignee_not_in_squad' }

  const scope = await loadSquadScope(env, squadId)
  if (!scope) return { value: null, error: 'assignee_not_in_squad' }

  const grants = await resolveCapabilities(env, member.id)
  if (hasCapability(grants, 'squad', scope, 'member')) return { value: member.id }
  // task.create.assignee-member-resolvable: onboarding lets an active tenant member be named before their grant exists.
  if (bar && (await relaxes(env, 'task.create.assignee-member-resolvable', { actor: actorOf(bar.auth), scopeRef: bar.scopeRef, detail: 'member no squad grant' }))) {
    return { value: member.id }
  }
  return { value: null, error: 'assignee_not_in_squad' }
}
