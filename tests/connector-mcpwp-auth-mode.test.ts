// mupot#1616: how an `mcpwp` connector authenticates. The vault owns header
// construction; an MCPWP API key goes out as X-API-Key (the only way the MCPWP
// REST layer accepts it), a WordPress application password stays Basic for the
// callers that still hit core /wp/v2 routes, and the choice is never steerable by
// anything but an explicit caller pin or the connector's own meta.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { encryptConnectorSecret } from '../src/connectors/crypto'
import { useConnectorById, type McpwpAuthMode } from '../src/connectors/service'

const TENANT = 'tenant-mcpwp-auth'
const MASTER_KEY = '44'.repeat(32)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function fixture(meta: Record<string, unknown>, secret: string): Promise<{ harness: SqliteD1Harness; env: Env; id: string }> {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  const id = 'connector-mcpwp-auth'
  const encrypted = await encryptConnectorSecret(MASTER_KEY, id, 'mcpwp', secret)
  harness.sqlite.prepare(
    `INSERT INTO connectors (id, tenant, type, label, encrypted_secret, meta, scope_type, scope_id, created_by, created_at)
     VALUES (?, ?, 'mcpwp', 'site', ?, ?, 'pot', NULL, 'test', '2026-01-01T00:00:00Z')`,
  ).run(id, TENANT, encrypted, JSON.stringify(meta))
  return { harness, env: { DB: harness.db, TENANT_SLUG: TENANT, CONNECTOR_MASTER_KEY: MASTER_KEY } as Env, id }
}

async function sentHeaders(meta: Record<string, unknown>, secret: string, pin?: McpwpAuthMode, callerHeaders?: HeadersInit): Promise<Headers> {
  const { harness, env, id } = await fixture(meta, secret)
  let captured = new Headers()
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = new Headers(init?.headers)
    return new Response('{}', { status: 200 })
  }))
  await useConnectorById(env, id, 'mcpwp', async (connector) => {
    await connector.authenticatedFetch('https://wordpress.example.com/x', callerHeaders ? { headers: callerHeaders } : {})
    return { status: 'available', observations: [] }
  }, pin ? { mcpwpAuthMode: pin } : {})
  harness.close()
  return captured
}

describe('mcpwp connector auth mode (mupot#1616)', () => {
  const secret = `s-${crypto.randomUUID()}`

  it('no username, no mode: the secret is an MCPWP API key and goes out as X-API-Key', async () => {
    const h = await sentHeaders({ siteUrl: 'https://wordpress.example.com' }, secret)
    expect(h.get('x-api-key')).toBe(secret)
    expect(h.get('authorization')).toBeNull()
  })

  it('a pre-#1616 connector with a username stays Basic for the core-route callers', async () => {
    const h = await sentHeaders({ siteUrl: 'https://wordpress.example.com', username: 'op' }, secret)
    expect(h.get('authorization')).toBe(`Basic ${btoa(`op:${secret}`)}`)
    expect(h.get('x-api-key')).toBeNull()
  })

  it('explicit meta auth_mode wins over the username inference, both ways', async () => {
    const key = await sentHeaders({ siteUrl: 'https://wordpress.example.com', username: 'op', auth_mode: 'api_key' }, secret)
    expect(key.get('x-api-key')).toBe(secret)
    expect(key.get('authorization')).toBeNull()
    const basic = await sentHeaders({ siteUrl: 'https://wordpress.example.com', username: 'op', auth_mode: 'basic' }, secret)
    expect(basic.get('authorization')).toBe(`Basic ${btoa(`op:${secret}`)}`)
    expect(basic.get('x-api-key')).toBeNull()
  })

  it('a caller pin overrides editable meta (the office pins api_key; meta saying basic cannot steer it)', async () => {
    const h = await sentHeaders({ siteUrl: 'https://wordpress.example.com', username: 'op', auth_mode: 'basic' }, secret, 'api_key')
    expect(h.get('x-api-key')).toBe(secret)
    expect(h.get('authorization')).toBeNull()
  })

  it('an unknown auth_mode is ignored (falls back to the inference), never treated as a mode', async () => {
    const h = await sentHeaders({ siteUrl: 'https://wordpress.example.com', auth_mode: 'bearer-everything' }, secret)
    expect(h.get('x-api-key')).toBe(secret)
  })

  it('a caller-supplied Authorization / X-API-Key is dropped, never forwarded beside the vaulted credential', async () => {
    const h = await sentHeaders({ siteUrl: 'https://wordpress.example.com' }, secret, 'api_key', { authorization: 'Bearer attacker', 'x-api-key': 'attacker' })
    expect(h.get('x-api-key')).toBe(secret)
    expect(h.get('authorization')).toBeNull()
  })

  it('Basic without a username fails closed (connector_fetch_failed), and the error never carries the secret', async () => {
    const { harness, env, id } = await fixture({ siteUrl: 'https://wordpress.example.com', auth_mode: 'basic' }, secret)
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    let message = ''
    await useConnectorById(env, id, 'mcpwp', async (connector) => {
      try {
        await connector.authenticatedFetch('https://wordpress.example.com/x')
      } catch (error) {
        message = String(error)
      }
      return { status: 'available', observations: [] }
    })
    expect(message).toContain('connector_fetch_failed')
    expect(message).not.toContain(secret)
    expect(fetchSpy).not.toHaveBeenCalled()
    harness.close()
  })
})
