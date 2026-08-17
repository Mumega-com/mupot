import { Hono } from 'hono'
import type { Env, BusEvent, BusEventType } from '../types'
import { timingSafeEqual } from '../lib/crypto'

export const sosApp = new Hono<{ Bindings: Env }>()

// Authentication middleware for SOS sub-app
sosApp.use('*', async (c, next) => {
  if (c.req.path.endsWith('/health')) return next()
  const secret = c.env.SOS_SECRET || c.env.BUS_TOKEN || c.env.SOS_TOKEN
  if (!secret) {
    return c.json({ error: 'unconfigured_secret', detail: 'addon secret unconfigured on environment' }, 503)
  }

  const authHeader = c.req.header('authorization')
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader
  const xSecret = c.req.header('x-secret') || c.req.header('x-sos-secret')

  const providedToken = bearerToken || xSecret
  if (!providedToken || !timingSafeEqual(providedToken, secret)) {
    return c.json({ error: 'unauthorized', detail: 'invalid or missing secret header' }, 401)
  }
  return next()
})

// GET /health — status of the SOS bridge sub-app
sosApp.get('/health', (c) => {
  return c.json({
    ok: true,
    addon: 'sos',
    status: 'active',
    tenant: c.env.TENANT_SLUG || 'default',
    busConfigured: Boolean(c.env.BUS),
  })
})

// POST /publish — publish event onto SOS event bus
sosApp.post('/publish', async (c) => {
  let body: { type?: string; payload?: unknown; squad_id?: string; agent_id?: string; tenant?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', detail: 'Request body must be valid JSON' }, 400)
  }

  if (!body.type || typeof body.type !== 'string') {
    return c.json({ error: 'invalid_payload', detail: 'type string is required' }, 400)
  }

  if (!c.env.BUS) {
    return c.json({ error: 'bus_unavailable', detail: 'BUS queue binding is missing' }, 500)
  }

  const event: BusEvent = {
    type: body.type as BusEventType,
    tenant: body.tenant || c.env.TENANT_SLUG || 'default',
    squad_id: body.squad_id,
    agent_id: body.agent_id,
    payload: body.payload ?? {},
    ts: new Date().toISOString(),
  }

  try {
    await c.env.BUS.send(event)
  } catch (err) {
    // Fail-closed discipline: return 500 on queue or bus failure
    return c.json({
      error: 'bus_publish_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }

  return c.json({ ok: true, emitted: { type: event.type, tenant: event.tenant }, ts: event.ts }, 201)
})

// POST /bridge — bridge inbound SOS bus events
sosApp.post('/bridge', async (c) => {
  let body: { event?: BusEvent; sourceSystem?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json', detail: 'Request body must be valid JSON' }, 400)
  }

  if (!body.event || !body.event.type) {
    return c.json({ error: 'invalid_payload', detail: 'event with type is required' }, 400)
  }

  if (!c.env.BUS) {
    return c.json({ error: 'bus_unavailable', detail: 'BUS queue binding is missing' }, 500)
  }

  const event: BusEvent = {
    ...body.event,
    tenant: body.event.tenant || c.env.TENANT_SLUG || 'default',
    ts: body.event.ts || new Date().toISOString(),
  }

  try {
    await c.env.BUS.send(event)
  } catch (err) {
    return c.json({
      error: 'bus_bridge_failed',
      detail: err instanceof Error ? err.message : String(err),
    }, 500)
  }

  return c.json({ ok: true, bridged: true, type: event.type, ts: event.ts }, 200)
})
