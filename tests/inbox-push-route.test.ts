import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inboxApp } from '../src/agents/inbox-routes'
import { hashMemberToken } from '../src/auth/member-bearer'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'
class Socket extends EventTarget { closed = false; accept() {} close() { this.closed = true } }
let h: SqliteD1Harness; let env: Env; let requests: Request[]; let sockets: Socket[]
beforeEach(async () => {
  h = createSqliteD1(); applyAllMigrations(h.sqlite); requests = []; sockets = []
  h.sqlite.exec(`INSERT INTO departments(id,slug,name) VALUES('pd','pd','P');
    INSERT INTO squads(id,department_id,slug,name) VALUES('ps','pd','ps','P');
    INSERT INTO agents(id,squad_id,slug,name,status) VALUES('pa','ps','pa','P','active');
    INSERT INTO members(id,display_name,tenant,status) VALUES('pm','P','test','active');
    INSERT INTO agent_member_bindings VALUES('test','pa','pm',datetime('now'));
    INSERT INTO member_tokens(id,member_id,agent_id,tenant,token_hash,label,channel) VALUES('pt','pm','pa','test','${await hashMemberToken('secret-test-token')}','seat-one','workspace');`)
  env = { DB: h.db, TENANT_SLUG: 'test', INBOX_STREAM_PUSH: '1', REALTIME_SEAT_EVENTS: '1', SEAT_EVENTS: {
    idFromName: (n: string) => n,
    get: () => ({ fetch: async (request: Request) => { requests.push(request); const socket = new Socket(); sockets.push(socket); return { status: 101, webSocket: socket } } }),
  } } as unknown as Env
  vi.useFakeTimers()
})
afterEach(() => { vi.useRealTimers(); h.close() })
const request = (query = '', headers = {}) => inboxApp.request('/stream' + query, { headers: { authorization: 'Bearer secret-test-token', ...headers } }, env)
describe('member-token push route', () => {
  it('bounds a hanging entry authentication lookup to five seconds', async () => {
    env.DB = { prepare() { return { bind() { return { first: () => new Promise(() => {}) } } } } } as unknown as D1Database
    const pending = request()
    await vi.advanceTimersByTimeAsync(5001)
    expect((await pending).status).toBe(503)
    expect(requests).toHaveLength(0)
  })
  it('builds a private descriptor from authentication, not client headers', async () => {
    const r = await request('', { 'x-mupot-bearer-subscription': '{"agent":"foreign"}' })
    expect(r.headers.get('X-Mupot-Stream-Mode')).toBe('push')
    expect(requests).toHaveLength(1)
    const descriptor = JSON.parse(requests[0].headers.get('x-mupot-bearer-subscription')!)
    expect(descriptor).toMatchObject({ agent: 'pa', member_id: 'pm', credential_id: 'pt', seat: 'seat-one', tenant: 'test' })
    expect(JSON.stringify(descriptor)).not.toContain('secret-test-token')
    await r.body!.cancel(); expect(sockets[0].closed).toBe(true)
  })
  it('refuses seat spoofing and malformed reconnect cursors', async () => {
    expect((await request('?seat=foreign')).status).toBe(403)
    expect((await request('?since=1.5')).status).toBe(400)
    expect((await request('', { 'Last-Event-ID': 'broken' })).status).toBe(400)
    expect(requests).toHaveLength(0)
  })
  it('distinguishes auth database failure from bad credentials', async () => {
    env.DB = { prepare() { throw new Error('offline') } } as unknown as D1Database
    expect((await request()).status).toBe(503)
    expect(requests).toHaveLength(0)
  })
  it('returns capacity refusal without polling fallback', async () => {
    env.SEAT_EVENTS = { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ error: 'bearer_pot_capacity' }, { status: 503 }) }) } as unknown as DurableObjectNamespace
    expect((await request()).status).toBe(503)
  })
  it('refuses a failed host fence lookup with 503, without opening the DO', async () => {
    h.sqlite.exec('DROP TABLE seat_event_grants') // simulate an unavailable authority table, not a missing grant
    expect((await request()).status).toBe(503)
    expect(requests).toHaveLength(0)
  })
  it('only uses explicit legacy fallback on actual DO failure after validating no host grant', async () => {
    env.SEAT_EVENTS = { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error('outage') } }) } as unknown as DurableObjectNamespace
    const r = await request()
    expect(r.headers.get('X-Mupot-Stream-Mode')).toBe('fallback')
    await r.body!.cancel()
  })
})
