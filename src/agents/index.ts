// mupot — agents router. Mounted at ROUTES.agents ('/api/agents') by src/index.ts.
//
// Surfaces the agent runtime over HTTP: wake an agent (RBAC-gated mutation),
// read an agent's runtime status. All paths are tenant-scoped — the agent row is
// resolved from D1 and must exist before we ever address its DurableObject, so a
// caller cannot poke an arbitrary DO id from another tenant.

import { Hono } from 'hono'
import type { Env, Agent, AuthContext, BusEvent } from '../types'
import { requireAuth } from '../auth'
import { createBus } from '../bus'

export const agentsApp = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// Every route requires auth AND tenant scope — the same explicit guard org/tasks
// enforce. Don't rely on per-tenant D1 alone as the boundary (P1 fix): a session
// minted for another tenant must never wake/read this tenant's agents.
agentsApp.use('*', requireAuth, async (c, next) => {
  if (c.get('auth').tenant !== c.env.TENANT_SLUG) {
    return c.json({ error: 'forbidden', reason: 'tenant_scope' }, 403)
  }
  await next()
})

// Resolve an agent row (tenant-scoped: D1 is the tenant's DB). Returns null if the
// id does not name a real agent in this tenant.
async function loadAgent(env: Env, agentId: string): Promise<Agent | null> {
  const row = await env.DB.prepare(
    `SELECT id, squad_id, slug, name, role, model, status, created_at FROM agents WHERE id = ?`,
  )
    .bind(agentId)
    .first<Agent>()
  return row ?? null
}

// POST /:agentId/wake — drive one cortex cycle. Mutating → requireAuth + role gate.
// org 'member' may read status but only 'admin'/'owner' may wake an agent (it
// spends model + bus quota and emits org-mutating actions).
agentsApp.post('/:agentId/wake', async (c) => {
  const auth = c.get('auth')
  if (auth.role !== 'owner' && auth.role !== 'admin') {
    return c.json({ error: 'forbidden', need: 'admin' }, 403)
  }

  const agentId = c.req.param('agentId')
  const agent = await loadAgent(c.env, agentId)
  if (!agent) return c.json({ error: 'agent_not_found' }, 404)
  if (agent.status !== 'active') return c.json({ error: 'agent_paused' }, 409)

  // optional wake body (reason/context/maxActions)
  type WakeBody = { reason?: string; context?: string; maxActions?: number }
  const body = await c.req.json<WakeBody>().catch((): WakeBody => ({}))

  // Announce the wake on the bus (observability + lets the consumer react), then
  // drive the DO directly so the caller gets the cycle result synchronously.
  const bus = createBus(c.env)
  const wakeEvent: BusEvent<{ by: string; reason?: string }> = {
    type: 'agent.wake',
    tenant: c.env.TENANT_SLUG,
    squad_id: agent.squad_id,
    agent_id: agent.id,
    payload: { by: auth.userId, reason: body.reason },
    ts: new Date().toISOString(),
  }
  await bus.emit(wakeEvent)

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id))
  const res = await stub.fetch('https://agent/wake', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reason: body.reason ?? 'manual',
      squad_id: agent.squad_id,
      context: body.context,
      maxActions: body.maxActions,
    }),
  })
  const result = await res.json<unknown>()
  return c.json(result, res.ok ? 200 : 409)
})

// GET /:agentId/status — runtime telemetry for an agent. Read-only; requireAuth.
agentsApp.get('/:agentId/status', async (c) => {
  const agentId = c.req.param('agentId')
  const agent = await loadAgent(c.env, agentId)
  if (!agent) return c.json({ error: 'agent_not_found' }, 404)

  const stub = c.env.AGENT.get(c.env.AGENT.idFromName(agent.id))
  const res = await stub.fetch('https://agent/status')
  const runtime = await res.json<unknown>()
  return c.json({
    agent: { id: agent.id, name: agent.name, role: agent.role, model: agent.model, status: agent.status, squad_id: agent.squad_id },
    runtime,
  })
})
