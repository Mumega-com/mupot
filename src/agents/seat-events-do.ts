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
  nextAuthDeadlineAlarm,
  normalizeHint,
  podAcceptRefusal,
  RecentIds,
  SeatEventsHub,
  storageTicketStore,
  type HubSocket,
  type JunkTracker,
  type SocketState,
} from './seat-events'

// mupot#1594 P1-A: the socket's ENTIRE attachment payload. `sub` is the existing
// {host, agents} SocketState once hello succeeds; `connectedAt` is written once, at accept,
// and never overwritten — it is what enforceAuthDeadline reads, and because it lives on the
// real WebSocket's own serializeAttachment payload (not an in-memory map keyed off a wrapper
// object) it survives hibernation and DO eviction, unlike the in-memory `ConnectClock` this
// replaces.
interface Attachment {
  connectedAt?: number
  sub?: SocketState
}

function wrap(ws: WebSocket): HubSocket {
  const read = (): Attachment => (ws.deserializeAttachment() as Attachment | null) ?? {}
  return {
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    getState: () => read().sub ?? null,
    setState: (s) => ws.serializeAttachment({ ...read(), sub: s }),
    getConnectedAt: () => read().connectedAt,
    markConnected: (nowSec) => {
      const cur = read()
      if (cur.connectedAt === undefined) ws.serializeAttachment({ ...cur, connectedAt: nowSec })
    },
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
  private wrapped(): HubSocket[] {
    return this.ctx.getWebSockets().map((ws) => this.wrapOnce(ws))
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
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      const wrapped = this.wrapOnce(pair[1])
      this.hub().noteConnected(wrapped)
      // mupot#1594 P1-A: never postpone a pending sweep. setAlarm() REPLACES any existing
      // alarm rather than taking the earlier of the two, so every prior connect that called
      // it unconditionally could push the deadline out indefinitely by reconnecting faster
      // than AUTH_DEADLINE_SEC. nextAuthDeadlineAlarm is pure and only returns a timestamp
      // when arming it actually brings the deadline EARLIER (or none was pending at all).
      const desired = Date.now() + AUTH_DEADLINE_SEC * 1000
      const next = nextAuthDeadlineAlarm(await this.ctx.storage.getAlarm(), desired)
      if (next !== null) await this.ctx.storage.setAlarm(next)
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
   *  deadline). Reschedules itself while any socket is still unauthenticated; otherwise lets
   *  the alarm lapse (mirrors PresenceChannelDO's scheduleExpiryAlarm pattern: recompute,
   *  never assume). */
  async alarm(): Promise<void> {
    this.hub().enforceAuthDeadline()
    const stillPending = this.ctx.getWebSockets().some((ws) => this.wrapOnce(ws).getState() === null)
    if (stillPending) await this.ctx.storage.setAlarm(Date.now() + AUTH_DEADLINE_SEC * 1000)
  }
}
