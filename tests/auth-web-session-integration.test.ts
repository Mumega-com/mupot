// tests/auth-web-session-integration.test.ts — Delivery Sequence step 1,
// exercised through the REAL src/auth route handlers (not a standalone
// wrapper around the D1 functions — see tests/web-sessions.test.ts for those
// unit-level cases). Real migration chain (createSqliteD1 + applyAllMigrations).
//
// RED/GREEN: every assertion here is RED against the pre-this-branch code —
// GET/POST /auth/sessions* did not exist at all, logout never touched a D1
// row (there was no D1 session table), and idle/absolute expiry had no
// enforcement path independent of KV's flat 7-day TTL. GREEN is this file
// passing on this branch's code.
//
// Uses GET /auth/dev-login (LOCAL_TEST_AUTH=1) as the login door — it mints a
// real session through the exact same mintSession/registerWebSession code
// path /callback and /handoff use, without needing to mock Google's network
// calls.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { linkLoginIdentity } from '../src/auth/login-identity'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

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

describe('web-session registry — integration through authApp (real D1)', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })

  afterEach(() => harness.close())

  async function seedMember(env: Env, id: string, email: string) {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES (?1, ?2, ?3, ?3, 'active', datetime('now'))`,
    )
      .bind(id, TENANT, email)
      .run()
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

  async function me(env: Env, cookie: string) {
    const res = await authApp.request('/me', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null }
  }

  async function sessions(env: Env, cookie: string) {
    const res = await authApp.request('/sessions', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    return { status: res.status, body: (await res.json()) as { sessions: Record<string, unknown>[] } }
  }

  it('an existing login-identity binding wins over email match — #1162 dual member', async () => {
    // Login email matches mem-login (no standing admin). The owner member is
    // mem-hadi with a different email. An explicit prior link of the IdP
    // subject to mem-hadi must win; email-string match must not steal it.
    const env = makeEnv('hadi@digid.ca')
    env.DB = harness.db
    await seedMember(env, 'mem-hadi', 'owner@mumega.test')
    await seedMember(env, 'mem-login', 'hadi@digid.ca')
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'local-test',
      providerSubject: 'hadi@digid.ca',
      verifiedEmail: 'hadi@digid.ca',
      memberId: 'mem-hadi',
    })
    expect(linked.ok).toBe(true)

    const cookie = await devLogin(env)
    const row = await env.DB.prepare(
      `SELECT ws.member_id AS member_id
         FROM web_sessions ws
         JOIN human_login_identities hli ON hli.id = ws.login_identity_id
        WHERE hli.provider = 'local-test' AND hli.provider_subject = 'hadi@digid.ca'
          AND ws.revoked_at IS NULL
        LIMIT 1`,
    ).first<{ member_id: string }>()
    expect(row?.member_id).toBe('mem-hadi')

    const { body } = await sessions(env, cookie)
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]?.is_current).toBe(true)
  })

  it('a login that resolves to a members row is registered — GET /auth/sessions lists it, marked is_current', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')

    const cookie = await devLogin(env)
    const { body: profile } = await me(env, cookie)
    // webSessionIdHash/webSessionMemberId are set by registerWebSession's
    // email match REGARDLESS of legacy role (dev-login's first-ever call
    // mints role='owner', which the SEPARATE capability-bridge deliberately
    // never populates auth.memberId for — see the invariant comment on
    // GET /auth/sessions). profile.memberId is intentionally NOT asserted
    // here; that field belongs to the pre-existing, untouched RBAC bridge.
    expect(typeof profile?.webSessionIdHash).toBe('string')
    expect(profile?.webSessionMemberId).toBe('m1')

    const { status, body } = await sessions(env, cookie)
    expect(status).toBe(200)
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toMatchObject({ is_current: true, live: true })
  })

  it('a login with NO matching members row is NOT registered — no D1 row, empty session list, old behaviour unchanged', async () => {
    const env = makeEnv('nobody@x.test')
    env.DB = harness.db
    // Deliberately no seedMember call.

    const cookie = await devLogin(env)
    const { body: profile } = await me(env, cookie)
    expect(profile?.webSessionIdHash).toBeUndefined()
    expect(profile?.memberId).toBeUndefined()

    const countRow = await harness.db.prepare('SELECT COUNT(*) AS n FROM web_sessions').first<{ n: number }>()
    expect(countRow?.n).toBe(0)

    // Still a working session under the OLD (KV-only) behaviour.
    expect((await me(env, cookie)).status).toBe(200)
  })

  it('revoking one\'s OWN session via POST /auth/sessions/:id/revoke ends it immediately', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie = await devLogin(env)
    const { body: profile } = await me(env, cookie)
    const id = profile?.webSessionIdHash as string

    const revokeRes = await authApp.request(
      `/sessions/${id}/revoke`,
      { method: 'POST', headers: { cookie: `mupot_session=${cookie}` } },
      env,
    )
    expect(revokeRes.status).toBe(200)
    await expect(revokeRes.json()).resolves.toEqual({ revoked: true })

    expect((await me(env, cookie)).status).toBe(401)
  })

  it('a member can NEVER revoke a DIFFERENT member\'s session by naming its id', async () => {
    const envA = makeEnv('a@x.test')
    envA.DB = harness.db
    await seedMember(envA, 'm-a', 'a@x.test')
    const cookieA = await devLogin(envA)
    const { body: profileA } = await me(envA, cookieA)
    const idA = profileA?.webSessionIdHash as string

    const envB = makeEnv('b@x.test')
    envB.DB = harness.db
    envB.SESSIONS = kv() // b logs in through a separate browser/cookie jar
    await seedMember(envB, 'm-b', 'b@x.test')
    const cookieB = await devLogin(envB)

    // B attempts to revoke A's session by id, using B's own authenticated cookie.
    const attempt = await authApp.request(
      `/sessions/${idA}/revoke`,
      { method: 'POST', headers: { cookie: `mupot_session=${cookieB}` } },
      envB,
    )
    expect(attempt.status).toBe(200)
    await expect(attempt.json()).resolves.toEqual({ revoked: false })

    // A's session is untouched.
    expect((await me(envA, cookieA)).status).toBe(200)
  })

  it('POST /auth/sessions/revoke-all keeps the CURRENT session alive by default ("sign out other devices")', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie1 = await devLogin(env) // "current" session for this test
    const cookie2 = await devLogin(env) // sibling session, same member

    const res = await authApp.request(
      '/sessions/revoke-all',
      { method: 'POST', headers: { cookie: `mupot_session=${cookie1}` } },
      env,
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ revoked_count: 1 })

    expect((await me(env, cookie1)).status).toBe(200) // survives
    expect((await me(env, cookie2)).status).toBe(401) // killed
  })

  it('POST /auth/sessions/revoke-all?include_current=1 kills every session including the caller\'s own', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie1 = await devLogin(env)
    const cookie2 = await devLogin(env)

    const res = await authApp.request(
      '/sessions/revoke-all?include_current=1',
      { method: 'POST', headers: { cookie: `mupot_session=${cookie1}` } },
      env,
    )
    await expect(res.json()).resolves.toEqual({ revoked_count: 2 })
    expect((await me(env, cookie1)).status).toBe(401)
    expect((await me(env, cookie2)).status).toBe(401)
  })

  it('a FRESH local-test subject reporting a colliding verified_email does not persist a binding to the victim', async () => {
    // Full chain: registerWebSession → resolveHumanMemberId (step 2 was the
    // P0) → linkLoginIdentity. Dev-login uses provider local-test and
    // subject = email, so this is the handoff-shaped join key.
    const env = makeEnv('victim@corp.test')
    env.DB = harness.db
    await seedMember(env, 'mem-victim', 'owner@mumega.test')
    await seedMember(env, 'mem-fresh', 'fresh@mumega.test')
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-victim',
      verifiedEmail: 'victim@corp.test',
      memberId: 'mem-victim',
    })
    expect(linked.ok).toBe(true)

    const cookie = await devLogin(env)
    const stolen = await env.DB.prepare(
      `SELECT member_id FROM human_login_identities
        WHERE tenant = ?1 AND provider = 'local-test' AND provider_subject = 'victim@corp.test'`,
    )
      .bind(TENANT)
      .first<{ member_id: string }>()
    expect(stolen).toBeNull()

    const { body: profile } = await me(env, cookie)
    expect(profile?.webSessionMemberId).not.toBe('mem-victim')
  })

  it('GET /auth/identities lists the caller\'s identities; POST revoke writes revoked_at and kills bound sessions', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie = await devLogin(env)
    expect((await me(env, cookie)).status).toBe(200)

    const listRes = await authApp.request('/identities', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(listRes.status).toBe(200)
    const listed = (await listRes.json()) as { identities: Array<{ id: string; live: boolean; provider: string }> }
    expect(listed.identities).toHaveLength(1)
    expect(listed.identities[0]?.live).toBe(true)
    expect(listed.identities[0]?.provider).toBe('local-test')
    const identityId = listed.identities[0]!.id

    const revokeRes = await authApp.request(
      `/identities/${identityId}/revoke`,
      { method: 'POST', headers: { cookie: `mupot_session=${cookie}` } },
      env,
    )
    expect(revokeRes.status).toBe(200)
    await expect(revokeRes.json()).resolves.toEqual({ revoked: true, sessions_revoked: 1 })

    const row = await harness.db.prepare(
      'SELECT revoked_at FROM human_login_identities WHERE id = ?1',
    )
      .bind(identityId)
      .first<{ revoked_at: string | null }>()
    expect(row?.revoked_at).not.toBeNull()
    expect((await me(env, cookie)).status).toBe(401)
  })

  it('a member can NEVER revoke a DIFFERENT member\'s identity by naming its id', async () => {
    const envA = makeEnv('a@x.test')
    envA.DB = harness.db
    await seedMember(envA, 'm-a', 'a@x.test')
    const cookieA = await devLogin(envA)
    const listA = await authApp.request('/identities', { headers: { cookie: `mupot_session=${cookieA}` } }, envA)
    const bodyA = (await listA.json()) as { identities: Array<{ id: string }> }
    const idA = bodyA.identities[0]!.id

    const envB = makeEnv('b@x.test')
    envB.DB = harness.db
    envB.SESSIONS = kv()
    await seedMember(envB, 'm-b', 'b@x.test')
    const cookieB = await devLogin(envB)

    const attempt = await authApp.request(
      `/identities/${idA}/revoke`,
      { method: 'POST', headers: { cookie: `mupot_session=${cookieB}` } },
      envB,
    )
    expect(attempt.status).toBe(200)
    await expect(attempt.json()).resolves.toEqual({ revoked: false, sessions_revoked: 0 })
    expect((await me(envA, cookieA)).status).toBe(200)
  })

  it('logout revokes the D1 web_sessions row, not just the KV blob', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie = await devLogin(env)
    const { body: profile } = await me(env, cookie)
    const idHash = profile?.webSessionIdHash as string

    await authApp.request('/logout', { headers: { cookie: `mupot_session=${cookie}` } }, env)

    const row = await harness.db.prepare('SELECT revoked_at, revoke_reason FROM web_sessions WHERE id_hash = ?1')
      .bind(idHash)
      .first<{ revoked_at: string | null; revoke_reason: string | null }>()
    expect(row?.revoked_at).not.toBeNull()
    expect(row?.revoke_reason).toBe('logout')
  })

  it('idle expiry (backdated in D1) fails closed on the next request even though the KV blob is still within its 7-day TTL', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie = await devLogin(env)
    const { body: profile } = await me(env, cookie)
    const idHash = profile?.webSessionIdHash as string

    // Simulate 24h+ of inactivity by backdating idle_expires_at — the KV
    // record's own 7-day TTL has not remotely elapsed.
    await harness.db.prepare(
      `UPDATE web_sessions SET idle_expires_at = datetime('now', '-1 minutes') WHERE id_hash = ?1`,
    )
      .bind(idHash)
      .run()

    expect((await me(env, cookie)).status).toBe(401)
  })

  it('absolute expiry (backdated in D1) fails closed regardless of idle freshness', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie = await devLogin(env)
    const { body: profile } = await me(env, cookie)
    const idHash = profile?.webSessionIdHash as string

    await harness.db.prepare(
      `UPDATE web_sessions
          SET absolute_expires_at = datetime('now', '-1 minutes'),
              idle_expires_at = datetime('now', '+1 day')
        WHERE id_hash = ?1`,
    )
      .bind(idHash)
      .run()

    expect((await me(env, cookie)).status).toBe(401)
  })

  it('a session killed by D1 expiry also clears the stale KV record (no repeated 500s / re-derivation)', async () => {
    const env = makeEnv('owner@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'owner@x.test')
    const cookie = await devLogin(env)
    const { body: profile } = await me(env, cookie)
    const idHash = profile?.webSessionIdHash as string
    await harness.db.prepare(
      `UPDATE web_sessions SET revoked_at = datetime('now'), revoke_reason = 'test' WHERE id_hash = ?1`,
    )
      .bind(idHash)
      .run()

    expect((await me(env, cookie)).status).toBe(401)
    // The SESSIONS KV record for this cookie is gone too.
    const kvRaw = await env.SESSIONS.get(`sess:${cookie}`)
    expect(kvRaw).toBeNull()
  })

  it('a missing/not-yet-applied web_sessions table degrades to legacy behaviour instead of 500ing every request', async () => {
    // This is the deployment-boundary case named in the task brief: migrations
    // 0139/0140 ship on this branch but are NOT applied here. A pot mid-way
    // through that window must not 500 on every dashboard request.
    const bareHarness = createSqliteD1()
    // Apply everything EXCEPT this feature's own two migrations, by only
    // running the ones that predate them — still the real chain, just
    // truncated at the exact boundary this scenario needs.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const dir = path.join(process.cwd(), 'migrations')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
    for (const file of files) {
      if (file.startsWith('0143_') || file.startsWith('0144_')) continue
      bareHarness.sqlite.exec(fs.readFileSync(path.join(dir, file), 'utf8'))
    }
    const env = makeEnv('owner@x.test')
    env.DB = bareHarness.db
    await seedMember(env, 'm1', 'owner@x.test')

    const cookie = await devLogin(env)
    const { status, body } = await me(env, cookie)
    expect(status).toBe(200)
    // No web session registry entry — the table doesn't exist yet.
    expect(body?.webSessionIdHash).toBeUndefined()
    expect(body?.webSessionMemberId).toBeUndefined()
    bareHarness.close()
  })

  it('a KV-only session is rejected after its member is suspended', async () => {
    const env = makeEnv('member@x.test')
    env.DB = harness.db
    await seedMember(env, 'm1', 'member@x.test')
    const cookie = await devLogin(env)
    const key = `sess:${cookie}`
    const raw = await env.SESSIONS.get(key)
    expect(raw).not.toBeNull()
    const record = JSON.parse(raw!) as Record<string, unknown>
    delete record.webSessionRegistered
    await env.SESSIONS.put(key, JSON.stringify(record))
    await env.DB.prepare('DELETE FROM web_sessions WHERE tenant = ?1 AND member_id = ?2')
      .bind(TENANT, 'm1')
      .run()
    await env.DB.prepare("UPDATE members SET status = 'suspended' WHERE id = ?1")
      .bind('m1')
      .run()

    expect((await me(env, cookie)).status).toBe(401)
    await expect(env.SESSIONS.get(key)).resolves.toBeNull()
  })
})
