// workerd equivalent of the repository's migration-backed fixture helper; runs the
// entire chain supplied by readD1Migrations, not a handwritten D1 mock/schema.
import { env, runInDurableObject, applyD1Migrations as applyAllMigrations } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { inboxApp } from '../../src/agents/inbox-routes'
import { hashMemberToken } from '../../src/auth/member-bearer'
import type { Env } from '../../src/types'
import { createSeatEventGrant } from '../../src/agents/seat-events'

const ns = (env as unknown as { SEAT_EVENTS: DurableObjectNamespace }).SEAT_EVENTS
beforeAll(async () => {
  const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: never }
  await applyAllMigrations(e.DB, e.TEST_MIGRATIONS)
  await e.DB.exec("INSERT OR IGNORE INTO departments(id,slug,name) VALUES('bd','bd','B')")
  await e.DB.exec("INSERT OR IGNORE INTO squads(id,department_id,slug,name) VALUES('bs','bd','bs','B')")
  await e.DB.exec("INSERT OR IGNORE INTO agents(id,squad_id,slug,name,status) VALUES('agent-a','bs','agent-a','A','active'),('host-a','bs','host-a','H','active')")
  await e.DB.exec("INSERT OR IGNORE INTO members(id,display_name,tenant,status) VALUES('host-m','H','test','active')")
  await e.DB.exec("INSERT OR IGNORE INTO agent_keys(tenant,agent_id,pubkey,algo,member_id,created_at) VALUES('test','host-a','public-fixture','Ed25519','host-m',1)")
  await e.DB.exec("INSERT OR IGNORE INTO seat_event_grants(id,tenant,host_agent_id,agent_id,granted_by_member_id,reason,created_at) VALUES('bg','test','host-a','agent-a','host-m','test',datetime('now'))")
  await e.DB.exec("INSERT OR IGNORE INTO agents(id,squad_id,slug,name,status) VALUES('stream-agent','bs','stream-agent','S','active')")
  await e.DB.exec("INSERT OR IGNORE INTO members(id,display_name,tenant,status) VALUES('stream-m','S','test','active')")
  await e.DB.exec("INSERT OR IGNORE INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES('test','stream-agent','stream-m',datetime('now'))")
  await e.DB.prepare("INSERT OR IGNORE INTO member_tokens(id,member_id,agent_id,tenant,channel,label,token_hash) VALUES('stream-t','stream-m','stream-agent','test','workspace','stream-seat',?1)").bind(await hashMemberToken('workerd-stream-test')).run()
}, 120_000)
function stub() { return ns.get(ns.newUniqueId()) }
function descriptor(agent = 'agent-a', credential = 'cred-a') {
  return { kind: 'bearer', tenant: 'test', agent, seat: 'seat-a', credential_id: credential, member_id: 'member-a', not_after: Date.now() + 60_000 }
}
function connect(s: DurableObjectStub, d = descriptor()) {
  return s.fetch('https://seat-events/bearer-connect', { headers: { Upgrade: 'websocket', 'x-mupot-bearer-subscription': JSON.stringify(d) } })
}
const hint = (agent = 'agent-a', seat: string | null = 'seat-a', id = crypto.randomUUID()) => ({ id, seq: 1, to_agent: agent, target_seat: seat, from_agent: 'sender', kind: 'message', request_id: null, in_reply_to: null, project_id: null, created_at: '2026-10-25' })
async function hostConnect(s: DurableObjectStub) {
  const ticket = 'x'.repeat(43)
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket)))).map(b => b.toString(16).padStart(2, '0')).join('')
  await s.fetch('https://seat-events/ticket', { method: 'POST', body: JSON.stringify({ hash, host: 'host-a', agents: ['agent-a'], expires_at: Math.floor(Date.now() / 1000) + 60 }) })
  const r = await s.fetch('https://seat-events/connect', { headers: { Upgrade: 'websocket', 'x-seat-events-host': 'host-a' } })
  const ws = r.webSocket!; ws.accept()
  const ready = new Promise<void>(resolve => ws.addEventListener('message', e => { if (JSON.parse(String(e.data)).type === 'ready') resolve() }))
  ws.send(JSON.stringify({ type: 'hello', v: 1, ticket, since: {} }))
  await ready
  return ws
}

describe('SeatEvents bearer observers in workerd', () => {
  it('accepts a trusted observer and pushes only matching seat hints without bodies', async () => {
    const s = stub(); const r = await connect(s)
    expect(r.status).toBe(101)
    const ws = r.webSocket!; ws.accept()
    const received = new Promise<string>(resolve => ws.addEventListener('message', e => resolve(String(e.data)), { once: true }))
    await s.fetch('https://seat-events/hint', { method: 'POST', body: JSON.stringify({ ...hint(), body: 'SECRET' }) })
    const frame = await received
    expect(JSON.parse(frame)).toMatchObject({ type: 'hint', seq: 1 })
    expect(frame).not.toContain('SECRET')
    expect(frame).not.toContain('sender')
    const wrong = await s.fetch('https://seat-events/hint', { method: 'POST', body: JSON.stringify(hint('agent-b')) })
    expect((await wrong.json() as { sent: number }).sent).toBe(0)
    ws.close()
  })
  it('refuses malformed or foreign descriptors before accepting a socket', async () => {
    const s = stub()
    expect((await connect(s, { ...descriptor(), tenant: 'other' })).status).toBe(403)
    expect((await connect(s, { ...descriptor(), not_after: Date.now() - 1 })).status).toBe(403)
  })
  it('caps observers separately and never presents one as a host attachment', async () => {
    const s = stub(); const sockets: WebSocket[] = []
    for (let i = 0; i < 2; i++) { const r = await connect(s); expect(r.status).toBe(101); r.webSocket!.accept(); sockets.push(r.webSocket!) }
    expect((await connect(s)).status).toBe(503)
    await runInDurableObject(s, (_instance, state) => {
      const attachments = state.getWebSockets().map(w => w.deserializeAttachment())
      expect(attachments).toHaveLength(2)
      expect(attachments.every(a => a.kind === 'bearer' && a.host === undefined)).toBe(true)
    })
    sockets.forEach(w => w.close())
  })
  it('host hello evicts observers and blocks a subsequent observer accept', async () => {
    const s = stub(); const r = await connect(s); const observer = r.webSocket!; observer.accept()
    const closed = new Promise<number>(resolve => observer.addEventListener('close', e => resolve(e.code)))
    const host = await hostConnect(s)
    expect(await closed).toBe(4409)
    expect((await connect(s, descriptor('agent-a', 'new-credential'))).status).toBe(409)
    host.close()
  })
  it('host installed before bearer accept wins the opposite order', async () => {
    const s = stub(); const host = await hostConnect(s)
    expect((await connect(s)).status).toBe(409)
    host.close()
  })
  it.each(['grant', 'member'])('a stale host after %s revocation does not strand bearer reconnect', async kind => {
    const s = stub(); const host = await hostConnect(s)
    const db = (env as unknown as Env).DB
    try {
      if (kind === 'grant') await db.exec("UPDATE seat_event_grants SET revoked_at=datetime('now'),revoked_by_member_id='host-m' WHERE id='bg'")
      else await db.exec("UPDATE members SET status='suspended' WHERE id='host-m'")
      const r = await connect(s)
      expect(r.status).toBe(101)
      r.webSocket!.accept(); r.webSocket!.close()
    } finally {
      await db.exec("UPDATE seat_event_grants SET revoked_at=NULL,revoked_by_member_id=NULL WHERE id='bg'")
      await db.exec("UPDATE members SET status='active' WHERE id='host-m'")
      host.close()
    }
  })
  it('closes observer junk frames without entering the host hello protocol', async () => {
    const r = await connect(stub()); const ws = r.webSocket!; ws.accept()
    const closed = new Promise<number>(resolve => ws.addEventListener('close', e => resolve(e.code)))
    ws.send(JSON.stringify({ type: 'hello', ticket: 'x'.repeat(43), v: 1 }))
    expect(await closed).toBe(4400)
  })
  it('delivers a real D1 inbox row through DO hint and Worker SSE without leaking hint metadata', async () => {
    const e = env as unknown as Env
    await e.DB.prepare("INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,kind,body,created_at,target_seat) VALUES('initial-row','test','stream-agent','host-a','host-m','message','initial catchup complete',datetime('now'),'stream-seat')").run()
    const abort = new AbortController()
    const r = await inboxApp.request('/stream', { headers: { authorization: 'Bearer workerd-stream-test' }, signal: abort.signal }, { ...e, INBOX_STREAM_PUSH: '1' })
    expect(r.status).toBe(200); expect(r.headers.get('X-Mupot-Stream-Mode')).toBe('push')
    const reader = r.body!.getReader(); const decoder = new TextDecoder(); let seen = ''
    const first = await reader.read(); seen += decoder.decode(first.value)
    expect(seen).toContain('retry:')
    while (!seen.includes('initial catchup complete')) { const part = await reader.read(); if (part.done) break; seen += decoder.decode(part.value) }
    expect(seen).toContain('initial catchup complete')
    await e.DB.prepare("INSERT INTO agent_messages(id,tenant,to_agent,from_agent,from_member,kind,body,created_at,target_seat) VALUES('push-row','test','stream-agent','host-a','host-m','message','body from durable row',datetime('now'),'stream-seat')").run()
    const row = await e.DB.prepare("SELECT seq FROM agent_messages WHERE id='push-row'").first<{ seq: number }>()
    const start = Date.now()
    const channel = ns.get(ns.idFromName('test:seat-events'))
    await channel.fetch('https://seat-events/hint', { method: 'POST', body: JSON.stringify({ ...hint('stream-agent', 'stream-seat', 'push-row'), seq: row!.seq, from_agent: 'hint-metadata-canary' }) })
    while (!seen.includes('body from durable row')) { const part = await reader.read(); if (part.done) break; seen += decoder.decode(part.value) }
    expect(seen).toContain('body from durable row')
    expect(seen).not.toContain('hint-metadata-canary')
    expect(Date.now() - start).toBeLessThan(2000)
    expect((await e.DB.prepare("SELECT read_at FROM agent_messages WHERE id='push-row'").first<{ read_at: string | null }>())?.read_at).toBeNull()
    await reader.cancel(); abort.abort()
  })
  it('committing a new host grant best-effort evicts the existing observer through the real DO', async () => {
    const e = env as unknown as Env
    await e.DB.exec("INSERT INTO agents(id,squad_id,slug,name,status) VALUES('grant-agent','bs','grant-agent','G','active')")
    const s = ns.get(ns.idFromName('test:seat-events'))
    const r = await connect(s, descriptor('grant-agent', 'grant-token')); const ws = r.webSocket!; ws.accept()
    const closed = new Promise<number>(resolve => ws.addEventListener('close', event => resolve(event.code)))
    const result = await createSeatEventGrant({ ...e, INBOX_STREAM_PUSH: '1' }, { hostAgentId: 'host-a', agentId: 'grant-agent', memberId: 'host-m', reason: 'test' })
    expect(result.ok).toBe(true)
    expect(await closed).toBe(4409)
  })
})
