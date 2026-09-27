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
  BACKLOG_HINT_LIMIT,
  CLOSE_TICKET_INVALID,
  MAX_AGENTS_PER_TICKET,
  RecentIds,
  SeatEventsHub,
  TICKET_TTL_SEC,
  backlogFor,
  canonicalTicketMessage,
  createSeatEventGrant,
  hintFromPayload,
  hostMayReceive,
  mintTicketSecret,
  normalizeHint,
  publishSeatHint,
  revokeSeatEventGrant,
  sha256Hex,
  verifyTicketRequest,
  type HubSocket,
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

class FakeSocket implements HubSocket {
  sent: string[] = []
  closed: { code: number; reason: string } | null = null
  private state: SocketState | null = null
  send(d: string) {
    if (this.closed) throw new Error('closed')
    this.sent.push(d)
  }
  close(code: number, reason: string) {
    this.closed = { code, reason }
  }
  getState() {
    return this.state
  }
  setState(s: SocketState) {
    this.state = s
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

function hubFor(w: World, opts: { now?: () => number; authorize?: (host: string, agent: string) => Promise<boolean> } = {}) {
  const sockets: FakeSocket[] = []
  const nowSec = opts.now ?? (() => NOW)
  const tickets = memTickets(nowSec)
  const recent = new RecentIds()
  const hub = () => new SeatEventsHub(w.env, { sockets: () => sockets, tickets, nowSec, recent, authorize: opts.authorize })
  async function ticketFor(host: string, agents: string[], ttl = TICKET_TTL_SEC) {
    const { ticket, hash } = await mintTicketSecret()
    await tickets.put(hash, { host, agents, expires_at: nowSec() + ttl })
    return ticket
  }
  async function connect(ticket: string, since: Record<string, number> = {}) {
    const s = new FakeSocket()
    sockets.push(s)
    await hub().onMessage(s, JSON.stringify({ type: 'hello', v: 1, ticket, since }))
    return s
  }
  return { sockets, tickets, hub, ticketFor, connect }
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

  it('a failed DO publish throws so the Queue retries; the retry is not a second notice', async () => {
    const w = await world()
    await grant(w, HOST1, A1)
    const hub = hubFor(w)
    const s = await hub.connect(await hub.ticketFor(HOST1, [A1]))
    const m = insertMessage(w, A1)
    let fail = true
    const ns = namespaceOver(hub)
    const flaky = {
      idFromName: ns.idFromName,
      get: () => ({
        fetch: async (req: Request) => (fail ? new Response('down', { status: 503 }) : ns.get().fetch(req)),
      }),
    }
    const env = { ...w.env, REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: flaky } as unknown as Env
    const ev = { type: 'message.created', tenant: TENANT, payload: { message_id: m.id, seq: m.seq, to_agent: A1, from_agent: 'k', from_member: 'x', kind: 'message', created_at: 'now' } } as BusEvent
    const item = () => ({ body: ev, id: 'q', attempts: 1, ack: vi.fn(), retry: vi.fn() })
    const i1 = item()
    await handleQueue({ messages: [i1] } as never, env)
    expect(i1.retry).toHaveBeenCalledOnce()
    fail = false
    const i2 = item()
    const i3 = item()
    await handleQueue({ messages: [i2, i3] } as never, env)
    expect(i2.ack).toHaveBeenCalledOnce()
    expect(i3.ack).toHaveBeenCalledOnce()
    expect(s.of('hint')).toHaveLength(1)
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
    const hub = hubFor(w, { authorize: async () => true })
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

  it('the WebSocket upgrade reaches the DO without Authorization or Cookie', async () => {
    const w = await world()
    let seen: string[] = []
    const hub = hubFor(w)
    const env = {
      ...w.env,
      REALTIME_SEAT_EVENTS: '1',
      SEAT_EVENTS: namespaceOver(hub, (req) => (seen = [...req.headers.keys()])),
    } as unknown as Env
    await seatEventsApp.request('/', {
      headers: { Upgrade: 'websocket', Authorization: 'Bearer secret', Cookie: 'sid=1', 'Sec-WebSocket-Key': 'k' },
    }, env)
    expect(seen).toContain('upgrade')
    expect(seen).not.toContain('authorization')
    expect(seen).not.toContain('cookie')
  })

  it('grants need an org-admin bearer: none and a plain member are both refused', async () => {
    const w = await world()
    const body = JSON.stringify({ host_agent_id: HOST1, agent_id: A1, reason: 'x' })
    expect((await seatEventsApp.request('/grants', { method: 'POST', body }, w.env)).status).toBe(403)
    w.h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
      VALUES ('tok-host', 'host1-m', '${await hashMemberToken('member-tok')}', '', 'workspace', datetime('now'), '${TENANT}')`)
    const member = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer member-tok' }, body }, w.env)
    expect(member.status).toBe(403)
    w.h.sqlite.exec(`INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', 'host1-m', 'org', NULL, 'admin')`)
    const admin = await seatEventsApp.request('/grants', { method: 'POST', headers: { Authorization: 'Bearer member-tok' }, body }, w.env)
    expect(admin.status).toBe(200)
  })
})
