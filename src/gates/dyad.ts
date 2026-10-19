// mupot — dyad gate default (migrations/0246).
//
// A squad can be a DYAD: an APPROVED, PINNED pair of agents (squads.dyad_agent_a/_b, set by an
// org owner/admin) that each gate the other's work, so a human is not the default code
// reviewer. Same-owner pairs (two of one human's agents on different models) are allowed.
//
// When a pair is pinned, a task_create with NO explicit gate_owner defaults gate_owner to the
// creator's peer:
//
//   creator X (one of the pinned pair) -> gate:<Y.slug>, Y = the OTHER pinned agent
//
// and ONLY when ALL hold, re-checked on every create:
//   - both pinned agents are still active and still agents of this squad (roster drift, a
//     replacement or a third agent never changes who the peer is; a broken pair just yields a hint);
//   - the set of live holders of gate:<Y.slug> is EXACTLY {Y}: no other agent (a puppet in another
//     squad, the creator) and no member holds it, so the "peer gate" cannot be satisfied by anyone
//     else the creator controls;
//   - Y is not the task's assignee (that would be self-review).
// Otherwise gate_owner stays null and the caller gets a next_step hint.
//
// Hard rules, each pinned by a test:
//   - never the creator's own gate; never gate:hadi, a reserved lane or any member gate. Human
//     gates (gate:hadi and member-principal gates) are reserved for money, identity, external and
//     publish work; this default never reaches them and changes nothing about how they work;
//   - an explicit gate_owner from the caller always wins (the caller of this module only asks when
//     none was passed), and existing validation still applies to explicit values.

import type { Env } from '../types'
import { GATE_CAPABILITY_RE, resolveSoleGateOwnerAgent } from './grants'

export interface DyadGateDefault {
  readonly gate_owner: string | null
  /** Present when no default was applied although a dyad pair is pinned. */
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

interface PairRow {
  id: string
  slug: string
  squad_id: string
  status: string
}

const NOT_PAIR_MEMBER =
  'dyad gate defaults only for a task created by one of the two pinned dyad agents. Set gate_owner explicitly.'

/**
 * Resolve the dyad default for a task being created in `squadId` by `creatorAgentId`.
 * Returns null when no pair is pinned (policy off: caller behaviour unchanged).
 * `assigneeAgentId` is the task's agent assignee, if any.
 */
export async function resolveDyadGateDefault(
  env: Env,
  squadId: string,
  creatorAgentId: string | null,
  assigneeAgentId: string | null,
): Promise<DyadGateDefault | null> {
  const squad = await env.DB.prepare('SELECT dyad_agent_a, dyad_agent_b FROM squads WHERE id = ?1')
    .bind(squadId)
    .first<{ dyad_agent_a: string | null; dyad_agent_b: string | null }>()
  if (!squad || squad.dyad_agent_a === null || squad.dyad_agent_b === null) return null
  const { dyad_agent_a: aId, dyad_agent_b: bId } = squad

  if (creatorAgentId === null || (creatorAgentId !== aId && creatorAgentId !== bId)) {
    return { gate_owner: null, next_step: NOT_PAIR_MEMBER }
  }
  const peerId = creatorAgentId === aId ? bId : aId

  const rows = await env.DB.prepare('SELECT id, slug, squad_id, status FROM agents WHERE id IN (?1, ?2)')
    .bind(aId, bId)
    .all<PairRow>()
  const found = rows.results ?? []
  const peer = found.find((r) => r.id === peerId)
  const creator = found.find((r) => r.id === creatorAgentId)
  const intact = (r: PairRow | undefined): r is PairRow => r !== undefined && r.status === 'active' && r.squad_id === squadId
  if (!intact(peer) || !intact(creator)) {
    return {
      gate_owner: null,
      next_step: 'the pinned dyad pair is no longer two active agents of this squad. An org admin re-pins it (update_squad), or set gate_owner explicitly.',
    }
  }
  if (assigneeAgentId !== null && assigneeAgentId === peer.id) {
    return { gate_owner: null, next_step: `the peer (${peer.slug}) is the assignee and cannot gate its own work. Set gate_owner explicitly.` }
  }

  const capability = `gate:${peer.slug}`
  if (!GATE_CAPABILITY_RE.test(capability) || isReservedForHumansOrSubsystems(capability)) {
    return { gate_owner: null, next_step: `the peer's gate (${capability}) is not a usable dyad gate. Set gate_owner explicitly.` }
  }
  const holders = await resolveSoleGateOwnerAgent(env, capability)
  if (holders.status === 'resolved' && holders.principal.type === 'agent' && holders.principal.id === peer.id) {
    return { gate_owner: capability }
  }
  return {
    gate_owner: null,
    next_step:
      holders.status === 'no_live_holder'
        ? `peer ${peer.slug} holds no live ${capability} grant. An org admin grants it (grant_gate_capability), or set gate_owner explicitly.`
        : `${capability} is not held exclusively by peer ${peer.slug} (another agent or a member also holds it), so it is not defaulted. Set gate_owner explicitly.`,
  }
}
