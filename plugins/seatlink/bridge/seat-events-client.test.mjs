// Fixtures only: fake hub speaking the real protocol shape (seat-events.ts), manual clock, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  canonicalTicketMessage, createSeatEventsClient, isOwnedByFleetHost, parseSeatEventsConfig,
  SAFETY_RESYNC_MS, PING_EVERY_MS,
} from './lib/seat-events-client.mjs'

const TENANT = 'tenant-x'
const HOST = 'host-1'
const tick = () => new Promise((r) => setImmediate(r))
const flush = async () => { for (let i = 0; i < 8; i++) await tick() }

function clock() {
  let t = 1_800_000_000_000
  let seq = 0
  const q = new Map()
  return {
    setTimeout: (f, ms) => { const id = ++seq; q.set(id, { at: t + ms, f }); return id },
    clearTimeout: (id) => q.delete(id),
    now: () => t,
    async advance(ms) {
      const end = t + ms
      for (;;) {
        const due = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        q.delete(due[0]); t = Math.max(t, due[1].at); due[1].f(); await flush()
      }
      t = end
      await flush()
    },
  }
}

function setup({ agents = ['a-push'], ticketStatus = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-'))
  const keyFile = path.join(dir, 'k.pem')
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
  fs.writeFileSync(keyFile, pem, { mode: 0o600 })
  const logs = []
  const ck = clock()
  const hub = { sockets: [], tickets: new Set(), verified: [], pings: 0, ticketStatus }
  class FakeWS {
    constructor(url) {
      this.url = url; this.l = {}; this.sent = []; hub.sockets.push(this)
      queueMicrotask(() => this.emit('open', {}))
    }
    addEventListener(n, f) { (this.l[n] ||= []).push(f) }
    emit(n, ev) { for (const f of this.l[n] || []) f(ev) }
    send(d) {
      this.sent.push(d)
      if (d === 'ping') { hub.pings++; return queueMicrotask(() => this.emit('message', { data: 'pong' })) }
      const f = JSON.parse(d)
      assert.equal(f.type, 'hello'); assert.equal(f.v, 1)
      const t = new URL(this.url).searchParams.get('ticket')
      assert.ok(hub.tickets.delete(t), 'ticket single-use')
      this.hello = f
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'ready', protocol: 1, host: HOST, subscriptions: (hub.readySubs || agents).map((agent) => ({ agent, ok: true })) }) }))
    }
    close(code = 1000) { queueMicrotask(() => this.emit('close', { code })) }
    push(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
  }
  const fetchImpl = async (url, init) => {
    assert.ok(url.endsWith('/api/fleet/events/ticket'))
    hub.attempts = (hub.attempts || 0) + 1
    if (hub.ticketStatus !== 200) return { ok: false, status: hub.ticketStatus, json: async () => hub.errBody || {} }
    const b = JSON.parse(init.body)
    const msg = Buffer.from(['seat-events-ticket:v1', TENANT, b.host_agent_id, [...new Set(b.agents)].sort().join(','), String(b.ts), b.nonce].join('\n'))
    assert.ok(crypto.verify(null, msg, publicKey, Buffer.from(b.sig, 'base64url')), 'signature verifies over the server canonical message')
    assert.match(b.nonce, /^[A-Za-z0-9_-]{16,128}$/); assert.match(b.sig, /^[A-Za-z0-9_-]{80,120}$/)
    hub.verified.push(b)
    const ticket = crypto.randomBytes(32).toString('base64url')
    hub.tickets.add(ticket)
    return { ok: true, status: 200, json: async () => (hub.ticketReply ? hub.ticketReply(b, ticket) : { ok: true, ticket, agents: b.agents, refused: [] }) }
  }
  const seats = agents.map((a) => ({ herdr: a.replace('a-', ''), agent_id: a, seat_events: true }))
  const cursors = {}
  const reads = []; const delivered = []; const dark = []; let nextSeq = 1; let pending = []
  const defaultRead = async (seat, since) => { reads.push([seat.herdr, since]); return pending.filter((x) => x.seq > since) }
  const c = createSeatEventsClient({
    api: 'https://pot.test', tenant: TENANT, hostId: HOST, keyFile, seats,
    readFile: (p) => fs.readFileSync(p, 'utf8'), fetchImpl, WebSocketImpl: FakeWS,
    deliver: async (seat, m) => { delivered.push([seat.herdr, m.id]) },
    getCursor: (s) => cursors[s.herdr] || 0, setCursor: (s, n) => { cursors[s.herdr] = n },
    log: (l) => logs.push(l), timers: ck, random: () => 0.5,
    onDark: (seat, why) => dark.push([seat.herdr, why]),
    readInbox: (...a) => (hub.readInbox ? hub.readInbox(...a) : defaultRead(...a)),
  })
  return { c, ck, hub, reads, delivered, dark, logs, pem, cursors, defaultRead, enqueue: (id) => { pending.push({ id, seq: nextSeq++ }) } }
}

test('hello then exactly one resync read; hint triggers exactly one inbox read and unchanged inject', async () => {
  const t = setup(); t.c.start(); await flush()
  assert.equal(t.hub.sockets.length, 1)
  assert.deepEqual(t.hub.sockets[0].hello.since, { 'a-push': 0 })
  assert.equal(t.reads.length, 1) // resync on ready
  t.enqueue('m1'); t.hub.sockets[0].push({ type: 'hint', agent: 'a-push', hint: { id: 'm1', seq: 1 } }); await flush()
  assert.equal(t.reads.length, 2); assert.deepEqual(t.reads[1], ['push', 0])
  assert.deepEqual(t.delivered, [['push', 'm1']]); assert.equal(t.cursors.push, 1)
})

test('idle period: zero reads (only pings) until the bounded safety resync', async () => {
  const t = setup(); t.c.start(); await flush()
  const base = t.reads.length
  await t.ck.advance(SAFETY_RESYNC_MS - 1000)
  assert.equal(t.reads.length, base); assert.ok(t.hub.pings >= 1)
  assert.ok(PING_EVERY_MS < SAFETY_RESYNC_MS)
})

test('safety resync: one cursor read per seat every 5 min with a healthy socket', async () => {
  const t = setup({ agents: ['a-push', 'a-sse'] }); t.c.start(); await flush()
  const base = t.reads.length // 2 resync reads
  t.enqueue('lost'); // hint was lost: no frame sent
  await t.ck.advance(SAFETY_RESYNC_MS + 10)
  assert.equal(t.reads.length - base, 2)
  assert.deepEqual(t.delivered, [['push', 'lost'], ['sse', 'lost']])
  await t.ck.advance(SAFETY_RESYNC_MS)
  assert.equal(t.reads.length - base, 4)
})

test('reconnect with backoff and one resync read per seat; no SSE fallback ever', async () => {
  const t = setup({ agents: ['a-push', 'a-sse'] }); t.c.start(); await flush()
  const before = t.reads.length
  t.hub.sockets[0].close(1006); await flush()
  assert.equal(t.hub.sockets.length, 1) // backoff not yet elapsed
  await t.ck.advance(1000); assert.equal(t.hub.sockets.length, 2)
  assert.equal(t.reads.length - before, 2)
})

test('socket down 10 minutes: only reconnect attempts, no fallback path exists, backoff capped', async () => {
  const t = setup(); t.c.start(); await flush()
  t.hub.ticketStatus = 503
  t.hub.sockets[0].close(1006); await flush()
  await t.ck.advance(10 * 60_000)
  assert.ok(t.logs.some((l) => /reconnect in/.test(l)))
  assert.ok(!t.logs.some((l) => /SSE|fall/i.test(l)))
  assert.ok(t.hub.verified.length >= 1)
  t.hub.ticketStatus = 200
  await t.ck.advance(60_000 * 2); await flush()
  assert.equal(t.c._state().ready, true)
})

test('409 notify_owned_by_fleet_host is "owned by host, do not fall back"', () => {
  assert.equal(isOwnedByFleetHost(409, { error: 'notify_owned_by_fleet_host', host_agent_id: 'h' }), true)
  assert.equal(isOwnedByFleetHost(409, { error: 'other' }), false)
  assert.equal(isOwnedByFleetHost(401, { error: 'notify_owned_by_fleet_host' }), false)
})

test('refused subscription is logged and not worked around (no reads, no SSE)', async () => {
  const t = setup({ agents: ['a-push', 'a-sse'] })
  t.c.start(); await flush()
  t.hub.sockets[0].push({ type: 'revoked', agent: 'a-sse', reason: 'grant_revoked' }); await flush()
  const base = t.reads.length
  t.hub.sockets[0].push({ type: 'hint', agent: 'a-sse', hint: { id: 'x', seq: 9 } }); await flush()
  assert.equal(t.reads.length, base)
  assert.ok(t.logs.some((l) => /revoked/.test(l)))
})

test('private key material never appears in logs; unreadable key gives a fixed message', async () => {
  const t = setup(); t.c.start(); await flush(); t.hub.sockets[0].close(1006); await flush(); await t.ck.advance(5000)
  const body = t.pem.split('\n').filter((l) => l && !l.startsWith('-----'))
  for (const l of t.logs) for (const k of body) assert.ok(!l.includes(k))
  const bad = createSeatEventsClient({
    api: 'https://pot.test', tenant: TENANT, hostId: HOST, keyFile: '/nonexistent/secret-path-xyz', seats: [{ herdr: 'k', agent_id: 'a-k' }],
    readFile: () => { throw new Error('ENOENT /nonexistent/secret-path-xyz') }, WebSocketImpl: class {}, fetchImpl: async () => { throw new Error('no') },
    readInbox: async () => [], deliver: async () => {}, getCursor: () => 0, setCursor: () => {}, log: (l) => t.logs.push(l), timers: clock(),
  })
  bad.start(); await flush(); bad.stop()
  assert.ok(t.logs.some((l) => /host key unreadable/.test(l)))
  assert.ok(!t.logs.some((l) => /secret-path-xyz/.test(l)))
})

test('config: absent seat_events => null (SSE path as today); per-seat opt-in; default key under ~/.fleet/agents', () => {
  assert.equal(parseSeatEventsConfig({ seats: [{ herdr: 'k', mupot_agent_id: 'a', mupot_token_file: 't', seat_events: true }] }), null)
  assert.equal(parseSeatEventsConfig({ seat_events: { host_id: HOST, tenant: TENANT }, seats: [{ herdr: 'k', mupot_agent_id: 'a', mupot_token_file: 't' }] }), null) // nobody opted in
  const c = parseSeatEventsConfig({ seat_events: { host_id: HOST, tenant: TENANT }, seats: [{ herdr: 'k', mupot_agent_id: 'a', mupot_token_file: 't', seat_events: true }, { herdr: 'x', mupot_agent_id: 'b', mupot_token_file: 't' }] })
  assert.deepEqual(c.seats.map((s) => s.herdr), ['k'])
  assert.ok(c.keyFile.endsWith(path.join('.fleet', 'agents', 'seatlink-host.key')))
})

test('canonical message matches the server layout (domain, tenant, host, sorted agents, ts, nonce)', () => {
  assert.equal(canonicalTicketMessage({ tenant: 't', host: 'h', agents: ['b', 'a', 'a'], ts: 5, nonce: 'n' }).toString(), 'seat-events-ticket:v1\nt\nh\na,b\n5\nn')
})

test('hostkey-gen: mode 600, prints only pubkey+fingerprint, refuses existing file and writable parent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-')); fs.chmodSync(dir, 0o700)
  const bin = new URL('../bin/seatlink-hostkey-gen.mjs', import.meta.url).pathname
  const f = path.join(dir, 'h.key')
  const out = execFileSync('node', [bin, f], { encoding: 'utf8' })
  const j = JSON.parse(out); assert.deepEqual(Object.keys(j).sort(), ['fingerprint', 'public_key'])
  assert.match(j.public_key, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(j.fingerprint, crypto.createHash('sha256').update(j.public_key).digest('hex'))
  assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  assert.ok(!out.includes('PRIVATE'))
  assert.throws(() => execFileSync('node', [bin, f], { stdio: 'pipe' }))
  fs.chmodSync(dir, 0o770)
  assert.throws(() => execFileSync('node', [bin, path.join(dir, 'g.key')], { stdio: 'pipe' }))
  assert.ok(!fs.existsSync(path.join(dir, 'g.key')))
})

// ---- dark seats: every refusal path hands the seat to SSE (onDark), once, with a reason ----
test('pre-grant opt-in (403 no_granted_agents): every seat goes dark once; reconnect is slow, not a storm', async () => {
  const t = setup({ agents: ['a-push', 'a-sse'] })
  t.hub.ticketStatus = 403; t.hub.errBody = { error: 'no_granted_agents' }
  t.c.start(); await flush()
  assert.deepEqual(t.dark.map((d) => d[0]).sort(), ['push', 'sse'])
  await t.ck.advance(5 * 60_000)
  assert.equal(t.dark.length, 2, 'onDark fires once per seat, not per retry')
  assert.ok(t.hub.attempts <= 6, `attempts ${t.hub.attempts}`)
})

test('partial grant: refused seat goes dark with the server reason; granted seat still push', async () => {
  const t = setup({ agents: ['a-push', 'a-sse'] })
  t.hub.readySubs = ['a-push']
  t.hub.ticketReply = (b, ticket) => { t.hub.tickets.add(ticket); return { ok: true, ticket, agents: ['a-push'], refused: [{ agent: 'a-sse', reason: 'not_granted' }] } }
  t.c.start(); await flush()
  assert.deepEqual(t.dark, [['sse', 'no grant at ticket time (not_granted)']])
  const base = t.reads.length
  t.hub.sockets[0].push({ type: 'hint', agent: 'a-sse', hint: { id: 'x', seq: 1 } }); await flush()
  assert.equal(t.reads.length, base, 'dark seat is not read over push')
  t.enqueue('m1'); t.hub.sockets[0].push({ type: 'hint', agent: 'a-push', hint: { id: 'm1', seq: 1 } }); await flush()
  assert.deepEqual(t.delivered, [['push', 'm1']])
})

test('mid-rollback revoke: seat goes dark on the revoked frame and stays out of the push reads', async () => {
  const t = setup(); t.c.start(); await flush()
  assert.equal(t.dark.length, 0)
  t.hub.sockets[0].push({ type: 'revoked', agent: 'a-kasra'.replace('kasra', 'push'), reason: 'grant_revoked' }); await flush()
  assert.deepEqual(t.dark.map((d) => d[0]), ['push'])
  t.hub.sockets[0].push({ type: 'revoked', agent: 'a-push', reason: 'again' }); await flush()
  assert.equal(t.dark.length, 1)
  const base = t.reads.length
  await t.ck.advance(SAFETY_RESYNC_MS + 10)
  assert.equal(t.reads.length, base)
})

test('ready with a refused subscription also goes dark', async () => {
  const t = setup({ agents: ['a-push', 'a-sse'] })
  const orig = t.hub
  t.hub.ticketReply = (b, ticket) => { orig.tickets.add(ticket); return { ok: true, ticket, agents: b.agents, refused: [] } }
  t.c.start(); await flush()
  t.hub.sockets[0].push({ type: 'ready', protocol: 1, host: 'h', subscriptions: [{ agent: 'a-push', ok: true }, { agent: 'a-sse', ok: false, reason: 'agent_already_claimed' }] }); await flush()
  assert.deepEqual(t.dark, [['sse', 'subscription refused (agent_already_claimed)']])
})

test('ticket 400 does not retry every second', async () => {
  const t = setup(); t.hub.ticketStatus = 400; t.hub.errBody = { error: 'bad_request', detail: 'agents' }
  t.c.start(); await flush(); await t.ck.advance(30_000)
  assert.ok(t.hub.attempts <= 2, `attempts ${t.hub.attempts}`)
  assert.ok(t.logs.some((l) => /400/.test(l)))
})

// ---- config validation ----
test('config: invalid agent id / paperclip seats are skipped (stay SSE); invalid host id disables push', () => {
  const base = { seat_events: { host_id: HOST, tenant: TENANT } }
  const c = parseSeatEventsConfig({ ...base, seats: [
    { herdr: 'ok', mupot_agent_id: 'a-ok', mupot_token_file: 't', seat_events: true },
    { herdr: 'bad', mupot_agent_id: 'Bad_ID', mupot_token_file: 't', seat_events: true },
    { herdr: 'pc', mupot_agent_id: 'a-pc', mupot_token_file: 't', seat_events: true, target: { kind: 'paperclip' } },
  ] })
  assert.deepEqual(c.seats.map((s) => s.herdr), ['ok'])
  assert.deepEqual(c.skipped.map((s) => [s.herdr, s.reason]), [['bad', 'agent id not a valid seat-events id'], ['pc', 'paperclip seats stay on SSE']])
  assert.equal(parseSeatEventsConfig({ seat_events: { host_id: 'Bad Host', tenant: TENANT }, seats: [{ herdr: 'k', mupot_agent_id: 'a', mupot_token_file: 't', seat_events: true }] }), null)
})

// ---- reads ----
test('readSeat pages while a page is full or complete=false, then stops', async () => {
  const t = setup()
  let page = 0
  t.hub.readInbox = async (seat, since) => {
    page++
    if (page === 1) return { messages: [{ id: 'a', seq: 1 }], complete: true } // resync read: tiny page
    if (page === 2) return { messages: [{ id: 'b', seq: 2 }], complete: false }
    if (page === 3) return { messages: [{ id: 'c', seq: 3 }], complete: true }
    return { messages: [], complete: true }
  }
  t.c.start(); await flush()
  assert.equal(page, 1)
  t.hub.sockets[0].push({ type: 'hint', agent: 'a-push', hint: { id: 'b', seq: 2 } }); await flush()
  assert.equal(page, 3) // incomplete page triggered exactly one more
  assert.deepEqual(t.delivered.map((d) => d[1]), ['a', 'b', 'c'])
})

test('a hint arriving mid-read coalesces into exactly one rerun that sees the new mail', async () => {
  const t = setup(); const gates = []; let n = 0
  t.hub.readInbox = (seat, since) => { n++; if (n === 1) return Promise.resolve([]); return new Promise((res) => gates.push(() => res(n === 2 ? [{ id: 'one', seq: 1 }] : [{ id: 'two', seq: 2 }]))) }
  t.c.start(); await flush() // read 1 (resync) done
  t.hub.sockets[0].push({ type: 'hint', agent: 'a-push', hint: {} }); await flush() // read 2 in flight
  t.hub.sockets[0].push({ type: 'hint', agent: 'a-push', hint: {} }); await flush() // coalesced: dirty
  t.hub.sockets[0].push({ type: 'hint', agent: 'a-push', hint: {} }); await flush() // still just dirty
  assert.equal(n, 2)
  gates[0](); await flush() // finish read 2 -> exactly one rerun
  assert.equal(n, 3)
  gates[1](); await flush()
  assert.equal(n, 3)
  assert.deepEqual(t.delivered.map((d) => d[1]), ['one', 'two'])
})

test('malformed server frames are ignored, never throw', async () => {
  const t = setup(); t.c.start(); await flush()
  const s = t.hub.sockets[0]
  for (const raw of ['null', '5', '"x"', '[]', '{"type":"ready","subscriptions":5}', '{"type":"ready","subscriptions":[null,3]}', '{"type":"hint"}', '{"type":"revoked"}']) s.emit('message', { data: raw })
  await flush()
  assert.equal(t.c._state().ready, true)
})
