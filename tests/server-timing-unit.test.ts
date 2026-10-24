// Unit: the Server-Timing helper's wrappers and renderer (Node pool, real-schema SQLite D1).
// The redaction test is the one mutation-checked: widening what renderServerTiming emits (a SQL
// fragment, a KV key, a token) makes it fail.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { instrumentEnv, renderServerTiming, serverTimingEnabled, withAuthTiming, MAX_KV_ENTRIES, type Timer } from '../src/lib/server-timing'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

let harness: SqliteD1Harness
beforeEach(() => {
  harness = createSqliteD1()
  harness.sqlite.exec('CREATE TABLE secret_table_name (secret_col_name TEXT)')
})
afterEach(() => harness.close())

function kvStub() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true }),
    getWithMetadata: async () => ({ value: null, metadata: null }),
  }
}

describe('server-timing helper', () => {
  it('serverTimingEnabled is strict "1"', () => {
    expect(serverTimingEnabled({ SERVER_TIMING: '1' })).toBe(true)
    for (const v of [undefined, '', '0', 'true', ' 1']) expect(serverTimingEnabled({ SERVER_TIMING: v })).toBe(false)
  })

  it('counts D1 statements (incl. batch with wrapped statements) and KV calls; header holds no query/key text', async () => {
    const base = { DB: harness.db, SESSIONS: kvStub(), OAUTH_KV: kvStub(), OTHER: 'passthrough' } as unknown as Env // test env: only the timed bindings
    const { env, timer } = instrumentEnv(base)
    expect((env as unknown as { OTHER: string }).OTHER).toBe('passthrough')
    await env.DB.prepare('INSERT INTO secret_table_name (secret_col_name) VALUES (?1)').bind('secret-value-xyz').run()
    await env.DB.prepare('SELECT secret_col_name FROM secret_table_name WHERE secret_col_name = ?1').bind('secret-value-xyz').first()
    await env.DB.batch([
      env.DB.prepare('SELECT 1 AS a').bind(),
      env.DB.prepare('SELECT 2 AS b').bind(),
    ])
    await env.SESSIONS.put('session:SECRET-KV-KEY', 'v')
    await env.SESSIONS.get('session:SECRET-KV-KEY')
    await env.OAUTH_KV.get('grant:ANOTHER-SECRET-KEY')
    const out = await withAuthTiming(env, async () => 'ok')
    expect(out).toBe('ok')
    expect(timer.d1.n).toBe(4)
    expect(timer.kv.map((k) => k.op)).toEqual(['put', 'get', 'get'])
    const h = renderServerTiming(timer)
    expect(h).toMatch(/d1;dur=\d+\.\d;desc="n=4"/)
    for (const bad of ['secret_table_name', 'secret_col_name', 'secret-value-xyz', 'SECRET-KV-KEY', 'ANOTHER-SECRET-KEY', 'SELECT', 'INSERT']) {
      expect(h).not.toContain(bad)
    }
    for (const p of h.split(', ')) expect(p).toMatch(/^[a-z0-9-]+;dur=\d+\.\d(;desc="n=\d+")?$/)
  })

  it('withAuthTiming on an uninstrumented env is a plain passthrough', async () => {
    expect(await withAuthTiming({}, async () => 7)).toBe(7)
  })

  it('caps individual KV entries and folds the remainder', () => {
    const t: Timer = { start: performance.now(), kv: [], d1: { n: 0, ms: 0 }, authMs: 0 }
    for (let i = 0; i < MAX_KV_ENTRIES + 3; i++) t.kv.push({ op: 'get', ms: 1 })
    const h = renderServerTiming(t)
    expect(h.match(/kv-get;/g)?.length).toBe(MAX_KV_ENTRIES)
    expect(h).toContain('kv-more;dur=3.0;desc="n=3"')
  })
})
