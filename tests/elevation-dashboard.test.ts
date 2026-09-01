// tests/elevation-dashboard.test.ts — Delivery Sequence step 5 ("UX
// convergence", mupot task f5fe1222, mumega-com#1173): the three
// server-rendered dashboard screens (src/dashboard/elevation.ts) exercised
// through the REAL dashboardApp, on the real migration chain
// (createSqliteD1 + applyAllMigrations), exactly like
// tests/elevation-approval-routes.test.ts exercises authApp's JSON routes.
//
// This file does NOT re-test decideElevationRequest/hasElevatedAction's own
// business rules — steps 3/4 already cover those exhaustively. It tests what
// step 5 actually added: the RENDERING (does the page show what it must,
// omit what it must never expose, and never offer a control step 3/4 would
// have to reject anyway) and the STRUCTURAL human-only gate.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { createAgentSession } from '../src/auth/agent-sessions'
import { createElevationRequest } from '../src/auth/elevation'

const TENANT = 'local'
const DEPT = 'dept-1'
const SQUAD_A = 'squad-a'
const SQUAD_B = 'squad-b'
const AGENT_ID = 'agent-a'
const AGENT_MEMBER = 'member-agent-a'
const ADMIN_MEMBER = 'member-admin'
const OUTSIDER_MEMBER = 'member-outsider'
const NOBODY_EMAIL = 'nobody@x.test'
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
    BRAND: 'Test Pot',
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(),
  } as unknown as Env
}

describe('elevation dashboard screens — integration through dashboardApp (real D1)', () => {
  let harness: SqliteD1Harness

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => harness.close())

  async function seedFixture(env: Env) {
    env.DB = harness.db
    await env.DB.prepare(`INSERT INTO departments (id, slug, name) VALUES (?1, 'dept', 'Dept')`).bind(DEPT).run()
    await env.DB.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad-a', 'Squad Alpha')`)
      .bind(SQUAD_A, DEPT)
      .run()
    await env.DB.prepare(`INSERT INTO squads (id, department_id, slug, name) VALUES (?1, ?2, 'squad-b', 'Squad Bravo')`)
      .bind(SQUAD_B, DEPT)
      .run()
    await env.DB.prepare(
      `INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES (?1, ?2, 'agent-a', 'Agent Alpha', 'member', 'test', 'active')`,
    )
      .bind(AGENT_ID, SQUAD_A)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, display_name, status, created_at) VALUES (?1, ?2, 'Agent A Member', 'active', datetime('now'))`,
    )
      .bind(AGENT_MEMBER, TENANT)
      .run()
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES (?1, ?2, 'admin@x.test', 'Admin Operator', 'active', datetime('now'))`,
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
    // admin@x.test: admin capability on squad-a ONLY (never squad-b).
    await env.DB.prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?1, ?2, 'squad', ?3, 'admin')`,
    )
      .bind('cap-admin-1', ADMIN_MEMBER, SQUAD_A)
      .run()

    const session = await createAgentSession(env, {
      tenant: TENANT,
      agentId: AGENT_ID,
      memberId: AGENT_MEMBER,
      authKind: 'workspace_token',
      credentialId: TOKEN_ID,
    })
    return { session }
  }

  async function seedPendingRequest(
    env: Env,
    agentSessionId: string,
    opts: { actions?: string[]; scopeId?: string; durationMinutes?: number } = {},
  ) {
    const result = await createElevationRequest(env, {
      tenant: TENANT,
      agentSessionId,
      agentId: AGENT_ID,
      memberId: AGENT_MEMBER,
      actions: opts.actions ?? ['action:manage_access'],
      scopeType: 'squad',
      scopeId: opts.scopeId ?? SQUAD_A,
      durationMinutes: opts.durationMinutes ?? 60,
      reason: 'need it for the task',
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

  // ── structural human-only gate ─────────────────────────────────────────

  it('an unauthenticated request to GET /elevation is redirected to login, never rendered', async () => {
    const env = makeEnv('admin@x.test')
    env.DB = harness.db
    const res = await dashboardApp.request('/elevation', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('a request carrying ONLY a bearer Authorization header (no cookie) — simulating an agent-bound credential — gets the exact same redirect: there is no argument channel for it to reach this page at all', async () => {
    const env = makeEnv('admin@x.test')
    env.DB = harness.db
    const res = await dashboardApp.request(
      '/elevation',
      { headers: { authorization: 'Bearer mupot_some-agent-bound-token' } },
      env,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('the same holds for the approval screen and the live-grants screen', async () => {
    const env = makeEnv('admin@x.test')
    env.DB = harness.db
    const headers = { authorization: 'Bearer mupot_some-agent-bound-token' }
    const approvalRes = await dashboardApp.request('/elevation/some-id', { headers }, env)
    const grantsRes = await dashboardApp.request('/elevation/grants', { headers }, env)
    expect(approvalRes.status).toBe(302)
    expect(grantsRes.status).toBe(302)
  })

  // ── unbridged login: explain, not a bare empty page ────────────────────

  it('a login with no matching members row is told WHY nothing is shown, not left with a bare empty page', async () => {
    const env = makeEnv(NOBODY_EMAIL)
    await seedFixture(env)
    const cookie = await devLogin(env) // succeeds (KV-only), never bridges to a members row

    const res = await dashboardApp.request('/elevation', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const bodyText = await res.text()
    expect(bodyText).toContain('not linked to a member identity')
  })

  // ── pending-requests screen ─────────────────────────────────────────────

  it('an operator with admin-on-squad sees the pending request, its agent name, and the effect badge', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    await seedPendingRequest(env, session.id, { actions: ['action:manage_access'] })
    const cookie = await devLogin(env)

    const res = await dashboardApp.request('/elevation', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const bodyText = await res.text()
    expect(bodyText).toContain('Agent Alpha')
    expect(bodyText).toContain('Reversible after expiry')
    expect(bodyText).toContain('Review this request')
  })

  it('a pending request outside the operator\'s administered scope is never silently absent — it is named by scope with a remedy, not just missing', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    await seedPendingRequest(env, session.id, { scopeId: SQUAD_A, actions: ['action:dispatch'] })
    await seedPendingRequest(env, session.id, { scopeId: SQUAD_B, actions: ['action:register_key'] })
    const cookie = await devLogin(env)

    const res = await dashboardApp.request('/elevation', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const bodyText = await res.text()
    // Squad B's request is out of admin@x.test's scope (admin only on squad-a):
    // the page must name Squad Bravo and the remedy, not just drop it.
    expect(bodyText).toContain('Outside your authority')
    expect(bodyText).toContain('Squad Bravo')
    expect(bodyText).toContain('ask an admin there')
    // But it must NOT leak the out-of-scope request's sensitive action detail
    // (the irreversible register_key action) into the aggregate panel.
    expect(bodyText).not.toContain('Register agent signing key')
  })

  // ── approval screen: structural narrow-only ─────────────────────────────

  it('the approval screen offers checkboxes for EXACTLY the requested actions — never a superset (structural narrow-only, not just server-enforced)', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, { actions: ['action:dispatch', 'action:manage_access'] })
    const cookie = await devLogin(env)

    const res = await dashboardApp.request(`/elevation/${request.id}`, { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const bodyText = await res.text()
    expect(bodyText).toContain('value="action:dispatch"')
    expect(bodyText).toContain('value="action:manage_access"')
    // No control anywhere on the page offers an action that was not requested.
    expect(bodyText).not.toContain('value="action:register_key"')
    expect(bodyText).not.toContain('value="action:migrate"')
    expect(bodyText).not.toContain('value="action:secrets"')
    expect(bodyText).not.toContain('value="action:mint_token"')
    expect(bodyText).not.toContain('value="action:project_lifecycle"')
  })

  it('the approval screen offers duration options only up to what was requested — never a superset', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, { durationMinutes: 240 })
    const cookie = await devLogin(env)

    const res = await dashboardApp.request(`/elevation/${request.id}`, { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const bodyText = await res.text()
    expect(bodyText).toContain('value="15"')
    expect(bodyText).toContain('value="60"')
    expect(bodyText).toContain('value="240"')
    expect(bodyText).not.toContain('value="480"')
    expect(bodyText).not.toContain('value="1440"')
  })

  it('the approval screen shows the unmissable irreversible warning when a requested action is permanent', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, { actions: ['action:register_key'] })
    const cookie = await devLogin(env)

    const res = await dashboardApp.request(`/elevation/${request.id}`, { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const bodyText = await res.text()
    expect(bodyText).toContain('PERMANENT')
    expect(bodyText).toContain('A time limit on this grant is not a time limit on its consequences')
  })

  it('the approval screen writes to the EXISTING decide endpoint — no new write path', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id)
    const cookie = await devLogin(env)

    const res = await dashboardApp.request(`/elevation/${request.id}`, { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const bodyText = await res.text()
    expect(bodyText).toContain(`/auth/elevation/requests/${request.id}/decide`)
  })

  it('a request outside the operator\'s administered scope, hit directly by id, explains the refusal and does NOT leak the request detail', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, { scopeId: SQUAD_B, actions: ['action:dispatch'], durationMinutes: 15 })
    const cookie = await devLogin(env)

    const res = await dashboardApp.request(`/elevation/${request.id}`, { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const bodyText = await res.text()
    expect(bodyText).toContain('do not hold admin authority')
    expect(bodyText).toContain('Squad Bravo')
    expect(bodyText).not.toContain('Agent Alpha')
    expect(bodyText).not.toContain('need it for the task') // the reason text
    expect(bodyText).not.toContain('value="action:dispatch"') // no form at all
  })

  // ── live-grants screen: the frozen effect, expiry, and revoke ───────────

  it('the frozen grant.effect renders — NOT the current registry classification for the same action', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, { actions: ['action:dispatch'] })
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

    // action:dispatch's LIVE registry classification is 'reversible'. Directly
    // corrupt the STORED (frozen) column to 'irreversible' — simulating a
    // registry that changed AFTER this grant was already approved — and prove
    // the page renders the stored value, never re-deriving from the registry.
    await env.DB.prepare(`UPDATE elevation_grants SET effect = 'irreversible' WHERE id = ?1`).bind(grantId).run()

    const res = await dashboardApp.request('/elevation/grants', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const bodyText = await res.text()
    expect(bodyText).toContain('PERMANENT — cannot be undone')
    expect(bodyText).not.toContain('Reversible after expiry')
  })

  it('an expired grant is excluded from the live-grants screen — it renders as gone, never as active', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, { actions: ['action:dispatch'] })
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

    // Force it into the past directly — same technique as the elevation.test.ts
    // controlled-clock expiry tests, applied at the storage layer since this
    // route always reads Date.now() internally.
    await env.DB.prepare(`UPDATE elevation_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?1`)
      .bind(grantId)
      .run()

    const res = await dashboardApp.request('/elevation/grants', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const bodyText = await res.text()
    expect(bodyText).not.toContain(`grant-${grantId}`)
    expect(bodyText).toContain('No active elevations')
  })

  it('the live-grants screen wires revoke to the EXISTING RBAC\'d revoke endpoint — no new write path', async () => {
    const env = makeEnv('admin@x.test')
    const { session } = await seedFixture(env)
    const request = await seedPendingRequest(env, session.id, { actions: ['action:dispatch'] })
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

    const res = await dashboardApp.request('/elevation/grants', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    const bodyText = await res.text()
    // The grant id is wired in as a data attribute; the client script builds
    // '/auth/elevation/' + id + '/revoke' | '/usage' at click time (never a
    // hardcoded id) — assert the pieces the runtime concatenates are the
    // EXISTING, already step-3/4-tested route family, and that this exact
    // grant id is actually present for the script to read.
    expect(bodyText).toContain(`data-grant="${grantId}"`)
    expect(bodyText).toContain("'/auth/elevation/' + encodeURIComponent(id) + '/revoke'")
    expect(bodyText).toContain("'/auth/elevation/' + encodeURIComponent(id) + '/usage'")
  })

  it('an active grant outside the operator\'s administered scope is named by scope, not silently absent, and not shown with full detail', async () => {
    const adminEnv = makeEnv('admin@x.test')
    const { session } = await seedFixture(adminEnv)
    // Grant it on squad-a (admin's own scope) first so we have a real grant,
    // then move it to squad-b's identity for the visibility check by seeding
    // a second request directly on squad-b decided by an org-capable outsider
    // is unnecessary complexity — instead assert via the pending-request path
    // already covered above, and here assert the SAME aggregate mechanism
    // exists on the grants page by constructing a squad-b-scoped grant row
    // directly (bypassing decide — this test targets ONLY the render, not
    // the ledger write path already covered by step 3/4's own tests).
    const cookie = await devLogin(adminEnv)
    // decided_by_web_session_hash / approved_by_web_session_hash both carry a
    // REFERENCES web_sessions(id_hash) FK (migration 0142) — use the REAL row
    // dev-login just created rather than a fabricated hash.
    const webSessionRow = await adminEnv.DB.prepare(`SELECT id_hash FROM web_sessions WHERE tenant = ?1 AND member_id = ?2 LIMIT 1`)
      .bind(TENANT, ADMIN_MEMBER)
      .first<{ id_hash: string }>()
    if (!webSessionRow) throw new Error('setup: no web_sessions row for admin after dev-login')
    const webSessionHash = webSessionRow.id_hash
    // ISO strings (matching the .toISOString() format every real writer in
    // this codebase uses), NOT SQLite datetime('now') — that produces a
    // space-separated format ("YYYY-MM-DD HH:MM:SS") which sorts LOWER than
    // an ISO 'T'-separated timestamp under a plain string '>' comparison,
    // which is exactly the comparison listActiveElevationGrants's WHERE
    // clause uses. A format mismatch here would make a genuinely-future
    // expires_at silently fail that comparison and vanish from every list —
    // indistinguishable from "expired" without this fix.
    const nowIso = new Date().toISOString()
    const inOneHourIso = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await adminEnv.DB.prepare(
      `INSERT INTO elevation_requests (id, tenant, agent_session_id, agent_id, member_id, requested_actions_json,
         requested_scope_type, requested_scope_id, requested_duration_minutes, reason, status, created_at, decision_expires_at,
         decided_at, decided_by_member_id, decided_by_web_session_hash)
       VALUES ('req-b', ?1, ?2, ?3, ?4, '["action:dispatch"]', 'squad', ?5, 60, 'x', 'approved', ?6, ?7, ?6, ?8, ?9)`,
    )
      .bind(TENANT, session.id, AGENT_ID, AGENT_MEMBER, SQUAD_B, nowIso, inOneHourIso, ADMIN_MEMBER, webSessionHash)
      .run()
    await adminEnv.DB.prepare(
      `INSERT INTO elevation_grants (id, tenant, elevation_request_id, agent_session_id, action, scope_type, scope_id, effect,
         approved_by_member_id, approved_by_web_session_hash, created_at, expires_at)
       VALUES ('grant-b', ?1, 'req-b', ?2, 'action:dispatch', 'squad', ?3, 'reversible', ?4, ?5, ?6, ?7)`,
    )
      .bind(TENANT, session.id, SQUAD_B, ADMIN_MEMBER, webSessionHash, nowIso, inOneHourIso)
      .run()

    const res = await dashboardApp.request('/elevation/grants', { headers: { cookie: `mupot_session=${cookie}` } }, adminEnv)
    const bodyText = await res.text()
    expect(bodyText).toContain('Outside your authority')
    expect(bodyText).toContain('Squad Bravo')
    expect(bodyText).not.toContain('grant-b')
  })
})
