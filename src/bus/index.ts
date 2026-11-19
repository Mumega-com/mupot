// mupot — bus component. The async nervous system of the pot.
//
// createBus(env): BusPort — producers call emit() to publish a BusEvent onto
//   the CF Queue (env.BUS). The Queue consumer (./consumer) routes it.
// busApp — HTTP surface: GET /health for liveness.
//
// mupot#2395: POST /emit was removed. It registered requireAuth as undefined in
// the production esbuild bundle (import-cycle hazard against auth), the wake
// contract advertised /bus/emit (not the /api/bus mount), and no caller, doc
// path, or test exercised the mounted HTTP route successfully. In-process
// createBus().emit remains the real publish path.

import { isInternalOnlyEventType } from './internal-events'
import { Hono } from 'hono'
import type { Env, BusEvent, BusPort } from '../types'

/**
 * createBus — the CF-profile BusPort. emit() stamps event.ts if the caller did
 * not provide one and forwards the event to the Queue. The Queue handles
 * durability, batching, retries and the DLQ (see wrangler.toml).
 */
export function createBus(env: Env): BusPort {
  return {
    async emit(event: BusEvent): Promise<void> {
      // mupot#1618: internal-only job types can never be produced through the shared emitter.
      if (isInternalOnlyEventType(event.type)) throw new Error('bus: internal-only event type cannot be emitted')
      const stamped: BusEvent = {
        ...event,
        ts: event.ts && event.ts.length > 0 ? event.ts : new Date().toISOString(),
      }
      if (env.BUS?.send) {
        await env.BUS.send(stamped)
      }
    },
  }
}

export const busApp = new Hono<{ Bindings: Env }>()

busApp.get('/health', (c) => c.json({ ok: true, component: 'bus', tenant: c.env.TENANT_SLUG }))
