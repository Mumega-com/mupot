// dashboard/radar-routes — GET /api/radar (#23): read-only JSON feed of the
// FleetRadar (dashboard/radar.ts) for the brain (ATC tower) and any other
// admin-scoped consumer. Same auth shape as the flights connector (flight/routes.ts):
// member-token bearer, org-admin capability required — this is a JSON API surface,
// not the session-cookie dashboard, and the radar can carry the same
// spend/coherence-relevant detail as the flights outcome feed.

import { Hono } from 'hono'
import type { Env } from '../types'
import { resolveOrgAdmin } from '../auth/member-bearer'
import { loadFleetRadar } from './radar'

const requireOrgAdmin = resolveOrgAdmin

export const radarApp = new Hono<{ Bindings: Env }>()

radarApp.get('/', async (c) => {
  const auth = await requireOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const radar = await loadFleetRadar(c.env)
  return c.json(radar)
})
