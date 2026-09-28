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
import { resolveCapabilities, hasCapability, canOnSquad, currentMemberRankOnScope } from '../auth/capability'
import { presenceLiveDoUpgradeRequest } from '../registry/realtime'
import {
  activeSeatEventGrant,
  consumeTicketPreCheck,
  createSeatEventGrant,
  isMemberActive,
  isSeatEventsEnabled,
  isWellFormedTicket,
  mintTicketSecret,
  recordTicketPreCheck,
  revokeSeatEventGrant,
  seatEventsChannelName,
  sha256Hex,
  SEAT_EVENTS_HOST_HEADER,
  SEAT_EVENTS_PROTOCOL,
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
): Promise<{ ok: true; squadId: string } | { ok: false; status: 404; error: string }> {
  const row = await c.env.DB.prepare('SELECT squad_id FROM agents WHERE id = ?1 LIMIT 1')
    .bind(targetAgentId)
    .first<{ squad_id: string }>()
  if (hasCapability(principal.grants, 'org', null, 'admin')) {
    // Org admin still needs the row to exist to report a real squadId to the caller — but an
    // org admin's own authorization never depended on it, so a missing agent falls through
    // to the SAME uniform 404 below rather than a separate admin-only branch.
    if (row) return { ok: true, squadId: row.squad_id }
  } else if (row && (await canOnSquad(c.env, principal.grants, row.squad_id, 'lead'))) {
    return { ok: true, squadId: row.squad_id }
  }
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
  // upgrade route could never later pass its pre-check on is worse than a 503 here.
  try {
    await recordTicketPreCheck(c.env, hash, v.host, expiresAt)
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
  // mupot#1589 P1-2: refuse an upgrade with no credential-shaped ticket BEFORE the DO is ever
  // called — a bare `Upgrade: websocket` with nothing else used to reach acceptWebSocket with
  // zero authentication. This is a presence+format gate only (mirrors PresenceChannelDO's own
  // pre-accept check, src/registry/presence-routes.ts); the ticket is still redeemed exactly
  // once, over the hello frame, exactly as before — see seat-events.ts's onMessage.
  //
  // mupot#1595 P2 (kasra-review round 1, Probe Z5): this FREE, pure-regex check must run
  // BEFORE the D1-costing rate limiter below — it used to run after, so a bare ticket-less
  // GET cost one D1 UPSERT (and, pre-pruning, one permanent row) per request, no signature or
  // grant required at all.
  const ticket = c.req.query('ticket')
  if (!ticket || !isWellFormedTicket(ticket)) return c.json({ error: 'ticket_required' }, 401, NO_STORE)
  // mupot#1594 P1-A: the upgrade route itself had NO rate limit — only /ticket did — even
  // though the upgrade is what actually costs the DO an accepted socket. Same atomic
  // per-IP (/64-bucketed) pattern as /ticket.
  if (!(await underUpgradeRateLimit(c.env, clientIp(c)))) return c.json({ error: 'rate_limited' }, 429, NO_STORE)
  // mupot#1595 P1 (kasra-review round 1, Probe Z2): format alone used to be enough to reach
  // the DO, and the PRE-CHECK itself (round 1 of this PR) only checked existence+expiry —
  // reusable for the ticket's whole 60s TTL, so one minted ticket got 80/80 upgrades forwarded
  // to the DO from 80 distinct IPv6 /64s. This now ATOMICALLY BURNS the pre-check row (see
  // consumeTicketPreCheck's own docstring) — one ticket opens exactly one upgrade attempt.
  // The DO's own independent single-use burn (`tickets.take()`, at hello) is untouched.
  const consumed = await consumeTicketPreCheck(c.env, await sha256Hex(ticket))
  if (!consumed.ok) return c.json({ error: 'ticket_invalid' }, 401, NO_STORE)
  // mupot#1595 P1: carry the ticket's OWN host (now known — it was just atomically consumed
  // from a row only /ticket ever wrote) to the DO as an internal, Worker-to-DO-only header —
  // never client-controlled — so accept-time can enforce a per-host cap on PENDING sockets,
  // independent of the pot-wide pending cap. Without this, single-use burn alone still let
  // ONE host mint tickets fast enough to fill the WHOLE shared pending budget by itself.
  const upgradeReq = presenceLiveDoUpgradeRequest(new URL('https://seat-events/connect'), c.req.raw)
  upgradeReq.headers.set(SEAT_EVENTS_HOST_HEADER, consumed.hostAgentId)
  // Forward ONLY the WebSocket hop headers (+ the internal host header above): no
  // Authorization, no Cookie reaches the DO.
  return stub(c.env).fetch(upgradeReq)
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

// mupot#1595 P1/P2 (codex round-2 review on 4dff34d2): round 1's revoke ceiling recognized
// ONLY an org-scope admin grant (`hasCapability(creatorGrants, 'org', null, 'admin')`) — a
// squad lead could still revoke a grant created by THAT SAME SQUAD's own admin/owner, or by
// an inherited department admin/owner, since none of those satisfy an ORG-scope check. Both
// creators pass `authorizeGrantTarget` and rank above `lead` on the capability ladder, so the
// stated "protect higher-rank creators" property was false for them even without a race.
// `currentMemberRankOnScope(env, memberId, 'squad', squadId)` is the general form: it already
// folds org/department inheritance AND the legacy role plane into one comparable number on
// the SAME scope the rank ceiling actually cares about (see its own docstring in
// auth/capability.ts) — comparing it for the creator against the revoker on the TARGET squad
// replaces the org-only special case entirely, an org admin still wins because an org grant
// resolves on every non-home squad via that same function.
//
// A suspended/archived creator's stale capability rows must not impose a ceiling either
// (isMemberActive) — resolveCapabilities has no status filter, so a suspended former admin
// would otherwise block every lead's revoke forever.
//
// The check and the revoke are still two D1 operations: bind the revoke to the EXACT grant
// row just authorized (`grantId`) so a concurrent revoke-and-replace (an admin revokes and
// re-grants between this check and the write) can never let an unauthorized revoke land on
// the NEW row — 0 rows changed means it moved, so loop and re-authorize against whatever is
// live now, bounded so this can never spin forever.
seatEventsApp.delete('/grants/:agent', async (c) => {
  const principal = await resolveGrantPrincipal(c)
  if (!principal.ok) return c.json({ error: principal.error }, principal.status)
  const agentId = c.req.param('agent')
  const target = await authorizeGrantTarget(c, principal, agentId)
  if (!target.ok) return c.json({ error: target.error }, target.status)

  for (let attempt = 0; attempt < 3; attempt++) {
    const live = await activeSeatEventGrant(c.env, agentId)
    if (!live) return c.json({ ok: true, revoked: 0 })
    if (live.granted_by_member_id !== principal.memberId && (await isMemberActive(c.env, live.granted_by_member_id))) {
      const [revokerRank, creatorRank] = await Promise.all([
        currentMemberRankOnScope(c.env, principal.memberId, 'squad', target.squadId),
        currentMemberRankOnScope(c.env, live.granted_by_member_id, 'squad', target.squadId),
      ])
      if (creatorRank > revokerRank) {
        return c.json({ error: 'forbidden_higher_authority' }, 403)
      }
    }
    const result = await revokeSeatEventGrant(c.env, { agentId, memberId: principal.memberId, grantId: live.id })
    if (result.revoked > 0) return c.json(result)
    // 0 rows changed: the grant this attempt authorized against is no longer the live one —
    // re-fetch and re-authorize against whatever replaced it, rather than treating a
    // no-op as success without ever having checked the new row.
  }
  return c.json({ error: 'grant_changed_retry' }, 409)
})

seatEventsApp.all('*', (c) => c.json({ error: 'not_found' }, 404))
