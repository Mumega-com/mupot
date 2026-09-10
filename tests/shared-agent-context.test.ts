import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { invokeTool, mcpActionsApp, mcpApp } from '../src/mcp'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { AUTH_CONTEXT_HEADER } from '../src/mcp/auth-header'
import type { AuthContext, Env } from '../src/types'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'

const SHARED = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
const FOREIGN = '44444444-4444-4444-8444-444444444444'
const UNKNOWN = '55555555-5555-4555-8555-555555555555'
const TENANT = 'test-pot'
const BEARER = 'local-fixture-only-token'
let h: SqliteD1Harness
let env: Env
let auth: AuthContext

function readBindings(channel = 'directory') {
  return [A, B].map((id, i) => ({
    tenant: TENANT, caller_member_id: 'm-shared', caller_agent_id: SHARED,
    token_id: 'token', channel, consenting_human_id: channel === 'directory' ? 'human' : null,
    selected_agent_id: id, route_id: `route-${i === 0 ? 'a' : 'b'}`, target_seat: null,
    expires_at: '2099-01-01T00:00:00.000Z',
  }))
}

function configure(bindings: unknown = readBindings()) {
  Object.assign(env, { AGENT_CONTEXT_READ_BINDINGS: JSON.stringify(bindings) })
}

function member(id: string, tenant = TENANT) {
  h.sqlite.prepare('INSERT INTO members (id, tenant, display_name, status) VALUES (?, ?, ?, ?)')
    .run(id, tenant, id, 'active')
}

function seedAgent(id: string, slug: string, tenant = TENANT) {
  member(`m-${slug}`, tenant)
  h.sqlite.prepare('INSERT INTO squads (id, department_id, slug, name) VALUES (?, ?, ?, ?)')
    .run(`s-${slug}`, 'dept', slug, `Squad ${slug}`)
  h.sqlite.prepare('INSERT INTO agents (id, squad_id, slug, name, role, status, okr) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, `s-${slug}`, slug, `Agent ${slug}`, 'member', 'active', `Objective ${slug}`)
  h.sqlite.prepare("INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?, ?, ?, datetime('now'))")
    .run(tenant, id, `m-${slug}`)
  h.sqlite.prepare('INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)')
    .run(`cap-${slug}`, `m-${slug}`, 'squad', `s-${slug}`, 'member')
}

function mail(id: string, agent: string, body = id, tenant = TENANT, seat: string | null = null) {
  h.sqlite.prepare('INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, body, target_seat, body_length, checksum_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, tenant, agent, SHARED, 'm-shared', body, seat, body.length, createHash('sha256').update(body).digest('hex'))
}

async function seat(channel = 'directory') {
  h.sqlite.prepare('UPDATE member_tokens SET channel = ? WHERE id = ?').run(channel, 'token')
  const value = await buildAuthContextFromProps(env, {
    memberId: 'm-shared', tokenId: 'token', email: null, consentedByMemberId: 'human',
  } as never)
  if (!value) throw new Error('fixture authentication failed')
  Object.freeze(value.capabilities)
  Object.freeze(value.latentCapabilities)
  return Object.freeze(value)
}

async function context(agent_id: string, extra: Record<string, unknown> = {}, caller = auth) {
  return invokeTool(caller, env, 'agent_context', { agent_id, route_id: agent_id === B ? 'route-b' : 'route-a', ...extra })
}

function result(out: Awaited<ReturnType<typeof context>>): any {
  expect(out.ok, JSON.stringify(out)).toBe(true)
  return out.ok ? out.result : undefined
}

function snapshot() {
  return h.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, h.sqlite.prepare(`SELECT * FROM "${name}"`).all()])
}

beforeEach(async () => {
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  env = { DB: h.db, TENANT_SLUG: TENANT } as unknown as Env
  configure()
  h.sqlite.exec("INSERT INTO departments (id, slug, name) VALUES ('dept', 'dept', 'Department')")
  seedAgent(SHARED, 'shared')
  seedAgent(A, 'a')
  seedAgent(B, 'b')
  seedAgent(FOREIGN, 'foreign', 'another-pot')
  member('human')
  h.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('human-admin', 'human', 'org', NULL, 'admin')")
  h.sqlite.prepare('INSERT INTO member_tokens (id, tenant, member_id, token_hash, channel, agent_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run('token', TENANT, 'm-shared', createHash('sha256').update(BEARER).digest('hex'), 'directory', SHARED)
  mail('shared-mail', SHARED)
  mail('a-mail', A)
  mail('b-mail', B)
  mail('foreign-mail', FOREIGN, 'FOREIGN SECRET', 'another-pot')
  mail('wrong-tenant-mail', A, 'WRONG TENANT SECRET', 'another-pot')
  mail('b-seat-mail', B, 'OTHER SEAT SECRET', TENANT, 'private-seat')
  h.sqlite.prepare('INSERT INTO tasks (id, squad_id, title, assignee_agent_id) VALUES (?, ?, ?, ?)')
    .run('task-a', 's-a', 'Work for A', A)
  auth = await seat()
})

afterEach(() => h.close())

describe('shared MCP explicit agent context', () => {
  it('reproduces connect A/B followed by unchanged shared inbox', async () => {
    for (const agent of [A, B]) {
      const connected = result(await invokeTool(auth, env, 'connect', { agent_name: agent }))
      expect(connected.binding).toBe('session_local')
      expect(connected.claimed_agent.id).toBe(agent)
      const inbox = result(await invokeTool(auth, env, 'inbox', { peek: true }))
      expect(inbox.messages.map((m: any) => m.id)).toEqual(['shared-mail'])
    }
    expect(auth.boundAgentId).toBe(SHARED)
  })

  it('isolates interleaved and concurrent targets with the same frozen caller and no database writes', async () => {
    const before = snapshot()
    const callerBefore = JSON.stringify(auth)
    const targets = [A, B, A, B]
    const outputs = []
    for (const id of targets) outputs.push(await context(id))
    outputs.push(...await Promise.all(targets.map(id => context(id))))
    outputs.forEach((out, i) => {
      const data = result(out)
      const isA = targets[i % 4] === A
      expect(data.caller_agent_id).toBe(SHARED)
      expect(data.selected_agent_id).toBe(isA ? A : B)
      expect(data.mode).toBe('read_only_target')
      expect(data.context.agent.okr).toBe(isA ? 'Objective a' : 'Objective b')
      expect(data.inbox.messages.map((m: any) => m.id)).toEqual([isA ? 'a-mail' : 'b-mail'])
      expect(data.inbox).toMatchObject({ consumed: false, complete: true, remaining: 0 })
      expect(JSON.stringify(data)).not.toMatch(/SECRET|shared-mail/)
      expect(data.context.capability).toBeUndefined()
    })
    expect(JSON.stringify(auth)).toBe(callerBefore)
    expect(snapshot()).toEqual(before)
  })

  it('allows canonical self without peer authority; workspace peer reads require admin AND approved binding', async () => {
    auth = await seat('workspace')
    expect(result(await context(SHARED)).inbox.messages[0].id).toBe('shared-mail')
    expect((await context(A)).ok).toBe(false)
    h.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('agent-admin', 'm-shared', 'org', NULL, 'admin')")
    expect((await context(A)).ok).toBe(false)
    configure(readBindings('workspace'))
    expect(result(await context(A)).selected_agent_id).toBe(A)
  })

  it.each([undefined, '', 'not-json', '{}', '[]'])('admin alone never grants peer inbox access with config %s', async config => {
    Object.assign(env, { AGENT_CONTEXT_READ_BINDINGS: config })
    expect(await context(A)).toMatchObject({ ok: false, error: 'forbidden' })
    expect(result(await context(SHARED)).inbox.messages[0].id).toBe('shared-mail')
  })

  it.each([
    { tenant: 'another-pot' }, { caller_member_id: 'human' }, { caller_agent_id: B },
    { token_id: 'other-token' }, { consenting_human_id: 'm-a' }, { channel: 'workspace' },
    { selected_agent_id: B }, { route_id: 'route-b' },
    { target_seat: 'private-seat' },
    { expires_at: '2001-01-01T00:00:00.000Z' }, { expires_at: '2099-02-29T00:00:00.000Z' },
    { expires_at: '2099-01-01' }, { expires_at: '2099-01-01T00:00:00+00:00' }, { expires_at: null },
  ])('refuses wrong or expired server binding %j', async change => {
    configure([{ ...readBindings()[0], ...change }])
    expect(await context(A)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('refuses a mixed route/target and fails closed if any configured row is malformed', async () => {
    expect(await context(A, { route_id: 'route-b' })).toMatchObject({ ok: false, error: 'forbidden' })
    configure([...readBindings(), { arbitrary: 'invalid' }])
    expect(await context(A)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it.each(["UPDATE member_tokens SET revoked_at = datetime('now') WHERE id = 'token'", "UPDATE member_tokens SET expires_at = '2001-01-01' WHERE id = 'token'"])
    ('revalidates token liveness after the auth snapshot: %s', async sql => {
      h.sqlite.exec(sql)
      expect(await context(A)).toMatchObject({ ok: false, error: 'forbidden' })
    })

  it.each(['observer', 'member', 'lead'])('refuses %s peer reads even with stale admin grants in AuthContext', async capability => {
    h.sqlite.prepare('UPDATE capabilities SET scope_type = ?, scope_id = ?, capability = ? WHERE id = ?')
      .run('squad', 's-shared', 'admin', 'human-admin')
    h.sqlite.prepare('INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)')
      .run('peer-grant', 'human', 'squad', 's-a', capability)
    const out = await context(A)
    expect(out).toMatchObject({ ok: false, error: 'forbidden' })
    expect(JSON.stringify(out)).not.toContain('Objective a')
  })

  it('admits existing target squad admin but not another squad, and notices revocation', async () => {
    h.sqlite.exec("UPDATE capabilities SET scope_type = 'squad', scope_id = 's-shared' WHERE id = 'human-admin'; INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('peer-grant', 'human', 'squad', 's-a', 'admin')")
    expect(result(await context(A)).selected_agent_id).toBe(A)
    expect((await context(B)).ok).toBe(false)
    h.sqlite.exec("DELETE FROM capabilities WHERE id = 'peer-grant'")
    expect((await context(A)).ok).toBe(false)
  })

  it.each(['m-shared', 'human', 'm-a'])('refuses suspended relevant member %s', async id => {
    h.sqlite.prepare('UPDATE members SET status = ? WHERE id = ?').run('suspended', id)
    expect(await context(A)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it.each([SHARED, A])('refuses paused caller or target agent %s', async id => {
    h.sqlite.prepare('UPDATE agents SET status = ? WHERE id = ?').run('paused', id)
    expect(await context(A)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('preserves consent session death when its human loses admin on the caller squad', async () => {
    h.sqlite.exec("UPDATE capabilities SET scope_type = 'squad', scope_id = 's-a' WHERE id = 'human-admin'")
    expect(await context(A)).toMatchObject({ ok: false, error: 'forbidden' })
    const dead = await seat()
    expect(dead.boundAgentId).toBeNull()
    expect(await context(A, {}, dead)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it.each([UNKNOWN, FOREIGN])('refuses unavailable UUID without disclosing context %s', async id => {
    expect(await context(id)).toMatchObject({ ok: false, error: 'forbidden' })
  })

  it('rejects tenant mismatch and a bound ID with the wrong canonical member', async () => {
    expect((await context(A, {}, { ...auth, tenant: 'another-pot' })).ok).toBe(false)
    expect((await context(A, {}, { ...auth, boundAgentId: B })).ok).toBe(false)
  })

  it.each([{ agent_id: 'a' }, { agent_id: '' }, { inbox_limit: 4 }, { inbox_limit: 0 }, { inbox_limit: 1.5 }, { max_bytes: 8193 }, { max_bytes: 0 }, { auth: { role: 'owner' } }])('rejects malformed limits or injected authority %j', async extra => {
    expect(await context(A, extra)).toMatchObject({ ok: false, error: 'invalid_args' })
  })

  it('caps items, accounts for omitted oversized UTF-8 bodies, and preserves integrity evidence', async () => {
    for (let i = 2; i <= 5; i++) mail(`a-mail-${i}`, A)
    h.sqlite.exec("UPDATE agent_messages SET body = 'broken' WHERE id = 'a-mail'")
    const full = result(await context(A))
    expect(full.inbox.messages).toHaveLength(3)
    expect(full.inbox).toMatchObject({ remaining: 2, complete: false })
    expect(full.inbox.messages[0].is_intact).toBe(false)
    h.sqlite.prepare('UPDATE agent_messages SET body = ? WHERE id = ?').run('🧪'.repeat(5000), 'a-mail')
    const bounded = result(await context(A, { max_bytes: 1400 }))
    const bytes = new TextEncoder().encode(JSON.stringify(bounded)).length
    expect(bytes).toBeLessThanOrEqual(1400)
    expect(bounded.receipt.bytes).toBe(bytes)
    expect(bounded.inbox.complete).toBe(false)
    expect(bounded.inbox.remaining).toBe(5 - bounded.inbox.messages.length)
    expect(bounded.receipt.messages_omitted).toBeGreaterThan(0)
    expect(bounded.inbox.messages.some((m: any) => m.id === 'a-mail')).toBe(false)
    expect(h.sqlite.prepare('SELECT read_at FROM agent_messages WHERE id = ?').get('a-mail')?.read_at).toBeNull()
  })

  it('accounts for an oversized context and refuses a budget too small for the receipt', async () => {
    h.sqlite.prepare('UPDATE agents SET okr = ? WHERE id = ?').run('Large objective '.repeat(5000), A)
    const data = result(await context(A))
    expect(new TextEncoder().encode(JSON.stringify(data)).length).toBeLessThanOrEqual(8192)
    expect(data.context).toBeNull()
    expect(data.receipt.context_omitted).toBe(true)
    expect((await context(A, { max_bytes: 1 })).ok).toBe(false)
  })

  it('preserves signed-only inbox fences', async () => {
    h.sqlite.prepare("INSERT INTO agent_inbox_fences (tenant, agent_id, mode, key_fingerprint, updated_by_member_id, updated_at, reason) VALUES (?, ?, ?, ?, 'human', datetime('now'), 'fixture')")
      .run(TENANT, A, 'signed_only', 'a'.repeat(64))
    expect(await context(A)).toMatchObject({ ok: false, error: 'consumer_fenced' })
  })

  it('keeps self token seat access and peer unseated access separate', async () => {
    h.sqlite.exec("UPDATE member_tokens SET label = 'own-seat' WHERE id = 'token'")
    mail('own-seat-message', SHARED, 'MY SEAT', TENANT, 'own-seat')
    mail('other-self-seat', SHARED, 'OTHER SELF SEAT', TENANT, 'other-seat')
    mail('peer-same-label', A, 'PEER PRIVATE', TENANT, 'own-seat')
    const self = result(await context(SHARED))
    expect(self.inbox.messages.map((m: any) => m.id)).toEqual(['shared-mail', 'own-seat-message'])
    expect(result(await context(A)).inbox.messages.map((m: any) => m.id)).toEqual(['a-mail'])
  })

  it('reports task pagination and retains missing integrity baselines as unknown', async () => {
    for (let i = 2; i <= 5; i++) h.sqlite.prepare('INSERT INTO tasks (id, squad_id, title, assignee_agent_id) VALUES (?, ?, ?, ?)')
      .run(`task-a-${i}`, 's-a', `Work ${i}`, A)
    h.sqlite.prepare('INSERT INTO agent_messages (id, tenant, to_agent, from_agent, from_member, body) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-a-mail', TENANT, A, SHARED, 'm-shared', 'legacy body')
    const data = result(await context(A))
    expect(data.context.tasks).toHaveLength(3)
    expect(data.context).toMatchObject({ tasks_remaining: 2, tasks_complete: false })
    expect(data.inbox.messages[0].is_intact).toBe(true)
    expect(data.inbox.messages[1].is_intact).toBeNull()
  })

  it('dispatches MCP using the trusted builder/envelope and Actions using a real fixture bearer', async () => {
    const incoming = new Request('https://pot.test/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', [AUTH_CONTEXT_HEADER]: JSON.stringify({ ...auth, boundAgentId: B }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'agent_context', arguments: { agent_id: A, route_id: 'route-a' } } }),
    })
    const response = await mcpApp.fetch(mcpInternalRequest(incoming, await seat()), env)
    const rpc = await response.json() as any
    expect(response.status, JSON.stringify(rpc)).toBe(200)
    const data = JSON.parse(rpc.result.content[0].text).result
    expect(data.caller_agent_id).toBe(SHARED)
    expect(data.inbox.messages[0].id).toBe('a-mail')

    await seat('workspace')
    configure(readBindings('workspace'))
    h.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('agent-admin', 'm-shared', 'org', NULL, 'admin')")
    const action = await mcpActionsApp.request('https://pot.test/actions/agent_context', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${BEARER}` },
      body: JSON.stringify({ agent_id: B, route_id: 'route-b' }),
    }, env)
    expect(action.status).toBe(200)
    expect((await action.json() as any).result.inbox.messages[0].id).toBe('b-mail')
  })

  it('Actions rejects missing/invalid authentication and ignores an external forged auth header', async () => {
    for (const authorization of ['', 'Bearer invalid']) {
      const response = await mcpActionsApp.request('https://pot.test/actions/agent_context', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization, [AUTH_CONTEXT_HEADER]: JSON.stringify(auth) },
        body: JSON.stringify({ agent_id: A }),
      }, env)
      expect(response.status).toBe(401)
      expect(JSON.stringify(await response.json())).not.toContain('a-mail')
    }
  })
})
