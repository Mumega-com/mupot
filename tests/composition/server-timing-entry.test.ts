// SERVER_TIMING_KEY gate through the REAL entry point (src/index.ts default fetch, OAuthProvider wrapper)
// inside workerd with real Miniflare D1 and KV. The header is operator-gated: a configured secret
// (>= 24 chars) AND a matching x-server-timing-key request header. Anything else = no header, and the
// response must be byte-identical for an existing vs a missing send target (anti-enumeration).

import { applyD1Migrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/types'

const RAW_TOKEN = 'raw-secret-token-do-not-leak-0123456789'
const COOKIE_VALUE = 'session-cookie-do-not-leak-abcdef'
const KEY = 'operator-timing-key-0123456789abcdef'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const testEnv = cfEnv as unknown as { MUPOT_DB: D1Database; ST_SESSIONS: KVNamespace; ST_OAUTH_KV: KVNamespace; TEST_MIGRATIONS: never }

async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const SENDER_TOKEN = 'sender-agent-token-0123456789abcdef'

beforeAll(async () => {
  await applyD1Migrations(testEnv.MUPOT_DB, testEnv.TEST_MIGRATIONS)
  const db = testEnv.MUPOT_DB
  await db.exec("INSERT OR IGNORE INTO members (id, email, display_name, status, tenant) VALUES ('m1', 'm@example.test', 'M', 'active', 'mumega')")
  await db.exec(`INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('t1', 'm1', '${await sha256Hex(RAW_TOKEN)}', 'x', 'workspace', datetime('now'), 'mumega')`)
  // Oracle fixture: a non-admin agent-bound sender in squad sq-a; an EXISTING target in another squad sq-b.
  await db.exec("INSERT OR IGNORE INTO departments (id, slug, name) VALUES ('d1', 'dept', 'Dept')")
  await db.exec("INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('sq-a', 'd1', 'a', 'A')")
  await db.exec("INSERT OR IGNORE INTO squads (id, department_id, slug, name) VALUES ('sq-b', 'd1', 'b', 'B')")
  await db.exec("INSERT OR IGNORE INTO agents (id, squad_id, slug, name) VALUES ('ag-send', 'sq-a', 'sender', 'Sender')")
  await db.exec("INSERT OR IGNORE INTO agents (id, squad_id, slug, name) VALUES ('ag-hidden', 'sq-b', 'hidden-target', 'Hidden')")
  await db.exec("INSERT OR IGNORE INTO members (id, email, display_name, status, tenant) VALUES ('m2', 'm2@example.test', 'M2', 'active', 'mumega')")
  await db.exec("INSERT OR IGNORE INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('mumega', 'ag-send', 'm2', datetime('now'))")
  await db.exec(`INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, agent_id, tenant) VALUES ('t2', 'm2', '${await sha256Hex(SENDER_TOKEN)}', 'x', 'workspace', datetime('now'), 'ag-send', 'mumega')`)
}, 120_000)

function makeEnv(key?: string): Env {
  return {
    TENANT_SLUG: 'mumega',
    BRAND: 'mupot',
    PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    DB: testEnv.MUPOT_DB,
    SESSIONS: testEnv.ST_SESSIONS,
    OAUTH_KV: testEnv.ST_OAUTH_KV,
    ...(key === undefined ? {} : { SERVER_TIMING_KEY: key }),
  } as unknown as Env // minimal test env: only the bindings this path reads
}

const inbox = (headers: Record<string, string> = {}) =>
  new Request('https://mupot.mumega.com/api/inbox?peek=1', { headers: { authorization: `Bearer ${RAW_TOKEN}`, ...headers } })

const send = (to: string, headers: Record<string, string> = {}) =>
  new Request('https://mupot.mumega.com/api/inbox/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${SENDER_TOKEN}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ to, body: 'hello' }),
  })

describe('SERVER_TIMING_KEY gate', () => {
  it('no secret configured: no header even if a key header is presented', async () => {
    const res = await worker.fetch(inbox({ 'x-server-timing-key': KEY }), makeEnv(), ctx)
    expect(res.headers.has('server-timing')).toBe(false)
  })

  it('secret configured, no key header: no header', async () => {
    const res = await worker.fetch(inbox(), makeEnv(KEY), ctx)
    expect(res.headers.has('server-timing')).toBe(false)
  })

  it('wrong key (incl. prefix and case variants): no header', async () => {
    for (const bad of ['wrong', KEY.slice(0, -1), KEY + 'x', KEY.toUpperCase(), '']) {
      const res = await worker.fetch(inbox({ 'x-server-timing-key': bad }), makeEnv(KEY), ctx)
      expect(res.headers.has('server-timing')).toBe(false)
    }
  })

  it('short or empty configured secret = disabled, even when the presented key equals it', async () => {
    for (const weak of ['', 'short', 'x'.repeat(23)]) {
      const res = await worker.fetch(inbox({ 'x-server-timing-key': weak }), makeEnv(weak), ctx)
      expect(res.headers.has('server-timing')).toBe(false)
    }
  })

  it('right key: well-formed phases, handler + auth ~ total, no secrets/SQL/ids, key not echoed', async () => {
    const res = await worker.fetch(
      inbox({ 'x-server-timing-key': KEY, cookie: `mupot_session=${COOKIE_VALUE}` }),
      makeEnv(KEY),
      ctx,
    )
    const h = res.headers.get('server-timing') ?? ''
    expect(h).not.toBe('')
    const parts = h.split(', ')
    for (const p of parts) expect(p).toMatch(/^[a-z0-9-]+;dur=\d+\.\d(;desc="n=\d+")?$/)
    expect(parts[0].startsWith('auth;')).toBe(true)
    expect(parts.slice(-2).map((p) => p.split(';')[0])).toEqual(['handler', 'total'])
    const dur = (n: string) => Number(new RegExp(`(?:^|, )${n};dur=([\\d.]+)`).exec(h)?.[1])
    expect(dur('auth')).toBeGreaterThanOrEqual(0) // workerd's clock only advances at I/O: > 0 is asserted with delayed stubs in the unit test
    expect(Math.abs(dur('handler') + dur('auth') - dur('total'))).toBeLessThanOrEqual(0.3) // 0.1 rounding per term
    expect(Number(/d1;dur=[\d.]+;desc="n=(\d+)"/.exec(h)?.[1])).toBeGreaterThanOrEqual(1)
    for (const bad of [RAW_TOKEN, COOKIE_VALUE, KEY, 'member_tokens', 'SELECT', 'Bearer', 'mumega', 'm1', 't1']) {
      expect(h).not.toContain(bad)
      for (const [, v] of res.headers) if (v !== h) expect(v).not.toContain(KEY)
    }
    expect(await res.text()).not.toContain(KEY)
  })

  it('right key is honored on a 401 and on a non-authenticated /api path (operator holds the key)', async () => {
    const res = await worker.fetch(
      new Request('https://mupot.mumega.com/api/inbox?peek=1', { headers: { authorization: 'Bearer nope', 'x-server-timing-key': KEY } }),
      makeEnv(KEY),
      ctx,
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('server-timing')).toContain('auth;dur=')
  })

  it('non-/api paths never get the header, even with the right key', async () => {
    const res = await worker.fetch(new Request('https://mupot.mumega.com/health', { headers: { 'x-server-timing-key': KEY } }), makeEnv(KEY), ctx)
    expect(res.headers.has('server-timing')).toBe(false)
  })

  it('uses real KV: a cookie session lookup runs through the timed KV', async () => {
    await testEnv.ST_SESSIONS.put('session:probe', '{}') // real Miniflare KV
    const res = await worker.fetch(
      new Request('https://mupot.mumega.com/api/orient', { headers: { cookie: 'mupot_session=probe', 'x-server-timing-key': KEY } }),
      makeEnv(KEY),
      ctx,
    )
    const h = res.headers.get('server-timing') ?? ''
    
    expect(h).toContain('auth;dur=')
    expect(h).not.toContain('probe')
  })

  it('oracle: existing-elsewhere vs missing target are indistinguishable WITHOUT the key (status, body, headers)', async () => {
    const hit = await worker.fetch(send('hidden-target'), makeEnv(KEY), ctx)
    const miss = await worker.fetch(send('no-such-agent-zzz'), makeEnv(KEY), ctx)
    expect(hit.status).toBe(404)
    expect(miss.status).toBe(404)
    expect(await hit.text()).toBe(await miss.text())
    expect(hit.headers.has('server-timing')).toBe(false)
    expect(miss.headers.has('server-timing')).toBe(false)
    const hk = await worker.fetch(send('hidden-target', { 'x-server-timing-key': KEY }), makeEnv(KEY), ctx)
    const mk = await worker.fetch(send('no-such-agent-zzz', { 'x-server-timing-key': KEY }), makeEnv(KEY), ctx)
    // Why the gate exists: the KEY HOLDER can see the difference (statement counts differ); nobody else can.
    const n = (r: Response) => /d1;dur=[\d.]+;desc="n=(\d+)"/.exec(r.headers.get('server-timing') ?? '')?.[1]
    expect(n(hk)).toBeDefined()
    expect(n(hk)).not.toBe(n(mk))
    // and with the gate disabled entirely
    const off = await worker.fetch(send('hidden-target'), makeEnv(), ctx)
    expect(off.headers.has('server-timing')).toBe(false)
  })
})
