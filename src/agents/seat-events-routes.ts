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
import type { CapabilityGrant, Env } from '../types'
import { bearerToken, resolveMemberByToken } from '../auth/member-bearer'
import { resolveCapabilities, hasCapability, canOnSquad } from '../auth/capability'
import { presenceLiveDoUpgradeRequest } from '../registry/realtime'
import {
  activeSeatEventGrant,
  createSeatEventGrant,
  isSeatEventsEnabled,
  isWellFormedTicket,
  mintTicketSecret,
  recordTicketPreCheck,
  revokeSeatEventGrant,
  seatEventsChannelName,
  sha256Hex,
  SEAT_EVENTS_PROTOCOL,
  ticketPreCheckPasses,
  TICKET_TTL_SEC,
  underTicketRateLimit,
  underUpgradeRateLimit,
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

// mupot#1589 P1-1: a grant write is an RBAC act (it decides who receives an agent's
// notification traffic) and needs a HUMAN member principal. The MCP plane already refuses an
// agent-bound caller on grant-shaped writes (src/mcp/archive.ts's requireOperatorOrgAdmin);
// this raw Hono route did not. `resolveGrantPrincipal` refuses the agent-bound case FIRST,
// before either endpoint even looks at its body/param — mirroring the ORDER
// operator_principal_required checks land in everywhere else in this codebase.
type GrantPrincipal = { ok: true; memberId: string; grants: CapabilityGrant[] } | { ok: false; status: 403; error: string }

async function resolveGrantPrincipal(c: Ctx): Promise<GrantPrincipal> {
  const id = await resolveMemberByToken(c.env, bearerToken(c.req.header('authorization')))
  if (!id) return { ok: false, status: 403, error: 'forbidden' }
  if (id.boundAgentId) return { ok: false, status: 403, error: 'operator_principal_required' }
  const grants = await resolveCapabilities(c.env, id.memberId)
  return { ok: true, memberId: id.memberId, grants }
}

// Rank ceiling: org admin, OR at least `lead` on the TARGET agent's own squad — "squads
// self-serve is the product direction," so a squad lead may authorize/revoke a seat-events
// grant for an agent on their own squad without needing org admin. Never cross-squad: the
// squad is re-resolved fresh from the agents row, never from anything caller-asserted.
//
// mupot#1594 P3: "make the 404-vs-403 agent-existence oracle uniform." This used to answer
// 404 agent_not_found for a missing agent but 403 forbidden for an existing one the caller
// has no standing on — two distinguishable codes that let ANY caller with grant-write access
// to at least one squad enumerate which agent ids exist, tenant-wide, for free. Collapsed
// onto ONE response for both cases, same convention messages.ts's sendToRef already uses for
// `send_target_not_visible` (existence and no-visibility give the identical 404): a
// non-admin principal who cannot act on `targetAgentId` learns nothing about whether it
// exists at all.
async function authorizeGrantTarget(
  c: Ctx,
  principal: { grants: CapabilityGrant[] },
  targetAgentId: string,
): Promise<{ ok: true } | { ok: false; status: 404; error: string }> {
  if (hasCapability(principal.grants, 'org', null, 'admin')) return { ok: true }
  const row = await c.env.DB.prepare('SELECT squad_id FROM agents WHERE id = ?1 LIMIT 1')
    .bind(targetAgentId)
    .first<{ squad_id: string }>()
  if (row && (await canOnSquad(c.env, principal.grants, row.squad_id, 'lead'))) return { ok: true }
  return { ok: false, status: 404, error: 'agent_not_visible' }
}

function clientIp(c: Ctx): string {
  // cf-connecting-ip ONLY — never X-Forwarded-For (client-controllable). Same rule as
  // src/auth/index.ts's resolveClientIp.
  return c.req.header('cf-connecting-ip') ?? 'unknown'
}

function stub(env: Env) {
  const ns = env.SEAT_EVENTS!
  return ns.get(ns.idFromName(seatEventsChannelName(env.TENANT_SLUG)))
}

export const seatEventsApp = new Hono<{ Bindings: Env }>()

seatEventsApp.post('/ticket', async (c) => {
  if (!isSeatEventsEnabled(c.env)) return c.json({ error: 'seat_events_disabled' }, 404)
  // mupot#1589 P3: no bearer here, so every request costs one D1 read (loadActiveAgentKey)
  // plus one Ed25519 verify with zero rate limit. Keyed on the connecting IP, never on the
  // caller-asserted (unverified at this point) host_agent_id — see underTicketRateLimit's
  // own docstring for why.
  if (!(await underTicketRateLimit(c.env, clientIp(c)))) return c.json({ error: 'rate_limited' }, 429, NO_STORE)
  const body = await readJson(c)
  if (!body) return c.json({ error: 'bad_request' }, 400)
  const v = await verifyTicketRequest(c.env, body)
  if (!v.ok) return c.json({ error: v.error, detail: v.detail }, v.status, NO_STORE)
  const { ticket, hash } = await mintTicketSecret()
  const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SEC
  // mupot#1594 P1-A: write the route's OWN pre-check record (migration 0180) BEFORE asking
  // the DO to store its copy. If this write fails, refuse outright — minting a ticket the
  // upgrade route could never later pass its pre-check on on is worse than a 503 here.
  try {
    await recordTicketPreCheck(c.env, hash, expiresAt)
  } catch (err) {
    console.error('[seat-events] ticket pre-check write failed:', err instanceof Error ? err.message : err)
    return c.json({ error: 'ticket_store_failed' }, 503, NO_STORE)
  }
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
  // mupot#1594 P1-A: the upgrade route itself had NO rate limit — only /ticket did — even
  // though the upgrade is what actually costs the DO an accepted socket. Same atomic
  // per-IP (/64-bucketed) pattern as /ticket.
  if (!(await underUpgradeRateLimit(c.env, clientIp(c)))) return c.json({ error: 'rate_limited' }, 429, NO_STORE)
  // mupot#1589 P1-2: refuse an upgrade with no credential-shaped ticket BEFORE the DO is ever
  // called — a bare `Upgrade: websocket` with nothing else used to reach acceptWebSocket with
  // zero authentication. This is a presence+format gate only (mirrors PresenceChannelDO's own
  // pre-accept check, src/registry/presence-routes.ts); the ticket is still redeemed exactly
  // once, over the hello frame, exactly as before — see seat-events.ts's onMessage.
  const ticket = c.req.query('ticket')
  if (!ticket || !isWellFormedTicket(ticket)) return c.json({ error: 'ticket_required' }, 401, NO_STORE)
  // mupot#1594 P1-A: format alone used to be enough to reach the DO — 200/200 forged 43-char
  // strings did in the adversarial probe, each spending a socket slot. Verify the ticket was
  // actually minted, for THIS tenant, and has not expired (one indexed D1 SELECT, no DO
  // round-trip) before ever forwarding the upgrade. The single-use burn is untouched: it
  // still happens exactly once, inside the DO, over the hello frame — see
  // ticketPreCheckPasses's own docstring for why this is not a weaker check than a signature.
  if (!(await ticketPreCheckPasses(c.env, await sha256Hex(ticket)))) {
    return c.json({ error: 'ticket_invalid' }, 401, NO_STORE)
  }
  // Forward ONLY the WebSocket hop headers: no Authorization, no Cookie reaches the DO.
  return stub(c.env).fetch(presenceLiveDoUpgradeRequest(new URL('https://seat-events/connect'), c.req.raw))
})

seatEventsApp.post('/grants', async (c) => {
  const principal = await resolveGrantPrincipal(c)
  if (!principal.ok) return c.json({ error: principal.error }, principal.status)
  const b = await readJson(c)
  if (!b) return c.json({ error: 'bad_request' }, 400)
  const agentId = typeof b.agent_id === 'string' ? b.agent_id : ''
  const target = await authorizeGrantTarget(c, principal, agentId)
  if (!target.ok) return c.json({ error: target.error }, target.status)
  const res = await createSeatEventGrant(c.env, {
    hostAgentId: typeof b.host_agent_id === 'string' ? b.host_agent_id : '',
    agentId,
    projectId: typeof b.project_id === 'string' ? b.project_id : null,
    memberId: principal.memberId,
    reason: typeof b.reason === 'string' ? b.reason : '',
  })
  if (!res.ok) {
    // mupot#1594: 'host_no_squad_standing' is a REAL authorization refusal on an existing,
    // visible agent (the caller already passed authorizeGrantTarget's oracle-safe check
    // above) — 403, not folded into the generic 404 default below.
    const status =
      res.reason === 'agent_already_granted' ? 409 :
      res.reason === 'db_error' ? 500 :
      res.reason === 'invalid_args' ? 400 :
      res.reason === 'host_key_missing' || res.reason === 'project_access_denied' || res.reason === 'host_no_squad_standing' ? 403 :
      404
    return c.json({ error: res.reason }, status)
  }
  return c.json({ ok: true, id: res.id })
})

seatEventsApp.delete('/grants/:agent', async (c) => {
  const principal = await resolveGrantPrincipal(c)
  if (!principal.ok) return c.json({ error: principal.error }, principal.status)
  const agentId = c.req.param('agent')
  const target = await authorizeGrantTarget(c, principal, agentId)
  if (!target.ok) return c.json({ error: target.error }, target.status)
  // mupot#1594 P2-C: "a squad lead may revoke only grants inside their own authority" — a
  // lead's revoke rank ceiling was the TARGET's squad only (authorizeGrantTarget above); it
  // never looked at who actually WROTE the live grant. A lead of the agent's own squad could
  // therefore revoke a grant an ORG ADMIN had explicitly created, silently undoing a
  // higher-rank decision. An org admin is exempt (can revoke anything, by definition). The
  // creator's capability is re-checked LIVE, at revoke time — not the rank they held when
  // they created the grant — matching this codebase's standing re-check convention elsewhere
  // (authorizeSeatDelivery, hostMayReceive): authority that has since been revoked cannot
  // still gate a lead out, and authority since GRANTED must not either.
  if (!hasCapability(principal.grants, 'org', null, 'admin')) {
    const live = await activeSeatEventGrant(c.env, agentId)
    if (live) {
      const creatorGrants = await resolveCapabilities(c.env, live.granted_by_member_id)
      if (hasCapability(creatorGrants, 'org', null, 'admin')) {
        return c.json({ error: 'forbidden_higher_authority' }, 403)
      }
    }
  }
  return c.json(await revokeSeatEventGrant(c.env, { agentId, memberId: principal.memberId }))
})

seatEventsApp.all('*', (c) => c.json({ error: 'not_found' }, 404))
