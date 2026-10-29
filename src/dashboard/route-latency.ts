import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env, AuthContext } from '../types'
import { requireAuth } from '../auth'
import { isOrgAdmin } from '../auth/capability'
import { readRouteLatency } from '../telemetry/route-latency'

export const routeLatencyApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

export async function boardLatencyRead(c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>) {
  const auth = c.get('auth')
  if (auth.tenant !== c.env.TENANT_SLUG || !isOrgAdmin(auth)) return c.json({ error: 'forbidden' }, 403)
  c.header('Cache-Control', 'no-store')
  // No user-controlled route label, identifier, SQL fragment or time range.
  const raw = c.req.query('days') ?? '7'
  if (c.req.query('route') !== undefined || !/^(?:[1-9]|1[0-3])$/.test(raw)) {
    return c.json({ error: 'invalid_latency_window' }, 400)
  }
  try {
    return c.json(await readRouteLatency(c.env, Number(raw)))
  } catch {
    return c.json({ error: 'route_latency_unavailable', status: 'unknown' }, 503)
  }
}

routeLatencyApp.get('/api/telemetry/board-latency', requireAuth, boardLatencyRead)
