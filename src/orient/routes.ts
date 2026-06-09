// orient/routes — the orient seam transports (digid-hybrid S1).
//
//   GET  /api/orient?agent=<id|slug>   an agent reads its basin-drop packet (HTTP twin;
//                                       the MCP `orient` tool follows when #41 frees src/mcp).
//   POST /api/orient/field/:agentId    the MIND pushes an agent's field state INBOUND
//                                       (org-admin; the pot mirror orient reads).
//
// GET auth: a member-token whose holder has ≥observer on the agent's squad (or org-admin).
// POST auth: org-admin (the mind is an org-admin service principal — same gate as the #70
// flight connector, via the shared resolveOrgAdmin). Tenant is environment-derived.

import { Hono } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken, resolveOrgAdmin } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { mcpEndpoint } from '../dashboard/connect'
import { resolveAgentRef } from '../org/resolve'
import { buildOrient, renderBrief, parseFieldPush, upsertAgentField } from './service'

export const orientApp = new Hono<{ Bindings: Env }>()

orientApp.get('/', async (c) => {
  const member = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!member) return c.json({ error: 'unauthorized' }, 401)

  // An agent-scoped token orients ITSELF by default — no ?agent= needed (the weld).
  // A human/operator token (no binding) must name the agent it wants.
  const ref = c.req.query('agent') ?? member.boundAgentId
  if (!ref) return c.json({ error: 'agent_required' }, 400)
  // id-first, slug-with-ambiguity-refusal: a bare slug can match agents in different
  // squads (UNIQUE(squad_id, slug)); refuse rather than gate against an arbitrary row.
  const resolved = await resolveAgentRef(c.env, ref)
  if (!resolved.ok) {
    return c.json({ error: resolved.reason === 'ambiguous' ? 'ambiguous_slug' : 'not_found' }, resolved.reason === 'ambiguous' ? 409 : 404)
  }
  const agentRef = resolved.value

  // Authorize: the caller must have ≥observer on the agent's squad (or be org-admin).
  const caps = await resolveCapabilities(c.env, member.memberId)
  const orgAdmin = hasCapability(caps, 'org', null, 'admin')
  const onSquad = hasCapability(caps, 'squad', agentRef.squad_id, 'observer')
  if (!orgAdmin && !onSquad) return c.json({ error: 'forbidden' }, 403)
  const callerCapability = orgAdmin ? 'admin' : 'observer+'

  const origin = new URL(c.req.url).origin
  const { data, notFound } = await buildOrient(c.env, agentRef.id, callerCapability, mcpEndpoint(origin), Date.now())
  if (notFound || !data) return c.json({ error: 'not_found' }, 404)
  return c.json({ packet: data, brief: renderBrief(data) })
})

orientApp.post('/field/:agentId', async (c) => {
  const auth = await resolveOrgAdmin(c.env, c.req.header('authorization'))
  if (!auth.ok) return c.json({ error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, auth.status)

  const agentId = c.req.param('agentId')
  // Only accept field for an agent that exists in THIS pot (no mirror rows for ghosts).
  const exists = await c.env.DB.prepare(`SELECT 1 AS ok FROM agents WHERE id = ?1 LIMIT 1`).bind(agentId).first<{ ok: number }>()
  if (!exists) return c.json({ error: 'not_found' }, 404)

  const parsed = parseFieldPush(await c.req.json().catch(() => null))
  if (!parsed.ok) return c.json({ error: parsed.error }, 400)
  await upsertAgentField(c.env, agentId, parsed.value, Date.now())
  return c.json({ ok: true, agent_id: agentId })
})
