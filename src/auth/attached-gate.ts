// An ATTACHED agent session may exercise its bound agent's gate capability (task_verdict), opt-in per admission.
// Decision (Hadi, owner, 2026-10-19): reviewing is agent work. Human approval (human_origin, org-admin escapes) is a
// different thing and stays refused for attached sessions.
//
// attachedGateAgent answers ONE question for the verdict path: "may this attached request pass the gate check as its
// bound agent right now?". It never trusts the request context: it re-reads the whole chain per call through
// findLiveAttachment (the same single statement the per-request resolver uses), so all of these hold at use time:
//   - the attachment is live (not detached) and is the one the request claims;
//   - its admission is live (not revoked / expired / denied) and carries gate_authority = 1 (the owner's opt-in);
//   - the bound agent is active (findLiveAttachment) and the attach designation still holds.
// The caller then ALSO requires hasActiveGateGrant(agent, gate_owner): the agent must itself hold the gate. Nothing here
// widens what the agent holds; it only lets the thread act as the agent for this one lane. Independence is enforced by
// evaluateVerdictGates (agent AND attaching human as deciders).

import type { AuthContext, Env } from '../types'
import { findLiveAttachment } from '../members/seat-attach'
import { attachedAuthority } from './attached-ceiling'

export async function attachedGateAgent(env: Env, auth: AuthContext): Promise<{ agentId: string; humanMemberId: string } | null> {
  const att = attachedAuthority(auth)
  const binding = auth.seatBinding
  if (!att || !binding) return null
  // The human's own unbound grant token is re-checked live by findLiveAttachment (grantTokenId).
  const live = await findLiveAttachment(env, { memberId: binding.humanMemberId, tokenId: binding.grantTokenId }, binding.seatId)
  if (!live) return null
  if (live.attachment_id !== att.attachmentId || live.agent_id !== att.agentId) return null
  if (Number(live.gate_authority) !== 1) return null
  // R1: gate power belongs to the ONE chat the human approved it for. A thread reaching this admission through a harness-wide
  // approval (grant continuity) never inherits it, whatever the admission's bit says.
  if (live.requested_seat_id !== live.seat_id) return null
  return { agentId: live.agent_id, humanMemberId: binding.humanMemberId }
}
