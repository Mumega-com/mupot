// mupot#1436 A2 — /auth/login binds the pending-invite cookie into OAuth
// state; /auth/callback is LINK-ONLY against the D1 invite row.
//
// Schema: createSqliteD1 + applyAllMigrations. Google token/userinfo are
// stubbed; every other write is real SQLite D1.
//
// MUTATION LEDGER (break → fail → restore), observed 2026-09-20:
//   1. cookie !== state pending id removed
//      → unit: reason became missing_marker (not state_binding)
//      → HTTP foreign-cookie: 302 instead of 403 (would have linked)
//   2. consume-on-read delete skipped
//      → "consumes the KV marker on first read" expected null, got the blob
//   3. D1 accepted_at / member_id required removed
//      → unaccepted invite + planted marker: action "link" memberId null
//      (instead of refuse d1_mismatch)
//   4. email equality short-circuited
//      → mismatch callback: 302 instead of 403 (wrong IdP would link)
//   5. refuse page email echo
//      → mismatch HTML asserts no email-shaped token; org/squad still named

import { afterEach, describe, expect, it, vi } from 'vitest'
import { authApp } from '../src/auth'
import {
  PENDING_INVITE_COOKIE,
  PENDING_INVITE_KV_PREFIX,
  consumePendingInviteMarker,
  decidePendingInviteLink,
  inviteLoginMismatchBody,
  parsePendingInviteIdFromState,
  pendingInviteEmailsMatch,
} from '../src/auth/pending-invite-link'
import { acceptInvite } from '../src/members'
import { inviteApp } from '../src/dashboard/invite'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const BRAND = 'Test Pot'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('inv-legacy', 'newcomer@example.com', 'dept-a', 'member', 'member-admin');
    INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-squad', 'squaduser@example.com', 'squad-web', 'member', 'member-admin');
  `)
  return harness
}

interface KvStore {
  store: Map<string, string>
  get: (key: string) => Promise<string | null>
  put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>
  delete: (key: string) => Promise<void>
}

function memoryKv(): KvStore {
  const store = new Map<string, string>()
  return {
    store,
    get: async (key) => store.get(key) ?? null,
    put: async (key, value) => {
      store.set(key, value)
    },
    delete: async (key) => {
      store.delete(key)
    },
  }
}

function envFor(harness: SqliteD1Harness, kv: KvStore): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND,
    PUBLIC_ORIGIN: ORIGIN,
    OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    OAUTH_CLIENT_SECRET: 'test-client-secret',
    SESSIONS: kv,
  } as unknown as Env
}

function stubGoogle(email: string, sub = 'google-sub-newcomer') {
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

function postForm(path: string, values: Record<string, string>) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams(values),
  })
}

function pendingIdFromAccept(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = new RegExp(`${PENDING_INVITE_COOKIE}=([^;]+)`).exec(setCookie)
  if (!match) throw new Error('no pending-invite cookie')
  return match[1]
}

async function startLogin(env: Env, pendingId?: string): Promise<string> {
  const res = await authApp.request(
    `${ORIGIN}/login`,
    pendingId ? { headers: { cookie: `${PENDING_INVITE_COOKIE}=${pendingId}` } } : {},
    env,
  )
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location') ?? '')
  const state = location.searchParams.get('state')
  if (!state) throw new Error('login redirect missing state')
  return state
}

function callbackReq(state: string, pendingId?: string) {
  return new Request(`${ORIGIN}/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: pendingId ? { cookie: `${PENDING_INVITE_COOKIE}=${pendingId}` } : {},
  })
}

function identityCount(harness: SqliteD1Harness, memberId?: string): number {
  if (memberId) {
    return (
      harness.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = ?`)
        .get(memberId) as { n: number }
    ).n
  }
  return (harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM human_login_identities`).get() as { n: number }).n
}

describe('decidePendingInviteLink — unit gates (mutation-proved)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('normalizes email the same way idx_members_email_lower does', () => {
    expect(pendingInviteEmailsMatch('Newcomer@Example.com', 'newcomer@example.com')).toBe(true)
    expect(pendingInviteEmailsMatch('a@x.test', 'b@x.test')).toBe(false)
  })

  it('skips when OAuth state did not bind an invite (ordinary login)', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const decision = await decidePendingInviteLink({
      env,
      statePendingId: null,
      cookiePendingId: 'stale-cookie',
      idpEmail: 'newcomer@example.com',
      orgName: BRAND,
    })
    expect(decision).toEqual({ action: 'skip' })
  })

  it('refuses a foreign cookie that does not equal the state-bound id', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const decision = await decidePendingInviteLink({
      env,
      statePendingId: 'state-bound',
      cookiePendingId: 'other-cookie',
      idpEmail: 'newcomer@example.com',
      orgName: BRAND,
    })
    expect(decision).toEqual({
      action: 'refuse',
      reason: 'state_binding',
      orgName: BRAND,
      squadName: null,
    })
    expect(kv.store.size).toBe(0)
  })

  it('P1-A: member_id stamp with null accepted_at is d1_mismatch (rollback residue)', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    harness.sqlite.exec(`
      UPDATE invites SET member_id = 'member-admin', accepted_at = NULL
       WHERE id = 'inv-legacy'
    `)
    kv.store.set(
      `${PENDING_INVITE_KV_PREFIX}pending-rollback-residue`,
      JSON.stringify({
        invite_id: 'inv-legacy',
        member_id: 'member-admin',
        issued_at: new Date().toISOString(),
      }),
    )
    const decision = await decidePendingInviteLink({
      env,
      statePendingId: 'pending-rollback-residue',
      cookiePendingId: 'pending-rollback-residue',
      idpEmail: 'newcomer@example.com',
      orgName: BRAND,
    })
    expect(decision).toEqual({
      action: 'refuse',
      reason: 'd1_mismatch',
      orgName: BRAND,
      squadName: null,
    })
  })

  it('refuses when D1 invite is not accepted or has no member stamp', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    kv.store.set(
      `${PENDING_INVITE_KV_PREFIX}pending-unaccepted`,
      JSON.stringify({
        invite_id: 'inv-legacy',
        member_id: 'member-admin',
        issued_at: new Date().toISOString(),
      }),
    )
    const decision = await decidePendingInviteLink({
      env,
      statePendingId: 'pending-unaccepted',
      cookiePendingId: 'pending-unaccepted',
      idpEmail: 'newcomer@example.com',
      orgName: BRAND,
    })
    expect(decision).toEqual({
      action: 'refuse',
      reason: 'd1_mismatch',
      orgName: BRAND,
      squadName: null,
    })
  })

  it('consumes the KV marker on first read — second read is empty', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    kv.store.set(
      `${PENDING_INVITE_KV_PREFIX}once`,
      JSON.stringify({
        invite_id: 'inv-legacy',
        member_id: 'member-admin',
        issued_at: new Date().toISOString(),
      }),
    )
    const first = await consumePendingInviteMarker(env, 'once')
    expect(first?.invite_id).toBe('inv-legacy')
    const second = await consumePendingInviteMarker(env, 'once')
    expect(second).toBeNull()
  })

  it('refuses a missing marker and does not email-bridge', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const decision = await decidePendingInviteLink({
      env,
      statePendingId: 'gone',
      cookiePendingId: 'gone',
      idpEmail: 'newcomer@example.com',
      orgName: BRAND,
    })
    expect(decision).toEqual({
      action: 'refuse',
      reason: 'missing_marker',
      orgName: BRAND,
      squadName: null,
    })
  })

  it('WARN-E: parsePendingInviteIdFromState excludes reauth and the literal 1 bind', () => {
    expect(parsePendingInviteIdFromState('1')).toBeNull()
    expect(parsePendingInviteIdFromState(JSON.stringify({ reauth: true }))).toBeNull()
    expect(
      parsePendingInviteIdFromState(JSON.stringify({ reauth: true, pending_invite: 'inv-x' })),
    ).toBeNull()
    expect(parsePendingInviteIdFromState(JSON.stringify({ pending_invite: 'inv-x' }))).toBe('inv-x')
    expect(parsePendingInviteIdFromState('not-json')).toBeNull()
  })

  it('refuse HTML names org/squad only — no email echo', () => {
    const html = inviteLoginMismatchBody(BRAND, { orgName: BRAND, squadName: 'Web Squad' })
    expect(html).toContain(BRAND)
    expect(html).toContain('Web Squad')
    expect(html).not.toMatch(/[^\s<>"]+@[^\s<>"]+/)
    expect(html).not.toContain('newcomer')
    expect(html).toMatch(/different account/i)
  })
})

describe('GET /auth/callback — pending-invite link (A2)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
    vi.unstubAllGlobals()
  })

  it('links the D1-accepted member on an unambiguous matching login', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const accept = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)
    expect(accept.status).toBe(302)
    const pendingId = pendingIdFromAccept(accept)
    const member = harness.sqlite
      .prepare(`SELECT id, member_id FROM invites WHERE id = 'inv-legacy'`)
      .get() as { id: string; member_id: string }
    expect(member.member_id).toBeTruthy()

    stubGoogle('Newcomer@Example.com', 'google-sub-nancy')
    const state = await startLogin(env, pendingId)
    const res = await authApp.fetch(callbackReq(state, pendingId), env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')

    expect(identityCount(harness, member.member_id)).toBe(1)
    const row = harness.sqlite
      .prepare(
        `SELECT provider, provider_subject, member_id FROM human_login_identities WHERE member_id = ?`,
      )
      .get(member.member_id) as { provider: string; provider_subject: string; member_id: string }
    expect(row).toEqual({
      provider: 'google',
      provider_subject: 'google-sub-nancy',
      member_id: member.member_id,
    })
    expect(kv.store.get(`${PENDING_INVITE_KV_PREFIX}${pendingId}`)).toBeUndefined()
  })

  it('refuses an email mismatch, keeps the invite consumed, links nothing, leaks no email', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const accept = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)
    const pendingId = pendingIdFromAccept(accept)
    const invite = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-legacy'`)
      .get() as { accepted_at: string; member_id: string }
    expect(invite.accepted_at).not.toBeNull()

    stubGoogle('other@example.com', 'google-sub-other')
    const state = await startLogin(env, pendingId)
    const res = await authApp.fetch(callbackReq(state, pendingId), env)
    expect(res.status).toBe(403)
    const html = await res.text()
    expect(html).toMatch(/different account/i)
    expect(html).toContain(BRAND)
    expect(html).not.toContain('newcomer@example.com')
    expect(html).not.toContain('other@example.com')
    expect(identityCount(harness)).toBe(0)
    const after = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-legacy'`)
      .get() as { accepted_at: string; member_id: string }
    expect(after.accepted_at).toBe(invite.accepted_at)
    expect(after.member_id).toBe(invite.member_id)
  })

  it('WARN-F: refuse clears the pending-invite cookie', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const accept = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)
    const pendingId = pendingIdFromAccept(accept)
    stubGoogle('other@example.com', 'google-sub-other')
    const state = await startLogin(env, pendingId)
    const res = await authApp.fetch(callbackReq(state, pendingId), env)
    expect(res.status).toBe(403)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${PENDING_INVITE_COOKIE}=`)
    expect(setCookie).toMatch(/Max-Age=0|max-age=0|Expires=/i)
  })

  it('replayed state links nothing (state already consumed)', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const accept = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)
    const pendingId = pendingIdFromAccept(accept)
    stubGoogle('newcomer@example.com', 'google-sub-nancy')
    const state = await startLogin(env, pendingId)
    const first = await authApp.fetch(callbackReq(state, pendingId), env)
    expect(first.status).toBe(302)

    const replay = await authApp.fetch(callbackReq(state, pendingId), env)
    expect(replay.status).toBe(400)
    await expect(replay.json()).resolves.toEqual({ error: 'invalid_state' })
    const member = harness.sqlite
      .prepare(`SELECT member_id FROM invites WHERE id = 'inv-legacy'`)
      .get() as { member_id: string }
    expect(identityCount(harness, member.member_id)).toBe(1)
  })

  it('foreign cookie on a state-bound login links nothing and does not consume the real marker', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const accept = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)
    const pendingId = pendingIdFromAccept(accept)
    stubGoogle('newcomer@example.com', 'google-sub-nancy')
    const state = await startLogin(env, pendingId)

    const res = await authApp.fetch(callbackReq(state, 'foreign-pending-id'), env)
    expect(res.status).toBe(403)
    expect(identityCount(harness)).toBe(0)
    expect(kv.store.get(`${PENDING_INVITE_KV_PREFIX}${pendingId}`)).toBeDefined()
  })

  it('missing marker (cookie+state bound, KV gone) refuses and does not email-bridge', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const accept = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)
    const pendingId = pendingIdFromAccept(accept)
    stubGoogle('newcomer@example.com', 'google-sub-nancy')
    const state = await startLogin(env, pendingId)
    kv.store.delete(`${PENDING_INVITE_KV_PREFIX}${pendingId}`)

    const res = await authApp.fetch(callbackReq(state, pendingId), env)
    expect(res.status).toBe(403)
    expect(identityCount(harness)).toBe(0)
    const invite = harness.sqlite
      .prepare(`SELECT accepted_at FROM invites WHERE id = 'inv-legacy'`)
      .get() as { accepted_at: string | null }
    expect(invite.accepted_at).not.toBeNull()
  })

  it('does not trust KV member_id — D1 invite.member_id is the link target', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)

    const accept = await inviteApp.fetch(postForm('/inv-legacy', { display_name: 'Newcomer Nancy' }), env)
    const pendingId = pendingIdFromAccept(accept)
    const key = `${PENDING_INVITE_KV_PREFIX}${pendingId}`
    const planted = JSON.parse(kv.store.get(key)!) as {
      invite_id: string
      member_id: string
      issued_at: string
    }
    kv.store.set(
      key,
      JSON.stringify({ ...planted, member_id: 'member-admin' }),
    )

    stubGoogle('newcomer@example.com', 'google-sub-nancy')
    const state = await startLogin(env, pendingId)
    const res = await authApp.fetch(callbackReq(state, pendingId), env)
    expect(res.status).toBe(302)

    expect(identityCount(harness, 'member-admin')).toBe(0)
    const accepted = harness.sqlite
      .prepare(`SELECT member_id FROM invites WHERE id = 'inv-legacy'`)
      .get() as { member_id: string }
    expect(identityCount(harness, accepted.member_id)).toBe(1)
    expect(accepted.member_id).not.toBe('member-admin')
  })

  it('idempotent linkLoginIdentity: same member + same subject does not refuse', async () => {
    harness = makeHarness()
    const kv = memoryKv()
    const env = envFor(harness, kv)
    const accepted = await acceptInvite(env, 'inv-legacy', 'Newcomer Nancy', { mintToken: false })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) throw new Error('unreachable')

    await consumePendingInviteMarker(env, 'unused')
    const linked = await decidePendingInviteLink({
      env,
      statePendingId: null,
      cookiePendingId: undefined,
      idpEmail: accepted.value.email,
      orgName: BRAND,
    })
    expect(linked.action).toBe('skip')

    const { linkLoginIdentity } = await import('../src/auth/login-identity')
    const first = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'google-sub-nancy',
      verifiedEmail: accepted.value.email,
      memberId: accepted.value.member_id,
    })
    expect(first.ok).toBe(true)
    const second = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'google-sub-nancy',
      verifiedEmail: accepted.value.email,
      memberId: accepted.value.member_id,
    })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.created).toBe(false)
  })
})
