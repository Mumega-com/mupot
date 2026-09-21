// tests/journey-new-member.test.ts — UC-1 automated journey test (mupot#1442).
//
// Source of truth: mumega.com agents/kasra/docs/use-case-new-member-journey-20260920.md
// (13 steps, one assertion each). This file drives that table as one `describe` per
// step, IN ORDER, sharing a single real SQLite D1 (createSqliteD1 + applyAllMigrations,
// following tests/invite-landing-page.test.ts / tests/accept-invite-direct.test.ts) —
// no hand-written CREATE TABLE, no mock DB. Every MCP tool call goes through
// `invokeTool` (never a ToolSpec's `.run()` directly — scripts/check-mcp-tool-seam.mjs).
//
// A step whose assertion cannot be met by the code AS IT EXISTS TODAY is `it.todo`
// naming the issue/task id, never `it.skip` and never bent to pass. Several steps
// below found the code's real behaviour diverging from the spec table; each is
// called out in a comment at the point of divergence (do not "fix" the test to
// hide these — they are findings for #1442, not test bugs):
//
//   FINDING A (RESOLVED by #1436 A3, mupot#1458/ad5fe58e) — a "plain squad
//     invite" (squad_id set, no project_id/expires_in_seconds/member_id) is now a
//     real, web-completable invite kind: src/members/index.ts's parseInvite treats
//     bare squad_id as the plain-squad producer (kind:'squad'), acceptInvite grants
//     the human-plane capability directly at squad scope (A3-2, not department
//     inheritance), and src/dashboard/invite.ts's loadInviteLanding renders the
//     squad's own name (never a department, since this invite kind carries none).
//     The only invite kind the web accept page still refuses (409 "redeemed in
//     Telegram") is the Telegram/project PAIRING kind (pairing_hash or
//     pairing_expires_at set) — isTelegramDoorInvite, unaffected by A3. This file
//     therefore drives a plain-squad invite straight at the squad created in step 1
//     (not a department), matching the spec table's step 2/3 literally instead of
//     working around a since-fixed gap.
//
//   FINDING B — /admin/members' "copyable /invite/<id> link" (step 2) is built
//     entirely CLIENT-SIDE (src/dashboard/index.ts, the inline <script> at the
//     bottom of the admin members page) from the JSON response of the invite-create
//     fetch call. A server-rendered GET of that page — which is all an HTTP-level
//     test can do, there is no DOM/JS engine here — never contains the literal
//     populated `/invite/<id>` URL; it only contains the id="invite-form"/
//     id="invite-link" scaffolding and the `'/invite/' + encodeURIComponent(inviteId)`
//     template that builds the real link at runtime, in a browser, after the POST
//     succeeds. This file asserts the response POST /invites carries `id` (the part
//     that IS server-observable) and that the admin page carries the link-building
//     wiring, and documents that the literal `/invite/<id>` string is never
//     server-rendered.
//
//   FINDING C — the capability spec invites NEW at ('lead') is BELOW the ('admin')
//     floor every agent-provisioning surface actually gates on: GET /enroll's agent
//     picker (src/dashboard/enroll.ts: "you hold admin on its squad"),
//     memberMayConsentToAgent (the OAuth consent floor, src/mcp/oauth-authorize.ts,
//     P0-3: "the floor to weld is admin, matching mint_agent_token"), and
//     mint_agent_token itself (src/mcp/provision.ts: "admin on the agent's squad").
//     lead=3 < admin=4 (src/auth/capability.ts RANK). A 'lead' NEW can never see an
//     agent in her own picker, never complete OAuth consent, and never mint her own
//     agent token — every one of those requires an ADMIN to act. This matches the
//     manual-walk finding already logged on mupot#1442 (an org-admin agent-bound MCP
//     token could create a squad+project but not add anyone to it). Steps 7-9 below
//     are written to reflect what the code actually requires: step 7 shows NEW's own
//     (empty) picker; step 8's happy-path consent and step 9's mint are both driven
//     by ADMIN, exactly as production would require today.
//
//   FINDING D — task_verdict's status transition on 'approved' sets tasks.status to
//     the literal string 'approved' (src/tasks/service.ts buildVerdictStatements),
//     never 'closed'. The spec table's step 12 says "task closed" informally; this
//     file asserts the real value.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import { invokeTool, TOOLS } from '../src/mcp'
import { handleOAuthAuthorize } from '../src/mcp/oauth-authorize'
import { resolveCapabilities } from '../src/auth/capability'
import { inviteApp } from '../src/dashboard/invite'
import { membersApp } from '../src/members'
import { dashboardApp } from '../src/dashboard/index'
import { authApp } from '../src/auth'
import { PENDING_INVITE_COOKIE, PENDING_INVITE_KV_PREFIX } from '../src/auth/pending-invite-link'
import type { AuthContext, Env } from '../src/types'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

const DEPT_ID = 'dept-uc1'
const ADMIN_MEMBER_ID = 'member-admin'
const ADMIN_EMAIL = 'admin@uc1.test'
const NEW_EMAIL = 'newcomer@uc1.test'

let harness: SqliteD1Harness
let env: Env
let sessions: Map<string, string>

// ── module-scope state threaded between steps (a real journey, not 13 isolated
// fixtures) ───────────────────────────────────────────────────────────────────
let squadId: string
let projectId: string
let inviteId: string
let newMemberId: string
let pendingInviteId: string
let newSessionId: string
let agentId: string
let agentMemberId: string
let taskId: string

function adminAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: ADMIN_MEMBER_ID,
    memberId: ADMIN_MEMBER_ID,
    email: ADMIN_EMAIL,
    // Legacy role 'owner' (not just an org:admin capability row) is what
    // legacyOwnerAdmin (src/tasks/index.ts, callerHoldsGateCapability) checks —
    // task_verdict's gate-ownership check is role-gated, not capability-row-gated,
    // for the org-admin escape. Both planes agree ADMIN is an org admin either way.
    role: 'owner',
    tenant: TENANT,
    channel: 'workspace',
    boundAgentId: null,
    capabilities: [
      { member_id: ADMIN_MEMBER_ID, scope_type: 'org', scope_id: null, capability: 'admin' },
    ],
    ...overrides,
  }
}

function cookieFor(sessionId: string): string {
  return `mupot_session=${sessionId}`
}

function extractSessionId(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = /mupot_session=([^;]+)/.exec(setCookie)
  if (!match) throw new Error(`no mupot_session cookie in response: ${setCookie}`)
  return match[1]
}

// mupot#1436 A2 — same extraction/stub pattern as tests/invite-login-link.test.ts,
// reused (not reinvented) for step 5's real Google callback.
function extractPendingInviteId(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = new RegExp(`${PENDING_INVITE_COOKIE}=([^;]+)`).exec(setCookie)
  if (!match) throw new Error(`no pending-invite cookie in response: ${setCookie}`)
  return match[1]
}

function stubGoogleUserinfo(email: string, sub: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
      }
      if (url.includes('openidconnect.googleapis.com/v1/userinfo')) {
        return new Response(JSON.stringify({ sub, email, email_verified: true }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }),
  )
}

async function startGoogleLogin(pendingId: string): Promise<string> {
  const res = await authApp.request(
    `${ORIGIN}/login`,
    { headers: { cookie: `${PENDING_INVITE_COOKIE}=${pendingId}` } },
    env,
  )
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  const state = location.searchParams.get('state')
  if (!state) throw new Error('login redirect missing state')
  return state
}

function googleCallbackReq(state: string, pendingId: string): Request {
  return new Request(`${ORIGIN}/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `${PENDING_INVITE_COOKIE}=${pendingId}` },
  })
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers })
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  const hdrs = new Headers(headers)
  hdrs.set('content-type', 'application/json')
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: hdrs, body: JSON.stringify(body) })
}

function postForm(path: string, values: Record<string, string>, headers: Record<string, string> = {}): Request {
  const hdrs = new Headers(headers)
  hdrs.set('content-type', 'application/x-www-form-urlencoded')
  if (!hdrs.has('Origin')) hdrs.set('Origin', ORIGIN)
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers: hdrs, body: new URLSearchParams(values) })
}

beforeAll(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  sessions = new Map<string, string>()
  env = {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    // Step 5's real Google callback (#1436 A2) needs a configured provider;
    // token/userinfo fetches are stubbed per-test via stubGoogleUserinfo.
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-client-secret',
    BUS: { send: vi.fn(async () => {}) },
    SESSIONS: {
      get: async (key: string, type?: string) => {
        const value = sessions.get(key) ?? null
        return type === 'json' && value ? JSON.parse(value) : value
      },
      put: async (key: string, value: string) => { sessions.set(key, value) },
      delete: async (key: string) => { sessions.delete(key) },
    },
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    // project_remember/project_recall (step 10) touch Vectorize + Workers AI.
    // Neither has a real-engine test double anywhere in this repo (mcp-project-
    // memory.test.ts mocks both the same way) — everything ELSE in this file runs
    // against the real SQLite D1 schema; only these two bindings are faked.
    AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
    VEC: (() => {
      const vectors: Array<{ id: string; metadata: { agentId: string; tenant: string } }> = []
      return {
        upsert: async (rows: Array<{ id: string; metadata: { agentId: string; tenant: string } }>) => {
          vectors.push(...rows)
        },
        query: async (_v: number[], opts: { topK: number; filter: { agentId: string; tenant: string } }) => ({
          matches: vectors
            .filter((v) => v.metadata.agentId === opts.filter.agentId && v.metadata.tenant === opts.filter.tenant)
            .slice(0, opts.topK)
            .map((v, i) => ({ id: v.id, score: 0.9 - i / 10 })),
        }),
      }
    })(),
  } as unknown as Env

  // Fixture pre-condition: the department ADMIN operates in. Creating THIS is not
  // itself a UC-1 step (the doc's steps start at "create project + squad" inside an
  // existing org) — every other test file in this repo seeds departments the same
  // way (tests/invite-landing-page.test.ts, tests/mcp-project-tools.test.ts).
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('${DEPT_ID}', 'uc1-dept', 'UC1 Department');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('${ADMIN_MEMBER_ID}', '${ADMIN_EMAIL}', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-org', '${ADMIN_MEMBER_ID}', 'org', NULL, 'admin');
  `)
})

afterAll(() => {
  harness.close()
})

// ════════════════════════════════════════════════════════════════════════════
// Step 1 — Create project + squad (ADMIN, MCP create_squad/project_create/
// project_squad_set, through invokeTool)
// ════════════════════════════════════════════════════════════════════════════
describe('Step 1 — ADMIN creates a project and a squad, links them at write', () => {
  it('project_squad_list shows the squad linked at write', async () => {
    const squadRes = await invokeTool(adminAuth(), env, 'create_squad', {
      department: DEPT_ID,
      slug: 'uc1-squad',
      name: 'UC1 Squad',
    }, ORIGIN)
    expect(squadRes.ok, JSON.stringify(squadRes)).toBe(true)
    squadId = (squadRes.result as { squad: { id: string } }).squad.id
    expect(squadId).toBeTruthy()

    const projectRes = await invokeTool(adminAuth(), env, 'project_create', {
      slug: 'uc1-project',
      name: 'UC1 Project',
      description: 'The UC-1 canonical journey project',
      goal: 'Prove the new-member journey works end to end',
      status: 'planned',
    }, ORIGIN)
    expect(projectRes.ok, JSON.stringify(projectRes)).toBe(true)
    projectId = (projectRes.result as { project: { id: string } }).project.id
    expect(projectId).toBeTruthy()

    const setRes = await invokeTool(adminAuth(), env, 'project_squad_set', {
      project_id: projectId,
      squad_id: squadId,
      access_level: 'write',
    }, ORIGIN)
    expect(setRes.ok, JSON.stringify(setRes)).toBe(true)

    const listRes = await invokeTool(adminAuth(), env, 'project_squad_list', { project_id: projectId }, ORIGIN)
    expect(listRes.ok, JSON.stringify(listRes)).toBe(true)
    expect((listRes.result as { squads: Array<{ squad_id: string; access_level: string }> }).squads)
      .toContainEqual(expect.objectContaining({ squad_id: squadId, access_level: 'write' }))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 2 — Invite NEW as 'lead' on the squad (ADMIN, HTTP POST /api/members/invites)
// ════════════════════════════════════════════════════════════════════════════
describe('Step 2 — ADMIN invites NEW at squad scope (FINDING A resolved by A3/FINDING B)', () => {
  it('POST /invites returns an id, and /admin/members carries the copyable-link wiring', async () => {
    sessions.set('sess:admin-session', JSON.stringify({
      userId: 'admin-user', email: ADMIN_EMAIL, role: 'member', createdAt: new Date().toISOString(),
    }))

    // A3: squad_id alone (no project_id/expires_in_seconds/member_id) is the
    // plain-squad producer — parseInvite (src/members/index.ts) routes it to
    // kind:'squad', authorized against 'admin' on THIS squad (ADMIN's org-wide
    // admin capability covers it via planeCoversScope, since uc1-squad is not a
    // home squad).
    const inviteRes = await membersApp.request(
      '/invites',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieFor('admin-session') }, body: JSON.stringify({
        email: NEW_EMAIL,
        squad_id: squadId,
        capability: 'lead',
      }) },
      env,
    )
    expect(inviteRes.status, await inviteRes.clone().text()).toBe(201)
    const body = await inviteRes.json<{ invite: { id: string } }>()
    expect(body.invite.id).toBeTruthy()
    inviteId = body.invite.id

    // FINDING B: the admin page never server-renders `/invite/<id>` with the real
    // id — only the client-side JS that builds it after the form's fetch resolves.
    const adminPage = await dashboardApp.fetch(get('/admin/members', { cookie: cookieFor('admin-session') }), env)
    expect(adminPage.status).toBe(200)
    const adminHtml = await adminPage.text()
    expect(adminHtml).toContain('id="invite-form"')
    expect(adminHtml).toContain('id="invite-link"')
    expect(adminHtml).toContain(`/invite/' + encodeURIComponent(inviteId)`)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 3 — GET /invite/:id, unauthenticated
// ════════════════════════════════════════════════════════════════════════════
describe('Step 3 — GET /invite/:id unauthenticated (A3: shows the squad, not a department)', () => {
  it('200s, shows org/squad/capability/inviter, no email anywhere in <body>', async () => {
    // inviteApp is mounted at /invite by src/index.ts; fetching it directly (not
    // through the parent app) uses its OWN root-relative routes, matching
    // tests/invite-landing-page.test.ts's exact convention.
    const res = await inviteApp.fetch(get(`/${inviteId}`), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Test Pot') // org (BRAND)
    expect(body).toContain('UC1 Squad') // A3: the invite's own squad, not a department
    expect(body).not.toContain('UC1 Department') // this invite kind carries no department_id
    expect(body).toContain('lead') // capability
    expect(body).toContain('Ada Admin') // inviter display name
    const rendered = body.slice(body.indexOf('<body>'))
    expect(rendered).not.toContain('@')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 4 — POST /invite/:id (accept with display name)
// ════════════════════════════════════════════════════════════════════════════
describe('Step 4 — NEW accepts the invite', () => {
  it('302 -> /auth/login; members row + capability row exist; no member_tokens row; accepted_at set', async () => {
    const res = await inviteApp.fetch(postForm(`/${inviteId}`, { display_name: 'Nadia Newcomer' }), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
    // A2: the accept response also plants the short-lived pending-invite pointer
    // (KV + cookie) that step 5's real Google callback consumes.
    pendingInviteId = extractPendingInviteId(res)

    const member = harness.sqlite
      .prepare(`SELECT id, email, display_name, status FROM members WHERE email = ?`)
      .get(NEW_EMAIL) as { id: string; email: string; display_name: string; status: string } | undefined
    expect(member).toBeDefined()
    expect(member!.display_name).toBe('Nadia Newcomer')
    expect(member!.status).toBe('active')
    newMemberId = member!.id

    // A3: a plain squad invite grants the human-plane capability directly at
    // squad scope (acceptInvite's scope-first logic) — not department
    // inheritance, since this invite carries squad_id, not department_id.
    const cap = harness.sqlite
      .prepare(`SELECT capability, scope_type, scope_id FROM capabilities WHERE member_id = ?`)
      .get(newMemberId) as { capability: string; scope_type: string; scope_id: string } | undefined
    expect(cap).toEqual({ capability: 'lead', scope_type: 'squad', scope_id: squadId })

    const tokenCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?`)
      .get(newMemberId) as { n: number }
    expect(tokenCount.n).toBe(0)

    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = ?`)
      .get(inviteId) as { accepted_at: string | null; member_id: string | null }
    expect(invite.accepted_at).not.toBeNull()
    // A2: the D1 invite row's own member_id stamp is the authority step 5's
    // callback links against — never the KV marker's copy.
    expect(invite.member_id).toBe(newMemberId)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 5 — Sign in. The dev-login door mints the WORKSPACE session steps 6-9
// use downstream (kept exactly as before); the real assertion this step now
// makes is the Google OAuth callback linking NEW's IdP identity to the D1
// invite's own member stamp (#1436 A2, task 5c42e0ff — closed by mupot#1458 /
// ad5fe58e). Harness reused verbatim from tests/invite-login-link.test.ts:
// stub Google's token/userinfo endpoints, drive /auth/login to capture the
// state it plants, then /auth/callback.
// ════════════════════════════════════════════════════════════════════════════
describe('Step 5 — NEW signs in', () => {
  it('mints a session cookie for the invited email via the dev-login door', async () => {
    const devLoginEnv = { ...env, LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: NEW_EMAIL } as unknown as Env
    const res = await authApp.request(`${ORIGIN}/dev-login`, {}, devLoginEnv)
    expect(res.status).toBe(302)
    newSessionId = extractSessionId(res)
    expect(newSessionId).toBeTruthy()
  })

  it('#1436 A2 (task 5c42e0ff): Google callback links THAT subject to the invite\'s D1 member stamp, and consumes the KV marker', async () => {
    stubGoogleUserinfo(NEW_EMAIL, 'google-sub-newcomer')
    try {
      const state = await startGoogleLogin(pendingInviteId)
      const res = await authApp.fetch(googleCallbackReq(state, pendingInviteId), env)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/')

      // The invite row's OWN member_id (stamped at accept time, step 4) is the
      // link target — never the KV marker's copy (mupot#1436 A2 design gate).
      const invite = harness.sqlite
        .prepare(`SELECT member_id FROM invites WHERE id = ?`)
        .get(inviteId) as { member_id: string }
      expect(invite.member_id).toBe(newMemberId)

      // NOTE: the FIRST test in this describe already minted a dev-login
      // ('local-test' provider) session for the same email, which also writes
      // a human_login_identities row for newMemberId — filter to 'google' so
      // this assertion is about the REAL callback link, not that fixture row.
      const identity = harness.sqlite
        .prepare(
          `SELECT provider, provider_subject, member_id FROM human_login_identities WHERE member_id = ? AND provider = 'google'`,
        )
        .get(newMemberId) as { provider: string; provider_subject: string; member_id: string } | undefined
      expect(identity).toEqual({
        provider: 'google',
        provider_subject: 'google-sub-newcomer',
        member_id: newMemberId,
      })

      // Get-then-delete: the pointer is single-use.
      expect(sessions.has(`${PENDING_INVITE_KV_PREFIX}${pendingInviteId}`)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a mismatched IdP email refuses — no email leak in the body, no login-identity row linked', async () => {
    // A fresh, dedicated invite/accept for the negative case (mirrors step 8's
    // own convention of a small isolated fixture rather than reusing NEW's
    // already-linked member) — the journey's single shared D1 can't replay the
    // main invite's already-consumed marker/state to prove the email-mismatch
    // gate specifically, and this is exactly what should refuse: a different
    // human completing SOME OTHER accepted invite's OAuth round trip.
    const mismatchInviteId = 'inv-uc1-mismatch'
    const mismatchEmail = 'mismatch@uc1.test'
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, department_id, capability, invited_by)
        VALUES ('${mismatchInviteId}', '${mismatchEmail}', '${DEPT_ID}', 'member', '${ADMIN_MEMBER_ID}');
    `)
    const accept = await inviteApp.fetch(postForm(`/${mismatchInviteId}`, { display_name: 'Mia Mismatch' }), env)
    expect(accept.status).toBe(302)
    const mismatchPendingId = extractPendingInviteId(accept)
    const mismatchInvite = harness.sqlite
      .prepare(`SELECT member_id FROM invites WHERE id = ?`)
      .get(mismatchInviteId) as { member_id: string }
    expect(mismatchInvite.member_id).toBeTruthy()

    stubGoogleUserinfo('someone-else@uc1.test', 'google-sub-mismatch')
    try {
      const state = await startGoogleLogin(mismatchPendingId)
      const res = await authApp.fetch(googleCallbackReq(state, mismatchPendingId), env)
      expect(res.status).toBe(403)
      const body = await res.text()
      const rendered = body.slice(body.indexOf('<body>'))
      expect(rendered).not.toContain('@')

      const linkCount = harness.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = ?`)
        .get(mismatchInvite.member_id) as { n: number }
      expect(linkCount.n).toBe(0)
      const bySubject = harness.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE provider_subject = ?`)
        .get('google-sub-mismatch') as { n: number }
      expect(bySubject.n).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 6 — Land
// ════════════════════════════════════════════════════════════════════════════
describe('Step 6 — landing behaviour', () => {
  // 6a: auto-redirect to "the project page of the only project NEW can read" is
  // not built — GET / renders the observatory dashboard for any principal that
  // clears the capability floor, never a redirect to a specific project. Filed
  // under the umbrella UC-1 issue; no narrower issue exists yet for this gap.
  it.todo('#1442 — landing page auto-redirect to the sole readable project (doc step 6a)')

  // 6b is the spec's own "control case": a signed-in principal with ZERO
  // capability. NEW's own session from step 5 is NOT this case — she holds a real
  // department-inherited 'lead' grant from step 4, so GET / for her clears the
  // capability floor and renders the dashboard, not "No access" (that is 6a's
  // gap, not 6b's). This control case exercises the exact negative branch the
  // doc names, using its own session on the SAME shared D1/dashboard app —
  // mirrors tests/dashboard-no-access-page.test.ts (mupot#1436 A4).
  it('control case: a signed-in principal with no capability sees the real "No access" copy, not a bare 403', async () => {
    const zeroCapEmail = 'nobody@uc1.test'
    sessions.set('sess:zero-cap-session', JSON.stringify({
      userId: 'zero-cap-user', email: zeroCapEmail, role: 'member', createdAt: new Date().toISOString(),
    }))
    const res = await dashboardApp.fetch(get('/', { cookie: cookieFor('zero-cap-session') }), env)
    expect(res.status).toBe(403)
    const body = await res.text()
    const normalized = body.replace(/\s+/g, ' ')
    // Exact string from src/dashboard/index.ts noDashboardAccessBody — NOT the
    // spec doc's paraphrase ("Signed in as <email>. No access yet. Ask an admin
    // for an invite link."); the real copy reads "No access in this org yet."
    expect(normalized).toContain(`Signed in as <strong>${zeroCapEmail}</strong>`)
    expect(normalized).toContain('No access in this org yet. Ask an admin for an invite link.')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 7 — Seat an agent (GET /enroll) — FINDING C
// ════════════════════════════════════════════════════════════════════════════
describe('Step 7 — NEW opens /enroll (FINDING C: lead < admin, picker is empty)', () => {
  it('200s and renders the enroll page (agent picker may legitimately be empty for a lead-only member)', async () => {
    const res = await dashboardApp.fetch(get('/enroll', { cookie: cookieFor(newSessionId) }), env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Enroll seat')
    // FINDING C: enroll's picker requires 'admin' on the squad (src/dashboard/
    // enroll.ts emptyState copy below); NEW holds only 'lead' (rank 3 < 4), so
    // she sees the empty state naming the real remedy — this IS the page
    // rendering correctly, not a bug in the page.
    expect(body).toContain('you hold')
    expect(body).toContain('admin')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 8 — Connect AGENT over MCP OAuth (single-render happy path only;
// double-render mismatch is mupot#1441). FINDING C: this floor also requires
// 'admin' on the squad, so this describe uses its own small ADMIN-eligible
// fixture rather than pretending NEW (lead) can pass it — reusing the exact
// mechanism proven live in tests/agent-bound-oauth-consent.test.ts (section C),
// not a fresh Google mock.
// ════════════════════════════════════════════════════════════════════════════
describe('Step 8 — MCP OAuth consent, single-render happy path', () => {
  const CONSENT_HUMAN = 'member-consent-human'
  const CONSENT_AGENT = { id: 'agent-consent', slug: 'agent-consent', name: 'Consent Agent', squad_id: 'squad-consent' }
  const CONSENT_AGENT_MEMBER = 'member-consent-agent'

  function stubOAuthProvider() {
    return {
      parseAuthRequest: vi.fn(async () => ({ clientId: 'client-1', scope: ['mcp:read', 'mcp:write'] })),
      completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example.test/callback?code=xyz' })),
    }
  }

  function stubGoogleFetch(email: string) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'gtok' }), { status: 200 })
      }
      if (url.includes('googleapis.com/oauth2/v2/userinfo')) {
        return new Response(JSON.stringify({ id: 'google-sub-consent', name: 'Consent Human', email, verified_email: true }), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }))
  }

  it('GET google-callback renders consent, POST consent 200s and mints an agent-bound token', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('${CONSENT_AGENT.squad_id}', '${DEPT_ID}', 'uc1-squad-consent', 'UC1 Consent Squad');
      INSERT INTO agents (id, squad_id, slug, name, status, autonomy, budget_cap_cents, budget_window)
        VALUES ('${CONSENT_AGENT.id}', '${CONSENT_AGENT.squad_id}', '${CONSENT_AGENT.slug}', '${CONSENT_AGENT.name}', 'active', 'execute', 5000, 'week');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('${CONSENT_HUMAN}', 'consent-human@uc1.test', 'Consent Human', 'active', '${TENANT}');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('${CONSENT_AGENT_MEMBER}', NULL, '${CONSENT_AGENT.name}', 'active', '${TENANT}');
      INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at)
        VALUES ('${TENANT}', '${CONSENT_AGENT.id}', '${CONSENT_AGENT_MEMBER}', datetime('now'));
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-consent-agent-home', '${CONSENT_AGENT_MEMBER}', 'squad', '${CONSENT_AGENT.squad_id}', 'member');
      -- FINDING C: 'admin', not 'lead' — the floor memberMayConsentToAgent enforces.
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-consent-human-squad', '${CONSENT_HUMAN}', 'squad', '${CONSENT_AGENT.squad_id}', 'admin');
    `)

    const oauthProvider = stubOAuthProvider()
    const oauthEnv = {
      ...env,
      GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'client-secret',
      OAUTH_PROVIDER: oauthProvider,
    } as unknown as Env

    const authorizeReq = new Request(
      `${ORIGIN}/authorize?client_id=client-1&response_type=code&redirect_uri=https://client.example.test/callback&code_challenge=abc&code_challenge_method=S256`,
    )
    const authorizeRes = await handleOAuthAuthorize(authorizeReq, oauthEnv)
    const nonce = /mupot_oauth_nonce=([^;]+)/.exec(authorizeRes.headers.get('Set-Cookie') ?? '')![1]

    stubGoogleFetch('consent-human@uc1.test')
    const callbackReq = new Request(`${ORIGIN}/oauth/google-callback?code=abc&state=${nonce}`, {
      headers: { Cookie: `mupot_oauth_nonce=${nonce}` },
    })
    const callbackRes = await handleOAuthAuthorize(callbackReq, oauthEnv)
    expect(callbackRes.status).toBe(200)
    const html = await callbackRes.clone().text()
    expect(html).toContain(CONSENT_AGENT.slug)
    expect(oauthProvider.completeAuthorization).not.toHaveBeenCalled() // not yet — no consent given

    const cookies = callbackRes.headers.getSetCookie ? callbackRes.headers.getSetCookie() : [callbackRes.headers.get('Set-Cookie') ?? '']
    const consentCookie = /mupot_oauth_consent=([^;]+)/.exec(cookies.find((c) => c.startsWith('mupot_oauth_consent=')) ?? '')![1]

    const consentReq = new Request(`${ORIGIN}/oauth/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `mupot_oauth_consent=${consentCookie}` },
      body: new URLSearchParams({ consent_nonce: consentCookie, action: 'continue', agent_id: CONSENT_AGENT.id }).toString(),
    })
    const consentRes = await handleOAuthAuthorize(consentReq, oauthEnv)
    expect(consentRes.status).toBe(302) // single render: one consent screen, one decisive POST
    expect(oauthProvider.completeAuthorization).toHaveBeenCalledTimes(1)
    const call = oauthProvider.completeAuthorization.mock.calls[0][0] as { props: { boundAgentId: string | null; memberId: string } }
    expect(call.props.boundAgentId).toBe(CONSENT_AGENT.id)
    expect(call.props.memberId).toBe(CONSENT_AGENT_MEMBER)

    vi.unstubAllGlobals()
  })

  // mupot#1441: the consent screen double-renders under [conditions the issue
  // names]. Not reproduced here — this describe only proves the single-render
  // happy path the rest of the suite depends on.
  it.todo('#1441')
})

// ════════════════════════════════════════════════════════════════════════════
// Step 9 — Orient (real mint_agent_token path; ADMIN mints per FINDING C, since
// NEW's own 'lead' cannot pass mint_agent_token's admin-on-squad floor either)
// ════════════════════════════════════════════════════════════════════════════
describe('Step 9 — orient the seated agent', () => {
  it('mint_agent_token (real path) + boot_context/orient show the invited squad and the project', async () => {
    harness.sqlite.exec(`
      INSERT INTO agents (id, squad_id, slug, name, status)
        VALUES ('agent-uc1', '${squadId}', 'agent-uc1', 'UC1 Agent', 'active');
    `)
    agentId = 'agent-uc1'

    const mintRes = await invokeTool(adminAuth(), env, 'mint_agent_token', { agent: agentId, capability: 'member' }, ORIGIN)
    expect(mintRes.ok, JSON.stringify(mintRes)).toBe(true)
    const minted = (mintRes.result as { token: { member_id: string; agent_id: string } }).token
    expect(minted.agent_id).toBe(agentId)
    agentMemberId = minted.member_id

    // The AuthContext a real workspace-channel request for this token would
    // resolve to (src/mcp/index.ts resolveAuth, knownNonDirectory branch):
    // boundAgentId = the weld, capabilities = resolveCapabilities(memberId) —
    // the SAME function production re-derives from, not a hand-rolled grant list.
    const agentAuth: AuthContext = {
      userId: agentMemberId,
      memberId: agentMemberId,
      email: null,
      role: 'member',
      tenant: TENANT,
      channel: 'workspace',
      boundAgentId: agentId,
      capabilities: await resolveCapabilities(env, agentMemberId),
    }

    const bootRes = await invokeTool(agentAuth, env, 'boot_context', {}, ORIGIN)
    expect(bootRes.ok, JSON.stringify(bootRes)).toBe(true)

    const orientRes = await invokeTool(agentAuth, env, 'orient', {}, ORIGIN)
    expect(orientRes.ok, JSON.stringify(orientRes)).toBe(true)
    // orient's tool wraps buildOrient's packet: { packet: data, brief } — see
    // src/mcp/index.ts's orient ToolSpec.
    const orient = orientRes.result as { packet: { squad: { id: string } } }
    expect(orient.packet.squad.id).toBe(squadId)

    const projectListRes = await invokeTool(agentAuth, env, 'project_list', {}, ORIGIN)
    expect(projectListRes.ok, JSON.stringify(projectListRes)).toBe(true)
    const projects = (projectListRes.result as { projects: Array<{ id: string }> }).projects
    expect(projects.map((p) => p.id)).toContain(projectId)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 10 — Remember + recall
// ════════════════════════════════════════════════════════════════════════════
describe('Step 10 — project_remember / project_recall', () => {
  function agentAuthFor(memberId: string, boundAgentId: string): AuthContext {
    return {
      userId: memberId, memberId, email: null, role: 'member', tenant: TENANT, channel: 'workspace',
      boundAgentId,
      capabilities: [{ member_id: memberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }
  }

  it('recall returns the remembered engram for a project participant', async () => {
    const write = await invokeTool(agentAuthFor(agentMemberId, agentId), env, 'project_remember', {
      project_id: projectId,
      text: 'UC-1 journey engram',
    }, ORIGIN)
    expect(write.ok, JSON.stringify(write)).toBe(true)

    const recall = await invokeTool(agentAuthFor(agentMemberId, agentId), env, 'project_recall', {
      project_id: projectId,
      query: 'journey',
    }, ORIGIN)
    expect(recall.ok, JSON.stringify(recall)).toBe(true)
    const hits = (recall.result as { hits: Array<{ text: string }> }).hits
    expect(hits.map((h) => h.text)).toContain('UC-1 journey engram')
  })

  it('a token bound to an agent in a squad WITHOUT project access gets 404 project_not_found — not a partial/empty result', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-outside-uc1', '${DEPT_ID}', 'squad-outside-uc1', 'Outside Squad');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('agent-outside-uc1', 'squad-outside-uc1', 'agent-outside', 'Outside Agent', 'active');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-outside-uc1', NULL, 'Outside Agent', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-outside-uc1', 'member-outside-uc1', 'squad', 'squad-outside-uc1', 'member');
    `)
    const outsider: AuthContext = {
      userId: 'member-outside-uc1', memberId: 'member-outside-uc1', email: null, role: 'member', tenant: TENANT,
      channel: 'workspace', boundAgentId: 'agent-outside-uc1',
      capabilities: [{ member_id: 'member-outside-uc1', scope_type: 'squad', scope_id: 'squad-outside-uc1', capability: 'member' }],
    }
    const recall = await invokeTool(outsider, env, 'project_recall', { project_id: projectId, query: 'journey' }, ORIGIN)
    expect(recall.ok).toBe(false)
    expect(recall.status).toBe(404)
    expect(recall.error).toBe('project_not_found')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 11 — Work the board
// ════════════════════════════════════════════════════════════════════════════
describe('Step 11 — task_create + task_update, visible on task_board', () => {
  it('the created task appears on the squad task_board', async () => {
    const agentAuth: AuthContext = {
      userId: agentMemberId, memberId: agentMemberId, email: null, role: 'member', tenant: TENANT,
      channel: 'workspace', boundAgentId: agentId,
      capabilities: [{ member_id: agentMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }
    const createRes = await invokeTool(agentAuth, env, 'task_create', {
      squad_id: squadId,
      project_id: projectId,
      title: 'UC-1 journey task',
      done_when: 'the journey test itself passes',
      priority: 'P2',
    }, ORIGIN)
    expect(createRes.ok, JSON.stringify(createRes)).toBe(true)
    taskId = (createRes.result as { task: { id: string } }).task.id

    const updateRes = await invokeTool(agentAuth, env, 'task_update', {
      task_id: taskId,
      status: 'in_progress',
    }, ORIGIN)
    expect(updateRes.ok, JSON.stringify(updateRes)).toBe(true)

    const boardRes = await invokeTool(agentAuth, env, 'task_board', { squad_id: squadId }, ORIGIN)
    expect(boardRes.ok, JSON.stringify(boardRes)).toBe(true)
    // task_board groups by status: { squad_id, counts, columns: Record<status, Task[]> }
    // (src/mcp/index.ts) — flatten every column to find the task regardless of
    // which column task_create/task_update left it in.
    const board = boardRes.result as { columns: Record<string, Array<{ id: string }>> }
    const allBoardTaskIds = Object.values(board.columns).flat().map((t) => t.id)
    expect(allBoardTaskIds).toContain(taskId)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 12 — Pass a gate (FINDING D: status lands as 'approved', not 'closed')
// ════════════════════════════════════════════════════════════════════════════
describe('Step 12 — task_update status=review, ADMIN task_verdict', () => {
  it('verdict row decided_by = ADMIN; task status is approved (the real value, not "closed")', async () => {
    const agentAuth: AuthContext = {
      userId: agentMemberId, memberId: agentMemberId, email: null, role: 'member', tenant: TENANT,
      channel: 'workspace', boundAgentId: agentId,
      capabilities: [{ member_id: agentMemberId, scope_type: 'squad', scope_id: squadId, capability: 'member' }],
    }
    // task_update has NO 'result' input field at all — `tasks.result` (the
    // artifact-gate evidence column, migrations/0006) is written ONLY by the
    // AgentDO execute-mode cortex cycle, never by this tool (src/mcp/index.ts,
    // comment on the PROVENANCE-SAFE ARTIFACT GATE). That gate is also scoped to
    // `existing.assignee_agent_id != null` — our step-11 task was created with no
    // assignee, so no artifact evidence is required to enter review at all; only
    // the GATE-EXIT GUARD applies (review requires a gate_owner).
    const reviewRes = await invokeTool(agentAuth, env, 'task_update', {
      task_id: taskId,
      status: 'review',
      gate_owner: 'gate:uc1-admin',
    }, ORIGIN)
    expect(reviewRes.ok, JSON.stringify(reviewRes)).toBe(true)

    // Simplest legal path for task_verdict named by the tool's own schema comment:
    // human_origin is OPTIONAL — omitting it entirely falls back to the calling
    // principal's own authority, exactly like every pre-#1424 verdict. ADMIN here
    // IS a real member (not agent-bound), so this is an ordinary, fully-authorized
    // verdict call — no human_origin harness-stamping machinery is needed or used.
    const verdictRes = await invokeTool(adminAuth(), env, 'task_verdict', {
      task_id: taskId,
      verdict: 'approved',
    }, ORIGIN)
    expect(verdictRes.ok, JSON.stringify(verdictRes)).toBe(true)

    const verdictRow = harness.sqlite
      .prepare(`SELECT decided_by FROM task_verdicts WHERE task_id = ?`)
      .get(taskId) as { decided_by: string } | undefined
    expect(verdictRow?.decided_by).toBe(ADMIN_MEMBER_ID)

    const taskRow = harness.sqlite
      .prepare(`SELECT status FROM tasks WHERE id = ?`)
      .get(taskId) as { status: string }
    // FINDING D: the real status value is 'approved', never the literal 'closed'
    // the spec doc's step 12 uses informally.
    expect(taskRow.status).toBe('approved')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Step 13 — Feedback (no test; canary is a separate, scheduled surface)
// ════════════════════════════════════════════════════════════════════════════
// No automated test here by design (per the doc: "canary not built" / "SYSTEM:
// Telegram to ADMIN" is the live-canary's job, item 3 of the doc's "three
// implementations of the same table", not this journey test's). See mupot#1442
// for canary tracking.

describe('sanity: every UC-1 MCP tool this file exercises is actually registered', () => {
  it('create_squad, project_create, project_squad_set/list, mint_agent_token, boot_context, orient, project_list, project_remember/recall, task_create/update/board, task_verdict', () => {
    for (const name of [
      'create_squad', 'project_create', 'project_squad_set', 'project_squad_list',
      'mint_agent_token', 'boot_context', 'orient', 'project_list',
      'project_remember', 'project_recall', 'task_create', 'task_update', 'task_board', 'task_verdict',
    ]) {
      expect(TOOLS.map((t) => t.name)).toContain(name)
    }
  })
})
