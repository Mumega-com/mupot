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
} from './seat-events-client.mjs'

const TENANT = 'mumega'
const HOST = 'muvps-host'
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

function setup({ agents = ['a-kasra'], ticketStatus = 200 } = {}) {
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
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'ready', protocol: 1, host: HOST, subscriptions: agents.map((agent) => ({ agent, ok: true })) }) }))
    }
    close(code = 1000) { queueMicrotask(() => this.emit('close', { code })) }
    push(frame) { this.emit('message', { data: JSON.stringify(frame) }) }
  }
  const fetchImpl = async (url, init) => {
    assert.ok(url.endsWith('/api/fleet/events/ticket'))
    if (hub.ticketStatus !== 200) return { ok: false, status: hub.ticketStatus, json: async () => ({}) }
    const b = JSON.parse(init.body)
    const msg = Buffer.from(['seat-events-ticket:v1', TENANT, b.host_agent_id, [...new Set(b.agents)].sort().join(','), String(b.ts), b.nonce].join('\n'))
    assert.ok(crypto.verify(null, msg, publicKey, Buffer.from(b.sig, 'base64url')), 'signature verifies over the server canonical message')
    assert.match(b.nonce, /^[A-Za-z0-9_-]{16,128}$/); assert.match(b.sig, /^[A-Za-z0-9_-]{80,120}$/)
    hub.verified.push(b)
    const ticket = crypto.randomBytes(32).toString('base64url')
    hub.tickets.add(ticket)
    return { ok: true, status: 200, json: async () => ({ ok: true, ticket }) }
  }
  const seats = agents.map((a) => ({ herdr: a.replace('a-', ''), agent_id: a, seat_events: true }))
  const cursors = {}
  const reads = []; const delivered = []; let nextSeq = 1; let pending = []
  const c = createSeatEventsClient({
    api: 'https://pot.test', tenant: TENANT, hostId: HOST, keyFile, seats,
    readFile: (p) => fs.readFileSync(p, 'utf8'), fetchImpl, WebSocketImpl: FakeWS,
    readInbox: async (seat, since) => { reads.push([seat.herdr, since]); const m = pending.filter((x) => x.seq > since); return m },
    deliver: async (seat, m) => { delivered.push([seat.herdr, m.id]) },
    getCursor: (s) => cursors[s.herdr] || 0, setCursor: (s, n) => { cursors[s.herdr] = n },
    log: (l) => logs.push(l), timers: ck, random: () => 0.5,
  })
  return { c, ck, hub, reads, delivered, logs, pem, cursors, enqueue: (id) => { pending.push({ id, seq: nextSeq++ }) } }
}

test('hello then exactly one resync read; hint triggers exactly one inbox read and unchanged inject', async () => {
  const t = setup(); t.c.start(); await flush()
  assert.equal(t.hub.sockets.length, 1)
  assert.deepEqual(t.hub.sockets[0].hello.since, { 'a-kasra': 0 })
  assert.equal(t.reads.length, 1) // resync on ready
  t.enqueue('m1'); t.hub.sockets[0].push({ type: 'hint', agent: 'a-kasra', hint: { id: 'm1', seq: 1 } }); await flush()
  assert.equal(t.reads.length, 2); assert.deepEqual(t.reads[1], ['kasra', 0])
  assert.deepEqual(t.delivered, [['kasra', 'm1']]); assert.equal(t.cursors.kasra, 1)
})

test('idle period: zero reads (only pings) until the bounded safety resync', async () => {
  const t = setup(); t.c.start(); await flush()
  const base = t.reads.length
  await t.ck.advance(SAFETY_RESYNC_MS - 1000)
  assert.equal(t.reads.length, base); assert.ok(t.hub.pings >= 1)
  assert.ok(PING_EVERY_MS < SAFETY_RESYNC_MS)
})

test('safety resync: one cursor read per seat every 5 min with a healthy socket', async () => {
  const t = setup({ agents: ['a-kasra', 'a-athena'] }); t.c.start(); await flush()
  const base = t.reads.length // 2 resync reads
  t.enqueue('lost'); // hint was lost: no frame sent
  await t.ck.advance(SAFETY_RESYNC_MS + 10)
  assert.equal(t.reads.length - base, 2)
  assert.deepEqual(t.delivered, [['kasra', 'lost'], ['athena', 'lost']])
  await t.ck.advance(SAFETY_RESYNC_MS)
  assert.equal(t.reads.length - base, 4)
})

test('reconnect with backoff and one resync read per seat; no SSE fallback ever', async () => {
  const t = setup({ agents: ['a-kasra', 'a-athena'] }); t.c.start(); await flush()
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
  const t = setup({ agents: ['a-kasra', 'a-athena'] })
  t.c.start(); await flush()
  t.hub.sockets[0].push({ type: 'revoked', agent: 'a-athena', reason: 'grant_revoked' }); await flush()
  const base = t.reads.length
  t.hub.sockets[0].push({ type: 'hint', agent: 'a-athena', hint: { id: 'x', seq: 9 } }); await flush()
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
  assert.equal(parseSeatEventsConfig({ seats: [{ herdr: 'k', agent_id: 'a', seat_events: true }] }), null)
  assert.equal(parseSeatEventsConfig({ seat_events: { host_id: HOST, tenant: TENANT }, seats: [{ herdr: 'k', agent_id: 'a' }] }), null) // nobody opted in
  const c = parseSeatEventsConfig({ seat_events: { host_id: HOST, tenant: TENANT }, seats: [{ herdr: 'k', agent_id: 'a', seat_events: true }, { herdr: 'x', agent_id: 'b' }] })
  assert.deepEqual(c.seats.map((s) => s.herdr), ['k'])
  assert.ok(c.keyFile.endsWith(path.join('.fleet', 'agents', 'seatlink-host.key')))
})

test('canonical message matches the server layout (domain, tenant, host, sorted agents, ts, nonce)', () => {
  assert.equal(canonicalTicketMessage({ tenant: 't', host: 'h', agents: ['b', 'a', 'a'], ts: 5, nonce: 'n' }).toString(), 'seat-events-ticket:v1\nt\nh\na,b\n5\nn')
})

test('hostkey-gen: mode 600, prints only pubkey+fingerprint, refuses existing file and writable parent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-')); fs.chmodSync(dir, 0o700)
  const bin = new URL('./bin/seatlink-hostkey-gen.mjs', import.meta.url).pathname
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
