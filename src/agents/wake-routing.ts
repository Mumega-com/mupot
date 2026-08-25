import type { Agent, BusEvent, Env } from '../types'
import { createBus } from '../bus'
import { getFleetAgentLiveness } from '../fleet/registry'
import { sendAgentMessage } from './messages'

const WAKE_ROUTER_SENDER = 'mupot-wake-router'
const DO_ORIGIN = 'https://agent'

export interface WakeRouteInput {
  agent: Agent
  byMemberId: string
  reason: string
  context?: string
  maxActions?: number
}

export type WakeRouteResult =
  | { ok: true; route: 'agent_do'; runtime: unknown }
  | {
      ok: true
      route: 'external_inbox' | 'fallback_inbox'
      delivered: true
      seq: number
      duplicate: boolean
    }
  | { ok: false; reason: 'wake_failed' }

type DurableRoute = Extract<WakeRouteResult, { delivered: true }>

async function deliverWakeEnvelope(
  env: Env,
  input: WakeRouteInput,
  target: string,
  route: DurableRoute['route'],
  idempotencyKey: string,
): Promise<WakeRouteResult> {
  const envelope = {
    type: 'agent.wake/v1',
    agent_id: input.agent.id,
    reason: input.reason,
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.maxActions === undefined ? {} : { maxActions: input.maxActions }),
    idempotency_key: idempotencyKey,
  }
  const sent = await sendAgentMessage(env, {
    fromAgent: WAKE_ROUTER_SENDER,
    fromMember: input.byMemberId,
    toAgent: target,
    kind: 'request',
    body: JSON.stringify(envelope),
    requestId: idempotencyKey,
  }, {
    system: true,
    reason: 'wake target is resolved server-side from the canonical agent and fleet registry',
  })
  if (!sent.ok) return { ok: false, reason: 'wake_failed' }
  return {
    ok: true,
    route,
    delivered: true,
    seq: sent.seq,
    duplicate: sent.duplicate,
  }
}

async function emitRoutedObservation(
  env: Env,
  input: WakeRouteInput,
  route: Exclude<WakeRouteResult, { ok: false }>['route'],
): Promise<void> {
  const event: BusEvent<{
    by: string
    reason: string
    route: string
    already_routed: true
  }> = {
    type: 'agent.wake',
    tenant: env.TENANT_SLUG,
    squad_id: input.agent.squad_id,
    agent_id: input.agent.id,
    actor: { kind: 'member', id: input.byMemberId },
    payload: {
      by: input.byMemberId,
      reason: input.reason,
      route,
      already_routed: true,
    },
    ts: new Date().toISOString(),
  }
  try {
    await createBus(env).emit(event)
  } catch {
    // The selected route has already committed. Observation is best-effort and must not
    // turn a successful, idempotent delivery into a second routing attempt by the caller.
  }
}

/** Select and execute exactly one wake route for a server-resolved canonical agent. */
export async function routeAgentWake(env: Env, input: WakeRouteInput): Promise<WakeRouteResult> {
  const idempotencyKey = `wake:${crypto.randomUUID()}`
  const external = await getFleetAgentLiveness(env, input.agent.id)

  if (external.live && external.runtime && external.agentId) {
    const result = await deliverWakeEnvelope(
      env,
      input,
      external.agentId,
      'external_inbox',
      idempotencyKey,
    )
    if (result.ok) await emitRoutedObservation(env, input, result.route)
    return result
  }

  const stub = env.AGENT.get(env.AGENT.idFromName(input.agent.id))
  const response = await stub.fetch(`${DO_ORIGIN}/wake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agent_id: input.agent.id,
      reason: input.reason,
      squad_id: input.agent.squad_id,
      context: input.context,
      maxActions: input.maxActions,
    }),
  })
  if (response.ok) {
    const runtime = await response.json<unknown>().catch(() => null)
    const result = { ok: true, route: 'agent_do', runtime } as const
    await emitRoutedObservation(env, input, result.route)
    return result
  }

  const fallback = await deliverWakeEnvelope(
    env,
    input,
    input.agent.slug || input.agent.id,
    'fallback_inbox',
    idempotencyKey,
  )
  if (fallback.ok) await emitRoutedObservation(env, input, fallback.route)
  return fallback
}
