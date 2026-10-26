// tests/human-presence.test.ts — decisions that WIDEN an agent's or a chat's authority need a user-verified passkey, not a session.
//
// The class: a program driving the owner's logged-in browser holds a real web session AND can pass a fresh Google re-auth, so
// "session + freshness" proves nothing about a human being present. Every widening dashboard decision now goes through
// src/approvals/human-presence.ts: a presence grant satisfied by a WebAuthn assertion (userVerification required) whose challenge
// is bound to the exact decision, consumed once by the route that performs it.
//
// Real dashboardApp / authApp / membersApp / momentsApp, real web sessions (dev-login), the real migration chain, a software
// authenticator that signs real ES256 assertions. Nothing here shortcuts the ceremony (tests/helpers/presence.ts: realTap).
//
// Mutations proven (PR body): requestPresence returning ok without a passkey; redeemPresence dropping the digest / kind / member
// term; the UV flag check removed; the challenge binding removed; the status='satisfied' guard; the per-route presenceGate call
// removed (each path's test goes red on its own).
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { RECENT_REAUTH_WINDOW_MS } from '../src/auth/web-sessions'
import { dashboardApp } from '../src/dashboard/index'
import { membersApp } from '../src/members'
import { tasksApp } from '../src/tasks'
import { upsertHarness } from '../src/members/harness'
import { buildAuthContextFromProps } from '../src/mcp/oauth-authorize'
import { mcpApp } from '../src/mcp/index'
import { mcpInternalRequest } from '../src/mcp/internal-dispatch'
import { createAgentSession } from '../src/auth/agent-sessions'
import { createElevationRequest } from '../src/auth/elevation'
import { PRESENCE_DECISION_KINDS, humanPresenceRequired, type PresenceDecisionKind } from '../src/approvals/human-presence'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { PRESENCE_ENV, challengeFor, csrfFor, enrolPasskey, presenceRefusal, realTap } from './helpers/presence'
import type { SoftAuthenticator } from './helpers/webauthn-authenticator'

const TENANT = 'local'
const ORIGIN = 'http://localhost'

function memoryKv() {
  const store = new Map<string, string>()
  return {
    store,
    async get(key: string, type?: string) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v },
    async put(key: string, value: string) { store.set(key, value) },
    async delete(key: string) { store.delete(key) },
  }
}

let h: SqliteD1Harness
let extraEnv: Record<string, string | undefined> = {}
function envFor(email: string): Env {
  return {
    TENANT_SLUG: TENANT, BRAND: 'Test Pot', LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: email, SESSIONS: memoryKv(), DB: h.db,
    OAUTH_KV: { get: async () => null, put: async () => undefined }, OAUTH_CLIENT_ID: 'cid',
    SEAT_ATTACH: '1', SEAT_AUTO_ENROLL: '1', SEAT_ATTACH_DESIGNATED: '1', VIP_LANE: '1', DELEGATED_OPERATORS: '1',
    SEAT_MAX_PER_MEMBER: '100', SEAT_MAX_TOTAL_PER_MEMBER: '200', SEAT_MAX_TOTAL_PER_HARNESS: '200',
    ...PRESENCE_ENV, ...extraEnv,
  } as unknown as Env
}

interface User { env: Env; cookie: string; memberId: string }
async function login(email: string, memberId: string): Promise<User> {
  const env = envFor(email)
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  const m = /mupot_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')
  if (!m) throw new Error('no session cookie')
  return { env, cookie: `mupot_session=${m[1]}`, memberId }
}
const setReauth = (memberId: string, at: string | null) => h.sqlite.prepare('UPDATE web_sessions SET recent_reauth_at = ? WHERE member_id = ?').run(at, memberId)
const fresh = () => new Date().toISOString()
const one = <T>(sql: string, ...p: unknown[]): T | undefined => h.sqlite.prepare(sql).get(...p) as T | undefined
const count = (sql: string, ...p: unknown[]): number => Number((h.sqlite.prepare(sql).get(...p) as { n: number }).n)

const q = (qs: string): string => (qs ? `?${qs}` : '')
function form(u: User, path: string, data: Record<string, string>, qs = ''): Promise<Response> {
  return Promise.resolve(dashboardApp.request(`${path}${q(qs)}`, {
    method: 'POST', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data),
  }, u.env))
}
function json(u: User, path: string, body: unknown, qs = '', app: { request: (p: string, i: RequestInit, e: Env) => Response | Promise<Response> } = dashboardApp): Promise<Response> {
  return Promise.resolve(app.request(`${path}${q(qs)}`, {
    method: 'POST', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, u.env))
}

// ── the chat side: a real OAuth harness grant, a real auto seat, the real seat_attach tool ─────────────────────────
let tokN = 0
async function grant(env: Env, memberId: string): Promise<AuthContext> {
  const harness = await upsertHarness(env, memberId, 'client-chatgpt', 'ChatGPT')
  if (!harness) throw new Error('harness fixture failed')
  const tokenId = `tok-${memberId}-${++tokN}`
  h.sqlite.exec(`INSERT INTO member_tokens (id, member_id, token_hash, label, channel, created_at, tenant) VALUES ('${tokenId}', '${memberId}', 'hash-${tokenId}', 'oauth:client-chatgpt', 'directory', '2026-10-09T00:00:00.000Z', '${TENANT}')`)
  const ctx = await buildAuthContextFromProps(env, { memberId, tokenId, email: null, channel: 'directory', boundAgentId: null, harnessId: harness.id })
  if (!ctx) throw new Error('grant ctx null')
  return ctx
}
async function rpc(env: Env, ctx: AuthContext, name: string, args: Record<string, unknown>, session: string): Promise<Record<string, unknown>> {
  const req = new Request('https://pot.test/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'openai/session': session } } }),
  })
  const res = await mcpApp.fetch(mcpInternalRequest(req, ctx), env)
  const body = (await res.json()) as { result?: { structuredContent?: Record<string, unknown> } }
  return body.result?.structuredContent ?? {}
}

let admin: User
let adminAuthn: SoftAuthenticator
let adminCtx: AuthContext

beforeEach(async () => {
  extraEnv = {}
  h = createSqliteD1()
  applyAllMigrations(h.sqlite)
  h.sqlite.exec(`
    INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');
    INSERT INTO departments (id, slug, name) VALUES ('D1', 'd1', 'Dept One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S1', 'D1', 's1-sqd', 'Squad One');
    INSERT INTO squads (id, department_id, slug, name) VALUES ('S2', 'D1', 's2-sqd', 'Squad Two');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag1', 'S1', 'ag1', 'Agent One', 'member', 'test', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag2', 'S1', 'ag2', 'Agent Two', 'member', 'test', 'active');
    INSERT INTO agents (id, squad_id, slug, name, role, model, status) VALUES ('ag3', 'S1', 'ag3', 'Agent Three', 'member', 'test', 'active');
    INSERT INTO members (id, display_name, status, tenant) VALUES ('seat-ag3', 'Agent Three seat', 'active', '${TENANT}');
    INSERT INTO agent_member_bindings (tenant, agent_id, member_id, created_at) VALUES ('${TENANT}', 'ag3', 'seat-ag3', '2026-10-01T00:00:00.000Z');
    INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-ag3-s1', 'ag3', 'S1', 'member');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-ag3-s1', 'seat-ag3', 'squad', 'S1', 'member');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-admin', 'admin@x.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-admin', 'mem-admin', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-other', 'other@x.test', 'Olive Other', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-other', 'mem-other', 'org', NULL, 'admin');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES ('mem-plain', 'plain@x.test', 'Plain Member', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-plain', 'mem-plain', 'squad', 'S1', 'member');
  `)
  admin = await login('admin@x.test', 'mem-admin')
  setReauth('mem-admin', fresh())
  adminAuthn = await enrolPasskey(admin.env, h.sqlite, 'mem-admin')
  adminCtx = await grant(admin.env, 'mem-admin')
})
afterEach(() => h.close())

/** The refusal a session-only (even freshly re-authenticated) caller gets, with the grant it filed. */
async function expectRefused(res: Response): Promise<{ grantId: string; approveUrl: string }> {
  expect(res.status).toBe(403)
  const r = await presenceRefusal(res)
  expect(r, 'the presence refusal (403 + X-Presence-Grant)').not.toBeNull()
  expect(r?.approveUrl, 'a secure-host passkey link').toMatch(/^https:\/\/secure\.example\.test\/m\/presence\/[0-9a-f-]+\/[A-Za-z0-9_-]+$/)
  return { grantId: r?.grantId ?? '', approveUrl: r?.approveUrl ?? '' }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
describe('the floor', () => {
  it('approval.human-presence-required has the same value at every level', () => {
    for (const level of [undefined, 'permissive', 'standard', 'strict', 'anything']) expect(humanPresenceRequired(level)).toBe(true)
  })
})

describe('the gate itself, on "Allow for me" (designation)', () => {
  const allow = (u: User, qs = '', agent = 'ag1') => form(u, `/agents/${agent}/designation`, { action: 'allow' }, qs)
  const designee = (agent = 'ag1'): string | null => one<{ d: string | null }>('SELECT attach_designated_member_id AS d FROM agents WHERE id = ?', agent)?.d ?? null

  it('a real, FRESH web session alone is refused: nothing written, a pending grant filed, a secure-host link given', async () => {
    const res = await allow(admin)
    const { grantId } = await expectRefused(res)
    expect(designee()).toBeNull()
    expect(one<{ status: string; kind: string }>('SELECT status, kind FROM presence_grants WHERE id = ?', grantId)).toEqual({ status: 'pending', kind: 'designation_allow' })
    expect(count('SELECT COUNT(*) AS n FROM agent_audit WHERE agent_id = ?', 'ag1')).toBe(0)
  })

  it('a pending (unsatisfied) grant presented back is refused: opening the link decides nothing', async () => {
    const { grantId } = await expectRefused(await allow(admin))
    const res = await allow(admin, `presence_grant=${grantId}`)
    expect(res.status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('a valid UV assertion bound to this decision satisfies the grant; the route then performs it, once', async () => {
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    const tap = await realTap(admin.env, adminAuthn, approveUrl)
    expect(tap.status, await tap.clone().text()).toBe(200)
    expect(one<{ status: string; satisfied_passkey_id: string | null }>('SELECT status, satisfied_passkey_id FROM presence_grants WHERE id = ?', grantId)?.status).toBe('satisfied')
    const done = await allow(admin, `presence_grant=${grantId}`)
    expect(done.status, await done.clone().text()).toBe(303)
    expect(designee()).toBe('mem-admin')
    // single use: replaying the redemption (another tab, a script) is refused and writes nothing more
    h.sqlite.exec("UPDATE agents SET attach_designated_member_id = NULL WHERE id = 'ag1'")
    const replay = await allow(admin, `presence_grant=${grantId}`)
    expect(replay.status).toBe(403)
    expect(designee()).toBeNull()
    expect(one<{ status: string }>('SELECT status FROM presence_grants WHERE id = ?', grantId)?.status).toBe('consumed')
  })

  it('an assertion WITHOUT user verification is refused and the grant stays pending', async () => {
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    const tap = await realTap(admin.env, adminAuthn, approveUrl, { sign: { uv: false } })
    expect(tap.status).toBe(403)
    expect(((await tap.json()) as { message: string }).message).toContain('user_not_verified')
    expect(one<{ status: string }>('SELECT status FROM presence_grants WHERE id = ?', grantId)?.status).toBe('pending')
    expect((await allow(admin, `presence_grant=${grantId}`)).status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('an assertion without user PRESENCE is refused too', async () => {
    const { approveUrl } = await expectRefused(await allow(admin))
    const tap = await realTap(admin.env, adminAuthn, approveUrl, { sign: { up: false, uv: true } })
    expect(tap.status).toBe(403)
  })

  it('an assertion bound to a DIFFERENT decision is refused: a challenge for grant A cannot satisfy grant B', async () => {
    const a = await expectRefused(await allow(admin, '', 'ag1'))
    const b = await expectRefused(await allow(admin, '', 'ag2'))
    const challengeForA = await challengeFor(admin.env, a.approveUrl)
    const tap = await realTap(admin.env, adminAuthn, b.approveUrl, { challenge: challengeForA })
    expect(tap.status).toBe(403)
    expect(one<{ status: string }>('SELECT status FROM presence_grants WHERE id = ?', b.grantId)?.status).toBe('pending')
    // and A's own grant, satisfied for A, cannot be redeemed for ag2
    expect((await realTap(admin.env, adminAuthn, a.approveUrl)).status).toBe(200)
    const wrong = await allow(admin, `presence_grant=${a.grantId}`, 'ag2')
    expect(wrong.status).toBe(403)
    expect(designee('ag2')).toBeNull()
    expect((await allow(admin, `presence_grant=${a.grantId}`, 'ag1')).status).toBe(303)
  })

  it('same kind, same subject, DIFFERENT parameters: a grant satisfied for one owner cannot be spent on another', async () => {
    const setOwner = (who: string, qs = '') => form(admin, '/agents/ag2/owner', { action: 'set', owner_member_id: who }, qs)
    const owner = (): string | null => one<{ o: string | null }>('SELECT owner_member_id AS o FROM agents WHERE id = ?', 'ag2')?.o ?? null
    const a = await expectRefused(await setOwner('mem-other'))
    expect((await realTap(admin.env, adminAuthn, a.approveUrl)).status).toBe(200)
    const wrong = await setOwner('mem-plain', `presence_grant=${a.grantId}`)
    expect(wrong.status).toBe(403)
    expect(owner()).toBeNull()
    expect((await setOwner('mem-other', `presence_grant=${a.grantId}`)).status).toBe(303)
    expect(owner()).toBe('mem-other')
  })

  it('a REPLAYED assertion (the same signed bytes again) wins nothing', async () => {
    const { approveUrl } = await expectRefused(await allow(admin))
    const first = await realTap(admin.env, adminAuthn, approveUrl)
    expect(first.status).toBe(200)
    // a second grant, same passkey: re-posting the first assertion's bytes at the new link fails its challenge binding
    const second = await expectRefused(await allow(admin, '', 'ag2'))
    const challenge = await challengeFor(admin.env, second.approveUrl)
    const stale = await realTap(admin.env, adminAuthn, second.approveUrl, { challenge, sign: { counter: 1 } }) // counter did not advance past the first tap
    expect(stale.status).toBe(403)
    expect(one<{ status: string }>('SELECT status FROM presence_grants WHERE id = ?', second.grantId)?.status).toBe('pending')
  })

  it('a challenge is single use: signing the same challenge twice satisfies once', async () => {
    const { approveUrl } = await expectRefused(await allow(admin))
    const csrf = await csrfFor(admin.env, approveUrl)
    const challenge = await challengeFor(admin.env, approveUrl)
    expect((await realTap(admin.env, adminAuthn, approveUrl, { challenge, csrf })).status).toBe(200)
    expect((await realTap(admin.env, adminAuthn, approveUrl, { challenge, csrf })).status).toBe(409) // grant no longer pending
  })

  it("another member's passkey cannot satisfy this member's grant", async () => {
    const other = await login('other@x.test', 'mem-other')
    const otherAuthn = await enrolPasskey(other.env, h.sqlite, 'mem-other')
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    const tap = await realTap(admin.env, otherAuthn, approveUrl)
    expect(tap.status).toBe(403)
    expect(one<{ status: string }>('SELECT status FROM presence_grants WHERE id = ?', grantId)?.status).toBe('pending')
  })

  it("a satisfied grant is the MEMBER's: another member's session cannot redeem it", async () => {
    const other = await login('other@x.test', 'mem-other')
    setReauth('mem-other', fresh())
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    expect((await realTap(admin.env, adminAuthn, approveUrl)).status).toBe(200)
    const res = await allow(other, `presence_grant=${grantId}`)
    expect(res.status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('a passkey revoked after the tap makes the satisfied grant worthless', async () => {
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    expect((await realTap(admin.env, adminAuthn, approveUrl)).status).toBe(200)
    h.sqlite.exec("UPDATE member_passkeys SET revoked_at = datetime('now') WHERE member_id = 'mem-admin'")
    expect((await allow(admin, `presence_grant=${grantId}`)).status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('an expired satisfied grant is refused', async () => {
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    expect((await realTap(admin.env, adminAuthn, approveUrl)).status).toBe(200)
    h.sqlite.prepare("UPDATE presence_grants SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(grantId)
    expect((await allow(admin, `presence_grant=${grantId}`)).status).toBe(403)
    expect(designee()).toBeNull()
  })

  it('a member with NO passkey is told to enrol one; no grant is filed and nothing is written', async () => {
    const other = await login('other@x.test', 'mem-other')
    setReauth('mem-other', fresh())
    const res = await allow(other)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('you have none yet')
    expect(count('SELECT COUNT(*) AS n FROM presence_grants WHERE member_id = ?', 'mem-other')).toBe(0)
    expect(designee()).toBeNull()
  })

  it('FAILS CLOSED when secure moments are off: no way to prove presence means no widening, not an open door', async () => {
    extraEnv = { SECURE_MOMENTS: undefined }
    const off = await login('admin@x.test', 'mem-admin')
    setReauth('mem-admin', fresh())
    const res = await allow(off)
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('passkeys are not available')
    expect(designee()).toBeNull()
  })

  it('a flood of unfinished requests is capped', async () => {
    for (let i = 0; i < 20; i++) expect((await allow(admin)).status).toBe(403)
    const res = await allow(admin)
    expect(res.status).toBe(429)
    expect(count("SELECT COUNT(*) AS n FROM presence_grants WHERE status = 'pending'")).toBe(20)
  })

  it('the secure-host link is a bearer for NOTHING by itself: another host, a wrong token, a GET all decide nothing', async () => {
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    const bad = approveUrl.replace(/\/[^/]+$/, '/wrong-token')
    const { momentsApp } = await import('../src/secure-moments/routes')
    expect((await momentsApp.fetch(new Request(bad), admin.env)).status).toBe(404)
    expect((await momentsApp.fetch(new Request(approveUrl), admin.env)).status).toBe(200)
    expect(one<{ status: string }>('SELECT status FROM presence_grants WHERE id = ?', grantId)?.status).toBe('pending')
  })

  it('the return page applies the satisfied decision through the same route (form posts the grant)', async () => {
    const { grantId, approveUrl } = await expectRefused(await allow(admin))
    const early = await dashboardApp.request(`/presence/${grantId}`, { headers: { cookie: admin.cookie } }, admin.env)
    expect(await early.text()).toContain('Waiting for your passkey')
    expect((await realTap(admin.env, adminAuthn, approveUrl)).status).toBe(200)
    const page = await dashboardApp.request(`/presence/${grantId}`, { headers: { cookie: admin.cookie } }, admin.env)
    const body = await page.text()
    expect(body).toContain(`action="/agents/ag1/designation?presence_grant=${grantId}"`)
    expect(body).toContain('name="action" value="allow"')
    // another member's session sees nothing of it
    const other = await login('other@x.test', 'mem-other')
    expect((await dashboardApp.request(`/presence/${grantId}`, { headers: { cookie: other.cookie } }, other.env)).status).toBe(404)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// Every path in the inventory: a session-only (fresh) call is refused with no write, and the same call with a grant satisfied by a
// REAL tap performs it. The table is keyed by PRESENCE_DECISION_KINDS: a kind added without a row here fails the ratchet below.
interface PathCase {
  kind: PresenceDecisionKind
  /** Optional per-case setup, run after the base fixture. */
  setup?: () => Promise<void> | void
  /** The decision as the SESSION user sends it; `qs` is '' or 'presence_grant=<id>'. */
  call: (qs: string) => Promise<Response>
  /** What a successful application returns (status). */
  ok: number | number[]
  /** True once the decision has been applied. */
  applied: () => boolean
  who?: () => User
}
const covered = new Set<PresenceDecisionKind>()
const designated = (): boolean => !!one('SELECT 1 AS x FROM agents WHERE id = ? AND attach_designated_member_id = ?', 'ag1', 'mem-admin')

/** Designate the admin for ag1 through the REAL gate (refusal, tap, apply). */
async function designateAdmin(): Promise<void> {
  const r = await expectRefused(await form(admin, '/agents/ag1/designation', { action: 'allow' }))
  expect((await realTap(admin.env, adminAuthn, r.approveUrl)).status).toBe(200)
  expect((await form(admin, '/agents/ag1/designation', { action: 'allow' }, `presence_grant=${r.grantId}`)).status).toBe(303)
}

async function filePendingAsk(): Promise<{ admissionId: string; code: string; seatId: string }> {
  await designateAdmin()
  const out = await rpc(admin.env, adminCtx, 'seat_attach', { agent: 'ag1' }, 'thread-1')
  expect(out.status, JSON.stringify(out)).toBe('pending_admission')
  const row = one<{ id: string; attach_code: string; requested_seat_id: string }>("SELECT id, attach_code, requested_seat_id FROM agent_seat_admissions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1")
  if (!row) throw new Error('no pending admission')
  return { admissionId: row.id, code: row.attach_code, seatId: row.requested_seat_id }
}

describe('every authority-widening path needs the passkey, and performs once it has it', () => {
  let ask: { admissionId: string; code: string; seatId: string } | null = null
  let cases: PathCase[] = []

  beforeEach(() => {
    ask = null
    cases = [
      {
        kind: 'designation_allow', ok: 303, applied: designated,
        call: (qs) => form(admin, '/agents/ag1/designation', { action: 'allow' }, qs),
      },
      {
        kind: 'agent_owner_set', ok: 303, applied: () => one<{ o: string | null }>('SELECT owner_member_id AS o FROM agents WHERE id = ?', 'ag2')?.o === 'mem-other',
        call: (qs) => form(admin, '/agents/ag2/owner', { action: 'set', owner_member_id: 'mem-other' }, qs),
      },
      {
        kind: 'agent_access_set', ok: 200, applied: () => count("SELECT COUNT(*) AS n FROM memberships WHERE agent_id = 'ag3' AND squad_id = 'S2'") === 1,
        call: (qs) => form(admin, '/agents/ag3/access', { squad_id: 'S2', action: 'set', capability: 'member', expected_capability: 'none', expected_membership: 'none', reason: 'test' }, qs),
      },
      {
        kind: 'squad_agent_join', ok: 200, applied: () => count("SELECT COUNT(*) AS n FROM memberships WHERE agent_id = 'ag3' AND squad_id = 'S2'") === 1,
        call: (qs) => form(admin, '/squads/S2/agents/join', { agent_id: 'ag3', capability: 'member' }, qs),
      },
      {
        kind: 'operator_delegate', ok: 200, applied: () => count("SELECT COUNT(*) AS n FROM agent_operator_delegations WHERE agent_id = 'ag3'") === 1,
        call: (qs) => json(admin, '/operators/delegate', { agent_id: 'ag3', scope_type: 'squad', scope_id: 'S1', max_grant: 'member' }, qs),
      },
      {
        kind: 'member_capability_grant', ok: 201, applied: () => count("SELECT COUNT(*) AS n FROM capabilities WHERE member_id = 'mem-plain' AND scope_type = 'squad' AND scope_id = 'S2'") === 1,
        call: (qs) => json(admin, '/members/mem-plain/capabilities', { action: 'grant', scope_type: 'squad', scope_id: 'S2', capability: 'member' }, qs, membersApp),
      },
      {
        kind: 'elevation_approve', ok: 200, applied: () => one<{ s: string }>("SELECT status AS s FROM elevation_requests LIMIT 1")?.s === 'approved',
        setup: async () => {
          const session = await createAgentSession(admin.env, { tenant: TENANT, agentId: 'ag3', memberId: 'seat-ag3', authKind: 'workspace_token', credentialId: 'tok-ag3' })
          const r = await createElevationRequest(admin.env, {
            tenant: TENANT, agentSessionId: session.id, agentId: 'ag3', memberId: 'seat-ag3',
            actions: ['action:manage_access'], scopeType: 'squad', scopeId: 'S1', durationMinutes: 60, reason: 'need it for the task',
          })
          if (!r.ok) throw new Error(`elevation fixture ${JSON.stringify(r)}`)
          h.sqlite.prepare("UPDATE elevation_requests SET id = 'elev-1' WHERE id = ?").run(r.request.id)
        },
        call: (qs) => json(admin, '/elevation/requests/elev-1/decide', { decision: 'approve', actions: ['action:manage_access'] }, qs, authApp),
      },
      {
        kind: 'task_verdict_approve', ok: 201, applied: () => count("SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 't-rev' AND verdict = 'approved'") === 1,
        setup: () => {
          h.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
            VALUES ('t-rev', 'S1', 'Review me', 'b', 'done', 'review', 'gate:hadi', NULL, NULL, datetime('now'), datetime('now'));
            INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg1', 'gate:hadi', 'member', 'mem-admin', 'test', datetime('now'))`)
        },
        call: (qs) => json(admin, '/t-rev/verdict', { verdict: 'approved', note: 'looks right' }, qs, tasksApp),
      },
      {
        kind: 'agent_token_mint', ok: 200, applied: () => count("SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = 'ag2'") === 1,
        call: (qs) => form(admin, '/admin/agent-token/mint', { agent_id: 'ag2', label: 'laptop', capability: 'member' }, qs),
      },
      {
        kind: 'scoped_key_mint', ok: 200, applied: () => count("SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = 'mem-plain'") === 1,
        call: (qs) => form(admin, '/admin/keys/mint', { preset_id: 'observer', member_id: 'mem-plain', scope_id: 'S1' }, qs),
      },
      {
        kind: 'seat_key_mint', ok: 200, applied: () => count("SELECT COUNT(*) AS n FROM member_tokens WHERE agent_id = 'ag1'") === 1,
        call: (qs) => form(admin, '/enroll/mint', { agent_id: 'ag1', seat: 'cursor-river' }, qs),
      },
      {
        kind: 'member_token_mint', ok: 201, applied: () => count("SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = 'mem-plain'") === 1,
        call: (qs) => json(admin, '/members/mem-plain/tokens', { label: 'ci' }, qs, membersApp),
      },
      {
        kind: 'passkey_enrol', ok: 200, applied: () => count("SELECT COUNT(*) AS n FROM passkey_enrolment_tokens WHERE member_id = 'mem-admin' AND consumed_at IS NULL") >= 1,
        call: (qs) => json(admin, '/account/passkey/enrol', {}, qs),
      },
      {
        kind: 'claim_confirm', ok: 303, applied: () => one<{ s: string }>('SELECT status AS s FROM agent_seat_admissions WHERE id = ?', ask?.admissionId)?.s === 'live',
        setup: async () => { ask = await filePendingAsk() },
        call: (qs) => form(admin, `/claim/${ask?.code}`, { admission_id: ask?.admissionId ?? '', agent_id: 'ag1' }, qs),
      },
      {
        kind: 'claim_own', ok: 303, applied: () => one<{ s: string }>('SELECT status AS s FROM agent_seat_admissions WHERE id = ?', ask?.admissionId)?.s === 'live',
        setup: async () => { ask = await filePendingAsk() },
        call: (qs) => form(admin, '/agents/ag1/claim', { admission_id: ask?.admissionId ?? '' }, qs),
      },
    ]
  })

  const KINDS_WITH_OWN_TESTS: PresenceDecisionKind[] = ['seat_attach', 'seat_release', 'seat_return_from_held']
  /** Kinds whose route needs a different harness (the Cloudflare Access JWT); the test lives in that file and names the kind. */
  const KINDS_TESTED_ELSEWHERE: Partial<Record<PresenceDecisionKind, string>> = {
    access_seed_approve: 'tests/access-approve.test.ts', access_elevation_approve: 'tests/access-approve.test.ts',
  }

  for (const kind of PRESENCE_DECISION_KINDS) {
    if (KINDS_WITH_OWN_TESTS.includes(kind) || kind in KINDS_TESTED_ELSEWHERE) continue
    it(`${kind}: refused on session + fresh sign-in alone, performed after a real UV passkey tap, only once`, async () => {
      const c = cases.find((x) => x.kind === kind)
      if (!c) throw new Error(`no case for ${kind}`)
      covered.add(kind)
      await c.setup?.()
      setReauth('mem-admin', fresh())
      const before = c.applied()
      expect(before).toBe(false)
      const refused = await expectRefused(await c.call(''))
      expect(c.applied(), 'a refused decision wrote something').toBe(false)
      // a fresh re-sign-in changes nothing
      setReauth('mem-admin', fresh())
      await expectRefused(await c.call(''))
      expect(c.applied()).toBe(false)
      // the passkey tap, then the same decision with the grant
      expect((await realTap(admin.env, adminAuthn, refused.approveUrl)).status).toBe(200)
      const done = await c.call(`presence_grant=${refused.grantId}`)
      expect([c.ok].flat(), await done.clone().text()).toContain(done.status)
      expect(c.applied(), `${kind} was not applied after a valid tap`).toBe(true)
      // a second use of the same grant is refused (by the gate, or earlier by the route's own "already done" check)
      const again = await c.call(`presence_grant=${refused.grantId}`)
      expect(again.status).toBeGreaterThanOrEqual(400)
      expect(one<{ status: string }>('SELECT status FROM presence_grants WHERE id = ?', refused.grantId)?.status).toBe('consumed')
    })
  }

  it('seat_attach: refused on session alone; performed after the tap', async () => {
    covered.add('seat_attach')
    await designateAdmin()
    await rpc(admin.env, adminCtx, 'boot_context', {}, 'thread-9')
    const seat = one<{ id: string }>('SELECT id FROM agent_seats WHERE member_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', 'mem-admin')
    if (!seat) throw new Error('no seat')
    const attach = (qs: string) => json(admin, '/connections/attach', { seat_id: seat.id, agent_id: 'ag1', ceiling: 'member' }, qs)
    const refused = await expectRefused(await attach(''))
    expect(count('SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL')).toBe(0)
    expect((await realTap(admin.env, adminAuthn, refused.approveUrl)).status).toBe(200)
    const done = await attach(`presence_grant=${refused.grantId}`)
    expect(done.status, await done.clone().text()).toBe(200)
    expect(count('SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL')).toBe(1)
    expect((await attach(`presence_grant=${refused.grantId}`)).status).toBe(403)
  })

  it('seat_release / seat_return_from_held: widening transitions need the tap; hold and trusted->observed do not', async () => {
    covered.add('seat_release')
    covered.add('seat_return_from_held')
    ask = await filePendingAsk()
    const seat = ask.seatId
    const status = (): string | null => one<{ s: string | null }>('SELECT admission_status AS s FROM agent_seats WHERE id = ?', seat)?.s ?? null
    const move = (action: string, qs = '') => json(admin, `/connections/seats/${seat}/${action}`, {}, qs)
    h.sqlite.prepare("UPDATE agent_seats SET admission_status = 'observed' WHERE id = ?").run(seat)
    // hold REDUCES reach: session-only, even with a stale sign-in
    setReauth('mem-admin', new Date(Date.now() - (RECENT_REAUTH_WINDOW_MS + 60_000)).toISOString())
    expect((await move('hold')).status).toBe(200)
    expect(status()).toBe('held')
    // held -> observed WIDENS
    const back = await expectRefused(await move('return'))
    expect(status()).toBe('held')
    expect((await realTap(admin.env, adminAuthn, back.approveUrl)).status).toBe(200)
    expect((await move('return', `presence_grant=${back.grantId}`)).status).toBe(200)
    expect(status()).toBe('observed')
    // observed -> trusted WIDENS
    const rel = await expectRefused(await move('release'))
    expect(status()).toBe('observed')
    // a grant for "return" cannot be spent on "release"
    expect((await realTap(admin.env, adminAuthn, rel.approveUrl)).status).toBe(200)
    expect((await move('release', `presence_grant=${back.grantId}`)).status).toBe(403)
    expect(status()).toBe('observed')
    expect((await move('release', `presence_grant=${rel.grantId}`)).status).toBe(200)
    expect(status()).toBe('trusted')
    // trusted -> observed REDUCES: session-only
    expect((await move('return')).status).toBe(200)
    expect(status()).toBe('observed')
  })

  it('the admission "Admit" button no longer decides: it hands back the existing passkey page; the session cannot approve', async () => {
    ask = await filePendingAsk()
    const res = await json(admin, `/connections/admissions/${ask.admissionId}/approve`, { ceiling: 'full', attach_code: ask.code })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; approve_url: string }
    expect(body.error).toBe('human_presence_required')
    expect(body.approve_url).toMatch(/^https:\/\/secure\.example\.test\/m\/[0-9a-f-]+\/[A-Za-z0-9_-]+$/)
    expect(one<{ s: string }>('SELECT status AS s FROM agent_seat_admissions WHERE id = ?', ask.admissionId)?.s).toBe('pending')
    expect(count('SELECT COUNT(*) AS n FROM agent_seat_attachments WHERE detached_at IS NULL')).toBe(0)
  })

  it('Deny and the other REDUCING decisions stay session-only (never harder to stop something)', async () => {
    ask = await filePendingAsk()
    setReauth('mem-admin', new Date(Date.now() - (RECENT_REAUTH_WINDOW_MS + 60_000)).toISOString()) // not even fresh
    // deny a pending admission
    expect((await json(admin, `/connections/admissions/${ask.admissionId}/deny`, {})).status).toBe(200)
    expect(one<{ s: string }>('SELECT status AS s FROM agent_seat_admissions WHERE id = ?', ask.admissionId)?.s).toBe('denied')
    // Stop the designation (and clear an owner)
    expect((await form(admin, '/agents/ag1/designation', { action: 'stop' })).status).toBe(303)
    expect(designated()).toBe(false)
    h.sqlite.exec("UPDATE agents SET owner_member_id = 'mem-other' WHERE id = 'ag2'")
    expect((await form(admin, '/agents/ag2/owner', { action: 'clear' })).status).toBe(303)
    expect(one<{ o: string | null }>('SELECT owner_member_id AS o FROM agents WHERE id = ?', 'ag2')?.o).toBeNull()
    // revoke an access row, and LOWER a level (member -> observer): reduce, session-only
    h.sqlite.exec("INSERT INTO memberships (id, agent_id, squad_id, capability) VALUES ('ms-ag3-s2', 'ag3', 'S2', 'member'); INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-ag3-s2', 'seat-ag3', 'squad', 'S2', 'member')")
    const lower = await form(admin, '/agents/ag3/access', { squad_id: 'S2', action: 'set', capability: 'observer', expected_capability: 'member', expected_membership: 'member', reason: '' })
    expect(lower.status, await lower.clone().text()).toBe(200)
    expect(one<{ c: string }>("SELECT capability AS c FROM memberships WHERE agent_id = 'ag3' AND squad_id = 'S2'")?.c).toBe('observer')
    const revoke = await form(admin, '/agents/ag3/access', { squad_id: 'S2', action: 'revoke', expected_capability: 'observer', expected_membership: 'observer', reason: '' })
    expect(revoke.status, await revoke.clone().text()).toBe(200)
    expect(count("SELECT COUNT(*) AS n FROM memberships WHERE agent_id = 'ag3' AND squad_id = 'S2'")).toBe(0)
    // revoke a delegation and an elevation-free account action: no presence filed for any of the above
    expect(count('SELECT COUNT(*) AS n FROM presence_grants')).toBeGreaterThanOrEqual(1) // only the designation done by the fixture
    expect(count("SELECT COUNT(*) AS n FROM presence_grants WHERE kind IN ('agent_access_set', 'agent_owner_set')")).toBe(0)
  })

  it('a task REJECT stays session-only; only the approve needs the passkey', async () => {
    h.sqlite.exec(`INSERT INTO tasks (id, squad_id, title, body, done_when, status, gate_owner, assignee_agent_id, result, created_at, updated_at)
      VALUES ('t-rev2', 'S1', 'Review me', 'b', 'done', 'review', 'gate:hadi', NULL, NULL, datetime('now'), datetime('now'));
      INSERT INTO gate_grants (id, capability, principal_type, principal_id, granted_by, created_at) VALUES ('gg2', 'gate:hadi', 'member', 'mem-admin', 'test', datetime('now'))`)
    const res = await json(admin, '/t-rev2/verdict', { verdict: 'rejected', note: 'not good enough' }, '', tasksApp)
    expect(res.status, await res.clone().text()).toBe(201)
    expect(count("SELECT COUNT(*) AS n FROM task_verdicts WHERE task_id = 't-rev2' AND verdict = 'rejected'")).toBe(1)
    expect(count("SELECT COUNT(*) AS n FROM presence_grants WHERE kind = 'task_verdict_approve'")).toBe(0)
  })

  it('a bearer-style / sessionless caller never reaches the gate with authority (the route refuses first)', async () => {
    const res = await dashboardApp.request('/agents/ag1/designation', {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ action: 'allow' }),
    }, admin.env)
    expect([302, 401, 403]).toContain(res.status)
    expect(count('SELECT COUNT(*) AS n FROM presence_grants')).toBe(0)
  })

  it('RATCHET: every kind in the inventory is exercised by a test in this file', () => {
    // The two seat tests and the per-kind loop above add to `covered`; this runs after them in file order.
    for (const kind of PRESENCE_DECISION_KINDS) {
      const elsewhere = KINDS_TESTED_ELSEWHERE[kind]
      if (elsewhere) expect(readFileSync(join(__dirname, '..', elsewhere), 'utf8'), `${kind} in ${elsewhere}`).toContain(kind)
      else expect(covered.has(kind), `no test for ${kind}`).toBe(true)
    }
  })

  it('RATCHET: every dashboard/api route file that performs a widening write calls the gate', () => {
    const root = join(__dirname, '..', 'src')
    const gated = [
      'dashboard/index.ts', 'dashboard/claim.ts', 'dashboard/connections.ts', 'dashboard/operators.ts', 'dashboard/account.ts',
      'members/index.ts', 'auth/index.ts',
    ]
    for (const f of gated) expect(readFileSync(join(root, f), 'utf8'), f).toMatch(/presenceGate(Json)?\(/)
    // decideAdmissionDirect('approve') is only reachable from the claim routes, which gate it; the connections approve route no longer calls it.
    const approvers = readdirSync(join(root, 'dashboard')).filter((f) => f.endsWith('.ts') && /decideAdmissionDirect\([\s\S]{0,200}'approve'/.test(readFileSync(join(root, 'dashboard', f), 'utf8')))
    expect(approvers).toEqual([])
    expect(readFileSync(join(root, 'members/claim.ts'), 'utf8')).toMatch(/decision: 'approve'/)
    expect(readFileSync(join(root, 'dashboard/claim.ts'), 'utf8')).toMatch(/presenceGate\(/)
  })
})
