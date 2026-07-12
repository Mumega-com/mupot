// mupot — bus component. The async nervous system of the pot.
//
// createBus(env): BusPort — producers call emit() to publish a BusEvent onto
//   the CF Queue (env.BUS). The Queue consumer (./consumer) routes it.
// busApp — HTTP surface: POST /emit (admin+, RBAC-gated) to publish an event,
//   GET /health for liveness.
//
// Every event is tenant-stamped from the request's AuthContext on the API path,
// so a caller cannot publish across tenant boundaries via this surface.

import { Hono } from 'hono'
import type { Env, AuthContext, BusEvent, BusEventType, BusPort } from '../types'

// The set of event types we accept on the wire. Mirrors BusEventType in types.ts.
const EVENT_TYPES: readonly BusEventType[] = [
  'lead.new',
  'task.created',
  'task.updated',
  'task.completed',
  'task.review',
  'task.blocked',
  'task.verdict',
  'flight.landed',
  'agent.wake',
  'fleet.control.requested',
  'brain.directive.updated',
  'squad.dispatch',
  'org.provisioned',
]

function isBusEventType(v: unknown): v is BusEventType {
  return typeof v === 'string' && (EVENT_TYPES as readonly string[]).includes(v)
}

/**
 * createBus — the CF-profile BusPort. emit() stamps event.ts if the caller did
 * not provide one and forwards the event to the Queue. The Queue handles
 * durability, batching, retries and the DLQ (see wrangler.toml).
 */
export function createBus(env: Env): BusPort {
  return {
    async emit(event: BusEvent): Promise<void> {
      const stamped: BusEvent = {
        ...event,
        ts: event.ts && event.ts.length > 0 ? event.ts : new Date().toISOString(),
      }
      await env.BUS.send(stamped)
    },
  }
}

// requireAuth is owned by the auth component; it sets c.get('auth').
import { requireAuth } from '../auth'
// requireCapability is the fine-grained RBAC gate (capability.ts). Publishing to
// the bus is an org-wide effect → admin on org scope. A pure web-login owner/admin
// satisfies the org-scope check via the legacy-role escape inside requireCapability.
import { requireCapability } from '../auth/capability'

// The org scope — bus emit is an org-wide capability.
const orgScope = (): { type: 'org'; id: null } => ({ type: 'org', id: null })

// Shape we accept from clients. tenant/ts are NOT trusted from the body —
// tenant is forced to the caller's scope; ts is stamped by createBus.
interface EmitBody {
  type?: unknown
  squad_id?: unknown
  agent_id?: unknown
  payload?: unknown
}

export const busApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

busApp.get('/health', (c) => c.json({ ok: true, component: 'bus', tenant: c.env.TENANT_SLUG }))

busApp.post('/emit', requireAuth, requireCapability(orgScope, 'admin'), async (c) => {
  const auth = c.get('auth')

  let body: EmitBody
  try {
    body = (await c.req.json()) as EmitBody
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (!isBusEventType(body.type)) {
    return c.json({ error: 'invalid_type', allowed: EVENT_TYPES }, 400)
  }

  const squad_id = typeof body.squad_id === 'string' ? body.squad_id : undefined
  const agent_id = typeof body.agent_id === 'string' ? body.agent_id : undefined

  // Tenant is bound to the authenticated scope — never taken from the body.
  const event: BusEvent = {
    type: body.type,
    tenant: auth.tenant,
    squad_id,
    agent_id,
    payload: body.payload ?? {},
    ts: new Date().toISOString(),
  }

  const bus = createBus(c.env)
  await bus.emit(event)

  return c.json({ ok: true, emitted: { type: event.type, tenant: event.tenant }, ts: event.ts })
})
