// Binding tests for two claims on 6c8d5795 that had no test (Kasra mutation
// pass, 2026-09-02, PR #1266): each survived a mutation that removed the code.
//
// A. Step 2 provider scoping (P1-3). With provider present and no subject, the
//    verified_email match must be scoped to THAT provider. An identity linked
//    under 'google' must not be reachable by presenting the same email under
//    'saml' (0143 header: two providers reporting one email is not one authority).
// B. autoEnrollSsoMember pre-lookup. When the resolver misses but a members row
//    with that email exists (reachable today: status != 'active', which step 3
//    filters out), enroll must report the existing member's state instead of
//    INSERTing a colliding row and throwing UNIQUE(members.email).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { resolveHumanMemberId } from '../src/members/resolve-human-member'
import { findOrCreateHumanMember } from '../src/members/human-identity'
import { autoEnrollSsoMember } from '../src/auth/sso'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

describe('identity: step-2 provider scoping + SSO enroll never INSERTs a colliding email', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: vi.fn().mockResolvedValue(undefined) },
    } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-a', ?1, 'a@mumega.test', 'A', 'active', datetime('now')),
              ('mem-suspended', ?1, 'gone@mumega.test', 'Gone', 'suspended', datetime('now'))`,
    ).bind(TENANT).run()
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-a',
      verifiedEmail: 'a@corp.test',
      memberId: 'mem-a',
    })
    expect(linked.ok).toBe(true)
  })

  afterEach(() => harness.close())

  it('A: same email under a different provider (no subject) does not reach the google-linked member', async () => {
    const viaGoogle = await resolveHumanMemberId(env, { tenant: TENANT, provider: 'google', email: 'a@corp.test' })
    expect(viaGoogle).toBe('mem-a')
    const viaSaml = await resolveHumanMemberId(env, { tenant: TENANT, provider: 'saml', email: 'a@corp.test' })
    expect(viaSaml).not.toBe('mem-a')
  })

  it('A2: verified_email fallback does not resolve a suspended identity owner', async () => {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-suspended-ident', ?1, 'suspended-ident@mumega.test', 'Suspended Ident', 'suspended', datetime('now'))`,
    ).bind(TENANT).run()
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-suspended',
      verifiedEmail: 'suspended-ident@corp.test',
      memberId: 'mem-suspended-ident',
    })
    expect(linked.ok).toBe(true)

    const direct = await resolveHumanMemberId(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-suspended',
      email: 'suspended-ident@corp.test',
    })
    const byVerifiedEmail = await resolveHumanMemberId(env, { tenant: TENANT, email: 'suspended-ident@corp.test' })

    expect(direct).toBeNull()
    expect(byVerifiedEmail).toBeNull()
  })

  it('B: SSO enroll for a suspended member reports member_suspended, never UNIQUE 500', async () => {
    let result: Awaited<ReturnType<typeof autoEnrollSsoMember>> | undefined
    let err: unknown
    try {
      result = await autoEnrollSsoMember(env, { email: 'gone@mumega.test', provider: 'google' })
    } catch (e) {
      err = e
    }
    expect(err).toBeUndefined()
    expect(result?.ok).toBe(false)
    expect(result?.error).toBe('member_suspended')
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM members WHERE lower(email) = 'gone@mumega.test'`).first<{ n: number }>()
    expect(n?.n).toBe(1)
  })

  it('B2: OAuth find-or-create returns an existing suspended identity owner', async () => {
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-gone',
      verifiedEmail: 'gone@mumega.test',
      memberId: 'mem-suspended',
    })
    expect(linked.ok).toBe(true)

    await expect(findOrCreateHumanMember(
      env,
      'gone@mumega.test',
      'Gone',
      { provider: 'google', subject: 'sub-gone' },
    )).resolves.toBe('mem-suspended')
    const n = await env.DB.prepare(
      `SELECT count(*) AS n FROM members WHERE lower(email) = 'gone@mumega.test'`,
    ).first<{ n: number }>()
    expect(n?.n).toBe(1)
  })
})

// C. registerWebSession refreshes verified_email on a step-1 hit (P0-2 fix).
//    Survived mutation on 6c8d5795: inverting the refresh condition left the
//    suite green. Drive the real /dev-login → registerWebSession chain with a
//    pre-linked identity whose verified_email is stale.
import { authApp } from '../src/auth'

describe('identity: step-1 hit refreshes stale verified_email', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  afterEach(() => harness.close())

  it('C: same subject logging in with a new IdP email updates human_login_identities.verified_email', async () => {
    const store = new Map<string, string>()
    const env = {
      TENANT_SLUG: TENANT,
      LOCAL_TEST_AUTH: '1',
      LOCAL_TEST_AUTH_EMAIL: 'hadi@digid.ca',
      DB: harness.db,
      SESSIONS: {
        get: async (k: string) => store.get(k) ?? null,
        put: async (k: string, v: string) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
      },
    } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-hadi', ?1, 'owner@mumega.test', 'Hadi', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    // dev-login's subject IS the email string; link that subject with a STALE verified_email.
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'local-test',
      providerSubject: 'hadi@digid.ca',
      verifiedEmail: 'old-alias@corp.test',
      memberId: 'mem-hadi',
    })
    expect(linked.ok).toBe(true)

    const res = await authApp.request('/dev-login', {}, env)
    expect(res.status).toBe(302)

    const row = await env.DB.prepare(
      `SELECT verified_email, member_id FROM human_login_identities
        WHERE tenant = ?1 AND provider = 'local-test' AND provider_subject = 'hadi@digid.ca' AND revoked_at IS NULL`,
    ).bind(TENANT).first<{ verified_email: string; member_id: string }>()
    expect(row?.member_id).toBe('mem-hadi')
    expect(row?.verified_email?.toLowerCase()).toBe('hadi@digid.ca')
  })
})
