// tests/uniform-503-2345.test.ts — mupot#2345: a failed agent-liveness read is the retryable 503 on EVERY surface that resolves
// an agent bearer (routines, addons, bearer-read, MCP), the directory exemption is keyed on consent, the root error handler
// keeps context headers, and the fail-closed edges of the live check are pinned (stream / presence / channel grant / home squad).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { seedLiveToken } from './helpers/live-token'
import { appErrorHandler } from '../src/app-error'
import { inboxApp } from '../src/agents/inbox-routes'
import { routinesApp } from '../src/routines/routes'
import { addonsApp } from '../src/addons/routes'
import { requireAuth } from '../src/auth/index'
import { mcpApp, mcpActionsApp } from '../src/mcp/index'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import { boundAgentVerdict } from '../src/auth/bound-agent-live'
import { hashMemberToken, memberTokenHashIsLive } from '../src/auth/member-bearer'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'mumega'
const OWNER = 'member-owner'
const AGENT_MEMBER = 'member-agent-a'
const BEARER = 'raw-agent-bearer-2345'

let h: SqliteD1Harness

/** `down.value` flips the agent-liveness statement to a throw; every other statement passes through. */
function envFor(down: { value: boolean } = { value: false }): Env {
  const db = {
    prepare: (sql: string) => { if (down.value && sql.includes('has_caps')) throw new Error('d1 down'); return h.db.prepare(sql) },
    batch: h.db.batch.bind(h.db),
  }
  return { DB: db, TENANT_SLUG: TENANT, BUS: { send: async () => {} } } as unknown as Env
}

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-eng', 'eng', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-eng', 'squad-a', 'Squad A');
    INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-a', 'squad-a', 'agent-a', 'Agent A', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${OWNER}', 'Owner', 'active', '${TENANT}');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('${AGENT_MEMBER}', 'Agent A', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-a', '${AGENT_MEMBER}', '2026-08-01T00:00:00.000Z');
    UPDATE agents SET owner_member_id = '${OWNER}' WHERE id = 'agent-a';
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-a', '${AGENT_MEMBER}', 'squad', 'squad-a', 'member');
  `)
  const tokenId = seedLiveToken(h.sqlite, { memberId: AGENT_MEMBER, tenant: TENANT, tokenId: 'tok-2345', channel: 'workspace', boundAgentId: 'agent-a' })
  h.sqlite.prepare(`UPDATE member_tokens SET token_hash = ? WHERE id = ?`).run(await hashMemberToken(BEARER), tokenId)
})
afterEach(() => h.close())

const bearer = { authorization: `Bearer ${BEARER}`, 'content-type': 'application/json' }
const suspendOwner = (): void => h.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = '${OWNER}'`)

function rooted(mount: (app: Hono<{ Bindings: Env }>) => void): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>()
  mount(app)
  app.onError(appErrorHandler)
  return app
}

describe('#2345 routines / addons / bearer-read: check-unavailable is a retryable 503, a refusal stays 401', () => {
  const surfaces: Array<[string, () => Hono<{ Bindings: Env }>, string]> = [
    ['routines', () => rooted((a) => a.route('/api', routinesApp)), '/api/projects/p1/routines'],
    ['addons', () => rooted((a) => a.route('/api/addons', addonsApp)), '/api/addons'],
    ['bearer-read', () => rooted((a) => { a.use('/api/*', requireAuth); a.get('/api/tasks', (c) => c.json({ ok: true })) }), '/api/tasks'],
  ]
  it.each(surfaces)('%s: D1 down -> 503 agent_check_unavailable + Retry-After', async (_n, build, path) => {
    const down = { value: true }
    const res = await build().request(path, { headers: bearer }, envFor(down))
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('2')
    expect(await res.json()).toEqual({ error: 'agent_check_unavailable' })
  })
  it.each(surfaces)('%s: a refused agent is still a 401', async (_n, build, path) => {
    suspendOwner()
    const res = await build().request(path, { headers: bearer }, envFor())
    expect(res.status).toBe(401)
  })
})

describe('#2345 MCP 503s carry Retry-After', () => {
  const agentAuth: AuthContext = {
    userId: AGENT_MEMBER, email: null, role: 'member', tenant: TENANT, memberId: AGENT_MEMBER, channel: 'workspace',
    capabilities: [{ member_id: AGENT_MEMBER, scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    boundAgentId: 'agent-a', tokenId: 'tok-2345',
  } as AuthContext
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${BEARER}`, [AUTH_CONTEXT_HEADER]: JSON.stringify(agentAuth) }
  it('legacy body, actions door and JSON-RPC tools/call', async () => {
    const env = envFor({ value: true })
    const legacy = await mcpApp.request('https://pot.test/', { method: 'POST', headers, body: JSON.stringify({ tool: 'inbox', args: {} }) }, env)
    const actions = await mcpActionsApp.request('https://pot.test/actions/inbox', { method: 'POST', headers, body: '{}' }, env)
    const rpc = await mcpApp.request('https://pot.test/', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inbox', arguments: {} } }) }, env)
    for (const res of [legacy, actions, rpc]) {
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('2')
    }
  })
})

describe('#2345 the capability-leg exemption is keyed on consent presence, not the channel label', () => {
  const env = (): Pick<Env, 'DB' | 'TENANT_SLUG'> => envFor()
  // A variable, not a literal: the verdict no longer reads a channel, and a stale caller that still sends one must not matter.
  const dir = (extra: { consentedByMemberId: string | null }) => ({ boundAgentId: 'agent-a', memberId: AGENT_MEMBER, channel: 'directory', ...extra })
  it('a directory session with NO consenter and zero capabilities is refused', async () => {
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'`)
    expect(await boundAgentVerdict(env(), dir({ consentedByMemberId: null }))).toBe('refused')
  })
  it('a directory session with no consenter and a live capability is admitted', async () => {
    expect(await boundAgentVerdict(env(), dir({ consentedByMemberId: null }))).toBe('live')
  })
  it('a consented session is not judged on the member capability leg', async () => {
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'`)
    expect(await boundAgentVerdict(env(), dir({ consentedByMemberId: OWNER }))).toBe('live')
  })
})

describe('#2345 the capability leg reads channel grants, minus home squads', () => {
  const verdict = (): Promise<string> => boundAgentVerdict(envFor(), { boundAgentId: 'agent-a', memberId: AGENT_MEMBER, consentedByMemberId: null })
  it('no capability row but a channel grant on a work squad -> live', async () => {
    h.sqlite.exec(`DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}'`)
    expect(await verdict()).toBe('refused')
    h.sqlite.exec(`PRAGMA foreign_keys = OFF; INSERT INTO channel_capability_grants (id, binding_id, member_id, squad_id, capability)
      VALUES ('ccg-1', 'b1', '${AGENT_MEMBER}', 'squad-a', 'member')`)
    expect(await verdict()).toBe('live')
  })
  it('a channel grant on a HOME squad does not count', async () => {
    h.sqlite.exec(`PRAGMA foreign_keys = OFF; DELETE FROM capabilities WHERE member_id = '${AGENT_MEMBER}';
      INSERT INTO departments (id, slug, name, kind) VALUES ('dept-home', 'home-x', 'Home', 'home');
      INSERT INTO squads (id, department_id, slug, name, kind) VALUES ('squad-home', 'dept-home', 'home-x', 'Home', 'home');
      INSERT INTO channel_capability_grants (id, binding_id, member_id, squad_id, capability)
        VALUES ('ccg-2', 'b2', '${AGENT_MEMBER}', 'squad-home', 'member')`)
    expect(await verdict()).toBe('refused')
  })
})

describe('#2345 long-lived sessions fail closed when the liveness read fails', () => {
  it('presence socket re-check: D1 error on the agent verdict -> not live', async () => {
    const hash = await hashMemberToken(BEARER)
    expect(await memberTokenHashIsLive(envFor(), hash, AGENT_MEMBER)).toBe(true)
    expect(await memberTokenHashIsLive(envFor({ value: true }), hash, AGENT_MEMBER)).toBe(false)
  })

  /** Opens the stream live, optionally takes the liveness read down, then makes a message arrive; returns what the client saw. */
  async function streamWithMessage(takeDown: boolean): Promise<string> {
    const down = { value: false }
    const app = rooted((a) => a.route('/api/inbox', inboxApp))
    const res = await app.request('/api/inbox/stream?poll_ms=20', { headers: bearer }, envFor(down))
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    await new Promise((r) => setTimeout(r, 100)) // let the initial flush (empty) finish: the message must arrive on a poll tick
    let seen = ''
    down.value = takeDown
    h.sqlite.exec(`INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, kind, body, request_id, in_reply_to,
        created_at, project_id, target_seat, body_length, checksum_sha256, read_at)
      VALUES ('msg-1', '${TENANT}', 'agent-a', 'x', 'm-x', 'message', 'CANARY-BODY-2345', NULL, NULL, '2026-11-05T00:00:00Z', NULL, NULL, 10, '${'0'.repeat(64)}', NULL)`)
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && !seen.includes('CANARY-BODY-2345')) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), Math.max(1, deadline - Date.now())))])
      if (r.done) break
      seen += dec.decode(r.value)
    }
    await reader.cancel().catch(() => undefined)
    return seen
  }

  it('inbox SSE stream control: a live agent receives the body', async () => {
    expect(await streamWithMessage(false)).toContain('CANARY-BODY-2345')
  }, 20_000)

  it('inbox SSE stream: the check going unavailable before a delivery tick ends the stream and leaks no body', async () => {
    expect(await streamWithMessage(true)).not.toContain('CANARY-BODY-2345')
  }, 20_000)
})

describe('#2345 root error handler', () => {
  it('a csrf 403 stays a 403 and keeps the headers set on the context', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => { c.header('X-Context-Header', 'kept'); c.header('Cache-Control', 'no-store'); await next() })
    app.use('*', csrf())
    app.post('/x', (c) => c.text('ok'))
    app.onError(appErrorHandler)
    const res = await app.request('http://pot.test/x', { method: 'POST', headers: { origin: 'https://evil.test', 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=b' })
    expect(res.status).toBe(403)
    expect(res.headers.get('x-context-header')).toBe('kept')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('an HTTPException keeps its own response and context headers', async () => {
    const app = new Hono()
    app.use('*', async (c, next) => { c.header('X-Context-Header', 'kept'); await next() })
    app.get('/x', () => { throw new HTTPException(418, { res: new Response('teapot', { status: 418, headers: { 'X-Own': '1' } }) }) })
    app.onError(appErrorHandler)
    const res = await app.request('http://pot.test/x')
    expect(res.status).toBe(418)
    expect(await res.text()).toBe('teapot')
    expect(res.headers.get('x-own')).toBe('1')
    expect(res.headers.get('x-context-header')).toBe('kept')
  })

  it('an unhandled error is a bare 500: the body never carries err.message, the log gets the stack', async () => {
    const logged: unknown[][] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { logged.push(a) }
    try {
      const app = new Hono()
      app.get('/x', () => { throw new Error('SECRET-DETAIL-2345') })
      app.onError(appErrorHandler)
      const res = await app.request('http://pot.test/x')
      expect(res.status).toBe(500)
      expect(await res.text()).toBe('Internal Server Error')
    } finally { console.error = orig }
    expect(JSON.stringify(logged)).toContain('at ')
  })
})
