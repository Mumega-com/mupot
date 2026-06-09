// mupot — the Loop gate wiring (P3, #34): the production `queueGatedAct` seam.
//
// When a gated loop proposes an act, the runtime structurally routes it HERE (never to
// a channel). This turns the proposed act into work a human must approve:
//   1. a GATED task (gate_owner set) → lands in /approvals, visible to the operator.
//   2. if the act targets a CRM channel kind (send_email/add_contact/move_stage), a
//      PENDING outbound_act linked to that task — which can only ever fire through
//      runApprovedActs() AFTER an approved verdict (#8). Nothing sends here.
//
// So a gated loop's autonomy ends at the gate: it can propose and queue, never send.

import type { Env } from '../types'
import type { LoopManifest } from './manifest'
import type { ProposedAct } from './runtime'
import { createTask } from '../tasks/service'
import { createOutboundAct } from '../integrations/ghl'

// Act tools that map to a customer-side outbound act (the GHL act-channel kinds).
const GHL_ACT_KINDS = new Set(['send_email', 'add_contact', 'move_stage'])
// The gate capability a loop-queued task requires. This is a `gate:*` string (the
// gate_grants namespace the verdict endpoint + approvals queue check), NOT a
// membership capability — owner/admin verdict it directly; a delegated reviewer needs
// a gate_grants row for 'gate:loops'.
const LOOP_GATE_OWNER = 'gate:loops'

export interface WireGateDeps {
  createTask?: typeof createTask
  createOutboundAct?: typeof createOutboundAct
  resolveSquadId?: (env: Env, loop: LoopManifest) => Promise<string | null>
}

/**
 * wireGatedAct — persist a proposed act as a pending, human-gated unit of work.
 * Always creates the gated task; additionally queues a pending outbound_act when the
 * tool is a CRM kind. Throws if the owning squad can't be resolved (no silent drop).
 */
export async function wireGatedAct(
  env: Env,
  loop: LoopManifest,
  act: ProposedAct,
  deps: WireGateDeps = {},
): Promise<void> {
  const resolveSquadId = deps.resolveSquadId ?? defaultResolveSquadId
  const doCreateTask = deps.createTask ?? createTask
  const doCreateOutboundAct = deps.createOutboundAct ?? createOutboundAct

  const squadId = await resolveSquadId(env, loop)
  if (!squadId) throw new Error('loop_squad_unresolved')

  // status:'review' is REQUIRED — the verdict endpoint (409 not_in_review) and the
  // /approvals queue both act ONLY on review tasks. A loop-queued act is a finished
  // proposal awaiting human approval (not work awaiting execution), so it enters at
  // 'review' directly. Without this the task strands at 'open', invisible + un-verdictable.
  const task = await doCreateTask(
    env,
    {
      squad_id: squadId,
      title: (act.summary || `loop act: ${act.tool}`).slice(0, 200),
      body: JSON.stringify({ loop_id: loop.id, tool: act.tool, args: act.args }),
      status: 'review',
      gate_owner: LOOP_GATE_OWNER,
    },
    { actor: { kind: 'agent', id: loop.agent_id ?? loop.id } },
  )

  if (GHL_ACT_KINDS.has(act.tool)) {
    await doCreateOutboundAct(env, task.id, act.tool, act.args)
  }
}

/** Resolve the squad that owns the loop: its squad_id, or the owning agent's squad. */
async function defaultResolveSquadId(env: Env, loop: LoopManifest): Promise<string | null> {
  if (loop.squad_id) return loop.squad_id
  if (!loop.agent_id) return null
  const row = await env.DB.prepare('SELECT squad_id FROM agents WHERE id = ? LIMIT 1')
    .bind(loop.agent_id)
    .first<{ squad_id: string }>()
  return row?.squad_id ?? null
}
