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
import { invokeTool } from '../src/mcp'
import type { AuthContext, Env } from '../src/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exactActionHash, type ExactAction } from '../src/auth/exact-action'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createAgentSession } from '../src/auth/agent-sessions'
import { createElevationRequest, loadElevationGrantById } from '../src/auth/elevation'
import { hashWebSessionId, markRecentReauth } from '../src/auth/web-sessions'

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

  it('human steering: deny A, approve changed B, then revoke B on the same worker session', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    await env.DB.prepare(
      "INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('steering-admin', ?1, 'org', NULL, 'admin')",
    ).bind(ADMIN_MEMBER).run()
    const cookie = await devLogin(env)
    await markReauth(env, cookie)
    const auth: AuthContext = {
      userId: AGENT_MEMBER, memberId: AGENT_MEMBER, email: null, role: 'member',
      tenant: TENANT, channel: 'workspace', boundAgentId: AGENT_ID, tokenId: TOKEN_ID, capabilities: [],
    }
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/exact-action-v1.json'), 'utf8')) as { action: ExactAction }
    const { principal: _fixturePrincipal, tenant: _fixtureTenant, ...fieldsA } = fixture.action
    const fieldsB = { ...fieldsA, payload_hash: 'b'.repeat(64) }
    const hashA = await exactActionHash({ principal: AGENT_ID, tenant: TENANT, ...fieldsA })
    const hashB = await exactActionHash({ principal: AGENT_ID, tenant: TENANT, ...fieldsB })
    expect(hashB).not.toBe(hashA)
    const propose = async (fields: typeof fieldsA, reason: string) => {
      const result = await invokeTool(auth, env, 'request_elevation', {
        actions: ['action:knowledge_write'], scope_type: 'org', duration_minutes: 15,
        reason, exact_action: fields,
      }, 'https://pot.test')
      expect(result.ok, JSON.stringify(result)).toBe(true)
      return (result as { ok: true; result: { request: { id: string } } }).result.request.id
    }
    const decide = async (id: string, body: object) => {
      const response = await authApp.request(`/elevation/requests/${id}/decide`, {
        method: 'POST', headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }, env)
      expect(response.status).toBe(200)
      return response.json() as Promise<{ ok: boolean; request: { status: string }; grants: Array<{ id: string }> }>
    }
    const verify = (hash: string, fields: typeof fieldsA) => invokeTool(auth, env, 'verify_protected_action', {
      exact_action_hash: hash, ...fields,
    }, 'https://pot.test')
    const usageCount = async () => Number((await env.DB.prepare('SELECT COUNT(*) AS n FROM elevation_usage_log').first<{ n: number }>())?.n)

    const requestA = await propose(fieldsA, 'original memory delta A')
    const pendingA = await verify(hashA, fieldsA)
    expect(pendingA.ok).toBe(false)
    expect(await usageCount()).toBe(0)
    const denial = await decide(requestA, { decision: 'deny', note: 'Change the memory delta to B; A is not permitted.' })
    expect(denial.request.status).toBe('denied')
    const requestB = await propose(fieldsB, 'changed memory delta B')
    expect(requestB).not.toBe(requestA)
    const approval = await decide(requestB, {
      decision: 'approve', actions: ['action:knowledge_write'], duration_minutes: 15,
      bound_action_hash: hashB,
    })
    expect(approval.ok).toBe(true)
    expect(approval.grants).toHaveLength(1)
    expect((await verify(hashA, fieldsA)).ok).toBe(false)
    expect(await usageCount()).toBe(0)
    const verifiedB = await verify(hashB, fieldsB)
    expect(verifiedB.ok, JSON.stringify(verifiedB)).toBe(true)
    if (verifiedB.ok) expect(verifiedB.result).toMatchObject({ grant_id: approval.grants[0].id, bound_action_hash: hashB })
    expect(await usageCount()).toBe(1)

    const revoked = await authApp.request(`/elevation/${approval.grants[0].id}/revoke`, {
      method: 'POST', headers: { cookie: `mupot_session=${cookie}` },
    }, env)
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toEqual({ revoked: true })
    expect((await verify(hashB, fieldsB)).ok).toBe(false)
    expect(await usageCount()).toBe(1)
    const rows = await env.DB.prepare('SELECT id, agent_session_id, status FROM elevation_requests ORDER BY created_at, id')
      .all<{ id: string; agent_session_id: string; status: string }>()
    expect(rows.results).toEqual(expect.arrayContaining([
      { id: requestA, agent_session_id: session.id, status: 'denied' },
      { id: requestB, agent_session_id: session.id, status: 'approved' },
    ]))
  })

  async function seedFixture(env: Env) {
    env.DB = harness.db
    // CLAIM THE BOOTSTRAP OWNER SEAT FIRST — with an email no test logs in as.
    //
    // upsertUserByEmail makes the FIRST user in an empty `users` table the org
    // owner (`isFirst && allowBootstrapOwner`), and every test here builds a
    // fresh D1 and then dev-logs-in. So without this row, the principal each
    // test calls "the outsider" or "an operator without authority" WAS the org
    // owner, holding the highest authority in the pot.
    //
    // Those tests passed only because the routes ignored the legacy role plane
    // entirely and read `auth.capabilities ?? []` — i.e. they passed BECAUSE of
    // the owner-lockout defect, and would have kept passing after it was fixed
    // only by asserting the owner still sees nothing. The fixture was encoding
    // the bug it should have caught.
    await env.DB.prepare(
      "INSERT INTO users (id, email, role) VALUES ('bootstrap-owner', 'bootstrap-owner@x.test', 'owner')",
    ).run()
    // …with a matching members row, because that is what production looks like:
    // the owner is a users row (authority, role plane) AND a members row
    // (identity, what the dashboard bridge resolves and what the ledger records
    // as the decider). Without the members row the routes return before ever
    // reaching an authority check, which would hide the fix under an unrelated
    // early return.
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('bootstrap-owner', ?1, 'bootstrap-owner@x.test', 'Bootstrap Owner', 'active', datetime('now'))`,
    ).bind(TENANT).run()
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

  // Adversarial gate P0-2: a pending action:knowledge_write request with a
  // real exact-action binding (migrations/0152), for testing the decide
  // route's bound_action_hash enforcement.
  async function seedPendingKnowledgeWriteRequest(env: Env, agentSessionId: string) {
    const result = await createElevationRequest(env, {
      tenant: TENANT, agentSessionId, agentId: AGENT_ID, memberId: AGENT_MEMBER,
      actions: ['action:knowledge_write'], scopeType: 'squad', scopeId: SQUAD, durationMinutes: 60,
      reason: 'write the approved page',
      exactAction: {
        target: { system: 'wiki', id: 'page-1', revision: 'rev-1' },
        expected_revision: 'rev-1',
        payload_hash: 'a'.repeat(64),
        destination: 'content/en/notes/page-1.mdx',
        operation: 'upsert',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    })
    if (!result.ok || !result.binding) throw new Error(`setup: could not create knowledge_write elevation request: ${JSON.stringify(result)}`)
    return { request: result.request, binding: result.binding }
  }

  /** Mark the web session behind `cookie` as recently reauthenticated —
   *  action:knowledge_write is in SENSITIVE_STEP_UP_ACTIONS, so every decide
   *  test for it needs this or it is refused at the (unrelated) reauth gate
   *  before ever reaching the bound_action_hash check under test. */
  async function markReauth(env: Env, cookie: string): Promise<void> {
    await markRecentReauth(env, await hashWebSessionId(cookie), Date.now())
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

  it('the ORG OWNER — whose authority is the legacy role plane, with ZERO capability rows — sees and can approve', async () => {
    // The owner is the principal with the most authority in the pot and
    // characteristically holds NO rows in `capabilities`: their authority lives
    // on auth.role, and the auth bridge deliberately leaves auth.capabilities
    // UNDEFINED for them (assigning [] is what downgrades them).
    //
    // The routes read `auth.capabilities ?? await resolveCapabilities(...)`,
    // and resolveCapabilities is pure SQL over `capabilities` with no role
    // plane — so that `??` materialized [] for exactly this principal. Measured
    // on the pre-fix code: GET /elevation/requests returned 200 {"requests":[]}
    // and POST .../decide returned 403. Not a visible refusal — a permanent,
    // silent "nothing is pending" for the only person who can approve anything.
    const env = makeEnv('bootstrap-owner@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id)
    const cookie = await devLogin(env)

    const ownerRows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'bootstrap-owner'",
    ).first<{ n: number }>()
    expect(ownerRows?.n ?? 0).toBe(0) // the whole point: authority without grants

    const listRes = await authApp.request('/elevation/requests', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { requests: Array<{ id: string }> }
    expect(listBody.requests).toHaveLength(1)
    expect(listBody.requests[0].id).toBe(request.id)

    const decideRes = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'deny' }),
      },
      env,
    )
    const decideBody = (await decideRes.json()) as { ok: boolean; reason?: string }
    expect(decideBody.ok, `owner decide refused: ${decideBody.reason}`).toBe(true)
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
    const request = await seedPendingRequest(env, session.id, ['action:project_lifecycle'])
    const cookie = await devLogin(env)

    const decideRes = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:project_lifecycle'] }),
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
    // action:mint_token, not action:register_key: both are in
    // SENSITIVE_STEP_UP_ACTIONS (which is what this test is about), but
    // register_key is not enforced by any tool yet and so cannot be requested.
    const request = await seedPendingRequest(env, session.id, ['action:mint_token'])
    const cookie = await devLogin(env)

    const res = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:mint_token'] }),
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
    const request = await seedPendingRequest(env, session.id, ['action:project_lifecycle'])
    const cookie = await devLogin(env)

    const decideRes = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:project_lifecycle'] }),
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
    const request = await seedPendingRequest(adminEnv, session.id, ['action:project_lifecycle'])
    const adminCookie = await devLogin(adminEnv)
    const decideRes = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${adminCookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:project_lifecycle'] }),
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

  // ── adversarial gate P0-2: bound_action_hash enforcement through the HTTP route ──

  it('approving action:knowledge_write WITHOUT bound_action_hash is refused (invalid_elevation_request)', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const { request } = await seedPendingKnowledgeWriteRequest(env, session.id)
    const cookie = await devLogin(env)
    await markReauth(env, cookie)

    const res = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:knowledge_write'] }),
      },
      env,
    )
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('invalid_elevation_request')
    expect(res.status).toBe(409)
  })

  it('approving action:knowledge_write with the WRONG bound_action_hash is refused', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const { request } = await seedPendingKnowledgeWriteRequest(env, session.id)
    const cookie = await devLogin(env)
    await markReauth(env, cookie)

    const res = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:knowledge_write'], bound_action_hash: 'f'.repeat(64) }),
      },
      env,
    )
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('invalid_elevation_request')
  })

  it('approving action:knowledge_write with the CORRECT bound_action_hash succeeds', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const { request, binding } = await seedPendingKnowledgeWriteRequest(env, session.id)
    const cookie = await devLogin(env)
    await markReauth(env, cookie)

    const res = await authApp.request(
      `/elevation/requests/${request.id}/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:knowledge_write'], bound_action_hash: binding.action_hash }),
      },
      env,
    )
    const body = (await res.json()) as { ok: boolean; grants: Array<{ action: string }> }
    expect(body.ok, JSON.stringify(body)).toBe(true)
    expect(body.grants[0].action).toBe('action:knowledge_write')
  })

  it('approving action:knowledge_write with NO binding row at all (pre-0152 or side-inserted request) is refused', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    // Bypasses createElevationRequest entirely — simulates a request row
    // that predates migrations/0152, or whose binding insert never landed.
    // Real JS ISO timestamps, not SQLite's datetime('now') — see
    // reference_config elsewhere in this repo: datetime('now') produces a
    // SPACE-separated string that sorts/parses incorrectly against the
    // real .toISOString() values every production writer uses.
    const nowIso = new Date().toISOString()
    const decisionExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    await env.DB.prepare(
      `INSERT INTO elevation_requests
         (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
          requested_scope_type, requested_scope_id, requested_duration_minutes, reason,
          status, created_at, decision_expires_at)
       VALUES ('req-no-binding', ?1, ?2, ?3, ?4, ?5, 'squad', ?6, 60, 'x', 'pending', ?7, ?8)`,
    )
      .bind(TENANT, session.id, AGENT_ID, AGENT_MEMBER, JSON.stringify(['action:knowledge_write']), SQUAD, nowIso, decisionExpiresAt)
      .run()
    const cookie = await devLogin(env)
    await markReauth(env, cookie)

    const res = await authApp.request(
      `/elevation/requests/req-no-binding/decide`,
      {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', actions: ['action:knowledge_write'], bound_action_hash: 'a'.repeat(64) }),
      },
      env,
    )
    const body = (await res.json()) as { ok: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('invalid_elevation_request')
  })
})
