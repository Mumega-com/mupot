// src/agents/execution-release-policy.ts - the ONE release policy for a task's execution hold
// (mupot#1809). Before this, three doors had three bars: execution_release required org-admin or
// squad-admin, MCP task_update released for anyone with `member`, REST PATCH /tasks/:id never
// released (200 with the hold still active). A hold is lifted - and a held task reassigned - only by
// a non-agent-bound HUMAN with admin on the task's squad (or org-admin).

import type { AuthContext, Env } from '../types'
import { canOnSquadAuth, hasWorkspaceAdmin } from '../auth/capability'
import { isTaskHeld } from './execution-brake-sql'

/**
 * The members.id a release is recorded against (released_by_member_id and the audit row FK to members):
 * the MCP/bearer member, else the member a cookie web session is registered to. null = no recordable
 * human identity, which cannot release (an unrecordable release would FK-fail after the reassign landed).
 */
export function releaseActorMemberId(auth: AuthContext): string | null {
  return auth.memberId ?? auth.webSessionMemberId ?? null
}

/** True iff this principal may release an execution hold on a task in `squadId`. */
export async function canReleaseExecutionHold(env: Env, auth: AuthContext, squadId: string): Promise<boolean> {
  if (auth.boundAgentId) return false // an agent never lifts the hold on a loop it may be in
  if (!releaseActorMemberId(auth)) return false
  return hasWorkspaceAdmin(auth) || await canOnSquadAuth(env, auth, squadId, 'admin')
}

export type HeldReassignDecision =
  /** the task is not held (or not being assigned to an agent): nothing to decide */
  | { action: 'proceed' }
  /** held, and the caller may release: reassign, then call releaseExecutionHold */
  | { action: 'release' }
  /** held and the caller is below the bar: refuse (409 task_held) - never leave it assigned-but-stalled */
  | { action: 'refuse' }

/**
 * Decide what an assignment of `task` TO AN AGENT does about an execution hold. Called by MCP
 * task_update and REST PATCH before persisting. The post-persist release is still unconditional for a
 * caller that passes canReleaseExecutionHold (a hold placed after this read is released too).
 */
export async function decideReassignOverHold(
  env: Env, auth: AuthContext, task: { id: string; squad_id: string },
): Promise<HeldReassignDecision> {
  if (!(await isTaskHeld(env, task.id))) return { action: 'proceed' }
  return (await canReleaseExecutionHold(env, auth, task.squad_id)) ? { action: 'release' } : { action: 'refuse' }
}
