// tests/seat-events.test.ts — body-free, one-socket-per-host seat-events channel.
//
// Every describe block below is a kill-witness for one safety property: remove the guard it names
// and at least one test here goes red (scripts/kill-witness-seat-events.mjs does exactly that).
// Real schema (the whole migration chain on node:sqlite), real Ed25519 signatures, real
// sendAgentMessage → message.created → handleQueue path; only the DO runtime is simulated, through
// the same SeatEventsHub the DO class delegates to.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BusEvent, Env, MessageCreatedPayload } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import {
  AUTH_DEADLINE_SEC,
  BACKLOG_HINT_LIMIT,
  CLOSE_AUTH_TIMEOUT,
  CLOSE_PROTOCOL_ABUSE,
  CLOSE_TICKET_INVALID,
  MAX_AGENTS_PER_TICKET,
  MAX_FRAME_BYTES,
  MAX_JUNK_FRAMES,
  MAX_PENDING_SOCKETS_PER_POT,
  MAX_SOCKETS_PER_HOST,
  MAX_SOCKETS_PER_POT,
  RecentIds,
  SeatEventsHub,
  TICKET_RATE_LIMIT_MAX_PER_IP,
  TICKET_TTL_SEC,
  UPGRADE_RATE_LIMIT_MAX_PER_IP,
  backlogFor,
  canonicalTicketMessage,
  createJunkTracker,
  createSeatEventGrant,
  hintFromPayload,
  hostMayReceive,
  ipRateLimitKey,
  isWellFormedTicket,
  mintTicketSecret,
  nextAuthDeadlineAlarm,
  normalizeHint,
  podAcceptRefusal,
  publishSeatHint,
  recordTicketPreCheck,
  revokeSeatEventGrant,
  sha256Hex,
  ticketPreCheckPasses,
  underTicketRateLimit,
  underUpgradeRateLimit,
  verifyTicketRequest,
  type HubSocket,
  type SeatAuthorization,
  type SeatHint,
  type SocketState,
  storageTicketStore,
  type TicketRecord,
} from '../src/agents/seat-events'
import { seatEventsApp } from '../src/agents/seat-events-routes'
import { inboxApp } from '../src/agents/inbox-routes'
import { hashMemberToken } from '../src/auth/member-bearer'
import { sendAgentMessage } from '../src/agents/messages'
import { handleQueue } from '../src/bus/consumer'

const TENANT = 't1'
const A1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const A2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const A3 = 'aaaaaaaa-0000-4000-8000-000000000003'
const HOST1 = 'orca-host-one'
const HOST2 = 'orca-host-two'
const CANARY = 'CANARY-BODY-9d41 must never leave D1'
const NOW = 1_790_000_000

const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url')

interface KeyPair { priv: CryptoKey; x: string }
async function keypair(): Promise<KeyPair> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  return { priv: kp.privateKey, x: jwk.x as string }
}

let nonceN = 0
async function signedRequest(
  k: KeyPair,
  p: { host: string; agents: string[]; ts?: number; nonce?: string; tenant?: string },
): Promise<Record<string, unknown>> {
  const ts = p.ts ?? NOW
  const nonce = p.nonce ?? `nonce-${String(++nonceN).padStart(12, '0')}`
  const msg = canonicalTicketMessage({ tenant: p.tenant ?? TENANT, host_agent_id: p.host, agents: p.agents, ts, nonce })
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, k.priv, msg)
  return { host_agent_id: p.host, agents: p.agents, ts, nonce, sig: b64url(sig) }
}

interface World {
  h: SqliteD1Harness
  env: Env
  k1: KeyPair
  k2: KeyPair
}

async function world(): Promise<World> {
  const h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  const k1 = await keypair()
  const k2 = await keypair()
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('d1', 'd', 'D');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('s1', 'd1', 's', 'S');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES
      ('${A1}', 's1', 'seat-one', 'Seat One', 'member', 'm', 'active'),
      ('${A2}', 's1', 'seat-two', 'Seat Two', 'member', 'm', 'active'),
      ('${A3}', 's1', 'seat-three', 'Seat Three', 'member', 'm', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES
      ('admin', 'Admin', 'active', '${TENANT}'),
      ('host1-m', 'Host One', 'active', '${TENANT}'),
      ('host2-m', 'Host Two', 'active', '${TENANT}'),
      ('seat1-m', 'Seat One', 'active', '${TENANT}');
    INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at) VALUES
      ('${TENANT}', '${HOST1}', '${k1.x}', 'Ed25519', 'host1-m', ${NOW}),
      ('${TENANT}', '${HOST2}', '${k2.x}', 'Ed25519', 'host2-m', ${NOW});
    -- mupot#1594 P2-C: HOST1/HOST2 are fleet-host identities, not agents rows — their OWNING
    -- members (agent_keys.member_id) need standing on squad 's1' (home of A1-A3) so the
    -- existing grant() helper used throughout this suite keeps passing hostHasStandingInSquad.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-host1-s1', 'host1-m', 'squad', 's1', 'member'),
      ('cap-host2-s1', 'host2-m', 'squad', 's1', 'member');
  `)
  const env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  return { h, env, k1, k2 }
}

let msgN = 0
function insertMessage(w: World, to: string, opts: { read?: boolean; body?: string } = {}): { id: string; seq: number } {
  const id = `msg-${++msgN}`
  w.h.sqlite.exec(`
    INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to,
                                created_at, project_id, target_seat, body_length, checksum_sha256, read_at)
    VALUES ('${id}', '${TENANT}', '${to}', 'kasra', 'm-k', 'message', '${opts.body ?? CANARY}', NULL, NULL,
            '2026-09-27T00:00:00Z', NULL, NULL, 10, '${'0'.repeat(64)}', ${opts.read ? "'2026-09-27T00:00:01Z'" : 'NULL'})`)
  const row = w.h.sqlite.prepare(`SELECT seq FROM agent_messages WHERE id = ?`).get(id) as { seq: number }
  return { id, seq: Number(row.seq) }
}

const grant = (w: World, host: string, agent: string) =>
  createSeatEventGrant(w.env, { hostAgentId: host, agentId: agent, memberId: 'admin', reason: 'test' })

/** Mint a member-token bearer welded (agent-bound) to `agent`, for P1-1's agent-bound-caller
 *  probes. Mirrors the pattern every other bearer-identity test in this suite already uses
 *  (seat1-m's per-agent tokens above) — just parameterized. */
async function seatToken(w: World, agent: string, member: string, raw: string): Promise<void> {
  w.h.sqlite.exec(`INSERT OR IGNORE INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
    VALUES ('${TENANT}', '${agent}', '${member}', datetime('now'))`)
  w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id)
    VALUES ('tok-${raw}', '${member}', '${await hashMemberToken(raw)}', '', 'workspace', datetime('now'), '${TENANT}', '${agent}')`)
}

// mupot#1594 P1-A: `attachment` stands in for the real WebSocket's serializeAttachment
// payload — a plain object living on the socket instance ITSELF, never on any hub/tracker
// object. That is what makes "drop the in-memory state, keep the attachment" testable: a
// test simulates hibernation by building a BRAND NEW SeatEventsHub (fresh junk/recent, like a
// freshly-woken DO instance) over the SAME FakeSocket instances — the attachment survives
// that exactly like a real WebSocket's does across a real hibernate/evict cycle.
class FakeSocket implements HubSocket {
  sent: string[] = []
  closed: { code: number; reason: string } | null = null
  private attachment: { connectedAt?: number; sub?: SocketState } = {}
  send(d: string) {
    if (this.closed) throw new Error('closed')
    this.sent.push(d)
  }
  close(code: number, reason: string) {
    this.closed = { code, reason }
  }
  getState() {
    return this.attachment.sub ?? null
  }
  setState(s: SocketState) {
    this.attachment = { ...this.attachment, sub: s }
  }
  getConnectedAt() {
    return this.attachment.connectedAt
  }
  markConnected(nowSec: number) {
    if (this.attachment.connectedAt === undefined) this.attachment = { ...this.attachment, connectedAt: nowSec }
  }
  frames(): Record<string, any>[] {
    return this.sent.map((s) => JSON.parse(s))
  }
  of(type: string) {
    return this.frames().filter((f) => f.type === type)
  }
}

/** In-memory DurableObjectStorage subset, driving the REAL storageTicketStore the DO uses. */
function memTickets(nowSec: () => number) {
  const raw = new Map<string, unknown>()
  const storage = {
    async get<T>(k: string) {
      return raw.get(k) as T | undefined
    },
    async put<T>(k: string, v: T) {
      raw.set(k, v)
    },
    async delete(k: string | string[]) {
      for (const x of Array.isArray(k) ? k : [k]) raw.delete(x)
    },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...raw].filter(([k]) => k.startsWith(prefix))) as Map<string, T>
    },
  }
  const store = storageTicketStore(storage, nowSec)
  return Object.assign(store, {
    map: {
      has: (h: string) => raw.has(`ticket:${h}`),
      keys: () => [...raw.keys()].map((k) => k.replace(/^ticket:/, '')),
      dump: () => JSON.stringify([...raw]),
    },
  })
}

function hubFor(w: World, opts: { now?: () => number; authorize?: (host: string, agent: string) => Promise<SeatAuthorization> } = {}) {
  const sockets: FakeSocket[] = []
  const nowSec = opts.now ?? (() => NOW)
  const tickets = memTickets(nowSec)
  const recent = new RecentIds()
  const junk = createJunkTracker()
  const hub = () => new SeatEventsHub(w.env, { sockets: () => sockets, tickets, nowSec, recent, authorize: opts.authorize, junk })
  async function ticketFor(host: string, agents: string[], ttl = TICKET_TTL_SEC) {
    const { ticket, hash } = await mintTicketSecret()
    await tickets.put(hash, { host, agents, expires_at: nowSec() + ttl })
    return ticket
  }
  /** Simulates the DO's /connect: push a bare accepted socket and mark it connected, WITHOUT
   *  sending hello — the pending-auth state a real WebSocket sits in between accept and hello. */
  function acceptRaw(): FakeSocket {
    const s = new FakeSocket()
    sockets.push(s)
    hub().noteConnected(s)
    return s
  }
  async function connect(ticket: string, since: Record<string, number> = {}) {
    const s = acceptRaw()
    await hub().onMessage(s, JSON.stringify({ type: 'hello', v: 1, ticket, since }))
    return s
  }
  /** mupot#1594 P1-A: simulate a hibernate/evict cycle — a BRAND NEW SeatEventsHub, with
   *  fresh (empty) junk/recent trackers, built over the SAME socket instances. Anything the
   *  hub kept in its OWN memory (junk counts, hint dedup) is gone, exactly like a real DO
   *  instance's fields after eviction; anything on the sockets' own attachments (state,
   *  connectedAt) survives, exactly like real WebSocket attachments do. */
  function hibernate() {
    return new SeatEventsHub(w.env, { sockets: () => sockets, tickets, nowSec, authorize: opts.authorize, recent: new RecentIds(), junk: createJunkTracker() })
  }
  return { sockets, tickets, hub, ticketFor, connect, acceptRaw, hibernate }
}

const hintFor = (agent: string, m: { id: string; seq: number }, extra: Record<string, unknown> = {}): SeatHint =>
  hintFromPayload({
    message_id: m.id, seq: m.seq, to_agent: agent, from_agent: 'kasra', from_member: 'm-k', kind: 'message',
    created_at: '2026-09-27T00:00:00Z', ...extra,
  } as MessageCreatedPayload)!

// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('body leakage', () => {
  it('a hint is built from an allowlist: body and any unknown field are dropped', () => {
    const h = hintFromPayload({ message_id: 'm', seq: 1, to_agent: A1, from_agent: 'x', body: CANARY, secret: 'x' } as never)
    expect(Object.keys(h!).sort()).toEqual(
      ['created_at', 'from_agent', 'id', 'in_reply_to', 'kind', 'project_id', 'request_id', 'seq', 'target_seat', 'to_agent'],
    )
    expect(JSON.stringify(h)).not.toContain('CANARY')
    expect(JSON.stringify(normalizeHint({ ...h, body: CANARY }))).not.toContain('CANARY')
  })

  it('catch-up reads D1 rows whose body is the canary and never discloses it', async () => {
    const w = await world()
    insertMessage(w, A1)
    const b = await backlogFor(w.env, A1, 0)
    expect(b.hints).toHaveLength(1)
    expect(JSON.stringify(b)).not.toContain('CANARY')
  })

  it('end to end: sendAgentMessage → message.created → handleQueue → DO → socket carries no body', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const sock = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const bus: BusEvent[] = []
    const env = {
      ...w.env,
      DB: withRealRowIds(w),
      BUS: { send: async (e: BusEvent) => void bus.push(e) },
      REALTIME_SEAT_EVENTS: '1',
      SEAT_EVENTS: namespaceOver(hub),
    } as unknown as Env
    const sent = await sendAgentMessage(env, { toAgent: A1, fromAgent: A2, fromMember: 'seat1-m', body: CANARY } as never)
    expect(sent.ok).toBe(true)
    expect(bus).toHaveLength(1)
    const item = { body: bus[0], id: 'q1', attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await handleQueue({ messages: [item] } as never, env)
    expect(item.ack).toHaveBeenCalledOnce()
    const hints = sock.of('hint')
    expect(hints).toHaveLength(1)
    expect(hints[0].hint.seq).toBe((sent as { seq: number }).seq)
    expect(sock.sent.join('')).not.toContain('CANARY')
  })
})

/** tests/helpers/sqlite-d1 reports meta.last_row_id = 0; production D1 reports the rowid, which
 *  sendAgentMessage turns into the message seq. Restore that one fact for the end-to-end test. */
function withRealRowIds(w: World): Env['DB'] {
  const wrap = (st: any): any =>
    new Proxy(st, {
      get(t, k) {
        if (k === 'bind') return (...v: unknown[]) => wrap(t.bind(...v))
        if (k === 'run')
          return async () => {
            const r = await t.run()
            const row = w.h.sqlite.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }
            return { ...r, meta: { ...r.meta, last_row_id: Number(row.id) } }
          }
        const v = t[k]
        return typeof v === 'function' ? v.bind(t) : v
      },
    })
  return new Proxy(w.env.DB, {
    get(t: any, k) {
      if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql))
      const v = t[k]
      return typeof v === 'function' ? v.bind(t) : v
    },
  }) as Env['DB']
}

/** A DurableObjectNamespace stand-in that routes Worker → DO calls into a hub. */
function namespaceOver(hub: ReturnType<typeof hubFor>, onFetch?: (req: Request) => void) {
  return {
    idFromName: (n: string) => n,
    get: () => ({
      async fetch(req: Request) {
        onFetch?.(req)
        const url = new URL(req.url)
        if (url.pathname === '/hint') {
          const hint = normalizeHint(await req.json())
          return Response.json({ ok: true, ...(await hub.hub().publish(hint!)) })
        }
        if (url.pathname === '/ticket') {
          const b = (await req.json()) as TicketRecord & { hash: string }
          await hub.tickets.put(b.hash, { host: b.host, agents: b.agents, expires_at: b.expires_at })
          return Response.json({ ok: true })
        }
        if (url.pathname === '/connect') {
          return Response.json({ headers: [...req.headers.keys()] })
        }
        return new Response('nf', { status: 404 })
      },
    }),
  }
}

describe('cross-agent / cross-host subscription', () => {
  it('a ticket only covers agents granted to the signing host', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    await grant(w, HOST2, A2)
    const r = await verifyTicketRequest(w.env, await signedRequest(w.k1, { host: HOST1, agents: [A1, A2, A3] }), () => NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.granted).toEqual([A1])
    expect(r.refused.map((x) => x.agent).sort()).toEqual([A2, A3])
  })

  it('a host with no grant for any listed agent gets 403, and cannot sign as another host', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const none = await verifyTicketRequest(w.env, await signedRequest(w.k2, { host: HOST2, agents: [A1] }), () => NOW)
    expect(none).toMatchObject({ ok: false, status: 403 })
    const impostor = await verifyTicketRequest(w.env, await signedRequest(w.k2, { host: HOST1, agents: [A1] }), () => NOW)
    expect(impostor).toMatchObject({ ok: false, status: 401 })
  })

  it("one host, two sockets: each hint goes only to the socket that subscribed that agent", async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    await grant(w, HOST1, A2)
    const hub = hubFor(w)
    const s1 = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const s2 = await hub.connect(await hub.ticketFor(HOST1, [A2]))
    await hub.hub().publish(hintFor(A2, insertMessage(w, A2)))
    expect(s1.sent.filter((f) => f.includes(A2))).toEqual([])
    expect(s2.of('hint')).toHaveLength(1)
  })

  it("a socket holding A1 never receives A2's hints", async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    await grant(w, HOST2, A2)
    const hub = hubFor(w)
    const s1 = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const s2 = await hub.connect(await hub.ticketFor(HOST2, [A2]))
    await hub.hub().publish(hintFor(A2, insertMessage(w, A2)))
    expect(s1.of('hint')).toHaveLength(0)
    expect(s2.of('hint')).toHaveLength(1)
  })
})

describe('forged / expired / replayed tickets and signatures', () => {
  it('forged, expired and reused tickets are refused and the socket is closed', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    let now = NOW
    const hub = hubFor(w, { now: () => now })
    const forged = await hub.connect('A'.repeat(43))
    expect(forged.of('error')[0].reason).toBe('ticket_invalid')
    expect(forged.closed?.code).toBe(CLOSE_TICKET_INVALID)

    const t = await hub.ticketFor(HOST1, [A1])
    const first = await hub.connect(t)
    expect(first.of('ready')[0].subscriptions).toEqual([{ agent: A1, ok: true }])
    const reused = await hub.connect(t)
    expect(reused.of('error')[0].reason).toBe('ticket_invalid')

    const late = await hub.ticketFor(HOST1, [A1])
    now += TICKET_TTL_SEC + 1
    const expired = await hub.connect(late)
    expect(expired.of('error')[0].reason).toBe('ticket_invalid')
  })

  it('replayed nonce, stale ts, tampered agent list and another tenant all fail', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    await grant(w, HOST1, A2)
    const req = await signedRequest(w.k1, { host: HOST1, agents: [A1] })
    expect((await verifyTicketRequest(w.env, req, () => NOW)).ok).toBe(true)
    expect(await verifyTicketRequest(w.env, req, () => NOW)).toMatchObject({ ok: false, status: 409, error: 'replay' })
    const stale = await signedRequest(w.k1, { host: HOST1, agents: [A1], ts: NOW - 3600 })
    expect(await verifyTicketRequest(w.env, stale, () => NOW)).toMatchObject({ ok: false, status: 401 })
    const tampered = { ...(await signedRequest(w.k1, { host: HOST1, agents: [A1] })), agents: [A1, A2] }
    expect(await verifyTicketRequest(w.env, tampered, () => NOW)).toMatchObject({ ok: false, status: 401 })
    const other = await signedRequest(w.k1, { host: HOST1, agents: [A1], tenant: 'other-pot' })
    expect(await verifyTicketRequest(w.env, other, () => NOW)).toMatchObject({ ok: false, status: 401 })
  })

  it('expired tickets are purged when the next ticket is minted (no timer)', async () => {
    const w = await world()
    let now = NOW
    const hub = hubFor(w, { now: () => now })
    await hub.ticketFor(HOST1, [A1])
    now += TICKET_TTL_SEC + 1
    await hub.tickets.purgeExpired()
    expect(hub.tickets.map.keys()).toEqual([])
  })

  it('tickets are stored only as a hash', async () => {
    const w = await world()
    const hub = hubFor(w)
    const t = await hub.ticketFor(HOST1, [A1])
    expect(hub.tickets.map.keys()).toEqual([await sha256Hex(t)])
    expect(hub.tickets.map.dump()).not.toContain(t)
  })
})

describe('duplicate / replayed events', () => {
  it('the same committed message published twice (Queue redelivery) reaches the host once', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const s = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const h = hintFor(A1, insertMessage(w, A1))
    expect((await hub.hub().publish(h)).sent).toBe(1)
    expect(await hub.hub().publish(h)).toMatchObject({ sent: 0, duplicate: true })
    expect(s.of('hint')).toHaveLength(1)
  })

  it('P1-3: a down seat DO is isolated — Hermes still runs exactly once and the message acks', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const s = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const m = insertMessage(w, A1)
    const hermes = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { event_id: string }
      return new Response(JSON.stringify({ accepted: true, event_id: body.event_id }), { status: 200 })
    })
    vi.stubGlobal('fetch', hermes)
    const ns = namespaceOver(hub)
    const down = { idFromName: ns.idFromName, get: () => ({ fetch: async () => new Response('down', { status: 503 }) }) }
    const env = {
      ...w.env,
      REALTIME_SEAT_EVENTS: '1',
      SEAT_EVENTS: down,
      HERMES_EVENTS_WEBHOOK_URL: 'https://hermes.example/webhooks/x',
      HERMES_WEBHOOK_SECRET: 's',
    } as unknown as Env
    const ev = { type: 'message.created', tenant: TENANT, payload: { message_id: m.id, seq: m.seq, to_agent: A1, from_agent: 'k', from_member: 'x', kind: 'message', created_at: 'now' } } as BusEvent
    const i1 = { body: ev, id: 'q', attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await handleQueue({ messages: [i1] } as never, env)
    // The seat leg failed (DO 503) but never throws — Hermes ran anyway and its own outcome
    // (delivered) is the only thing that decided ack vs retry.
    expect(i1.ack).toHaveBeenCalledOnce()
    expect(i1.retry).not.toHaveBeenCalled()
    expect(hermes).toHaveBeenCalledOnce()
    expect(s.of('hint')).toHaveLength(0) // the DO never actually received the hint while down
    vi.unstubAllGlobals()
  })

  it('P1-3 control: with the flag off, seat is skipped and Hermes behaviour is unchanged', async () => {
    const w = await world()
    const m = insertMessage(w, A1)
    const hermes = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { event_id: string }
      return new Response(JSON.stringify({ accepted: true, event_id: body.event_id }), { status: 200 })
    })
    vi.stubGlobal('fetch', hermes)
    const env = {
      ...w.env,
      HERMES_EVENTS_WEBHOOK_URL: 'https://hermes.example/webhooks/x',
      HERMES_WEBHOOK_SECRET: 's',
    } as unknown as Env
    const ev = { type: 'message.created', tenant: TENANT, payload: { message_id: m.id, seq: m.seq, to_agent: A1, from_agent: 'k', from_member: 'x', kind: 'message', created_at: 'now' } } as BusEvent
    const c = { body: ev, id: 'q', attempts: 1, ack: vi.fn(), retry: vi.fn() }
    await handleQueue({ messages: [c] } as never, env)
    expect(c.ack).toHaveBeenCalledOnce()
    expect(hermes).toHaveBeenCalledOnce()
    vi.unstubAllGlobals()
  })

  it('with the channel off the consumer never calls the DO (and Hermes behaviour is unchanged)', async () => {
    const fetchSpy = vi.fn()
    const r = await publishSeatHint({ TENANT_SLUG: TENANT, SEAT_EVENTS: { idFromName: fetchSpy, get: fetchSpy } } as unknown as Env, TENANT, {})
    expect(r).toEqual({ ok: true, skipped: true, reason: 'disabled' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('sequence gaps and reconnect catch-up', () => {
  it('catch-up returns only this agent\'s unread rows above the cursor; gaps are normal', async () => {
    const w = await world()
    const a = insertMessage(w, A1)
    insertMessage(w, A2) // another agent's row makes a gap in A1's seqs
    const b = insertMessage(w, A1)
    insertMessage(w, A1, { read: true }) // consumed by the seat: not re-announced
    const c = insertMessage(w, A1)
    const r = await backlogFor(w.env, A1, a.seq)
    expect(r.hints.map((h) => h.seq)).toEqual([b.seq, c.seq])
    expect(r.unread).toBe(3)
    expect(r.complete).toBe(true)
  })

  it('a message whose hint was lost while the host was away arrives in the reconnect backlog', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const s1 = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const seen = insertMessage(w, A1)
    await hub.hub().publish(hintFor(A1, seen))
    s1.close(1006, 'network')
    hub.sockets.splice(0, 1)
    const lost = insertMessage(w, A1) // committed while offline; its publish found no socket
    await hub.hub().publish(hintFor(A1, lost))
    const s2 = await hub.connect(await hub.ticketFor(HOST1, [A1]), { [A1]: seen.seq })
    const bl = s2.of('backlog')[0]
    expect(bl.agent).toBe(A1)
    expect(bl.hints.map((h: SeatHint) => h.id)).toEqual([lost.id])
  })
})

describe('backpressure', () => {
  it(`a burst is capped at ${BACKLOG_HINT_LIMIT} hints with an exact unread count`, async () => {
    const w = await world()
    for (let i = 0; i < 120; i++) insertMessage(w, A1)
    const r = await backlogFor(w.env, A1, 0)
    expect(r.hints).toHaveLength(BACKLOG_HINT_LIMIT)
    expect(r.unread).toBe(120)
    expect(r.complete).toBe(false)
  })

  it(`a ticket request for more than ${MAX_AGENTS_PER_TICKET} agents is refused before any crypto`, async () => {
    const w = await world()
    const agents = Array.from({ length: MAX_AGENTS_PER_TICKET + 1 }, (_, i) => `agent-${i}`)
    expect(await verifyTicketRequest(w.env, await signedRequest(w.k1, { host: HOST1, agents }), () => NOW)).toMatchObject({ ok: false, status: 400 })
  })

  it('the DO dedup memory is bounded', () => {
    const r = new RecentIds(3)
    for (const id of ['a', 'b', 'c', 'd']) r.add(id)
    expect(r.add('a')).toBe(true) // evicted, so seen as new; the host floor still dedups it
    expect(r.add('d')).toBe(false)
  })
})

describe('revoked ownership', () => {
  it('revoking the grant turns the next hint into a revoked frame and stops disclosure', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const s = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    await revokeSeatEventGrant(w.env, { agentId: A1, memberId: 'admin' })
    const r = await hub.hub().publish(hintFor(A1, insertMessage(w, A1)))
    expect(r).toMatchObject({ sent: 0, revoked: 1 })
    expect(s.of('hint')).toHaveLength(0)
    expect(s.of('revoked')[0]).toMatchObject({ agent: A1, reason: 'grant_revoked' })
    await hub.hub().publish(hintFor(A1, insertMessage(w, A1)))
    expect(s.of('hint')).toHaveLength(0)
  })

  it('a grant revoked between mint and connect does not open; a disabled host member stops disclosure', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    await grant(w, HOST1, A2)
    const hub = hubFor(w)
    const t = await hub.ticketFor(HOST1, [A1, A2])
    await revokeSeatEventGrant(w.env, { agentId: A2, memberId: 'admin' })
    const s = await hub.connect(t)
    expect(s.of('ready')[0].subscriptions).toEqual([{ agent: A1, ok: true }, { agent: A2, ok: false, reason: 'not_granted' }])
    w.h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'host1-m'`)
    expect(await hostMayReceive(w.env, HOST1, A1)).toBe(false)
    await hub.hub().publish(hintFor(A1, insertMessage(w, A1)))
    expect(s.of('revoked')).toHaveLength(1)
  })

  it('mupot#1589 P2-3: one transient D1 error during publish is skipped, never read as a revocation', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    let failNext = false
    const flakyDb = new Proxy(w.env.DB as unknown as Record<string, unknown>, {
      get(t, k) {
        if (k === 'prepare') {
          return (sql: string) => {
            if (failNext && sql.includes('seat_event_grants g')) {
              failNext = false
              throw new Error('D1_ERROR: transient')
            }
            return (t.prepare as (s: string) => unknown)(sql)
          }
        }
        const v = (t as Record<string, unknown>)[k as string]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
    const env2 = { ...w.env, DB: flakyDb } as unknown as Env
    const w2 = { ...w, env: env2 }
    const hub = hubFor(w2 as World)
    const s = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    failNext = true
    const r1 = await hub.hub().publish(hintFor(A1, insertMessage(w, A1)))
    // the transient error skips THIS hint — no 'revoked' frame, socket stays open
    expect(r1).toMatchObject({ sent: 0, revoked: 0 })
    expect(s.of('revoked')).toHaveLength(0)
    expect(s.closed).toBeNull()
    // the NEXT hint, once D1 recovers, delivers normally — the grant was never actually touched
    const r2 = await hub.hub().publish(hintFor(A1, insertMessage(w, A1)))
    expect(r2).toMatchObject({ sent: 1, revoked: 0 })
    expect(s.of('hint')).toHaveLength(1)
    expect(await hostMayReceive(w.env, HOST1, A1)).toBe(true)
  })

  it('mupot#1589 P2-3: a transient error checking the CURRENT holder never lets a newcomer steal the agent', async () => {
    const w = await world()
    // The holder's OWN hello (1st call for (HOST1,A1)) must succeed so it actually holds the
    // agent; only the LATER claim-time re-check of that same (host, agent) pair — made while
    // the newcomer is connecting — hits the transient error.
    let hostOneCalls = 0
    const hub = hubFor(w, {
      authorize: async (host) => {
        if (host !== HOST1) return 'granted' // the newcomer's own per-agent check
        hostOneCalls++
        return hostOneCalls === 1 ? 'granted' : 'error'
      },
    })
    const holder = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const newcomer = await hub.connect(await hub.ticketFor(HOST2, [A1]))
    expect(newcomer.of('ready')[0].subscriptions[0]).toMatchObject({ agent: A1, ok: false, reason: 'held_by_other_host' })
    expect(holder.of('revoked')).toHaveLength(0)
    expect(holder.getState()?.agents).toEqual([A1])
  })
})

describe('dual-consumer conflict (one consumer per UUID)', () => {
  it('a second live grant for the same agent is refused by the durable fence', async () => {
    const w = await world()
    expect((await grant(w, HOST1, A1)).ok).toBe(true)
    expect(await grant(w, HOST2, A1)).toEqual({ ok: false, reason: 'agent_already_granted' })
    await revokeSeatEventGrant(w.env, { agentId: A1, memberId: 'admin' })
    expect((await grant(w, HOST2, A1)).ok).toBe(true) // explicit move: revoke then grant
  })

  it('the same host reconnecting supersedes its old socket; the old one stops receiving', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const old = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const neu = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    expect(old.of('superseded')[0].agent).toBe(A1)
    expect(old.closed).not.toBeNull()
    await hub.hub().publish(hintFor(A1, insertMessage(w, A1)))
    expect(old.of('hint')).toHaveLength(0)
    expect(neu.of('hint')).toHaveLength(1)
  })

  it('an agent held by another still-authorized host is refused, not stolen', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    await hub.connect(await hub.ticketFor(HOST1, [A1]))
    // A stale ticket for HOST2 (minted before the grant moved away from it, say) must not win.
    const intruder = await hub.connect(await hub.ticketFor(HOST2, [A1]))
    expect(intruder.of('ready')[0].subscriptions[0]).toMatchObject({ agent: A1, ok: false })
  })

  it('if two hosts were ever both authorized, the holder keeps the agent (claim guard, independent of the grant index)', async () => {
    const w = await world()
    const hub = hubFor(w, { authorize: async () => 'granted' })
    const holder = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const other = await hub.connect(await hub.ticketFor(HOST2, [A1]))
    expect(other.of('ready')[0].subscriptions).toEqual([{ agent: A1, ok: false, reason: 'held_by_other_host' }])
    expect(holder.of('revoked')).toHaveLength(0)
    expect(holder.getState()?.agents).toEqual([A1])
  })

  it('a moved grant evicts the old host socket as revoked', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const old = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    await revokeSeatEventGrant(w.env, { agentId: A1, memberId: 'admin' })
    await grant(w, HOST2, A1)
    const neu = await hub.connect(await hub.ticketFor(HOST2, [A1]))
    expect(neu.of('ready')[0].subscriptions).toEqual([{ agent: A1, ok: true }])
    expect(old.of('revoked')[0]).toMatchObject({ agent: A1, reason: 'grant_moved' })
  })

  it('the legacy per-agent stream is closed to an agent whose hints a fleet host owns (Herdr fence)', async () => {
    const w = await world()
    const raw = 'seat-one-token'
    w.h.sqlite.exec(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${A1}', 'seat1-m', datetime('now'))`)
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id)
      VALUES ('tok1', 'seat1-m', '${await hashMemberToken(raw)}', '', 'workspace', datetime('now'), '${TENANT}', '${A1}')`)
    const hub = hubFor(w)
    const on = { ...w.env, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: namespaceOver(hub) } as unknown as Env
    const ac = new AbortController()
    const open = await inboxApp.request('/stream', { headers: { Authorization: `Bearer ${raw}` }, signal: ac.signal }, on)
    expect(open.status).toBe(200)
    ac.abort()
    await grant(w, HOST1, A1)
    const fenced = await inboxApp.request('/stream', { headers: { Authorization: `Bearer ${raw}` } }, on)
    expect(fenced.status).toBe(409)
    expect(await fenced.json()).toMatchObject({ error: 'notify_owned_by_fleet_host', host_agent_id: HOST1 })
    const off = await inboxApp.request('/stream', { headers: { Authorization: `Bearer ${raw}` }, signal: ac.signal }, w.env)
    expect(off.status).toBe(200) // flag off: behaviour exactly as before
  })
})

describe('redirect / bearer leakage (HTTP surface)', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('every path answers JSON, never a redirect — flag off, unknown path, wrong method', async () => {
    const w = await world()
    for (const [path, init] of [
      ['/ticket', { method: 'POST', body: '{}' }],
      ['/', {}],
      ['/nope', {}],
    ] as const) {
      const r = await seatEventsApp.request(path, init, w.env)
      expect(r.status).toBe(404)
      expect(r.headers.get('location')).toBeNull()
      expect(r.headers.get('content-type')).toContain('json')
    }
  })

  it('a bearer alone mints nothing, and a minted ticket response is no-store', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const env = { ...w.env, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: namespaceOver(hub) } as unknown as Env
    const bearerOnly = await seatEventsApp.request('/ticket', { method: 'POST', headers: { Authorization: 'Bearer x' }, body: '{}' }, env)
    expect(bearerOnly.status).toBe(400)
    const req = await signedRequest(w.k1, { host: HOST1, agents: [A1], ts: Math.floor(Date.now() / 1000) })
    const ok = await seatEventsApp.request('/ticket', { method: 'POST', body: JSON.stringify(req) }, env)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    const body = (await ok.json()) as { ticket: string; agents: string[] }
    expect(body.agents).toEqual([A1])
    expect(hub.tickets.map.has(await sha256Hex(body.ticket))).toBe(true)
  })

  it('the WebSocket upgrade reaches the DO without Authorization or Cookie, given a well-formed, pre-checked ticket', async () => {
    const w = await world()
    let seen: string[] = []
    const hub = hubFor(w)
    const env = {
      ...w.env,
      REALTIME_SEAT_EVENTS: '1',
      SEAT_EVENTS: namespaceOver(hub, (req) => (seen = [...req.headers.keys()])),
    } as unknown as Env
    const ticket = 'A'.repeat(43)
    // mupot#1594 P1-A: the route now pre-checks the ticket against seat_events_tickets before
    // ever forwarding — a shape-only ticket with no matching row would be refused at 401
    // without reaching the DO at all (covered by the forged-ticket test below).
    await recordTicketPreCheck(env, await sha256Hex(ticket), Math.floor(Date.now() / 1000) + TICKET_TTL_SEC)
    await seatEventsApp.request(`/?ticket=${ticket}`, {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer secret', Cookie: 'sid=1', 'Sec-WebSocket-Key': 'k' },
    }, env)
    expect(seen).toContain('upgrade')
    expect(seen).not.toContain('authorization')
    expect(seen).not.toContain('cookie')
  })

  it('mupot#1589 P1-2: an upgrade with no ticket at all is refused before the DO is ever reached', async () => {
    const w = await world()
    let reached = false
    const hub = hubFor(w)
    const env = {
      ...w.env,
      REALTIME_SEAT_EVENTS: '1',
      SEAT_EVENTS: namespaceOver(hub, () => { reached = true }),
    } as unknown as Env
    const noTicket = await seatEventsApp.request('/', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'k' } }, env)
    expect(noTicket.status).toBe(401)
    expect(reached).toBe(false)
    const badTicket = await seatEventsApp.request('/?ticket=not-even-close-to-43-chars', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'k' },
    }, env)
    expect(badTicket.status).toBe(401)
    expect(reached).toBe(false)
  })

  it('grants need an org-admin bearer: none and a plain member are both refused', async () => {
    const w = await world()
    const body = JSON.stringify({ host_agent_id: HOST1, agent_id: A1, reason: 'x' })
    expect((await seatEventsApp.request('/grants', { method: 'POST', body }, w.env)).status).toBe(403)
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-host', 'host1-m', '${await hashMemberToken('member-tok')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    const member = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer member-tok' }, body }, w.env)
    // host1-m holds only 'member' (not 'lead'+) on s1 from world()'s own fixture (mupot#1594
    // P2-C standing) — below authorizeGrantTarget's rank ceiling, so the uniform 404 oracle
    // applies (mupot#1594 P3), same as a nonexistent agent would.
    expect(member.status).toBe(404)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'host1-m', 'org', NULL, 'admin')`)
    const admin = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer member-tok' }, body }, w.env)
    expect(admin.status).toBe(200)
  })
})

// ═════════════ mupot#1589 P1-1: grant writes need a human member principal + a squad rank ceiling ═════════════
describe('grant writer authorization (P1-1)', () => {
  it('an agent-bound token is refused on BOTH create and revoke, even when its member holds org admin', async () => {
    const w = await world()
    w.h.sqlite.exec(`INSERT INTO members (id, display_name, status, tenant) VALUES ('agent3-m', 'Seat Three', 'active', '${TENANT}')`)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-ag', 'agent3-m', 'org', NULL, 'admin')`)
    await seatToken(w, A3, 'agent3-m', 'agent-three-tok')
    const body = JSON.stringify({ host_agent_id: HOST2, agent_id: A1, reason: 'x' })
    const create = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer agent-three-tok' }, body }, w.env)
    expect(create.status).toBe(403)
    expect(await create.json()).toMatchObject({ error: 'operator_principal_required' })
    await grant(w, HOST1, A1) // a real grant to attempt revoking
    const revoke = await seatEventsApp.request('/grants/' + A1, { method: 'DELETE', headers: { Authorization: 'Bearer agent-three-tok' } }, w.env)
    expect(revoke.status).toBe(403)
    expect(await revoke.json()).toMatchObject({ error: 'operator_principal_required' })
  })

  it('a squad lead may grant/revoke for an agent on their OWN squad without org admin', async () => {
    const w = await world()
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-lead', 'seat1-m', '${await hashMemberToken('lead-tok')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-lead', 'seat1-m', 'squad', 's1', 'lead')`)
    const body = JSON.stringify({ host_agent_id: HOST1, agent_id: A1, reason: 'squad self-serve' })
    const create = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer lead-tok' }, body }, w.env)
    expect(create.status).toBe(200)
    const revoke = await seatEventsApp.request('/grants/' + A1, { method: 'DELETE', headers: { Authorization: 'Bearer lead-tok' } }, w.env)
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toMatchObject({ revoked: 1 })
  })

  it('a member of ANOTHER squad is refused, never cross-squad', async () => {
    const w = await world()
    w.h.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('s2', 'd1', 's2', 'S2');
      INSERT INTO members (id, display_name, status, tenant) VALUES ('other-m', 'Other', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-other', 'other-m', 'squad', 's2', 'lead');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
        VALUES ('tok-other', 'other-m', '${await hashMemberToken('other-tok')}', '', 'workspace', datetime('now'), '${TENANT}');
    `)
    const body = JSON.stringify({ host_agent_id: HOST1, agent_id: A1, reason: 'x' }) // A1 is on s1, not s2
    const create = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer other-tok' }, body }, w.env)
    // mupot#1594 P3: uniform existence oracle — no standing on A1's squad reads identically
    // to A1 not existing at all (404 agent_not_visible), never a distinguishable 403.
    expect(create.status).toBe(404)
    expect(await create.json()).toMatchObject({ error: 'agent_not_visible' })
    await grant(w, HOST1, A1)
    const revoke = await seatEventsApp.request('/grants/' + A1, { method: 'DELETE', headers: { Authorization: 'Bearer other-tok' } }, w.env)
    expect(revoke.status).toBe(404)
  })

  it('a member below lead (a plain squad member) is refused, same uniform oracle', async () => {
    const w = await world()
    w.h.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES ('junior-m', 'Junior', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-junior', 'junior-m', 'squad', 's1', 'member');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
        VALUES ('tok-junior', 'junior-m', '${await hashMemberToken('junior-tok')}', '', 'workspace', datetime('now'), '${TENANT}');
    `)
    const body = JSON.stringify({ host_agent_id: HOST1, agent_id: A1, reason: 'x' })
    const create = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer junior-tok' }, body }, w.env)
    expect(create.status).toBe(404)
    expect(await create.json()).toMatchObject({ error: 'agent_not_visible' })
  })

  // ═════════════ mupot#1594 P3: uniform 404 existence oracle on a TRULY missing agent ═════════
  it('a truly nonexistent agent id gets the SAME 404 agent_not_visible as no-standing', async () => {
    const w = await world()
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-lead2', 'seat1-m', '${await hashMemberToken('lead-tok-2')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-lead2', 'seat1-m', 'squad', 's1', 'lead')`)
    const body = JSON.stringify({ host_agent_id: HOST1, agent_id: 'does-not-exist', reason: 'x' })
    const r = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer lead-tok-2' }, body }, w.env)
    expect(r.status).toBe(404)
    expect(await r.json()).toMatchObject({ error: 'agent_not_visible' })
  })
})

// ═════════════ mupot#1589 P1-2: authenticated-DO-socket controls (deadline, junk, caps) ═════════════
describe('WebSocket abuse controls (P1-2)', () => {
  it('a socket that connects and never sends hello is closed once the auth deadline passes', async () => {
    const w = await world()
    let now = NOW
    const hub = hubFor(w, { now: () => now })
    const pending = hub.acceptRaw()
    expect(hub.hub().enforceAuthDeadline()).toBe(0) // not yet due
    expect(pending.closed).toBeNull()
    now += AUTH_DEADLINE_SEC
    expect(hub.hub().enforceAuthDeadline()).toBe(1)
    expect(pending.closed).toMatchObject({ code: CLOSE_AUTH_TIMEOUT, reason: 'auth_timeout' })
  })

  it('the auth deadline never touches a socket that already authenticated', async () => {
    const w = await world()
    let now = NOW
    await grant(w, HOST1, A1)
    const hub = hubFor(w, { now: () => now })
    const s = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    now += AUTH_DEADLINE_SEC + 5
    expect(hub.hub().enforceAuthDeadline()).toBe(0)
    expect(s.closed).toBeNull()
  })

  it(`${MAX_JUNK_FRAMES + 1} junk frames close the socket; a well-formed hello never counts as junk`, async () => {
    const w = await world()
    const hub = hubFor(w)
    const s = hub.acceptRaw()
    for (let i = 0; i < MAX_JUNK_FRAMES; i++) {
      await hub.hub().onMessage(s, i % 2 ? '{"type":"x"}' : 'not json')
      expect(s.closed).toBeNull() // under the threshold: still open
    }
    await hub.hub().onMessage(s, '{"type":"x"}') // the one that tips it over
    expect(s.closed).toMatchObject({ code: CLOSE_PROTOCOL_ABUSE, reason: 'junk_frames' })
  })

  it('an oversized frame is closed immediately, independent of the junk counter', async () => {
    const w = await world()
    const hub = hubFor(w)
    const s = hub.acceptRaw()
    await hub.hub().onMessage(s, JSON.stringify({ type: 'hello', v: 1, ticket: 'A'.repeat(43), padding: 'x'.repeat(MAX_FRAME_BYTES) }))
    expect(s.closed).toMatchObject({ code: CLOSE_PROTOCOL_ABUSE, reason: 'frame_too_large' })
  })

  it(`a host cannot hold more than ${MAX_SOCKETS_PER_HOST} concurrent authenticated sockets`, async () => {
    const w = await world()
    const agents = Array.from({ length: MAX_SOCKETS_PER_HOST + 1 }, (_, i) => `agent-h-${i}`)
    w.h.sqlite.exec(
      agents.map((a) => `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('${a}', 's1', '${a}', '${a}', 'member', 'm', 'active')`).join(';\n'),
    )
    for (const a of agents) await grant(w, HOST1, a)
    const hub = hubFor(w)
    const sockets = []
    for (const a of agents) sockets.push(await hub.connect(await hub.ticketFor(HOST1, [a])))
    const last = sockets[sockets.length - 1]
    // The (MAX_SOCKETS_PER_HOST + 1)th socket is refused outright — a distinct error frame,
    // not a partial 'ready' with a not-ok subscription (this is a per-CONNECTION ceiling, not
    // a per-agent one).
    expect(last.of('error')[0]).toMatchObject({ reason: 'host_socket_limit' })
    expect(last.of('ready')).toHaveLength(0)
    expect(last.closed).toMatchObject({ code: CLOSE_TICKET_INVALID, reason: 'host_socket_limit' })
    expect(sockets.slice(0, MAX_SOCKETS_PER_HOST).every((s) => s.of('ready')[0]?.subscriptions[0]?.ok)).toBe(true)
  })

  it('podAcceptRefusal thresholds authenticated and pending SEPARATELY (mupot#1594 P1-A)', () => {
    expect(podAcceptRefusal({ authenticated: 0, pending: 0 })).toBeNull()
    expect(podAcceptRefusal({ authenticated: MAX_SOCKETS_PER_POT - 1, pending: 0 })).toBeNull()
    expect(podAcceptRefusal({ authenticated: MAX_SOCKETS_PER_POT, pending: 0 })).toBe('pot_full')
    expect(podAcceptRefusal({ authenticated: MAX_SOCKETS_PER_POT + 1, pending: 0 })).toBe('pot_full')
    // A pending flood never counts against the authenticated ceiling...
    expect(podAcceptRefusal({ authenticated: 0, pending: MAX_PENDING_SOCKETS_PER_POT - 1 })).toBeNull()
    expect(podAcceptRefusal({ authenticated: 0, pending: MAX_PENDING_SOCKETS_PER_POT })).toBe('pending_full')
    // ...and cannot smuggle its way past the pending cap by pointing at authenticated headroom.
    expect(podAcceptRefusal({ authenticated: 1, pending: MAX_PENDING_SOCKETS_PER_POT })).toBe('pending_full')
  })
})

// ═════════════ mupot#1589 P3: ticket-mint rate limit ═════════════
describe('ticket rate limit (P3)', () => {
  it('the ceiling is atomic under concurrency: exactly max succeed, the rest are refused', async () => {
    const w = await world()
    const calls = Array.from({ length: TICKET_RATE_LIMIT_MAX_PER_IP + 5 }, () => underTicketRateLimit(w.env, '203.0.113.9', NOW * 1000))
    const results = await Promise.all(calls)
    expect(results.filter(Boolean)).toHaveLength(TICKET_RATE_LIMIT_MAX_PER_IP)
  })

  it('different IPs get independent buckets', async () => {
    const w = await world()
    for (let i = 0; i < TICKET_RATE_LIMIT_MAX_PER_IP; i++) expect(await underTicketRateLimit(w.env, '203.0.113.1', NOW * 1000)).toBe(true)
    expect(await underTicketRateLimit(w.env, '203.0.113.1', NOW * 1000)).toBe(false)
    expect(await underTicketRateLimit(w.env, '203.0.113.2', NOW * 1000)).toBe(true)
  })

  it('POST /ticket 429s once the ceiling is hit, keyed on cf-connecting-ip', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const env = { ...w.env, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: namespaceOver(hub) } as unknown as Env
    const req = () => signedRequest(w.k1, { host: HOST1, agents: [A1], ts: Math.floor(Date.now() / 1000) })
    const headers = { 'cf-connecting-ip': '198.51.100.7' }
    let last: Response | null = null
    for (let i = 0; i < TICKET_RATE_LIMIT_MAX_PER_IP; i++) {
      last = await seatEventsApp.request('/ticket', { method: 'POST', headers, body: JSON.stringify(await req()) }, env)
    }
    expect(last?.status).toBe(200)
    const over = await seatEventsApp.request('/ticket', { method: 'POST', headers, body: JSON.stringify(await req()) }, env)
    expect(over.status).toBe(429)
  })
})

// ═════════════ mupot#1589 P2-1: the fence predicate must equal the delivery predicate ═════════════
describe('Herdr fence parity (P2-1)', () => {
  it('a live grant row the host cannot actually use (suspended host member) does not fence the legacy stream', async () => {
    const w = await world()
    const raw = 'seat-two-token'
    w.h.sqlite.exec(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${A1}', 'seat1-m', datetime('now'))`)
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id)
      VALUES ('tok-fence', 'seat1-m', '${await hashMemberToken(raw)}', '', 'workspace', datetime('now'), '${TENANT}', '${A1}')`)
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const on = { ...w.env, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: namespaceOver(hub) } as unknown as Env
    // sanity: with a HEALTHY host, the fence is live (same as the pre-existing Herdr-fence test).
    const fenced = await inboxApp.request('/stream', { headers: { Authorization: `Bearer ${raw}` } }, on)
    expect(fenced.status).toBe(409)
    // now the host member goes suspended: hostMayReceive is false, so delivery could never
    // reach this host either — the fence must match and fall through, not leave the agent dark.
    w.h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'host1-m'`)
    const ac = new AbortController()
    const open = await inboxApp.request('/stream', { headers: { Authorization: `Bearer ${raw}` }, signal: ac.signal }, on)
    expect(open.status).toBe(200)
    ac.abort()
  })
})

// ═════════════ mupot#1594 P2-B: the fence must fail CLOSED on a D1 error, never open ═════════════
describe('Herdr fence fails CLOSED on a D1 error (P2-B)', () => {
  it('a transient D1 error re-authorizing the grant refuses 503, never opens the legacy stream', async () => {
    const w = await world()
    const raw = 'seat-fence-b-token'
    w.h.sqlite.exec(`INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
      VALUES ('${TENANT}', '${A1}', 'seat1-m', datetime('now'))`)
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant, agent_id)
      VALUES ('tok-fence-b', 'seat1-m', '${await hashMemberToken(raw)}', '', 'workspace', datetime('now'), '${TENANT}', '${A1}')`)
    await grant(w, HOST1, A1)
    // Only authorizeSeatDelivery's own query (aliased `seat_event_grants g`) fails — the
    // PRIOR activeSeatEventGrant lookup (unaliased) must still succeed so the fence code path
    // actually reaches the failing call, exactly like the P2-3 publish test's flakyDb.
    const flakyDb = new Proxy(w.env.DB as unknown as Record<string, unknown>, {
      get(t, k) {
        if (k === 'prepare') {
          return (sql: string) => {
            if (sql.includes('seat_event_grants g')) throw new Error('D1_ERROR: transient')
            return (t.prepare as (s: string) => unknown)(sql)
          }
        }
        const v = (t as Record<string, unknown>)[k as string]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
    const on = { ...w.env, DB: flakyDb, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: {} } as unknown as Env
    const r = await inboxApp.request('/stream', { headers: { Authorization: `Bearer ${raw}` } }, on)
    // Before the fix, hostMayReceive's boolean collapse turned this 'error' into `false` —
    // "not eligible" — so `stillEligible` was false, the fence fell through, and the legacy
    // stream opened 200 wide open. It must now refuse, not open.
    expect(r.status).toBe(503)
    expect(await r.json()).toMatchObject({ error: 'fence_check_failed' })
    expect(r.headers.get('retry-after')).toBe('2')
  })
})

// ═════════════ mupot#1594 P2-C: grant scope — host standing to create, rank ceiling to revoke ═════════════
describe('grant scope: host standing and revoke rank ceiling (P2-C)', () => {
  it('a lead of s1 cannot route an s1 agent to a host with no standing in s1', async () => {
    const w = await world()
    const k3 = await keypair()
    w.h.sqlite.exec(`
      INSERT INTO members (id, display_name, status, tenant) VALUES ('orphan-m', 'Orphan', 'active', '${TENANT}');
      INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
        VALUES ('${TENANT}', 'orphan-host', '${k3.x}', 'Ed25519', 'orphan-m', ${NOW});
    `)
    // orphan-m has NO capability row anywhere, and 'orphan-host' is not an agents row at all —
    // neither of hostHasStandingInSquad's two seams is satisfied.
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-lead3', 'seat1-m', '${await hashMemberToken('lead-tok-3')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-lead3', 'seat1-m', 'squad', 's1', 'lead')`)
    const body = JSON.stringify({ host_agent_id: 'orphan-host', agent_id: A1, reason: 'route to orphan' })
    const r = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer lead-tok-3' }, body }, w.env)
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'host_no_squad_standing' })
  })

  it('a host that IS itself an agent registered to the target squad passes ("registered to it")', async () => {
    const w = await world()
    const k3 = await keypair()
    // A3 is already an `agents` row on s1 (world()'s own fixture) — no memberships row, no
    // capability grant, just squad_id = 's1'. That alone must satisfy standing.
    w.h.sqlite.exec(`INSERT INTO agent_keys (tenant, agent_id, pubkey, algo, member_id, created_at)
      VALUES ('${TENANT}', '${A3}', '${k3.x}', 'Ed25519', 'admin', ${NOW})`)
    const r = await createSeatEventGrant(w.env, { hostAgentId: A3, agentId: A1, memberId: 'admin', reason: 'A3 hosts A1' })
    expect(r.ok).toBe(true)
  })

  it('a lead cannot revoke a grant an org admin created; an org admin can revoke anything', async () => {
    const w = await world()
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin-org', 'admin', 'org', NULL, 'admin')`)
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-admin', 'admin', '${await hashMemberToken('admin-tok')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-lead4', 'seat1-m', '${await hashMemberToken('lead-tok-4')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-lead4', 'seat1-m', 'squad', 's1', 'lead')`)
    // The ORG ADMIN creates the grant (higher authority than the s1 lead).
    const created = await createSeatEventGrant(w.env, { hostAgentId: HOST1, agentId: A1, memberId: 'admin', reason: 'admin-created' })
    expect(created.ok).toBe(true)
    // The s1 lead — who otherwise passes authorizeGrantTarget (lead on A1's own squad) — is
    // refused: this grant is outside their authority because a higher-rank principal made it.
    const leadRevoke = await seatEventsApp.request('/grants/' + A1, { method: 'DELETE', headers: { Authorization: 'Bearer lead-tok-4' } }, w.env)
    expect(leadRevoke.status).toBe(403)
    expect(await leadRevoke.json()).toMatchObject({ error: 'forbidden_higher_authority' })
    // The org admin can revoke it (their own creation, or anyone else's — org admin is exempt).
    const adminRevoke = await seatEventsApp.request('/grants/' + A1, { method: 'DELETE', headers: { Authorization: 'Bearer admin-tok' } }, w.env)
    expect(adminRevoke.status).toBe(200)
    expect(await adminRevoke.json()).toMatchObject({ revoked: 1 })
  })

  it('a lead CAN revoke a grant created by another lead (peer authority, not higher)', async () => {
    const w = await world()
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-lead5', 'seat1-m', '${await hashMemberToken('lead-tok-5')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-lead5', 'seat1-m', 'squad', 's1', 'lead')`)
    await grant(w, HOST1, A1) // created by 'admin' via the grant() helper, but 'admin' holds no org-admin capability in THIS world()
    const revoke = await seatEventsApp.request('/grants/' + A1, { method: 'DELETE', headers: { Authorization: 'Bearer lead-tok-5' } }, w.env)
    expect(revoke.status).toBe(200)
  })
})

// ═════════════ mupot#1594 P1-A: route-level ticket pre-check before the DO is ever reached ═════════════
describe('route-level ticket pre-check (P1-A)', () => {
  it('200 forged tickets reach 0 DO fetches — all refused with 401 at the route', async () => {
    const w = await world()
    let doFetches = 0
    const hub = hubFor(w)
    const env = {
      ...w.env,
      REALTIME_SEAT_EVENTS: '1',
      SEAT_EVENTS: namespaceOver(hub, () => { doFetches++ }),
    } as unknown as Env
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    for (let i = 0; i < 200; i++) {
      const forged = Array.from({ length: 43 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
      const r = await seatEventsApp.request(`/?ticket=${forged}`, {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'k', 'cf-connecting-ip': `203.0.${Math.floor(i / 50)}.${i % 50}` },
      }, env)
      expect(r.status).toBe(401)
    }
    expect(doFetches).toBe(0)
  })

  it('a minted, unexpired ticket passes the pre-check; the same hash fails once expired', async () => {
    const w = await world()
    const hash = await sha256Hex('z'.repeat(43))
    await recordTicketPreCheck(w.env, hash, NOW + 30, () => NOW)
    expect(await ticketPreCheckPasses(w.env, hash, () => NOW)).toBe(true)
    expect(await ticketPreCheckPasses(w.env, hash, () => NOW + 31)).toBe(false)
  })

  it('a D1 error during the pre-check fails CLOSED', async () => {
    const w = await world()
    const flakyDb = new Proxy(w.env.DB as unknown as Record<string, unknown>, {
      get(t, k) {
        if (k === 'prepare') {
          return (sql: string) => {
            if (sql.includes('seat_events_tickets')) throw new Error('D1_ERROR: transient')
            return (t.prepare as (s: string) => unknown)(sql)
          }
        }
        const v = (t as Record<string, unknown>)[k as string]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
    expect(await ticketPreCheckPasses({ ...w.env, DB: flakyDb } as unknown as Env, 'whatever')).toBe(false)
  })

  it('POST /ticket refuses 503 (never mints) when the pre-check write itself fails', async () => {
    const w = await world()
    const flakyDb = new Proxy(w.env.DB as unknown as Record<string, unknown>, {
      get(t, k) {
        if (k === 'prepare') {
          return (sql: string) => {
            if (sql.includes('INSERT INTO seat_events_tickets')) throw new Error('D1_ERROR: transient')
            return (t.prepare as (s: string) => unknown)(sql)
          }
        }
        const v = (t as Record<string, unknown>)[k as string]
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    })
    const env2 = { ...w.env, DB: flakyDb } as unknown as Env
    await grant({ ...w, env: env2 } as World, HOST1, A1)
    const req = await signedRequest(w.k1, { host: HOST1, agents: [A1], ts: Math.floor(Date.now() / 1000) })
    const r = await seatEventsApp.request('/ticket', { method: 'POST', body: JSON.stringify(req) }, { ...env2, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: namespaceOver(hubFor(w)) } as unknown as Env)
    expect(r.status).toBe(503)
  })
})

// ═════════════ mupot#1594 P1-A: the upgrade route's own rate limit, /64-bucketed ═════════════
describe('upgrade rate limit (P1-A)', () => {
  it('the upgrade route 429s once its own per-IP ceiling is hit', async () => {
    const w = await world()
    const hub = hubFor(w)
    const env = { ...w.env, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: namespaceOver(hub) } as unknown as Env
    const headers = { Upgrade: 'websocket', 'Sec-WebSocket-Key': 'k', 'cf-connecting-ip': '198.51.100.42' }
    let last: Response | null = null
    for (let i = 0; i < UPGRADE_RATE_LIMIT_MAX_PER_IP; i++) {
      last = await seatEventsApp.request('/?ticket=' + 'B'.repeat(43), { headers }, env)
    }
    expect(last?.status).toBe(401) // allowed through the limiter; refused by the (never-minted) pre-check
    const over = await seatEventsApp.request('/?ticket=' + 'B'.repeat(43), { headers }, env)
    expect(over.status).toBe(429)
  })

  it('the ticket-mint and upgrade limiters are INDEPENDENT buckets', async () => {
    const w = await world()
    const ip = '198.51.100.77'
    for (let i = 0; i < TICKET_RATE_LIMIT_MAX_PER_IP; i++) await underTicketRateLimit(w.env, ip, NOW * 1000)
    expect(await underTicketRateLimit(w.env, ip, NOW * 1000)).toBe(false) // ticket bucket exhausted
    expect(await underUpgradeRateLimit(w.env, ip, NOW * 1000)).toBe(true) // upgrade bucket untouched
  })

  it('ipRateLimitKey buckets IPv6 to its /64, defeating rotation within the block; IPv4 passes through', () => {
    expect(ipRateLimitKey('2001:db8:aaaa:bbbb:1::1')).toBe(ipRateLimitKey('2001:db8:aaaa:bbbb:2::2'))
    expect(ipRateLimitKey('2001:db8:aaaa:bbbb::1')).not.toBe(ipRateLimitKey('2001:db8:cccc:dddd::1'))
    expect(ipRateLimitKey('203.0.113.5')).toBe('203.0.113.5')
    expect(ipRateLimitKey('unknown')).toBe('unknown')
  })
})

// ═════════════ mupot#1594 P1-A: hibernation-safe auth deadline; never-postponed sweep ═════════════
describe('auth-deadline hibernation safety (P1-A)', () => {
  it('a pending socket past the deadline is closed after a SIMULATED HIBERNATION (fresh hub, same socket)', async () => {
    const w = await world()
    let now = NOW
    const hub = hubFor(w, { now: () => now })
    const pending = hub.acceptRaw() // connectedAt written via the ORIGINAL hub/DO instance
    now += AUTH_DEADLINE_SEC
    // Simulate the DO being evicted and rebuilt: fresh junk/recent trackers, same sockets.
    const revived = hub.hibernate()
    expect(revived.enforceAuthDeadline()).toBe(1)
    expect(pending.closed).toMatchObject({ code: CLOSE_AUTH_TIMEOUT, reason: 'auth_timeout' })
  })

  it('nextAuthDeadlineAlarm never postpones a pending sweep; it DOES bring one earlier', () => {
    const armed = NOW * 1000 + AUTH_DEADLINE_SEC * 1000
    expect(nextAuthDeadlineAlarm(null, armed)).toBe(armed) // nothing pending: arm it
    // A connect 5s later asks for a deadline 5s FURTHER OUT than the one already armed.
    expect(nextAuthDeadlineAlarm(armed, armed + 5_000)).toBeNull()
    // A deadline that would fire EARLIER than what's armed DOES get taken.
    expect(nextAuthDeadlineAlarm(armed, armed - 5_000)).toBe(armed - 5_000)
  })
})
