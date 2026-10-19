// W2 (SEAT_ATTACH) — the ONE place that answers "is this caller an ATTACHED seat, and what is its ceiling?".
//
// THE DEFECT CLASS THIS CLOSES. An attached thread runs under the identity of an existing agent (boundAgentId, the agent's
// welded member). Any authority path that is KEYED ON THAT AGENT'S IDENTITY (its gate grants, its surface grants, the
// operator delegations somebody else gave it, the agents.owner_member_id lookup behind human_origin, the
// gate:agent-self-completion assignee shortcut) would hand the thread everything the agent is, instead of what the
// attaching human's admission allows. The rule for every such path is:
//
//     authority(attached seat) = min(human's live standing, the agent's own grant, the admission CEILING)   per scope
//     and NEVER: surface caps, another human's delegations, an owner-keyed act, human approval (human_origin).
//     GATES are off by default and open ONLY on the owner's per-admission opt-in (agent_seat_admissions.gate_authority = 1,
//     migration 0247, defaulted to 1 when the agent already holds a `gate:*` grant at the human's decision): then, and only
//     while the attachment + admission + agent are live (src/auth/attached-gate.ts re-reads the chain on every call), the
//     thread may pass the task_verdict gate check AS ITS BOUND AGENT, and only for a gate_owner the agent holds a live
//     gate_grants row for. Verdict independence is unchanged and judged for BOTH the agent and the attaching human.
//
// Capabilities are clamped at the source (resolveSeatCapabilities in seat-handle.ts takes the ceiling from here). Every
// identity-keyed path consults THIS module:
//   - src/gates/principal.ts            resolveGatePrincipal   -> null (no surface / approvals-queue principal)
//   - src/tasks/index.ts                callerHoldsGateCapability / holdsTaskGateLane (opt-in via attachedGateAgent; never the
//                                       self-completion assignee shortcut), verdictPrincipal (the agent), evaluateVerdictGates (human independence)
//   - src/auth/capability.ts            hasSurfaceCap
//   - src/operators/chokepoint.ts       authorizeStructuralWrite (only the attaching human's delegations, max_grant clamped)
//   - src/mcp/index.ts                  the delegation floor bypass; task_verdict human_origin (refused for ANY seat session)
// Elevation grants are bound to the exact agent session (the attachment's own token), so they never carry across threads.
//   - "sudo for attached chats": the ONE exception to "an attached thread cannot elevate" is ATTACHED_SUDO_ACTIONS below;
//     see docs/architecture/delegated-operators.md ("sudo for attached chats").

import type { AuthContext, Capability } from '../types'

export const ATTACH_CEILINGS = ['member', 'lead', 'full'] as const
export type AttachCeiling = (typeof ATTACH_CEILINGS)[number]

export function isAttachCeiling(v: unknown): v is AttachCeiling {
  return typeof v === 'string' && (ATTACH_CEILINGS as readonly string[]).includes(v)
}

/** The capability a ceiling caps at; `full` is "the agent's own standing" (still capped by the human), so no cap here. */
export function ceilingCapability(c: AttachCeiling): Capability | null {
  return c === 'member' ? 'member' : c === 'lead' ? 'lead' : null
}

export interface AttachedAuthority {
  attachmentId: string
  humanMemberId: string
  agentId: string
  ceiling: AttachCeiling
}

/** Non-null exactly when the SERVER bound this request to a thread attached to an existing agent. */
export function attachedAuthority(auth: Pick<AuthContext, 'seatBinding'>): AttachedAuthority | null {
  const b = auth.seatBinding
  if (!b?.attached) return null
  return { attachmentId: b.attached.attachmentId, humanMemberId: b.humanMemberId, agentId: b.attached.agentId, ceiling: b.attached.ceiling }
}

/**
 * mupot#2006 — the attribution an attached thread's writes carry (agent_messages / task_result_submissions /
 * flight_event_outbox). Derived from the server-resolved auth ONLY, never from tool args; null for any non-attached caller.
 */
export interface AttachmentAttribution {
  attachmentId: string
  consentingMemberId: string
}

export function attachmentAttribution(auth: Pick<AuthContext, 'seatBinding'>): AttachmentAttribution | null {
  const a = attachedAuthority(auth)
  return a ? { attachmentId: a.attachmentId, consentingMemberId: a.humanMemberId } : null
}

/**
 * "sudo" for an ATTACHED chat: the ONLY elevation actions an attached thread may request (request_elevation) and use.
 * Everything else stays refused (attached_seat_cannot_elevate): minting, access, deploy, secrets, keys, irreversible
 * acts (org_department_create, routine_archive), home access and every gate power. Adding a key here is a reviewed
 * one-line change: it must be (a) enforced by a tool that is safe for an attached thread to call with a live grant,
 * (b) reversible, and (c) never an act that mints or widens authority. The set is consulted at THREE points (the request,
 * the decision, every use in hasElevatedAction), so a row forged past one of them is still refused by the others.
 */
export const ATTACHED_SUDO_ACTIONS: readonly string[] = ['action:org_structure']

export function isAttachedSudoAction(action: string): boolean {
  return ATTACHED_SUDO_ACTIONS.includes(action)
}
