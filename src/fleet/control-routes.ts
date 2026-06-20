// Fleet Control routes (Deliverable 2) — under /api/fleet.
//
//  POST /control  — emit a signed control-request (owner-cap; the host verifies + executes).
//  POST /report   — the host consumer daemon publishes its controllable agents + live status.
//  GET  /agents   — read the registry (the dashboard renders the roster from this).
//
// Control is the high-stakes write (drives host processes) and requires an EXPLICIT owner capability
// (no legacy web-role escape). Report is accepted ONLY from the configured consumer agent and only
// populates a DISPLAY cache — a forged status can mislead the panel, never authorize a host action.

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { emitControlRequest } from './control'
import { reportFleetAgents, listFleetAgents } from './registry'

export const fleetControlApp = new Hono<{ Bindings: Env }>()

type Parsed = { ok: true; value: unknown } | { ok: false; reason: 'too_large' | 'bad_json' }

/** Read + parse a JSON body with a HARD byte cap applied BEFORE parsing (anti-DoS, codex note):
 *  reject by content-length and by actual length, then parse. */
async function readJsonCapped(c: Context, maxBytes: number): Promise<Parsed> {
  const len = c.req.header('content-length')
  if (len && Number(len) > maxBytes) return { ok: false, reason: 'too_large' }
  const text = await c.req.text()
  if (text.length > maxBytes) return { ok: false, reason: 'too_large' }
  if (!text) return { ok: true, value: {} }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, reason: 'bad_json' }
  }
}

fleetControlApp.post('/control', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401) // generic — no auth oracle

  const grants = await resolveCapabilities(c.env, id.memberId)
  if (!hasCapability(grants, 'org', null, 'owner')) return c.json({ error: 'forbidden' }, 403)

  const parsed = await readJsonCapped(c, 4096)
  if (!parsed.ok) return c.json({ error: parsed.reason }, parsed.reason === 'too_large' ? 413 : 400)
  const body = parsed.value as { agent_id?: unknown; verb?: unknown }
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

fleetControlApp.post('/report', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  // Only the configured consumer agent (the daemon) may report fleet status.
  if (!c.env.FLEET_CONSUMER_AGENT || id.boundAgentId !== c.env.FLEET_CONSUMER_AGENT) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const parsed = await readJsonCapped(c, 65536) // up to ~200 agents
  if (!parsed.ok) return c.json({ error: parsed.reason }, parsed.reason === 'too_large' ? 413 : 400)
  const agents = (parsed.value as { agents?: unknown }).agents
  const res = await reportFleetAgents(c.env, id.boundAgentId, agents)
  return c.json(res, res.ok ? 200 : 400)
})

fleetControlApp.get('/agents', async (c) => {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return c.json({ error: 'unauthorized' }, 401)
  return c.json({ ok: true, agents: await listFleetAgents(c.env) })
})
