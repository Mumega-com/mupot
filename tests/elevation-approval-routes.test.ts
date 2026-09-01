// tests/elevation-approval-routes.test.ts — Delivery Sequence step 3 (mupot
// task f5fe1222, mumega-com#1173): the HUMAN half of the approval flow,
// exercised through the REAL dashboard route handlers (src/auth authApp),
// exactly like tests/auth-web-session-integration.test.ts does for
// GET/POST /auth/sessions*. An approval MUST be created by an operator-
// principal BROWSER session (a real web_sessions row from GET /auth/
// dev-login), never a bare MCP bearer call — that is the whole point of
// routing decide_elevation through authApp instead of a tool.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createAgentSession } from '../src/auth/agent-sessions'
import { createElevationRequest, loadElevationGrantById } from '../src/auth/elevation'

const TENANT = 'local'
const DEPT = 'dept-1'
const SQUAD = 'squad-1'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const ADMIN_MEMBER = 'member-admin'
const OUTSIDER_MEMBER = 'member-outsider'
const TOKEN_ID = 'token-a-1'

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

function makeEnv(email: string): Env {
  return {
    TENANT_SLUG: TENANT,
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(),
  } as unknown as Env
}

describe('elevation approval — integration through authApp (real D1)', () => {
  let harness: SqliteD1Harness

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => harness.close())

  async function seedFixture(env: Env) {
    env.DB = harness.db
    await env.DB.prepare(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`).bind(DEPT).run()
    await env.DB.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad', 'Squad')`)
      .bind(SQUAD, DEPT)
      .run()
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, 'agent-a', 'Agent A', 'member', 'test', 'active')`,
    )
      .bind(AGENT_ID, SQUAD)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, 'Agent A Member', 'active', datetime('now'))`,
    )
      .bind(AGENT_MEMBER, TENANT)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, 'admin@x.test', 'Admin', 'active', datetime('now'))`,
    )
      .bind(ADMIN_MEMBER, TENANT)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, 'outsider@x.test', 'Outsider', 'active', datetime('now'))`,
    )
      .bind(OUTSIDER_MEMBER, TENANT)
      .run()
    await env.DB.prepare(
      `INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`,
    )
      .bind(TENANT, AGENT_ID, AGENT_MEMBER)
      .run()
    await env.DB.prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, agent_id, created_at)
       VALUES (?1, ?2, 'hash-1', 'primary', 'workspace', ?3, ?4, datetime('now'))`,
    )
      .bind(TOKEN_ID, AGENT_MEMBER, TENANT, AGENT_ID)
      .run()
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?1, ?2, 'squad', ?3, 'admin')`,
    )
      .bind('cap-admin-1', ADMIN_MEMBER, SQUAD)
      .run()

    const session = await createAgentSession(env, {
      tenant: TENANT, agentId: AGENT_ID, memberId: AGENT_MEMBER, authKind: 'workspace_token', credentialId: TOKEN_ID,
    })
    return { session }
  }

  async function seedPendingRequest(env: Env, agentSessionId: string, actions: string[] = ['action:manage_access']) {
    const result = await createElevationRequest(env, {
      tenant: TENANT, agentSessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
      actions, scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60, reason: 'need it for the task',
    })
    if (!result.ok) throw new Error('setup: could not create elevation request')
    return result.request
  }

  function cookieFrom(res: Response): string {
    const setCookie = res.headers.get('set-cookie') ?? ''
    const match = /mupot_session=([^;]+)/.exec(setCookie)
    if (!match) throw new Error('no session cookie in response')
    return match[1]
  }

  async function devLogin(env: Env): Promise<string> {
    const res = await authApp.request('/dev-login', {}, env)
    expect(res.status).toBe(302)
    return cookieFrom(res)
  }

  it('an operator with admin-on-squad sees the pending request in GET /auth/elevation/requests', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    await seedPendingRequest(env, session.id)
    const cookie = await devLogin(env)

    const res = await authApp.request('/elevation/requests', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { requests: Array<{ scope_id: string; actions: Array<{ key: string; effect: string }> }> }
    expect(body.requests).toHaveLength(1)
    expect(body.requests[0].scope_id).toBe(SQUAD)
    expect(body.requests[0].actions[0]).toMatchObject({ key: 'action:manage_access', effect: 'reversible' })
  })

  it('an operator WITHOUT admin authority on the scope sees NOTHING — visibility follows authorization, never shown-then-403', async () => {
    const env = makeEnv('outsider@x.test')
    const { session } = await seedFixture(env)
    await seedPendingRequest(env, session.id)
    const cookie = await devLogin(env)

    const res = await authApp.request('/elevation/requests', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const body = (await res.json()) as { requests: unknown[] }
    expect(body.requests).toHaveLength(0)
  })

  it('POST /elevation/requests/:id/decide approve creates the grant and it is queryable via GET /elevation/active', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, ['action:dispatch'])
    const cookie = await devLogin(env)

    const decideRes = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:dispatch'] }),
      },
      env,
    )
    expect(decideRes.status).toBe(200)
    const decideBody = (await decideRes.json()) as { ok: boolean; grants: Array<{ id: string; action: string }> }
    expect(decideBody.ok).toBe(true)
    expect(decideBody.grants).toHaveLength(1)

    const activeRes = await authApp.request('/elevation/active', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const activeBody = (await activeRes.json()) as { grants: Array<{ id: string }> }
    expect(activeBody.grants).toHaveLength(1)
    expect(activeBody.grants[0].id).toBe(decideBody.grants[0].id)
  })

  it('cannot approve a superset of the requested actions through the HTTP route either', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, ['action:manage_access'])
    const cookie = await devLogin(env)

    const res = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:manage_access', 'action:register_key'] }),
      },
      env,
    )
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  it('a sensitive action requires a fresh reauth on the deciding web session — a plain dev-login (no reauth) is refused', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, ['action:register_key'])
    const cookie = await devLogin(env)

    const res = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:register_key'] }),
      },
      env,
    )
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('reauth_required')
  })

  it('a caller without a bridged web session (no matching members row) is forbidden from deciding', async () => {
    const env = makeEnv('nobody@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id)
    const cookie = await devLogin(env) // succeeds (KV-only) but never registers a D1 web_session

    const res = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:manage_access'] }),
      },
      env,
    )
    expect(res.status).toBe(403)
  })

  it('POST /elevation/:id/revoke ends a grant, scoped to the caller\'s own admin authority', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, ['action:dispatch'])
    const cookie = await devLogin(env)

    const decideRes = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:dispatch'] }),
      },
      env,
    )
    const grantId = ((await decideRes.json()) as { grants: Array<{ id: string }> }).grants[0].id

    const revokeRes = await authApp.request(
      `/elevation/${grantId}/revoke`,
      { method: 'POST', headers: { cookie: `mupot_session=${cookie}` } },
      env,
    )
    expect(revokeRes.status).toBe(200)
    await expect(revokeRes.json()).resolves.toEqual({ revoked: true })

    const grant = await loadElevationGrantById(env, TENANT, grantId)
    expect(grant?.revoked_at).toBeTruthy()
  })

  it('an outsider (no admin authority on the scope) cannot revoke someone else\'s grant', async () => {
    const adminEnv = makeEnv('admin@x.test')
    const { session } = await seedFixture(adminEnv)
    const request = await seedPendingRequest(adminEnv, session.id, ['action:dispatch'])
    const adminCookie = await devLogin(adminEnv)
    const decideRes = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${adminCookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:dispatch'] }),
      },
      adminEnv,
    )
    const grantId = ((await decideRes.json()) as { grants: Array<{ id: string }> }).grants[0].id

    const outsiderEnv = makeEnv('outsider@x.test')
    outsiderEnv.DB = adminEnv.DB
    outsiderEnv.SESSIONS = kv()
    const outsiderCookie = await devLogin(outsiderEnv)

    const attempt = await authApp.request(
      `/elevation/${grantId}/revoke`,
      { method: 'POST', headers: { cookie: `mupot_session=${outsiderCookie}` } },
      outsiderEnv,
    )
    expect(attempt.status).toBe(403)

    const grant = await loadElevationGrantById(adminEnv, TENANT, grantId)
    expect(grant?.revoked_at).toBeNull()
  })
})
