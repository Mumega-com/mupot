// Fleet Control route (Deliverable 2) — POST /api/fleet/control.
//
// An owner (panel) or an owner-capable agent asks to start|stop|status|restart a HOST process.
// Authenticated by the pot member-token (bearer), like check-in. Because this drives REAL host
// processes, it requires the HIGHEST capability — an explicit OWNER grant on org scope (NO legacy
// web-role escape): an agent can control the fleet only if the owner deliberately granted it
// owner-cap. The route signs a control-request and drops it in the consumer's inbox; the host
// verifies the signature before acting (the bus only proves "a pot member sent this"; the Ed25519
// signature proves "the panel authorized THIS host action").

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { emitControlRequest } from './control'

export const fleetControlApp = new Hono<{ Bindings: Env }>()

fleetControlApp.post('/control', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  // Generic 401 — never distinguish missing vs bad token (no auth oracle).
  if (!id) return c.json({ error: 'unauthorized' }, 401)

  const grants = await resolveCapabilities(c.env, id.memberId)
  if (!hasCapability(grants, 'org', null, 'owner')) return c.json({ error: 'forbidden' }, 403)

  const body = (await c.req.json().catch(() => ({}))) as { agent_id?: unknown; verb?: unknown }
  if (typeof body.agent_id !== 'string' || typeof body.verb !== 'string') {
    return c.json({ error: 'bad_request', detail: 'agent_id and verb (string) required' }, 400)
  }

  const res = await emitControlRequest(
    c.env,
    { agent_id: body.agent_id, verb: body.verb },
    { memberId: id.memberId, boundAgentId: id.boundAgentId },
  )
  if (!res.ok) {
    const code = res.reason === 'unconfigured' ? 503 : res.reason === 'invalid_input' ? 400 : 502
    return c.json({ error: res.reason, detail: res.detail }, code)
  }
  return c.json({ ok: true, nonce: res.nonce, agent_id: res.agent_id, verb: res.verb })
})
