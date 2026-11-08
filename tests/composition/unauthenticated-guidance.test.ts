// Real Miniflare D1 + the complete committed chain; use the repository's sanctioned helper alias.
import { applyD1Migrations as applyAllMigrations, env as cfEnv } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { sha256Hex } from '../../src/lib/canonical-json'

const bindings = cfEnv as unknown as { MUPOT_DB: D1Database; TEST_MIGRATIONS: never; ST_OAUTH_KV: KVNamespace; ST_SESSIONS: KVNamespace }
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
const revoked = 'mupot_beta_revoked_test_fixture'
const expired = 'mupot_beta_expired_test_fixture'
const live = 'mupot_beta_live_test_fixture'
const origin = 'https://pot.test'
const env = () => ({ DB: bindings.MUPOT_DB, OAUTH_KV: bindings.ST_OAUTH_KV, SESSIONS: bindings.ST_SESSIONS,
  TENANT_SLUG: 'mumega', PUBLIC_ORIGIN: origin, BRAND: 'Mupot' }) as never
beforeAll(async () => {
  await applyAllMigrations(bindings.MUPOT_DB, bindings.TEST_MIGRATIONS)
  await bindings.MUPOT_DB.exec("INSERT OR IGNORE INTO departments(id,slug,name) VALUES ('beta-d','beta-d','Beta')")
  await bindings.MUPOT_DB.exec("INSERT OR IGNORE INTO squads(id,department_id,slug,name) VALUES ('beta-s','beta-d','beta-s','Beta')")
  await bindings.MUPOT_DB.exec("INSERT OR IGNORE INTO agents(id,squad_id,slug,name,status) VALUES ('beta-a','beta-s','beta-a','Beta','active')")
  await bindings.MUPOT_DB.exec("INSERT OR IGNORE INTO members(id,tenant,display_name,status) VALUES ('beta-m','mumega','Beta','active')")
  await bindings.MUPOT_DB.exec("INSERT OR IGNORE INTO capabilities(id,member_id,scope_type,scope_id,capability) VALUES ('beta-cap','beta-m','squad','beta-s','member')")
  await bindings.MUPOT_DB.exec("INSERT OR IGNORE INTO agent_member_bindings(tenant,agent_id,member_id,created_at) VALUES ('mumega','beta-a','beta-m',datetime('now'))")
  for (const [id, raw, revokedAt, expiresAt] of [
    ['beta-revoked', revoked, '2020-01-01', null],
    ['beta-expired', expired, null, '2020-01-01'],
    ['beta-live', live, null, null],
  ] as const) {
    await bindings.MUPOT_DB.prepare(`INSERT OR IGNORE INTO member_tokens(id,tenant,member_id,agent_id,token_hash,channel,revoked_at,expires_at)
      VALUES (?,'mumega','beta-m','beta-a',?,'workspace',?,?)`).bind(id, await sha256Hex(raw), revokedAt, expiresAt).run()
  }
}, 120_000)

function request(path: string, token?: string) {
  const isPost = path === '/mcp' || path.startsWith('/mcp/profile/') || path.startsWith('/actions/')
  return new Request(origin + path, { method: isPost ? 'POST' : 'GET',
    headers: { ...(isPost ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(isPost ? { body: path.startsWith('/actions/') ? '{}' : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) } : {}) })
}

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function signedInboxRequest(body: Record<string, unknown>) {
  return new Request(origin + '/api/inbox/signed', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('cold authentication guidance at the deployed HTTP boundary', () => {
  it.each(['/mcp','/mcp/tools','/mcp/health','/mcp/profile/needs-you','/actions/status','/openapi.full.json','/api/inbox?peek=1','/api/tasks'])('%s refuses equally without, with unknown, revoked, and expired credentials', async path => {
    const bodies: string[] = [], challenges: Array<string | null> = []
    for (const token of [undefined, 'mupot_beta_unknown_test_fixture', revoked, expired]) {
      const response = await worker.fetch(request(path, token), env(), ctx)
      expect(response.status).toBe(401)
      challenges.push(response.headers.get('www-authenticate'))
      const text = await response.text(); bodies.push(text)
      const body = JSON.parse(text)
      expect(body).toMatchObject({ who_acts: 'owner', what_happened: 'This request could not be authenticated.',
        help_url: 'https://mumega.com/docs/how-to-connect/' })
      expect(body.next_step).toContain('your human')
      if (path.startsWith('/api/')) {
        expect(body.next_step).toContain(path.startsWith('/api/inbox') ? 'admin-issued agent key' : 'sign in at this pot')
        expect(body.next_step).not.toContain('OAuth consent flow')
      } else expect(body.next_step).toContain('workspace admin')
      for (const value of ['beta-m','beta-a',revoked,'mupot_beta_unknown_test_fixture']) expect(text).not.toContain(value)
    }
    expect(new Set(bodies).size).toBe(1)
    if (path.startsWith('/mcp')) {
      for (let i = 0; i < challenges.length; i++) {
        // These are the unmodified provider challenges: missing and rejected
        // credentials already have different descriptions; do not rewrite them.
        const description = i === 0 ? ', error_description="Missing or invalid access token"' : ''
        expect(challenges[i]).toBe(`Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource${path}", error="invalid_token"${description}`)
      }
    } else expect(challenges).toEqual([null, null, null, null])
  })

  it('shares one body shape across the public authentication surfaces', async () => {
    const shapes: string[] = []
    for (const path of ['/mcp','/actions/status','/openapi.full.json','/api/inbox?peek=1','/api/tasks']) {
      const response = await worker.fetch(request(path),env(),ctx)
      expect(response.status).toBe(401)
      shapes.push(Object.keys(await response.json() as object).sort().join(','))
    }
    expect(new Set(shapes).size).toBe(1)
  })

  it('keeps authenticated status, public discovery, and unrelated failures intact', async () => {
    const accepted = await worker.fetch(request('/actions/status', live), env(), ctx)
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).not.toContain('what_happened')
    const mcp = await worker.fetch(request('/mcp', live), env(), ctx)
    expect(mcp.status).toBe(200)
    const rpc = await mcp.json() as { result: { tools: unknown[] } }
    expect(rpc.result.tools.length).toBeGreaterThan(0)
    const discovery = await worker.fetch(request('/.well-known/oauth-protected-resource/mcp'), env(), ctx)
    expect(discovery.status).toBe(200)
    expect((await discovery.json() as { resource: string }).resource).toBe(origin + '/mcp')
    const publicSpec = await worker.fetch(request('/openapi.json'), env(), ctx)
    expect(publicSpec.status).toBe(200)
  })

  it.each([
    ['clock skew', async () => ({
      agent_id: 'beta-a', peek: true, limit: 1, ts: 1,
      nonce: b64url(crypto.getRandomValues(new Uint8Array(24))),
      sig: b64url(crypto.getRandomValues(new Uint8Array(64))),
    }), 'signature timestamp out of window'],
    ['bad signature', async () => {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
      const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey)
      await bindings.MUPOT_DB.prepare(`INSERT OR REPLACE INTO agent_keys(tenant,agent_id,pubkey,algo,member_id,created_at)
        VALUES ('mumega','beta-a',?,'Ed25519','beta-m',?)`).bind(publicKey.x, Math.floor(Date.now() / 1000)).run()
      return {
        agent_id: 'beta-a', peek: true, limit: 1, ts: Math.floor(Date.now() / 1000),
        nonce: b64url(crypto.getRandomValues(new Uint8Array(24))),
        sig: b64url(crypto.getRandomValues(new Uint8Array(64))),
      }
    }, 'signature verification failed'],
  ])('keeps signed inbox %s detail through the composed worker', async (_case, bodyFor, detail) => {
    const response = await worker.fetch(signedInboxRequest(await bodyFor()), env(), ctx)
    expect(response.status).toBe(401)
    expect(await response.text()).toBe(JSON.stringify({ error: 'unauthorized', detail }))
  })
})
