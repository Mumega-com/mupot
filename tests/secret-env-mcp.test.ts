// tests/secret-env-mcp.test.ts — secret_env_request / secret_env_status MCP tools.
// Custody discipline: neither tool ever returns a secret VALUE. request returns
// only names + a request id; status returns only the state enum per name.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AuthContext, Env } from '../src/types'
import { TOOLS, invokeTool } from '../src/mcp/index'
import { createSqliteD1 } from './helpers/sqlite-d1'

const migrations = [
  '../migrations/0001_init.sql',
  '../migrations/0071_secret_env.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))

const TENANT = 'tenant-a'
const ORIGIN = 'https://pot.test'

function makeDb() {
  const harness = createSqliteD1()
  for (const migration of migrations) harness.sqlite.exec(migration)
  return {
    env: { DB: harness.db, TENANT_SLUG: TENANT } as Env,
    bindingRow: (name: string) => harness.sqlite
      .prepare('SELECT * FROM secret_env_bindings WHERE tenant = ? AND binding_name = ?')
      .get(TENANT, name) as Record<string, unknown> | undefined,
  }
}

function auth(memberId: string): AuthContext {
  return {
    userId: memberId,
    email: `${memberId}@example.test`,
    role: 'member',
    tenant: TENANT,
    channel: 'workspace',
    memberId,
    capabilities: [],
    boundAgentId: null,
  }
}

const member = auth('member-1')

describe('secret-env MCP tools — registry', () => {
  it('registers secret_env_request and secret_env_status as authenticated tools', () => {
    for (const name of ['secret_env_request', 'secret_env_status']) {
      const spec = TOOLS.find((t) => t.name === name)
      expect(spec).toBeDefined()
      expect(spec?.min).toBe('authenticated')
    }
  })
})

describe('secret_env_request', () => {
  it('creates a pending request and returns only names — never a value field', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = out.result as { request_id: string; keys: string[] }
    expect(typeof result.request_id).toBe('string')
    expect(result.keys).toEqual(['STRIPE_API_KEY'])
    expect(JSON.stringify(result)).not.toContain('value')

    const row = db.bindingRow('STRIPE_API_KEY')
    expect(row?.status).toBe('pending')
    expect(row?.requested_by).toBe('member-1')
  })

  it('rejects an unauthenticated caller', async () => {
    const db = makeDb()
    const anon = { ...member, memberId: undefined, userId: '' } as AuthContext
    const out = await invokeTool(anon, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })

  it('rejects missing reason with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: '',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects an empty keys array with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects an invalid binding name with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'not-a-valid-name', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects a key entry missing purpose with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY' }],
      reason: 'need to process payments',
    }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('passes adapter_hint through when provided', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
      adapter_hint: 'stripe',
    }, ORIGIN)
    expect(out.ok).toBe(true)
    const row = db.bindingRow('STRIPE_API_KEY')
    expect(row?.adapter_hint).toBe('stripe')
  })
})

describe('secret_env_status', () => {
  it('returns bound/unbound/pending statuses and never a value field', async () => {
    const db = makeDb()
    await invokeTool(member, db.env, 'secret_env_request', {
      keys: [{ name: 'STRIPE_API_KEY', purpose: 'charge customers' }],
      reason: 'need to process payments',
    }, ORIGIN)

    const out = await invokeTool(member, db.env, 'secret_env_status', {
      names: ['STRIPE_API_KEY', 'NEVER_REQUESTED'],
    }, ORIGIN)

    expect(out.ok).toBe(true)
    if (!out.ok) return
    const result = out.result as { statuses: Record<string, string> }
    expect(result.statuses.STRIPE_API_KEY).toBe('pending')
    expect(result.statuses.NEVER_REQUESTED).toBe('unbound')
    expect(JSON.stringify(result)).not.toContain('"value"')
  })

  it('rejects an empty names array with 400', async () => {
    const db = makeDb()
    const out = await invokeTool(member, db.env, 'secret_env_status', { names: [] }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects more than 20 names with 400', async () => {
    const db = makeDb()
    const names = Array.from({ length: 21 }, (_, i) => `KEY_${i}`)
    const out = await invokeTool(member, db.env, 'secret_env_status', { names }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(400)
  })

  it('rejects an unauthenticated caller', async () => {
    const db = makeDb()
    const anon = { ...member, memberId: undefined, userId: '' } as AuthContext
    const out = await invokeTool(anon, db.env, 'secret_env_status', { names: ['STRIPE_API_KEY'] }, ORIGIN)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.status).toBe(403)
  })
})
