// mupot — seat-events HTTP surface, mounted at /api/fleet/events (before the dashboard catch-all,
// so an unknown path here is a JSON 404, never a redirect to a sign-in page).
//
//   POST   /api/fleet/events/ticket          signed by the host's Ed25519 key (no bearer)
//   GET    /api/fleet/events                 WebSocket upgrade → SeatEventsDO; auth = hello ticket
//   POST   /api/fleet/events/grants          org-admin bearer: authorize host → agent
//   DELETE /api/fleet/events/grants/:agent   org-admin bearer: revoke the agent's live grant
//
// Gate: REALTIME_SEAT_EVENTS=1 AND the SEAT_EVENTS binding. Off → 404 seat_events_disabled on the
// ticket and socket routes. Grants are writable either way, so a migration can be staged first.

import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability } from '../auth/capability'
import { presenceLiveDoUpgradeRequest } from '../registry/realtime'
import {
  createSeatEventGrant,
  isSeatEventsEnabled,
  mintTicketSecret,
  revokeSeatEventGrant,
  seatEventsChannelName,
  SEAT_EVENTS_PROTOCOL,
  TICKET_TTL_SEC,
  verifyTicketRequest,
} from './seat-events'

const MAX_BODY_BYTES = 8192
const NO_STORE = { 'Cache-Control': 'no-store' }

type Ctx = Context<{ Bindings: Env }>

async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  const declared = Number(c.req.header('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  try {
    const raw = await c.req.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return null
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

async function requireOrgAdmin(c: Ctx): Promise<{ memberId: string } | null> {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return null
  const grants = await resolveCapabilities(c.env, id.memberId)
  return hasCapability(grants, 'org', null, 'admin') ? { memberId: id.memberId } : null
}

function stub(env: Env) {
  const ns = env.SEAT_EVENTS!
  return ns.get(ns.idFromName(seatEventsChannelName(env.TENANT_SLUG)))
}

export const seatEventsApp = new Hono<{ Bindings: Env }>()

seatEventsApp.post('/ticket', async (c) => {
  if (!isSeatEventsEnabled(c.env)) return c.json({ error: 'seat_events_disabled' }, 404)
  const body = await readJson(c)
  if (!body) return c.json({ error: 'bad_request' }, 400)
  const v = await verifyTicketRequest(c.env, body)
  if (!v.ok) return c.json({ error: v.error, detail: v.detail }, v.status, NO_STORE)
  const { ticket, hash } = await mintTicketSecret()
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC
  const stored = await stub(c.env).fetch(
    new Request('https://seat-events/ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash, host: v.host, agents: v.granted, expires_at: expiresAt }),
    }),
  )
  if (!stored.ok) return c.json({ error: 'ticket_store_failed' }, 503, NO_STORE)
  return c.json(
    { ok: true, protocol: SEAT_EVENTS_PROTOCOL, ticket, expires_at: expiresAt, host: v.host, agents: v.granted, refused: v.refused },
    200,
    NO_STORE,
  )
})

seatEventsApp.get('/', async (c) => {
  if (!isSeatEventsEnabled(c.env)) return c.json({ error: 'seat_events_disabled' }, 404)
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'expected_websocket' }, 426)
  // Forward ONLY the WebSocket hop headers: no Authorization, no Cookie reaches the DO.
  return stub(c.env).fetch(presenceLiveDoUpgradeRequest(new URL('https://seat-events/connect'), c.req.raw))
})

seatEventsApp.post('/grants', async (c) => {
  const admin = await requireOrgAdmin(c)
  if (!admin) return c.json({ error: 'forbidden' }, 403)
  const b = await readJson(c)
  if (!b) return c.json({ error: 'bad_request' }, 400)
  const res = await createSeatEventGrant(c.env, {
    hostAgentId: typeof b.host_agent_id === 'string' ? b.host_agent_id : '',
    agentId: typeof b.agent_id === 'string' ? b.agent_id : '',
    projectId: typeof b.project_id === 'string' ? b.project_id : null,
    memberId: admin.memberId,
    reason: typeof b.reason === 'string' ? b.reason : '',
  })
  if (!res.ok) {
    const status = res.reason === 'agent_already_granted' ? 409 : res.reason === 'db_error' ? 500 : res.reason === 'invalid_args' ? 400 : 404
    return c.json({ error: res.reason }, status)
  }
  return c.json({ ok: true, id: res.id })
})

seatEventsApp.delete('/grants/:agent', async (c) => {
  const admin = await requireOrgAdmin(c)
  if (!admin) return c.json({ error: 'forbidden' }, 403)
  return c.json(await revokeSeatEventGrant(c.env, { agentId: c.req.param('agent'), memberId: admin.memberId }))
})

seatEventsApp.all('*', (c) => c.json({ error: 'not_found' }, 404))
