// plugins/seatlink/seat-events-client.mjs — SeatEventsDO push client for seatlink.
//
// Replaces N per-seat /api/inbox/stream SSE polls (each re-reads D1 every poll_ms) with ONE
// WebSocket per host. Protocol mirrored exactly from the server (do not invent; re-read on change):
//   POST {api}/api/fleet/events/ticket   src/agents/seat-events-routes.ts:107   body {host_agent_id, agents, ts, nonce, sig}
//   sig = Ed25519 over canonicalTicketMessage  src/agents/seat-events.ts:707
//         ['seat-events-ticket:v1', tenant, host, sortedUniqueAgents.join(','), String(ts), nonce].join('\n')
//         (domain tag src/agents/seat-events.ts:48; sig/nonce/id regexes :81-86; ts window = TICKET_WINDOW_SEC :49)
//   GET  {api}/api/fleet/events?ticket=T (WebSocket upgrade)  seat-events-routes.ts:143
//   client -> {type:'hello', v:1, ticket, since:{agent:seq}}  seat-events.ts:1044 (only client frame; <=4096 bytes)
//   server -> ready | backlog | hint{agent,hint} | revoked | superseded | error   seat-events.ts:173
//   keepalive: client sends the text 'ping', DO auto-answers 'pong' without waking (seat-events-do.ts:70)
//   close codes: 4401 ticket invalid, 4409 no subscriptions, 4408 auth timeout, 4400 protocol abuse (seat-events.ts:54-67)
//   limits: ticket TTL 60s single-use, <=64 agents/ticket, <=8 sockets/host, 15s hello deadline.
//
// Behaviour: hint {agent} -> ONE peek read of that seat's inbox (since cursor) -> existing inject path,
// unchanged. After every (re)connect: one resync read per seat. While ready, a SAFETY RESYNC reads each
// seat once every SAFETY_RESYNC_MS (hints can be lost: messages.ts:682-715, consumer.ts:680-705,
// seat-events.ts:1195-1212). NO SSE fallback: while a seat_event_grants row is live the stream route
// answers 409 notify_owned_by_fleet_host (inbox-routes.ts:156-165), so falling back cannot work and must
// not try to bypass the fence. Socket loss => reconnect with backoff only. Rollback is operator-only:
// revoke the seat's grant (DELETE /api/fleet/events/grants/:agent), then the plain SSE path works again.
// The private key is read from a file on every connect, held only inside the signing call, never logged.

import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const TICKET_SIG_DOMAIN = 'seat-events-ticket:v1'
export const SEAT_EVENTS_PROTOCOL = 1
export const SAFETY_RESYNC_MS = 300_000
export const PING_EVERY_MS = 25_000
export const DEAD_AFTER_MS = 70_000
export const BACKOFF_MIN_MS = 1_000
export const BACKOFF_MAX_MS = 60_000
export const INBOX_PAGE = 100
export const MAX_AGENTS_PER_TICKET = 64

/** Exact bytes the host signs. Must stay byte-identical to canonicalTicketMessage (seat-events.ts:707). */
export function canonicalTicketMessage({ tenant, host, agents, ts, nonce }) {
  const a = [...new Set(agents)].sort().join(',')
  return Buffer.from([TICKET_SIG_DOMAIN, tenant, host, a, String(ts), nonce].join('\n'), 'utf8')
}

/** Parse the optional top-level seats.json `seat_events` block. Returns null when absent/disabled. */
export function parseSeatEventsConfig(cfg) {
  const se = cfg?.seat_events
  if (!se || typeof se !== 'object') return null
  const { host_id: hostId, tenant } = se
  const keyFile = typeof se.host_key_file === 'string' && se.host_key_file ? se.host_key_file : path.join(os.homedir(), '.fleet', 'agents', 'seatlink-host.key')
  if (typeof hostId !== 'string' || !hostId) return null
  if (typeof tenant !== 'string' || !tenant) return null // tenant slug is bound into the signature
  const seats = (cfg.seats || []).filter((s) => s && s.seat_events === true && typeof s.agent_id === 'string' && s.agent_id)
  if (seats.length === 0) return null
  return { keyFile, hostId, tenant, seats: seats.slice(0, MAX_AGENTS_PER_TICKET) }
}

/** The stream route's fence answer (inbox-routes.ts:162). A SSE opener that sees this must stop and
 *  NOT retry or work around it: the seat is owned by a fleet host (push) until the grant is revoked. */
export function isOwnedByFleetHost(status, body) {
  return status === 409 && body?.error === 'notify_owned_by_fleet_host'
}

/** Default peek reader: the same non-consuming surface the SSE stream is built on. */
export function makePeekReader({ api, readToken, fetchImpl = fetch }) {
  return async function readInbox(seat, sinceSeq) {
    const token = readToken(seat)
    if (!token) throw new Error(`${seat.herdr}: no token`)
    const url = `${api.replace(/\/$/, '')}/api/inbox?peek=1&limit=${INBOX_PAGE}${sinceSeq ? `&since_seq=${sinceSeq}` : ''}`
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`inbox peek HTTP ${res.status}`)
    const body = await res.json()
    if (!body?.ok || !Array.isArray(body.messages)) throw new Error('inbox peek: malformed response')
    return body.messages
  }
}

/**
 * deps:
 *   api, tenant, hostId, keyFile, seats[{herdr, agent_id}]
 *   readFile(path)->string            reads the PKCS8 PEM private key
 *   fetchImpl, WebSocketImpl          ticket POST / socket
 *   readInbox(seat, sinceSeq)->msgs   one peek read
 *   deliver(seat, msg)->Promise       the EXISTING inject path (routeMail), unchanged
 *   getCursor(seat)/setCursor(seat,n) the existing per-seat since cursor
 *   log, timers{setTimeout,clearTimeout,now}, random
 */
export function createSeatEventsClient(deps) {
  const {
    api, tenant, hostId, keyFile, seats, readFile, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket,
    readInbox, deliver, getCursor, setCursor, log,
    timers = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t), now: () => Date.now() },
    random = Math.random,
  } = deps
  const byAgent = new Map(seats.map((s) => [s.agent_id, s]))
  const reading = new Map() // agent_id -> {running, dirty}
  let stopped = false
  let ws = null
  let ready = false
  let backoff = BACKOFF_MIN_MS
  let reconnectTimer = null
  let resyncTimer = null
  let pingTimer = null
  let lastFrameAt = 0
  let connecting = false
  const refused = new Set() // agents the server refused on the last hello: logged, never worked around

  const emptySince = () => Object.fromEntries(seats.map((s) => [s.agent_id, Number(getCursor(s) || 0)]))

  async function signTicketRequest() {
    // Key material lives only in this scope; errors are reduced to a fixed string so nothing leaks.
    let sig, ts, nonce
    const agents = [...byAgent.keys()].sort()
    try {
      const priv = crypto.createPrivateKey(readFile(keyFile))
      ts = Math.floor(timers.now() / 1000)
      nonce = crypto.randomBytes(16).toString('base64url')
      sig = crypto.sign(null, canonicalTicketMessage({ tenant, host: hostId, agents, ts, nonce }), priv).toString('base64url')
    } catch {
      throw new Error('host key unreadable or invalid')
    }
    return { host_agent_id: hostId, agents, ts, nonce, sig }
  }

  async function fetchTicket() {
    const body = await signTicketRequest()
    const res = await fetchImpl(`${api.replace(/\/$/, '')}/api/fleet/events/ticket`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!res.ok) {
      const e = new Error(`ticket HTTP ${res.status}`)
      e.status = res.status
      throw e
    }
    const j = await res.json()
    if (typeof j?.ticket !== 'string') throw new Error('ticket: malformed response')
    return j.ticket
  }

  function armResync() {
    if (resyncTimer || stopped) return
    resyncTimer = timers.setTimeout(() => {
      resyncTimer = null
      if (stopped || !ready) return // reconnect does its own resync
      for (const s of seats) if (!refused.has(s.agent_id)) void readSeat(s)
      armResync()
    }, SAFETY_RESYNC_MS)
  }

  /** One peek read for the seat, then inject unchanged. Hints arriving mid-read coalesce into one rerun. */
  async function readSeat(seat) {
    const st = reading.get(seat.agent_id) ?? { running: false, dirty: false }
    reading.set(seat.agent_id, st)
    if (st.running) { st.dirty = true; return }
    st.running = true
    try {
      do {
        st.dirty = false
        const msgs = await readInbox(seat, Number(getCursor(seat) || 0))
        let max = Number(getCursor(seat) || 0)
        for (const m of msgs) {
          await deliver(seat, m)
          if (typeof m.seq === 'number' && m.seq > max) max = m.seq
        }
        if (max > Number(getCursor(seat) || 0)) setCursor(seat, max)
      } while (st.dirty)
    } catch (e) {
      log(`seat-events: ${seat.herdr}: inbox read failed: ${e.message}`)
    } finally {
      st.running = false
    }
  }

  function scheduleReconnect(why) {
    ready = false
    if (pingTimer) { timers.clearTimeout(pingTimer); pingTimer = null }
    if (resyncTimer) { timers.clearTimeout(resyncTimer); resyncTimer = null }
    if (stopped || reconnectTimer) return
    const delay = Math.round(backoff * (0.75 + random() * 0.5))
    log(`seat-events: ${why}; reconnect in ${delay}ms`)
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; connect() }, delay)
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
  }

  function pingLoop(sock) {
    pingTimer = timers.setTimeout(() => {
      if (stopped || ws !== sock) return
      if (timers.now() - lastFrameAt > DEAD_AFTER_MS) {
        try { sock.close(4000, 'dead') } catch { /* gone */ }
        return
      }
      try { sock.send('ping') } catch { /* close handler will fire */ }
      pingLoop(sock)
    }, PING_EVERY_MS)
  }

  async function connect() {
    if (stopped || connecting) return
    connecting = true
    let ticket
    try {
      ticket = await fetchTicket()
    } catch (e) {
      connecting = false
      if (e.status === 429 || e.status === 401 || e.status === 403 || e.status === 404) backoff = Math.max(backoff, 30_000)
      return scheduleReconnect(`ticket failed (${e.status ?? e.message})`)
    }
    connecting = false
    if (stopped) return
    const sock = new WebSocketImpl(`${api.replace(/^http/, 'ws').replace(/\/$/, '')}/api/fleet/events?ticket=${encodeURIComponent(ticket)}`)
    ws = sock
    sock.addEventListener('open', () => {
      lastFrameAt = timers.now()
      sock.send(JSON.stringify({ type: 'hello', v: SEAT_EVENTS_PROTOCOL, ticket, since: emptySince() }))
    })
    sock.addEventListener('message', (ev) => { lastFrameAt = timers.now(); onFrame(sock, ev.data) })
    sock.addEventListener('error', () => { /* 'close' follows; nothing to log (URL carries the ticket) */ })
    sock.addEventListener('close', (ev) => {
      if (ws !== sock) return
      ws = null
      scheduleReconnect(`socket closed code=${ev?.code}`)
    })
  }

  function onFrame(sock, data) {
    if (typeof data !== 'string' || data === 'pong') return
    let f
    try { f = JSON.parse(data) } catch { return }
    if (f.type === 'ready') {
      refused.clear()
      for (const sub of f.subscriptions || []) {
        if (!sub.ok && byAgent.has(sub.agent)) {
          refused.add(sub.agent)
          log(`seat-events: ${byAgent.get(sub.agent).herdr}: subscription refused (${String(sub.reason).slice(0, 40)}); not served by push`)
        }
      }
      if (refused.size === seats.length) return // server closes 4409; reconnect path takes over
      ready = true
      backoff = BACKOFF_MIN_MS
      pingLoop(sock)
      armResync()
      for (const s of seats) if (!refused.has(s.agent_id)) void readSeat(s) // one resync read per seat
    } else if (f.type === 'hint') {
      const seat = byAgent.get(f.agent)
      if (seat && !refused.has(seat.agent_id)) void readSeat(seat)
    } else if (f.type === 'revoked' || f.type === 'superseded') {
      const seat = byAgent.get(f.agent)
      if (seat) { refused.add(seat.agent_id); log(`seat-events: ${seat.herdr}: ${f.type} (${String(f.reason).slice(0, 80)})`) }
    }
    // 'backlog' is body-free hint metadata; the resync read above already covers it.
  }

  return {
    start() { void connect() },
    stop() {
      stopped = true
      for (const t of [reconnectTimer, resyncTimer, pingTimer]) if (t) timers.clearTimeout(t)
      try { ws?.close(1000, 'stop') } catch { /* gone */ }
    },
    _state: () => ({ ready }),
  }
}
