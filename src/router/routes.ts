import { Hono } from 'hono'
import { requireAuth } from '../auth'
import { authorizeExecutionScope } from '../auth/execution-scope'
import { isOrgAdmin } from '../auth/capability'
import type { AuthContext, Env } from '../types'
import { runRouterTick } from './engine'

type AppEnv = { Bindings: Env; Variables: { auth: AuthContext } }

export const routerApp = new Hono<AppEnv>()

routerApp.use('*', requireAuth)

// POST /api/router/tick — an org-admin operational trigger for one named squad.
routerApp.post('/tick', async (c) => {
  const auth = c.get('auth')
  if (!isOrgAdmin(auth)) return c.json({ error: 'forbidden' }, 403)

  let body: { squad_id?: unknown; dry_run?: unknown; limit?: unknown }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  if (typeof body.squad_id !== 'string' || body.squad_id.trim().length === 0) {
    return c.json({ error: 'invalid_args', message: 'squad_id required' }, 400)
  }
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
    return c.json({ error: 'invalid_args', message: 'dry_run must be boolean' }, 400)
  }
  if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) {
    return c.json({ error: 'invalid_args', message: 'limit must be number' }, 400)
  }

  const decision = await authorizeExecutionScope(c.env, auth, {
    action: 'router:mutate', squadId: body.squad_id,
  })
  if (!decision.ok) return c.json({ error: decision.error }, decision.status)
  if (!auth.memberId) return c.json({ error: 'forbidden' }, 403)

  try {
    const result = await runRouterTick(c.env, decision, {
      squadId: body.squad_id,
      dryRun: body.dry_run === true,
      limit: body.limit,
    }, { memberId: auth.memberId })
    return c.json({ ok: true, result })
  } catch {
    return c.json({ error: 'router_unavailable' }, 503)
  }
})
