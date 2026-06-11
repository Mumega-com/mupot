// mupot — Loop HTTP surface (P5, #36): create/list/lifecycle a loop THROUGH the product.
//
// Owner/admin only (CSRF + session). createLoop runs the full validateLoopSpec — incl.
// the structural CASL backstop (a channel-bearing loop MUST be gated). This is the
// dogfood path: an operator declares a loop here, never via raw SQL.
//
// Owner-binding note: squad_id/agent_id in the manifest name the owning work-unit. The
// pot is single-tenant per deploy and this route is admin-gated, so the owner is a unit
// the admin already controls within their tenant — no cross-tenant/escalation surface.

import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import type { Env, AuthContext } from '../types'
import { requireAuth, requireRole } from '../auth'
import { createLoop, listLoops, getLoop, setLoopStatus } from './service'
import { isLoopStatus } from './manifest'
import type { LoopStatus } from './manifest'
import { seedOutreachLoop } from './outreach-pack'
import { listLoopDecisions } from './decisions'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const loopsApp = new Hono<AppEnv>()

loopsApp.use('*', csrf())
loopsApp.use('*', requireAuth)
loopsApp.use('*', requireRole('admin')) // owner + admin

// GET /api/loops?status=active — list this tenant's loops.
loopsApp.get('/', async (c) => {
  const status = c.req.query('status')
  const loops = await listLoops(c.env, isLoopStatus(status) ? { status } : {})
  return c.json({ loops })
})

// GET /api/loops/:id — one loop.
loopsApp.get('/:id', async (c) => {
  const loop = await getLoop(c.env, c.req.param('id'))
  return loop ? c.json({ loop }) : c.json({ error: 'not_found' }, 404)
})

// POST /api/loops/seed-outreach — one-click: create the Outreach squad + a gated
// outreach loop. The dogfood path to a live loop. Idempotent-ish: a second call fails
// at the squad slug (already exists) and reports it.
loopsApp.post('/seed-outreach', async (c) => {
  const r = await seedOutreachLoop(c.env)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ ok: true, squad: r.squad, loop: r.loop }, 201)
})

// POST /api/loops — create a loop from a manifest spec (validated, CASL-backstopped).
loopsApp.post('/', async (c) => {
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  const r = await createLoop(c.env, body)
  if (!r.ok) return c.json({ error: r.error }, 400)
  return c.json({ loop: r.value }, 201)
})

// GET /api/loops/:id/decisions — persisted cycle-outcome feed (S-BRAIN-CTRL-MUPOT-1 AC#3).
// Admin-gated (loopsApp.use('*', requireRole('admin')) covers all routes in this app).
// Member reads of the decision feed go through the /brain dashboard page, not this API.
// ?limit= (max 200, default 50) ?offset= (for pagination).
loopsApp.get('/:id/decisions', async (c) => {
  const loopId = c.req.param('id')
  const loop = await getLoop(c.env, loopId)
  if (!loop) return c.json({ error: 'not_found' }, 404)

  const limitRaw = c.req.query('limit')
  const offsetRaw = c.req.query('offset')
  const limit = limitRaw ? Math.max(1, Math.min(200, parseInt(limitRaw, 10) || 50)) : 50
  const offset = offsetRaw ? Math.max(0, parseInt(offsetRaw, 10) || 0) : 0

  const decisions = await listLoopDecisions(c.env, loopId, { limit, offset })
  return c.json({ decisions, loop_id: loopId, limit, offset })
})

// POST /api/loops/:id/status — pause / resume (active) / kill.
loopsApp.post('/:id/status', async (c) => {
  let body: { status?: unknown }
  try {
    body = (await c.req.json()) as { status?: unknown }
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }
  if (!isLoopStatus(body.status)) {
    return c.json({ error: 'invalid_status', accepted: ['active', 'paused', 'done', 'killed'] }, 400)
  }
  const ok = await setLoopStatus(c.env, c.req.param('id'), body.status as LoopStatus)
  return ok ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
})
