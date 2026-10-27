// src/gates/own-lane.ts — "is this gate lane the creator's OWN?" (floor task.create.gate-owner-own-lane).
//
// A task creator who is also the assignee may, below under_attack, name a gate lane that someone ELSE holds. It
// may never name a lane it holds itself: that is the self-close shape no-self-review exists to stop. "Holds" here
// means an active gate grant for the creator's agent or member, or a lane that is named after the creator's agent
// (gate:<agent id or slug>). Org owner/admin implicit authority is deliberately NOT counted: the question is whose
// LANE it is, and counting every admin as holding every lane would make the relaxation unreachable for them.

import type { AuthContext, Env } from '../types'
import { hasActiveGateGrant } from './grants'

export async function creatorHoldsLane(env: Env, auth: AuthContext, lane: string): Promise<boolean> {
  if (auth.boundAgentId) {
    if (await hasActiveGateGrant(env, lane, 'agent', auth.boundAgentId)) return true
    const row = await env.DB.prepare('SELECT slug FROM agents WHERE id = ?1 LIMIT 1').bind(auth.boundAgentId).first<{ slug: string | null }>()
    const name = lane.startsWith('gate:') ? lane.slice('gate:'.length) : lane
    if (name === auth.boundAgentId || (row?.slug && name === row.slug)) return true
  }
  if (auth.memberId && (await hasActiveGateGrant(env, lane, 'member', auth.memberId))) return true
  return false
}
