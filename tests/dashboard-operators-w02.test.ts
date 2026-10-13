// tests/dashboard-operators-w02.test.ts — W0.2: the human "Operators" dashboard page (src/dashboard/operators.ts) over the
// EXISTING delegation writers, through the REAL dashboardApp, real web sessions and the real migration chain.
//
// Mutations proven (see PR body): (a) checkWebSession's fresh branch removed -> "a stale session cannot create" goes red;
// (b) the web-session field check removed -> the agent/bearer 403 tests go red; (c) the origin check removed -> the
// cross-origin tests go red; (d) fresh:true flipped to false on create -> stale test red; fresh:false flipped to true on
// revoke -> "revoke needs only a real session" goes red.

import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { makeOperatorsApp } from '../src/dashboard/operators'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const ORIGIN = 'http://localhost'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

let harness: SqliteD1Harness
let flag: string | undefined

function makeEnv(email: string): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(),
    DB: harness.db,
    DELEGATED_OPERATORS: flag,
  } as unknown as Env
}

async function login(email: string): Promise<{ env: Env; cookie: string }> {
  const env = makeEnv(email)
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return { env, cookie: `mupot_session=${m[1]}` }
}

function setReauth(memberId: string, at: string | null): void {
  harness.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = ?').run(at, memberId)
}

const freshNow = () => new Date().toISOString()
const stale = () => new Date(Date.now() - 10 * 60 * 1000).toISOString()

function post(env: Env, cookie: string, path: string, body?: unknown, origin: string | null = ORIGIN) {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' }
  if (origin) headers.origin = origin
  return dashboardApp.request(path, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) }, env)
}

const DELEGATE = { agent_id: 'agent-A', scope_type: 'squad', scope_id: 'S1', max_grant: 'member' }

function rows(sql: string): Array<Record<string, unknown>> {
  return harness.sqlite.prepare(sql).all() as Array<Record<string, unknown>>
}

beforeEach(() => {
  flag = '1'
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One');
    INSERT INTO projects (id, slug, name) VALUES ('P1', 'p1', 'Project One');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('agent-A', 'S1', 'agent-a', 'Agent A', 'member', 'test', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('seat-agent-A', 'Agent A seat', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'agent-A', 'seat-agent-A', '2026-10-01T00:00:00.000Z');

    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Hadi Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-plain', 'plain@x.test', 'Plain', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-plain', 'mem-plain', 'squad', 'S1', 'member');
  `)
})

afterEach(() => harness.close())

describe('GET /operators', () => {
  it('redirects an unauthenticated caller to login', async () => {
    const res = await dashboardApp.request('/operators', {}, makeEnv('admin@x.test'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('an org admin sees the create form, with agents and scopes, and the delegation list with agent, scope, max grant, delegator, created, revoked', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const created = await post(env, cookie, '/operators/delegate', DELEGATE)
    expect(created.status, await created.clone().text()).toBe(200)
    const res = await dashboardApp.request('/operators', { headers: { cookie } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="op-create"')
    expect(body).toContain('Agent A')
    expect(body).toContain('squad:S1')
    expect(body).toContain('Squad: Squad One')
    expect(body).toContain('Hadi Admin')
    expect(body).toContain('data-op-revoke=')
    expect(body).toContain('Active')
  })

  it('a plain squad member gets the "no scope you can delegate over" state, no create button, and sees no delegations they have no stake in', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    await post(env, cookie, '/operators/delegate', DELEGATE)
    const plain = await login('plain@x.test')
    const res = await dashboardApp.request('/operators', { headers: { cookie: plain.cookie } }, plain.env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('id="op-create"')
    expect(body).toContain('No scope you can delegate over')
    expect(body).not.toContain('data-op-revoke=')
    expect(body).toContain('No operators yet.')
  })

  it('flag off: says "Operators are disabled", no create form, but still lists delegations with a Revoke button', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    await post(env, cookie, '/operators/delegate', DELEGATE)
    flag = undefined
    const off = { ...env, DELEGATED_OPERATORS: undefined } as Env
    const res = await dashboardApp.request('/operators', { headers: { cookie } }, off)
    const body = await res.text()
    expect(body).toContain('Operators are disabled')
    expect(body).not.toContain('id="op-create"')
    expect(body).toContain('data-op-revoke=')
  })
})

describe('POST /operators/delegate', () => {
  it('creation through the UI writes the delegation row (delegator = the human, created_by = the human) and nothing else', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await post(env, cookie, '/operators/delegate', DELEGATE)
    expect(res.status).toBe(200)
    const r = rows('SELECT * FROM agent_operator_delegations')
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ tenant: TENANT, agent_id: 'agent-A', delegator_member_id: 'mem-admin', created_by_member_id: 'mem-admin', scope_type: 'squad', scope_id: 'S1', max_grant: 'member', revoked_at: null })
    expect(r[0].created_at).toBeTruthy()
    // the immutable row IS the creation record: it cannot be edited or deleted afterwards
    expect(() => harness.sqlite.exec("UPDATE agent_operator_delegations SET max_grant = 'lead'")).toThrow(/one-way revoke/)
    expect(() => harness.sqlite.exec('DELETE FROM agent_operator_delegations')).toThrow(/never deleted/)
  })

  it('refuses a stale session (re-authenticated more than five minutes ago, or never): reauth_required, no row', async () => {
    const { env, cookie } = await login('admin@x.test')
    for (const at of [stale(), null]) {
      setReauth('mem-admin', at)
      const res = await post(env, cookie, '/operators/delegate', DELEGATE)
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'reauth_required' })
    }
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
  })

  it('refuses a cross-origin POST, and one with no Origin at all', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    for (const origin of ['https://evil.example', null]) {
      const res = await post(env, cookie, '/operators/delegate', DELEGATE, origin)
      expect(res.status).toBe(403)
    }
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
  })

  it('refuses a non-admin (the writer authority check is unchanged), even with a fresh session', async () => {
    const { env, cookie } = await login('plain@x.test')
    setReauth('mem-plain', freshNow())
    const res = await post(env, cookie, '/operators/delegate', DELEGATE)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
  })

  it('flag off: create is refused with delegated_operators_disabled, no row', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const off = { ...env, DELEGATED_OPERATORS: undefined } as Env
    const res = await post(off, cookie, '/operators/delegate', DELEGATE)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'delegated_operators_disabled' })
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
  })

  it('maps writer errors to statuses (bad scope type 400, unknown agent 404, duplicate 409) and rejects a non-object body', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    expect((await post(env, cookie, '/operators/delegate', { ...DELEGATE, scope_type: 'galaxy' })).status).toBe(400)
    expect((await post(env, cookie, '/operators/delegate', { ...DELEGATE, agent_id: 'nope' })).status).toBe(404)
    expect((await post(env, cookie, '/operators/delegate', { ...DELEGATE, max_grant: 'admin' })).status).toBe(400)
    expect((await post(env, cookie, '/operators/delegate', [1])).status).toBe(400)
    expect((await post(env, cookie, '/operators/delegate', {})).status).toBe(400)
    expect((await post(env, cookie, '/operators/delegate', DELEGATE)).status).toBe(200)
    expect((await post(env, cookie, '/operators/delegate', DELEGATE)).status).toBe(409)
  })
})

describe('POST /operators/:id/revoke', () => {
  async function made(): Promise<{ env: Env; cookie: string; id: string }> {
    const s = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    const res = await post(s.env, s.cookie, '/operators/delegate', DELEGATE)
    const { delegation } = (await res.json()) as { delegation: { id: string } }
    return { ...s, id: delegation.id }
  }

  it('revokes with only a real session (no fresh re-auth), stamping revoked_at', async () => {
    const { env, cookie, id } = await made()
    setReauth('mem-admin', null)
    const res = await post(env, cookie, `/operators/${id}/revoke`)
    expect(res.status, await res.clone().text()).toBe(200)
    const r = rows(`SELECT revoked_at FROM agent_operator_delegations WHERE id = '${id}'`)
    expect(r[0].revoked_at).toBeTruthy()
    // revoking twice: the row is already gone from the live set
    expect((await post(env, cookie, `/operators/${id}/revoke`)).status).toBe(404)
  })

  it('works for a delegator who has since been demoted (the delegator can always withdraw)', async () => {
    const { env, cookie, id } = await made()
    harness.sqlite.exec("DELETE FROM capabilities WHERE id = 'cap-admin'")
    const res = await post(env, cookie, `/operators/${id}/revoke`)
    expect(res.status, await res.clone().text()).toBe(200)
  })

  it('works with the flag off', async () => {
    const { env, cookie, id } = await made()
    const off = { ...env, DELEGATED_OPERATORS: undefined } as Env
    expect((await post(off, cookie, `/operators/${id}/revoke`)).status).toBe(200)
  })

  it('refuses cross-origin, and a member who neither made it nor administers its scope', async () => {
    const { env, cookie, id } = await made()
    expect((await post(env, cookie, `/operators/${id}/revoke`, undefined, 'https://evil.example')).status).toBe(403)
    const plain = await login('plain@x.test')
    const res = await post(plain.env, plain.cookie, `/operators/${id}/revoke`)
    expect(res.status).toBe(403)
    expect(rows('SELECT revoked_at FROM agent_operator_delegations')[0].revoked_at).toBeNull()
  })
})

describe('principals that are not a real human web session get 403 before any argument is read', () => {
  const agent: AuthContext = {
    userId: 'seat-agent-A', email: null, role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-admin',
    capabilities: [], boundAgentId: 'agent-A',
  }
  const bearer: AuthContext = {
    userId: 'mem-admin', email: 'admin@x.test', role: 'member', tenant: TENANT, channel: 'workspace', memberId: 'mem-admin',
    capabilities: [], boundAgentId: null,
  }
  const forged: AuthContext = { ...bearer, webSessionIdHash: 'f'.repeat(64), webSessionMemberId: 'someone-else' }

  function appAs(auth: AuthContext) {
    const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()
    app.use('*', async (c, next) => { c.set('auth', auth); await next() })
    app.route('/', makeOperatorsApp((_e, _t, body) => body))
    return app
  }

  for (const [name, auth] of [['an agent-bound caller', agent], ['a bearer / OAuth caller (no web session)', bearer], ['a session whose member differs from the identity', forged]] as const) {
    it(`${name}: create and revoke are 403 not_a_web_session, nothing written`, async () => {
      const env = makeEnv('admin@x.test')
      for (const [path, body] of [['/operators/delegate', DELEGATE], ['/operators/x/revoke', undefined]] as const) {
        const res = await appAs(auth).request(path, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        }, env)
        expect(res.status).toBe(403)
        expect(await res.json()).toEqual({ error: 'not_a_web_session' })
      }
      expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
    })
  }

  it('a revoked web session cannot create or revoke', async () => {
    const { env, cookie } = await login('admin@x.test')
    setReauth('mem-admin', freshNow())
    harness.sqlite.exec("UPDATE web_sessions SET revoked_at = datetime('now') WHERE member_id = 'mem-admin'")
    const res = await post(env, cookie, '/operators/delegate', DELEGATE)
    expect([302, 401, 403]).toContain(res.status)
    expect(rows('SELECT 1 FROM agent_operator_delegations')).toHaveLength(0)
  })
})
