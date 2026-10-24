// Unit: the Server-Timing helper (Node pool, real-schema SQLite D1, delayed stubs). Each guard here
// was mutated to confirm a test fails when it is removed.

import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  instrumentEnv, renderServerTiming, serverTimingAuthorized, unwrapBinding, withAuthTiming, withServerTiming,
  MAX_KV_ENTRIES, SERVER_TIMING_KEY_HEADER, type Timer,
} from '../src/lib/server-timing'
import { resolveMemberByToken } from '../src/auth/member-bearer'
import { requireAuth } from '../src/auth'
import { routineTablesReady } from '../src/routines/schema-ready'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let harness: SqliteD1Harness
beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec('CREATE TABLE secret_table_name (secret_col_name TEXT)')
})
afterEach(() => harness.close())

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function kvStub(delayMs = 0, seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed))
  return {
    get: async (k: string) => { await sleep(delayMs); return store.get(k) ?? null },
    put: async (k: string, v: string) => { await sleep(delayMs); store.set(k, v) },
    delete: async (k: string) => { await sleep(delayMs); store.delete(k) },
    list: async () => ({ keys: [], list_complete: true }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  }
}

/** A D1 wrapper that sleeps before every query, standing in for network latency. */
function delayedDb(db: D1Database, ms: number): D1Database {
  const delayStmt = (s: D1PreparedStatement): D1PreparedStatement => ({
    bind: (...a: unknown[]) => delayStmt(s.bind(...a)),
    first: async (...a: unknown[]) => { await sleep(ms); return (s.first as (...x: unknown[]) => Promise<unknown>)(...a) },
    all: async () => { await sleep(ms); return s.all() },
    run: async () => { await sleep(ms); return s.run() },
    raw: async (...a: unknown[]) => { await sleep(ms); return (s.raw as (...x: unknown[]) => Promise<unknown>)(...a) },
  }) as unknown as D1PreparedStatement // test double implements the surface mupot calls
  return { prepare: (q: string) => delayStmt(db.prepare(q)), batch: db.batch.bind(db) } as unknown as D1Database // same
}

const KEY = 'operator-timing-key-0123456789abcdef'
const req = (h?: string) => new Request('https://x.test/api/y', { headers: h === undefined ? {} : { [SERVER_TIMING_KEY_HEADER]: h } })

describe('gate: serverTimingAuthorized', () => {
  it('requires a >=24 char secret AND an exactly matching header', () => {
    expect(serverTimingAuthorized({ SERVER_TIMING_KEY: KEY }, req(KEY))).toBe(true)
    expect(serverTimingAuthorized({}, req(KEY))).toBe(false) // unset
    expect(serverTimingAuthorized({ SERVER_TIMING_KEY: KEY }, req())).toBe(false) // no header
    for (const bad of ['', 'x', KEY.slice(1), KEY + 'x', KEY.toUpperCase()]) {
      expect(serverTimingAuthorized({ SERVER_TIMING_KEY: KEY }, req(bad))).toBe(false)
    }
    for (const weak of ['', 'a', 'x'.repeat(23)]) {
      expect(serverTimingAuthorized({ SERVER_TIMING_KEY: weak }, req(weak))).toBe(false) // short secret = disabled
    }
    expect(serverTimingAuthorized({ SERVER_TIMING_KEY: 'x'.repeat(24) }, req('x'.repeat(24)))).toBe(true)
  })
})

describe('wrappers', () => {
  it('counts D1 (incl. batch of wrapped statements and withSession->batch) and KV; header holds no query/key text', async () => {
    const base = { DB: harness.db, SESSIONS: kvStub(), OAUTH_KV: kvStub(), OTHER: 'passthrough' } as unknown as Env // test env
    const { env, timer } = instrumentEnv(base)
    expect((env as unknown as { OTHER: string }).OTHER).toBe('passthrough')
    await env.DB.prepare('INSERT INTO secret_table_name (secret_col_name) VALUES (?1)').bind('secret-value-xyz').run()
    await env.DB.prepare('SELECT secret_col_name FROM secret_table_name WHERE secret_col_name = ?1').bind('secret-value-xyz').first()
    await env.DB.batch([env.DB.prepare('SELECT 1 AS a').bind(), env.DB.prepare('SELECT 2 AS b').bind()])
    expect(timer.d1.n).toBe(4)
    await env.SESSIONS.put('session:SECRET-KV-KEY', 'v')
    await env.SESSIONS.get('session:SECRET-KV-KEY')
    await env.OAUTH_KV.get('grant:ANOTHER-SECRET-KEY')
    expect(timer.kv.map((k) => k.op)).toEqual(['put', 'get', 'get'])
    const h = renderServerTiming(timer)
    expect(h).toMatch(/d1;dur=\d+\.\d;desc="n=4"/)
    for (const bad of ['secret_table_name', 'secret_col_name', 'secret-value-xyz', 'SECRET-KV-KEY', 'ANOTHER-SECRET-KEY', 'SELECT', 'INSERT']) expect(h).not.toContain(bad)
    for (const p of h.split(', ')) expect(p).toMatch(/^[a-z0-9-]+;dur=\d+\.\d(;desc="n=\d+")?$/)
  })

  it('withSession().batch() unwraps wrapped statements and is counted', async () => {
    const real = harness.db as unknown as { withSession?: unknown }
    // The sqlite harness has no withSession; provide the minimal session surface over it.
    real.withSession = () => ({ prepare: (q: string) => harness.db.prepare(q), batch: (s: D1PreparedStatement[]) => harness.db.batch(s) })
    const { env, timer } = instrumentEnv({ DB: harness.db, SESSIONS: kvStub(), OAUTH_KV: kvStub() } as unknown as Env) // test env
    const session = env.DB.withSession('first-unconstrained')
    const out = await session.batch([session.prepare('SELECT 1 AS a').bind(), session.prepare('SELECT 2 AS b').bind()])
    expect(out).toHaveLength(2)
    expect(timer.d1.n).toBe(2)
  })

  it('unwrapBinding returns the real DB for a wrapped one and is identity otherwise', () => {
    const { env } = instrumentEnv({ DB: harness.db, SESSIONS: kvStub(), OAUTH_KV: kvStub() } as unknown as Env) // test env
    expect(env.DB).not.toBe(harness.db)
    expect(unwrapBinding(env.DB)).toBe(harness.db)
    expect(unwrapBinding(harness.db)).toBe(harness.db)
  })

  it('a 101 response is returned as the SAME object (WebSocket upgrade not rebuilt)', () => {
    const t: Timer = { start: performance.now(), kv: [], kvMore: { n: 0, ms: 0 }, d1: { n: 0, ms: 0 }, authMs: 0 }
    const upgrade = { status: 101, headers: new Headers(), body: null } as unknown as Response // 101 cannot be built with new Response() in Node
    expect(withServerTiming(upgrade, t)).toBe(upgrade)
    const ok = new Response('x')
    const out = withServerTiming(ok, t)
    expect(out.headers.get('server-timing')).toContain('total;dur=')
  })

  it('withAuthTiming on an uninstrumented env is a plain passthrough', async () => {
    expect(await withAuthTiming({}, async () => 7)).toBe(7)
  })

  it('KV memory is bounded: entries capped, remainder only counted and summed', async () => {
    const { env, timer } = instrumentEnv({ DB: harness.db, SESSIONS: kvStub(), OAUTH_KV: kvStub() } as unknown as Env) // test env
    for (let i = 0; i < MAX_KV_ENTRIES + 5; i++) await env.SESSIONS.get(`k${i}`)
    expect(timer.kv).toHaveLength(MAX_KV_ENTRIES)
    expect(timer.kvMore.n).toBe(5)
    const h = renderServerTiming(timer)
    expect(h.match(/kv-get;/g)?.length).toBe(MAX_KV_ENTRIES)
    expect(h).toMatch(/kv-more;dur=\d+\.\d;desc="n=5"/)
  })
})

describe('identity-keyed caches see the raw DB', () => {
  it('a fresh per-request wrapper does not defeat the schema-ready cache (no extra sqlite_master query)', async () => {
    const mk = () => instrumentEnv({ DB: harness.db, SESSIONS: kvStub(), OAUTH_KV: kvStub() } as unknown as Env) // test env
    const first = mk()
    expect(await routineTablesReady(first.env)).toBe(true)
    expect(first.timer.d1.n).toBe(1)
    const second = mk()
    expect(await routineTablesReady(second.env)).toBe(true)
    expect(second.timer.d1.n).toBe(0)
  })
})

describe('auth phase under delayed stubs', () => {
  const RAW = 'bearer-token-for-timing-test'
  function seed(): void {
    harness.sqlite.exec(`
      INSERT INTO members (id, display_name, email, status, tenant) VALUES ('m1', 'M', 'm@example.com', 'active', 'tenant-a');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant)
        VALUES ('t1', 'm1', '${createHash('sha256').update(RAW).digest('hex')}', 'x', 'workspace', '2026-07-24T00:00:00.000Z', 'tenant-a');`)
  }

  it('bearer auth: auth > 0 (>= delay), d1 counted, handler + auth ~ total', async () => {
    seed()
    const { env, timer } = instrumentEnv({ TENANT_SLUG: 'tenant-a', DB: delayedDb(harness.db, 25), SESSIONS: kvStub(), OAUTH_KV: kvStub() } as unknown as Env) // test env
    const id = await resolveMemberByToken(env, RAW)
    expect(id?.memberId).toBe('m1')
    await sleep(15) // "handler" work after auth
    const h = renderServerTiming(timer)
    const dur = (n: string) => Number(new RegExp(`(?:^|, )${n};dur=([\\d.]+)`).exec(h)?.[1])
    expect(dur('auth')).toBeGreaterThanOrEqual(20)
    expect(dur('d1')).toBeGreaterThanOrEqual(20)
    expect(dur('handler')).toBeGreaterThanOrEqual(10)
    expect(Math.abs(dur('handler') + dur('auth') - dur('total'))).toBeLessThanOrEqual(0.3)
  })

  it('cookie (session) auth: auth > 0 (>= delay) and the KV read is timed', async () => {
    const sessions = kvStub(25) // no seeded session => auth resolves to 401, still timed
    const { env, timer } = instrumentEnv({ TENANT_SLUG: 'tenant-a', DB: harness.db, SESSIONS: sessions, OAUTH_KV: kvStub() } as unknown as Env) // test env
    const app = new Hono<{ Bindings: Env }>()
    app.use('*', requireAuth)
    app.get('/', (c) => c.text('ok'))
    const res = await app.fetch(new Request('https://x.test/', { headers: { cookie: 'mupot_session=abc' } }), env)
    expect(res.status).toBe(401)
    const h = renderServerTiming(timer)
    const dur = (n: string) => Number(new RegExp(`(?:^|, )${n};dur=([\\d.]+)`).exec(h)?.[1])
    expect(dur('auth')).toBeGreaterThanOrEqual(20)
    expect(h).toMatch(/kv-get;dur=/)
  })
})
