// tests/bound-agent-live-rest.test.ts — mupot#2343: the #983 live check on REST bearer routes, plus the zero-capability
// ("demoted") refusal at the MCP tool doors. Real SQL (whole migration chain), real resolveMemberByToken.
//
// Every fixture caller is a plain squad-member agent: NOT an org owner and not a workspace admin.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { Hono } from 'hono'
import { appErrorHandler } from '../src/app-error'
import { inboxApp, streamInboxEvents } from '../src/agents/inbox-routes'
import { mcpApp, mcpActionsApp } from '../src/mcp/index'
import { hashMemberToken, memberTokenHashIsLive, resolveMemberByToken, resolveStreamMemberByToken } from '../src/auth/member-bearer'
import { boundAgentVerdict, BOUND_AGENT_CHECK_UNAVAILABLE, BOUND_AGENT_NOT_AUTHORIZED } from '../src/auth/bound-agent-live'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { seedLiveToken } from './helpers/live-token'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const OWNER = 'member-owner'
const AGENT_MEMBER = 'member-agent-a'
const BEARER = 'raw-agent-bearer-2343'

let harness: SqliteD1Harness

function envFor(h: SqliteD1Harness, db: unknown = h.db): Env {
  return { DB: db, TENANT_SLUG: TENANT, BUS: { send: async () => {} } } as unknown as Env
}
/** A DB whose agent-liveness statement throws (every other statement passes through). */
function liveReadThrows(h: SqliteD1Harness): unknown {
  return { prepare: (sql: string) => { if (sql.includes('FROM agents a') && sql.includes('has_caps')) throw new Error('d1 down'); return h.db.prepare(sql) }, batch: h.db.batch.bind(h.db) }
}

beforeEach(async () => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-eng', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-eng', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-b', 'squad-a', 'agent-b', 'Agent B', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${OWNER}', 'Owner', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${AGENT_MEMBER}', 'Agent A', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-a', '${AGENT_MEMBER}', '2026-08-01T00:00:00.000Z');
    UPDATE agents SET owner_member_id = '${OWNER}' WHERE id = 'agent-a';
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', '${AGENT_MEMBER}', 'squad', 'squad-a', 'member');
  `)
  const tokenId = seedLiveToken(harness.sqlite, { memberId: AGENT_MEMBER, tenant: TENANT, tokenId: 'tok-rest', channel: 'workspace', boundAgentId: 'agent-a' })
  harness.sqlite.prepare(`UPDATE member_tokens SET token_hash = ? WHERE id = ?`).run(await hashMemberToken(BEARER), tokenId)
})

afterEach(() => harness.close())

// The real inbox router behind the real root error handler (src/index.ts installs the same appErrorHandler).
const app = new Hono<{ Bindings: Env }>().route('/api/inbox', inboxApp)
app.onError(appErrorHandler)
const auth = { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' }
const list = (env = envFor(harness)) => inboxApp.request('/?peek=1', { headers: auth }, env)
const send = (env = envFor(harness)) => inboxApp.request('/send', { method: 'POST', headers: auth, body: JSON.stringify({ to: 'agent-b', body: 'hi' }) }, env)
const stream = (env = envFor(harness)) => inboxApp.request('/stream', { headers: auth }, env)
const routes: Array<[string, (env?: Env) => Promise<Response>]> = [['inbox list', list], ['inbox send', send], ['inbox stream', stream]]

/** Each way the weld can stop being backed by live humans/agents; each must refuse on every REST route. */
const BREAKERS: Array<[string, string]> = [
  ['owner suspended', `UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`],
  ['owner in another tenant', `UPDATE members SET tenant = 'other-tenant' WHERE id = '${OWNER}'`],
  ['owner row missing', `PRAGMA foreign_keys = OFF; DELETE FROM members WHERE id = '${OWNER}'`],
  ['agent deactivated', `UPDATE agents SET status = 'inactive' WHERE id = 'agent-a'`],
  ['agent member demoted (zero capabilities)', `DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'`],
]

describe('#2343 REST routes refuse a weld that is no longer live', () => {
  it.each(routes)('control: %s serves a live agent', async (_n, call) => {
    const res = await call()
    expect(res.status).toBe(200)
    await res.body?.cancel()
  })

  for (const [label, sql] of BREAKERS) {
    it.each(routes)(`${label}: %s -> 401 unauthorized`, async (_n, call) => {
      harness.sqlite.exec(sql)
      const res = await call()
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    })
  }

  it('paused agent keeps the brake semantics (admitted)', async () => {
    harness.sqlite.exec(`UPDATE agents SET status = 'paused' WHERE id = 'agent-a'`)
    expect((await list()).status).toBe(200)
  })

  it('refusals are uniform: owner gone and zero-cap are byte-identical', async () => {
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    const a = await (await list()).text()
    harness.sqlite.exec(`UPDATE members SET status = 'active' WHERE id = '${OWNER}'; DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'`)
    expect(await (await list()).text()).toBe(a)
  })

  it('an unbound human token is untouched (no extra read, no refusal)', async () => {
    const tokenId = seedLiveToken(harness.sqlite, { memberId: 'member-human', tenant: TENANT, tokenId: 'tok-human', channel: 'workspace' })
    harness.sqlite.prepare(`UPDATE member_tokens SET token_hash = ? WHERE id = ?`).run(await hashMemberToken('human-bearer'), tokenId)
    harness.sqlite.exec(`UPDATE agents SET status = 'inactive'`)
    expect(await resolveMemberByToken(envFor(harness), 'human-bearer')).toMatchObject({ memberId: 'member-human', boundAgentId: null })
  })

  it('an existing stream ends at its next re-validation once the owner is gone', async () => {
    const env = envFor(harness)
    let alive = true
    const gen = streamInboxEvents(env, {
      agent: 'agent-a', pollMs: 5000,
      revalidate: async () => (await resolveMemberByToken(env, BEARER).catch(() => null))?.boundAgentId === 'agent-a',
    }, { sleep: async () => { /* no wait */ }, nowMs: (() => { let t = 0; return () => (t += 61_000) })() })
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    const next = await gen.next() // first tick: idle + cadence elapsed -> revalidate -> refused -> generator ends
    expect(next.done).toBe(true)
    alive = false
    expect(alive).toBe(false)
  })

  it('presence socket re-check drops a refused agent token', async () => {
    const hash = await hashMemberToken(BEARER)
    expect(await memberTokenHashIsLive(envFor(harness), hash, AGENT_MEMBER)).toBe(true)
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    expect(await memberTokenHashIsLive(envFor(harness), hash, AGENT_MEMBER)).toBe(false)
  })

  it('push-mode stream entry maps a refusal to invalid', async () => {
    harness.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)
    expect(await resolveStreamMemberByToken(envFor(harness), BEARER)).toEqual({ status: 'invalid' })
  })
})

describe('#2343 a failed liveness read is a retryable 503, never a 403 and never a pass', () => {
  it.each([
    ['GET /api/inbox', '/api/inbox?peek=1', 'GET'],
    ['POST /api/inbox/send', '/api/inbox/send', 'POST'],
    ['GET /api/inbox/stream', '/api/inbox/stream', 'GET'],
  ])('%s -> 503 agent_check_unavailable (root app, onError)', async (_n, path, method) => {
    const res = await app.request(path, { method, headers: auth, ...(method === 'POST' ? { body: JSON.stringify({ to: 'agent-b', body: 'hi' }) } : {}) }, envFor(harness, liveReadThrows(harness)))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
    expect(await res.json()).toEqual({ error: BOUND_AGENT_CHECK_UNAVAILABLE })
  })

  it('push-mode stream entry reports error (-> its existing 503)', async () => {
    expect(await resolveStreamMemberByToken(envFor(harness, liveReadThrows(harness)), BEARER)).toEqual({ status: 'error' })
  })

  it('the verdict is unavailable, and the boolean form is false', async () => {
    expect(await boundAgentVerdict(envFor(harness, liveReadThrows(harness)) as Pick<Env, 'DB' | 'TENANT_SLUG'>, { boundAgentId: 'agent-a', memberId: AGENT_MEMBER })).toBe('unavailable')
  })
})

// ── MCP doors: demoted (zero-capability) workspace agent + cross-tenant legs + 503 + elicitation ordering ──────────
describe('#2343 MCP tool doors', () => {
  const agentAuth = (extra: Partial<AuthContext> = {}): AuthContext => ({
    userId: AGENT_MEMBER, email: null, role: 'member', tenant: TENANT, memberId: AGENT_MEMBER, channel: 'workspace',
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    boundAgentId: 'agent-a', tokenId: 'tok-rest', ...extra,
  } as AuthContext)
  const headers = (): Record<string, string> => ({ 'content-type': 'application/json', authorization: `Bearer ${BEARER}`, [AUTH_CONTEXT_HEADER]: JSON.stringify(agentAuth()) })
  const legacy = (tool: string, args: Record<string, unknown>, env = envFor(harness)) => mcpApp.request('https://pot.test/', { method: 'POST', headers: headers(), body: JSON.stringify({ tool, args }) }, env)
  const actions = (tool: string, args: Record<string, unknown>, env = envFor(harness)) => mcpActionsApp.request(`https://pot.test/actions/${tool}`, { method: 'POST', headers: headers(), body: JSON.stringify(args) }, env)
  const rpc = (tool: string, args: Record<string, unknown>, env = envFor(harness)) => mcpApp.request('https://pot.test/', { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) }, env)

  const FLOOR_TOOLS: Array<[string, Record<string, unknown>]> = [['inbox', {}], ['send', { to: 'agent-b', body: 'hello' }], ['inbox_lease', {}], ['presence_list', { self: true }]]

  it.each(FLOOR_TOOLS)('control: %s reaches its body with capabilities', async (tool, args) => {
    expect((await legacy(tool, args)).status).toBeLessThan(400)
  })

  it.each(FLOOR_TOOLS)('zero-capability workspace agent: %s -> 403 agent_not_authorized on every door', async (tool, args) => {
    harness.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'`)
    for (const door of [legacy, actions]) {
      const res = await door(tool, args)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe(BOUND_AGENT_NOT_AUTHORIZED)
    }
    expect(JSON.stringify(await (await rpc(tool, args)).json())).toContain(BOUND_AGENT_NOT_AUTHORIZED)
  })

  it('an expired-only capability set is zero capabilities', async () => {
    harness.sqlite.exec(`UPDATE capabilities SET expires_at = '2026-01-02 00:00:00' WHERE member_id = '${AGENT_MEMBER}'`)
    expect((await legacy('inbox', {})).status).toBe(403)
  })


  it.each([
    ['owner in another tenant', `UPDATE members SET tenant = 'other-tenant' WHERE id = '${OWNER}'`],
    ['owner row missing', `PRAGMA foreign_keys = OFF; DELETE FROM members WHERE id = '${OWNER}'`],
  ])('%s -> 403 on the tool doors', async (_n, sql) => {
    harness.sqlite.exec(sql)
    expect((await legacy('inbox', {})).status).toBe(403)
  })

  it('consenter row missing / in another tenant -> refused (verdict)', async () => {
    harness.sqlite.exec(`INSERT INTO members (id, display_name, status, tenant) VALUES ('m-consent-x', 'X', 'active', 'other-tenant')`)
    const env = envFor(harness) as Pick<Env, 'DB' | 'TENANT_SLUG'>
    expect(await boundAgentVerdict(env, { boundAgentId: 'agent-a', consentedByMemberId: 'm-consent-x', channel: 'directory' })).toBe('refused')
    expect(await boundAgentVerdict(env, { boundAgentId: 'agent-a', consentedByMemberId: 'm-ghost', channel: 'directory' })).toBe('refused')
  })

  it('a consented (directory) session is not judged on the member capability leg', async () => {
    harness.sqlite.exec(`INSERT INTO members (id, display_name, status, tenant) VALUES ('m-consent', 'C', 'active', '${TENANT}'); DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'`)
    const env = envFor(harness) as Pick<Env, 'DB' | 'TENANT_SLUG'>
    expect(await boundAgentVerdict(env, { boundAgentId: 'agent-a', memberId: AGENT_MEMBER, consentedByMemberId: 'm-consent', channel: 'directory' })).toBe('live')
  })

  it('liveness read throws -> 503 agent_check_unavailable on every door (not 403)', async () => {
    const env = envFor(harness, liveReadThrows(harness))
    for (const door of [legacy, actions]) {
      const res = await door('inbox', {}, env)
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toBe(BOUND_AGENT_CHECK_UNAVAILABLE)
    }
    const r = await rpc('inbox', {}, env)
    expect(r.status).toBe(503)
    expect(JSON.stringify(await r.json())).toContain(BOUND_AGENT_CHECK_UNAVAILABLE)
  })
})
