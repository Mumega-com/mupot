// Option B task 0 (mupot#2374): /device is retired. Every method/path/content type answers one
// constant 410 and nothing runs behind it: no mint, no raw key, no KV/D1 access, no transition.
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { DEVICE_RETIRED_BODY, deviceRetiredApp } from '../src/auth/device-retired'
import type { Env } from '../src/types'

const PATHS = [
  '/device', '/device/', '/device/code', '/device/code/', '/device/token', '/device/preview',
  '/device/decision', '/device/ABCD-2345', '/device/a/b/c',
]
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
const OLD_CONTENT = [
  { type: 'application/json', body: JSON.stringify({ agent: 'agent-a', device_code: 'dc', user_code: 'ABCD-2345', action: 'allow', csrf: 'x' }) },
  { type: 'application/x-www-form-urlencoded', body: 'agent=agent-a&device_code=dc&user_code=ABCD-2345&action=allow&csrf=x' },
  { type: 'multipart/form-data; boundary=zz', body: '--zz\r\nContent-Disposition: form-data; name="user_code"\r\n\r\nABCD-2345\r\n--zz--\r\n' },
  { type: 'text/plain', body: 'user_code=ABCD-2345' },
  { type: '', body: 'agent=agent-a' },
]

// A spy KV: any touch at all is a failure, and the seeded legacy handles must stay byte-identical.
function spyKv(seed: Record<string, string>) {
  const store = new Map(Object.entries(seed))
  const calls: string[] = []
  const kv = {
    async get(key: string) { calls.push(`get:${key}`); return store.get(key) ?? null },
    async put(key: string, value: string) { calls.push(`put:${key}`); store.set(key, value) },
    async delete(key: string) { calls.push(`delete:${key}`); store.delete(key) },
    async list() { calls.push('list'); return { keys: [], list_complete: true } },
  }
  return { kv, calls, store }
}

const LEGACY = {
  'device-grant:hash1': JSON.stringify({ user_code: 'ABCD-2345', tenant: 'mumega', agent_id: 'agent-a', status: 'pending' }),
  'device-grant:hash2': JSON.stringify({ user_code: 'WXYZ-6789', tenant: 'mumega', agent_id: 'agent-a', status: 'approved', token_id: 'tok-legacy' }),
  'device-user:mumega:ABCD-2345': 'hash1',
  'device-pending:mumega': JSON.stringify(['hash1']),
  'device-redeem:hash2': 'RAW-LEGACY-SECRET-MUST-NEVER-APPEAR',
}

function snapshot(h: SqliteD1Harness): string {
  const tables = ['agents', 'members', 'member_tokens', 'capabilities', 'agent_member_bindings']
  return JSON.stringify(tables.map((t) => h.sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()))
}

function composed(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  app.route('/device', deviceRetiredApp)
  // Stand-in for the dashboard '/' catch-all: reaching it means /device fell through.
  app.all('*', (c) => c.text('FELL_THROUGH_TO_CATCH_ALL', 302))
  return app
}

describe('/device is retired (constant 410, nothing runs behind it)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => { harness?.close(); harness = undefined })

  it('answers the constant 410 for every method x path x old content type, with no side effects', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-eng', 'eng', 'Engineering');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-eng', 'squad-a', 'Squad A');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
      INSERT INTO members (id, email, display_name, status, created_at, tenant)
        VALUES ('human', 'human@example.test', 'Human', 'active', '2026-08-01T00:00:00.000Z', 'mumega');
    `)
    const before = snapshot(harness)
    const sessions = spyKv(LEGACY)
    const legacyBefore = JSON.stringify([...sessions.store])
    const env = { DB: harness.db, SESSIONS: sessions.kv, TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: 'https://pot.test' } as unknown as Env
    const app = composed()

    for (const path of PATHS) {
      for (const method of METHODS) {
        const bodies = method === 'GET' || method === 'HEAD' ? [null] : OLD_CONTENT
        for (const content of bodies) {
          const headers: Record<string, string> = {}
          if (content?.type) headers['content-type'] = content.type
          const res = await app.fetch(new Request(`https://pot.test${path}`, { method, headers, body: content?.body }), env)
          const label = `${method} ${path} ${content?.type ?? ''}`
          expect(res.status, label).toBe(410)
          expect(res.headers.get('cache-control'), label).toBe('no-store')
          expect(res.headers.get('set-cookie'), label).toBeNull()
          expect(res.headers.get('location'), label).toBeNull()
          if (method !== 'HEAD') {
            const text = await res.text()
            expect(JSON.parse(text), label).toEqual(DEVICE_RETIRED_BODY)
            expect(text, label).not.toMatch(/access_token|device_code|user_code|RAW-LEGACY|ABCD-2345|\bagent-a\b/)
          }
        }
      }
    }
    expect(sessions.calls).toEqual([])
    expect(JSON.stringify([...sessions.store])).toBe(legacyBefore)
    expect(snapshot(harness)).toBe(before)
  })

  it('carries what_happened / who_acts / next_step and the help URL', () => {
    expect(DEVICE_RETIRED_BODY.what_happened).toMatch(/retired/)
    expect(DEVICE_RETIRED_BODY.who_acts).toBe('owner')
    expect(DEVICE_RETIRED_BODY.next_step.length).toBeGreaterThan(20)
    expect(DEVICE_RETIRED_BODY.help_url).toBe('https://mumega.com/docs/how-to-connect/')
  })

  it('does not depend on any env: flags off, bindings absent, still 410 and no throw', async () => {
    const app = composed()
    for (const env of [{}, { DEVICE_GRANT_ENABLED: '0' }, { DEVICE_GRANT_ENABLED: '1', TENANT_SLUG: 'x' }]) {
      const res = await app.fetch(new Request('https://pot.test/device/token', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"device_code":"dc"}',
      }), env as unknown as Env)
      expect(res.status).toBe(410)
    }
  })

  it('a malformed or huge body is never read or parsed', async () => {
    const app = composed()
    const res = await app.fetch(new Request('https://pot.test/device/code', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' + 'x'.repeat(200_000),
    }), {} as unknown as Env)
    expect(res.status).toBe(410)
  })
})

describe('the weak device flow is gone from the tree', () => {
  const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

  it('the weak handlers, service and preview script no longer exist', () => {
    for (const p of ['src/auth/device-routes.ts', 'src/auth/device-grant.ts', 'scripts/device-grant-preview.mjs', 'tests/device-grant.test.ts']) {
      expect(existsSync(new URL(`../${p}`, import.meta.url)), p).toBe(false)
    }
  })

  it('src/index.ts mounts only the retired app, ahead of the dashboard catch-all, with no device-grant import', () => {
    const index = read('src/index.ts')
    expect(index).not.toMatch(/device-routes|device-grant|deviceApp\b/)
    const mount = index.indexOf("app.route('/device', deviceRetiredApp)")
    expect(mount).toBeGreaterThan(-1)
    expect(mount).toBeLessThan(index.indexOf('app.route(ROUTES.dashboard, dashboardApp)'))
    expect(mount).toBeLessThan(index.indexOf("app.route('/', platformApp)"))
  })

  it('no source file mints a device:<code> token any more', () => {
    for (const p of ['src/members/service.ts', 'src/mcp/oauth-authorize.ts', 'src/auth/index.ts']) {
      expect(read(p), p).not.toMatch(/`device:\$\{/)
    }
  })
})
