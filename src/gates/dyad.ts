// mupot — dyad gate default (migrations/0246).
//
// A squad can be a DYAD: exactly two active agents that each gate the other's work, so a
// human is not the default code reviewer. When squads.dyad_gate = 1, a task_create with NO
// explicit gate_owner defaults gate_owner to the creator's peer:
//
//   creator X (a bound agent of the squad) -> gate:<Y.slug>, Y = the squad's other active agent
//
// and ONLY when Y holds a live (agent-principal, active) gate_grants row for exactly that
// capability. Otherwise gate_owner stays null and the caller gets a next_step hint.
//
// Hard rules, each pinned by a test:
//   - never the creator's own gate (and never a gate whose holder is the assignee: that is
//     self-review of the assignee's work);
//   - never gate:hadi, any reserved lane, or a gate any MEMBER principal holds. Human gates
//     (gate:hadi and member-principal gates) are reserved for money, identity, external and
//     publish work; this default never reaches them, and nothing here changes how they work;
//   - an explicit gate_owner from the caller always wins (the caller of this module only asks
//     when none was passed), and existing validation still applies to explicit values.

import type { Env } from '../types'
import { GATE_CAPABILITY_RE, hasActiveGateGrant } from './grants'

export interface DyadGateDefault {
  readonly gate_owner: string | null
  /** Present when no default was applied although dyad_gate is on. */
  readonly next_step?: string
}

/** Lanes with their own completion machinery plus the human gate; never a dyad default. */
function isReservedForHumansOrSubsystems(capability: string): boolean {
  return (
    capability === 'gate:hadi' ||
    capability === 'gate:office' ||
    capability === 'gate:routines' ||
    capability === 'gate:agent-self-completion' ||
    capability.startsWith('gate:self-')
  )
}

interface PeerRow {
  id: string
  slug: string
}

/**
 * Resolve the dyad default for a task being created in `squadId` by `creatorAgentId`.
 * Returns null when the squad is not a dyad squad (policy off: caller behaviour unchanged).
 * `assigneeAgentId` is the task's agent assignee, if any.
 */
export async function resolveDyadGateDefault(
  env: Env,
  squadId: string,
  creatorAgentId: string | null,
  assigneeAgentId: string | null,
): Promise<DyadGateDefault | null> {
  const squad = await env.DB.prepare('SELECT dyad_gate FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ dyad_gate: number }>()
  if (!squad || squad.dyad_gate !== 1) return null

  const agents = await env.DB.prepare(
    `SELECT id, slug FROM agents WHERE squad_id = ?1 AND status = 'active' ORDER BY id ASC`,
  )
    .bind(squadId)
    .all<PeerRow>()
  const active = agents.results ?? []

  if (active.length !== 2) {
    return {
      gate_owner: null,
      next_step: `dyad_gate is on but this squad has ${active.length} active agents; dyad needs exactly two. Set gate_owner explicitly, or fix the squad roster.`,
    }
  }
  if (creatorAgentId === null) {
    return {
      gate_owner: null,
      next_step: 'dyad_gate defaults the gate only for a task created by one of the two dyad agents. Set gate_owner explicitly.',
    }
  }
  const peer = active.find((a) => a.id !== creatorAgentId)
  const creatorIsMember = active.some((a) => a.id === creatorAgentId)
  if (!peer || !creatorIsMember) {
    return {
      gate_owner: null,
      next_step: 'dyad_gate defaults the gate only for a task created by one of the two dyad agents. Set gate_owner explicitly.',
    }
  }
  if (assigneeAgentId !== null && assigneeAgentId === peer.id) {
    return {
      gate_owner: null,
      next_step: `the peer (${peer.slug}) is the assignee and cannot gate its own work. Set gate_owner explicitly.`,
    }
  }

  const capability = `gate:${peer.slug}`
  if (!GATE_CAPABILITY_RE.test(capability) || isReservedForHumansOrSubsystems(capability)) {
    return {
      gate_owner: null,
      next_step: `the peer's gate (${capability}) is not a usable dyad gate. Set gate_owner explicitly.`,
    }
  }
  const peerHolds = await hasActiveGateGrant(env, capability, 'agent', peer.id)
  // A capability a live member principal also holds is a human gate; a dyad default never lands on it.
  const memberHolder = await env.DB.prepare(
    `SELECT 1 AS one FROM gate_grants WHERE capability = ?1 AND principal_type = 'member' LIMIT 1`,
  )
    .bind(capability)
    .first<{ one: number }>()
  if (!peerHolds || memberHolder) {
    return {
      gate_owner: null,
      next_step: peerHolds
        ? `${capability} is also held by a member, so it is a human gate and is not defaulted. Set gate_owner explicitly.`
        : `peer ${peer.slug} holds no live ${capability} grant. An org admin grants it (grant_gate_capability), or set gate_owner explicitly.`,
    }
  }
  return { gate_owner: capability }
}
