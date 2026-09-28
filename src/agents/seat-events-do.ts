// mupot — SeatEventsDO: one per pot, WebSocket hibernation. A thin shell over SeatEventsHub
// (./seat-events.ts), which holds all the logic and is tested without workerd.
//
// Internal surface (reached only through the Worker, never directly):
//   POST /ticket   {hash, host, agents, expires_at}   store a minted ticket (hash only)
//   POST /hint     SeatHint                           fan out one committed-message hint
//   GET  /connect  (Upgrade)                          accept a host socket; auth is the hello ticket
//
// No alarm, no timers. `ping` is answered by the runtime's auto-response without waking the DO,
// so the host keepalive costs no DO wake and no D1 read.

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import { reciprocateWebSocketClose } from '../registry/realtime'
import {
  AUTH_DEADLINE_SEC,
  createJunkTracker,
  decodeSocketAttachment,
  nextAuthDeadlineAlarm,
  nextSweepAlarmMs,
  normalizeHint,
  pendingHostCapExceeded,
  podAcceptRefusal,
  RecentIds,
  SEAT_EVENTS_HOST_HEADER,
  SeatEventsHub,
  storageTicketStore,
  type HubSocket,
  type JunkTracker,
} from './seat-events'

// mupot#1594 P1-A / mupot#1595 P1: the socket's ENTIRE attachment payload is read through
// `decodeSocketAttachment` (seat-events.ts), which ALSO recognizes the legacy pre-mupot#1594
// shape (a bare {host, agents} written directly by the previously deployed code) and decodes
// it as authenticated — see that function's own docstring for the rollout hazard this closes.
function wrap(ws: WebSocket): HubSocket {
  const read = () => decodeSocketAttachment(ws.deserializeAttachment())
  return {
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    getState: () => read().sub ?? null,
    setState: (s) => ws.serializeAttachment({ ...read(), sub: s }),
    getConnectedAt: () => read().connectedAt,
    getPendingHost: () => read().pendingHost,
    markConnected: (nowSec, pendingHost) => {
      const cur = read()
      if (cur.connectedAt === undefined) ws.serializeAttachment({ ...cur, connectedAt: nowSec, pendingHost })
    },
    // mupot#1595 (adversarial round 2): stamped by the hub's own closeSocket(), independent
    // of the real WebSocket's readyState — see pendingDeadlines()'s own docstring.
    markClosed: (nowSec) => {
      const cur = read()
      if (cur.closedAt === undefined) ws.serializeAttachment({ ...cur, closedAt: nowSec })
    },
    isClosed: () => read().closedAt !== undefined,
  }
}

export class SeatEventsDO extends DurableObject<Env> {
  private readonly recent = new RecentIds()
  private readonly nowSec = () => Math.floor(Date.now() / 1000)
  private readonly tickets: ReturnType<typeof storageTicketStore>
  // mupot#1589 P1-2: these two survive across fetch()/webSocketMessage() calls for the DO's
  // lifetime (a fresh SeatEventsHub is built per call, but these are constructed once here
  // and threaded through `deps` every time — same pattern as `recent`/`tickets` above).
  private readonly junk: JunkTracker = createJunkTracker()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
    this.tickets = storageTicketStore(ctx.storage, this.nowSec)
  }

  private hub(): SeatEventsHub {
    // Wrappers are rebuilt per call and compared by identity inside the hub, so map each
    // socket once per call and pass the same wrapper for the acting socket.
    return new SeatEventsHub(this.env, {
      sockets: () => this.wrapped(),
      tickets: this.tickets,
      nowSec: this.nowSec,
      recent: this.recent,
      junk: this.junk,
    })
  }

  private cache = new WeakMap<WebSocket, HubSocket>()
  // mupot#1595 (adversarial round 2): only a socket the RUNTIME still reports OPEN counts
  // toward anything — a socket in CLOSING (readyState 2, e.g. one we called .close() on that
  // the peer hasn't ack'd — sometimes never, for a half-open raw-TCP client) or CLOSED must
  // never occupy a pending/authenticated/per-host slot. This is the DO-shell half of the fix;
  // pendingDeadlines()'s closedAt exclusion (seat-events.ts) is the workerd-independent half
  // that makes the core property unit-testable without a real WebSocket.
  private wrapped(): HubSocket[] {
    return this.ctx.getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN)
      .map((ws) => this.wrapOnce(ws))
  }
  private wrapOnce(ws: WebSocket): HubSocket {
    let w = this.cache.get(ws)
    if (!w) {
      w = wrap(ws)
      this.cache.set(ws, w)
    }
    return w
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/ticket' && req.method === 'POST') {
      const b = (await req.json()) as { hash?: unknown; host?: unknown; agents?: unknown; expires_at?: unknown }
      if (typeof b.hash !== 'string' || typeof b.host !== 'string' || !Array.isArray(b.agents) || typeof b.expires_at !== 'number') {
        return Response.json({ error: 'bad_ticket' }, { status: 400 })
      }
      await this.tickets.purgeExpired()
      await this.tickets.put(b.hash, { host: b.host, agents: b.agents as string[], expires_at: b.expires_at })
      return Response.json({ ok: true })
    }
    if (url.pathname === '/hint' && req.method === 'POST') {
      const hint = normalizeHint(await req.json())
      if (!hint) return Response.json({ error: 'bad_hint' }, { status: 400 })
      return Response.json({ ok: true, ...(await this.hub().publish(hint)) })
    }
    if (url.pathname === '/connect' && req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      // mupot#1589 P1-2 / mupot#1594 P1-A: bound how many sockets this DO will hold open,
      // BEFORE accepting a new one — the Worker route's pre-check gate keeps most junk out,
      // but this is the DO's own floor regardless of what got past it. Authenticated and
      // pending sockets are counted, and capped, SEPARATELY: a flood of never-authenticated
      // connections must never be able to starve the authenticated-host budget.
      const existing = this.wrapped()
      const authenticated = existing.filter((s) => s.getState() !== null).length
      const pending = existing.length - authenticated
      const refusal = podAcceptRefusal({ authenticated, pending })
      if (refusal) {
        const error = refusal === 'pot_full' ? 'seat_events_at_capacity' : 'seat_events_pending_at_capacity'
        return Response.json({ error }, { status: 503 })
      }
      // mupot#1595 P1: the route atomically consumes the ticket before ever calling here, so
      // it already knows — and hands us — the ticket's real host. Cap PENDING sockets per
      // host too: single-use burn stops the SAME ticket reopening the pending budget, but one
      // host minting many DISTINCT valid tickets fast enough could still fill the whole
      // shared pending cap by itself. Trust this header only because it is set by our OWN
      // Worker route, never forwarded from anything client-sent (see the header's own
      // docstring in seat-events.ts).
      const pendingHost = req.headers.get(SEAT_EVENTS_HOST_HEADER) ?? undefined
      if (pendingHost) {
        const pendingForHost = existing.filter((s) => s.getState() === null && s.getPendingHost() === pendingHost).length
        if (pendingHostCapExceeded(pendingForHost)) {
          return Response.json({ error: 'seat_events_host_pending_at_capacity' }, { status: 503 })
        }
      }
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      const wrapped = this.wrapOnce(pair[1])
      this.hub().noteConnected(wrapped, pendingHost)
      // mupot#1594 P1-A: never postpone a pending sweep. setAlarm() REPLACES any existing
      // alarm rather than taking the earlier of the two, so every prior connect that called
      // it unconditionally could push the deadline out indefinitely by reconnecting faster
      // than AUTH_DEADLINE_SEC. nextAuthDeadlineAlarm is pure and only returns a timestamp
      // when arming it actually brings the deadline EARLIER (or none was pending at all).
      const desired = Date.now() + AUTH_DEADLINE_SEC * 1000
      const next = nextAuthDeadlineAlarm(await this.ctx.storage.getAlarm(), desired)
      // mupot#1595 (adversarial round 2): a hard floor on every alarm this DO ever arms — 1s
      // out at minimum, regardless of what either pure function computes. Belt-and-braces
      // against the hot-loop class (a near-past or already-past timestamp fires immediately,
      // recomputes the same thing, fires again) even if some future change reintroduces a
      // stale-timestamp path neither `nextAuthDeadlineAlarm` nor `pendingDeadlines` catches.
      if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000))
      return new Response(null, { status: 101, webSocket: pair[0] })
    }
    return new Response('not found', { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.hub().onMessage(this.wrapOnce(ws), message)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Subscriptions live on the socket's attachment and die with it: nothing to clean up.
    reciprocateWebSocketClose(ws, code, reason)
  }

  /** Sweeps for sockets that connected and never completed hello (mupot#1589 P1-2's auth
   *  deadline). Reschedules itself at the EARLIEST surviving pending socket's own real
   *  deadline (mupot#1595 P2, codex round-2 review) — not a fresh `now + AUTH_DEADLINE_SEC`,
   *  which could nearly double a survivor's effective deadline when it connected any time
   *  after the socket that triggered this sweep. Lets the alarm lapse when nothing is
   *  pending (mirrors PresenceChannelDO's scheduleExpiryAlarm pattern: recompute, never
   *  assume).
   *
   *  mupot#1595 (adversarial round 2): a socket THIS sweep just closed used to stay in the
   *  pending-deadline list — in real workerd it can sit in `ctx.getWebSockets()` with
   *  `readyState CLOSING` until the peer acks (sometimes never, for a half-open raw-TCP
   *  client), and its `connectedAt` never advances. Re-arming at that stale, already-past
   *  timestamp fired immediately, closed nothing new, and recomputed the SAME stale
   *  timestamp forever — Miniflare measured 15,887 alarms in 66s with 3 half-open clients.
   *  `this.hub().pendingDeadlines()` now excludes anything the hub has closed (`markClosed`,
   *  workerd-independent) AND `wrapped()` excludes anything the RUNTIME no longer reports
   *  OPEN — either alone would have closed this; both together cover the pure-logic and the
   *  real-workerd cases. The `now + 1000ms` floor is the last-resort backstop. */
  async alarm(): Promise<void> {
    const hub = this.hub()
    hub.enforceAuthDeadline()
    const next = nextSweepAlarmMs(hub.pendingDeadlines())
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000))
  }
}
