// SERVER_TIMING flag through the REAL entry point (src/index.ts default fetch, OAuthProvider wrapper)
// inside workerd with a real Miniflare D1 carrying the committed migrations: the timed D1/KV wrappers
// must work against native bindings (this-binding), not just fakes. Flag off = no header.

import { applyD1Migrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { Env } from '../../src/types'

const TENANT = 'mumega'
const RAW_TOKEN = 'raw-secret-token-do-not-leak-0123456789'
const COOKIE_VALUE = 'session-cookie-do-not-leak-abcdef'
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const testEnv = cfEnv as unknown as { MUPOT_DB: D1Database; TEST_MIGRATIONS: never }

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    list: async () => ({ keys: [], list_complete: true, cacheStatus: null }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  }
}


async function sha256Hex(raw: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.MUPOT_DB, testEnv.TEST_MIGRATIONS)
  const hash = await sha256Hex(RAW_TOKEN)
  await testEnv.MUPOT_DB.exec("INSERT OR IGNORE INTO members (id, email, display_name, status, tenant) VALUES ('m1', 'm@example.test', 'M', 'active', 'mumega')")
  await testEnv.MUPOT_DB.exec(`INSERT OR IGNORE INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('t1', 'm1', '${hash}', 'x', 'workspace', datetime('now'), 'mumega')`)
}, 120_000)

function makeEnv(flag?: string): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'mupot',
    PUBLIC_ORIGIN: 'https://mupot.mumega.com',
    DB: testEnv.MUPOT_DB,
    SESSIONS: kv(),
    OAUTH_KV: kv(),
    ...(flag === undefined ? {} : { SERVER_TIMING: flag }),
  } as unknown as Env // minimal test env: only the bindings this path reads
}

const inbox = (headers: Record<string, string> = { authorization: `Bearer ${RAW_TOKEN}` }) =>
  new Request('https://mupot.mumega.com/api/inbox?peek=1', { headers })

describe('Server-Timing flag', () => {
  it('flag off (unset, "0", "true"): no header at all', async () => {
    for (const flag of [undefined, '0', 'true', '']) {
      const res = await worker.fetch(inbox(), makeEnv(flag), ctx)
      expect(res.headers.has('server-timing')).toBe(false)
    }
  })

  it('flag on: well-formed phases on an authed /api response, no secrets, no SQL', async () => {
    const res = await worker.fetch(
      inbox({ authorization: `Bearer ${RAW_TOKEN}`, cookie: `mupot_session=${COOKIE_VALUE}` }),
      makeEnv('1'),
      ctx,
    )
    const h = res.headers.get('server-timing') ?? ''
    expect(h).not.toBe('')
    const names = h.split(', ').map((p) => p.split(';')[0])
    expect(names[0]).toBe('auth')
    expect(names).toContain('d1')
    expect(names.slice(-2)).toEqual(['handler', 'total'])
    for (const p of h.split(', ')) expect(p).toMatch(/^[a-z0-9-]+;dur=\d+\.\d(;desc="n=\d+")?$/)
    const d1n = Number(/d1;dur=[\d.]+;desc="n=(\d+)"/.exec(h)?.[1])
    expect(d1n).toBeGreaterThanOrEqual(1) // the token lookup ran through the timed D1
    const dur = (n: string) => Number(new RegExp(`(?:^|, )${n};dur=([\\d.]+)`).exec(h)?.[1])
    expect(dur('auth')).toBeLessThanOrEqual(dur('total'))
    for (const bad of [RAW_TOKEN, COOKIE_VALUE, 'member_tokens', 'SELECT', 'Bearer', 'mumega']) expect(h).not.toContain(bad)
  })

  it('flag on: non-/api paths get no header', async () => {
    const res = await worker.fetch(new Request('https://mupot.mumega.com/health'), makeEnv('1'), ctx)
    expect(res.headers.has('server-timing')).toBe(false)
  })

  it('flag on: a bad token still gets only phase names (no echo of the token)', async () => {
    const res = await worker.fetch(inbox({ authorization: 'Bearer wrong-token-xyz' }), makeEnv('1'), ctx)
    const h = res.headers.get('server-timing') ?? ''
    expect(h).toContain('auth;dur=')
    expect(h).not.toContain('wrong-token-xyz')
  })
})
