// mupot — bus Queue consumer. Owns the queue handler exported as default.queue
// from src/index.ts. Routes each BusEvent to the right Durable Object (agent or
// squad) and acks on success / retries on throw.
//
// Routing:
//   agent.wake     → AgentDO(agent_id).fetch(/wake)
//   squad.dispatch → SquadCoordinatorDO(squad_id).fetch(/dispatch)
//   task.created   → wake the owning squad (if squad_id present), else log
//   lead.new       → wake the owning squad (if squad_id present), else log
//   task.updated   → log (terminal observation; no DO wake by default)
//
// Per-message ack/retry: ack on success, retry() on throw, so a single poison
// message does not block a healthy batch. After max_retries (wrangler.toml) the
// message lands in the DLQ.

import type { MessageBatch, Message } from '@cloudflare/workers-types'
import type { Env, BusEvent } from '../types'
import { postAgentActivity } from '../channels'

// Internal origin for DO fetch routing. DO fetch ignores host; the path carries
// the intent. The agents component routes these paths inside its DO classes.
const DO_ORIGIN = 'https://do.mupot.internal'

async function wakeAgent(env: Env, agentId: string, event: BusEvent): Promise<void> {
  const id = env.AGENT.idFromName(agentId)
  const stub = env.AGENT.get(id)
  const res = await stub.fetch(`${DO_ORIGIN}/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (!res.ok) {
    throw new Error(`AgentDO ${agentId} wake failed: ${res.status}`)
  }
}

async function dispatchSquad(env: Env, squadId: string, event: BusEvent): Promise<void> {
  const id = env.SQUAD.idFromName(squadId)
  const stub = env.SQUAD.get(id)
  const res = await stub.fetch(`${DO_ORIGIN}/dispatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  })
  if (!res.ok) {
    throw new Error(`SquadCoordinatorDO ${squadId} dispatch failed: ${res.status}`)
  }
}

async function claimFlightEvent(env: Env, event: BusEvent): Promise<boolean> {
  const payload = event.payload as { outbox_id?: unknown }
  if (typeof payload?.outbox_id !== 'string' || payload.outbox_id.length === 0) return true
  const result = await env.DB.prepare(
    `UPDATE flight_event_outbox
        SET consumed_at=?3
      WHERE tenant=?1 AND id=?2 AND event_type='flight.landed' AND consumed_at IS NULL`,
  ).bind(event.tenant, payload.outbox_id, new Date().toISOString()).run()
  return result.meta?.changes === 1
}

async function routeEvent(env: Env, event: BusEvent): Promise<boolean> {
  switch (event.type) {
    case 'agent.wake': {
      if (!event.agent_id) {
        // Nothing to wake — drop quietly (ack) rather than retry forever.
        console.error('bus: agent.wake missing agent_id', { tenant: event.tenant })
        return true
      }
      await wakeAgent(env, event.agent_id, event)
      return true
    }
    case 'squad.dispatch': {
      if (!event.squad_id) {
        console.error('bus: squad.dispatch missing squad_id', { tenant: event.tenant })
        return true
      }
      await dispatchSquad(env, event.squad_id, event)
      return true
    }
    case 'task.created':
    case 'lead.new': {
      // Wake the owning squad so it can triage/assign. If no squad is named,
      // this is an org-level signal — log it and ack.
      if (event.squad_id) {
        await dispatchSquad(env, event.squad_id, event)
      } else {
        console.error(`bus: ${event.type} with no squad_id (org-level)`, {
          tenant: event.tenant,
        })
      }
      return true
    }
    case 'task.updated':
    case 'task.completed':
    case 'task.review':   // K1: gated execution success — task awaits verdict; no DO wake
    case 'task.blocked':
    case 'task.verdict':
    case 'fleet.control.requested':
    case 'brain.directive.updated':
    case 'org.provisioned': {
      // Terminal observations, gate decisions, and structural provisioning; no DO
      // wake by default. Log for the activity feed (the agent-actor branch in
      // handleQueue surfaces task.completed/blocked into the squad's bound channel).
      console.log(`bus: ${event.type}`, {
        tenant: event.tenant,
        squad_id: event.squad_id,
      })
      return true
    }
    case 'flight.landed': {
      if (!(await claimFlightEvent(env, event))) return false
      console.log('bus: flight.landed', {
        tenant: event.tenant,
        squad_id: event.squad_id,
      })
      return true
    }
    default: {
      // Exhaustiveness guard. Unknown types are acked (not retried) to avoid
      // poisoning the queue with events we will never understand.
      const _exhaustive: never = event.type
      console.error('bus: unknown event type', { type: _exhaustive, tenant: event.tenant })
      return true
    }
  }
}

/**
 * handleQueue — the CF Queue consumer entrypoint. Mounted as default.queue.
 * Processes each message independently: ack on success, retry on throw.
 */
export async function handleQueue(batch: MessageBatch<BusEvent>, env: Env): Promise<void> {
  for (const message of batch.messages as Message<BusEvent>[]) {
    try {
      const routed = await routeEvent(env, message.body)
      // Best-effort live activity feed: surface agent actions into the squad's
      // bound channel. A feed-post failure must NOT retry the message (the work
      // already routed) — it is observability, not the action itself.
      if (routed && message.body.actor?.kind === 'agent') {
        try {
          await postAgentActivity(env, message.body)
        } catch (e) {
          console.error('bus: activity-feed post failed (non-fatal)', {
            id: message.id,
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
      message.ack()
    } catch (err) {
      console.error('bus: message failed, will retry', {
        id: message.id,
        attempts: message.attempts,
        error: err instanceof Error ? err.message : String(err),
      })
      message.retry()
    }
  }
}
