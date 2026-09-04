// Adversarial regression for the two P0s found on 587eb2ae (Kasra adversarial
// arm + Kasra-core independent confirmation, 2026-09-02, PR #1266).
//
// Written against the VULNERABLE head before any fix. All three cases are RED
// here and must be GREEN after. Cherry-pick this commit before the patch so the
// assertions are not shaped by the fix.
//
// P0-1  Step 4 (owner_login_emails → unique org owner) has neither the step-2
//       join-key gate nor the step-3 live-identity gate. A never-seen
//       provider_subject presenting an owner alias email resolves to the owner,
//       and registerWebSession then persists that binding. Same takeover shape
//       the step-2/step-3 fixes closed, one rung higher.
// P0-2  verified_email is write-once. When a member's live identity carries a
//       verified_email that differs from members.email (alias login, or an
//       ordinary IdP email change), the member's PRIMARY email resolves to null:
//       step 2 misses, step 3 is refused by NOT EXISTS, step 4 misses. On base
//       that lookup could not return null while a members row existed. The null
//       is a provision signal to autoEnrollSsoMember, which INSERTs a duplicate
//       members.email and throws UNIQUE — uncaught, a 500 on /api/auth/sso/enroll.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { resolveHumanMemberId } from '../src/members/resolve-human-member'
import { autoEnrollSsoMember } from '../src/auth/sso'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

describe('identity owner-alias + write-once verified_email regression (P0, 587eb2ae)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      SESSIONS: { get: async () => null, put: async () => {}, delete: async () => {} },
    } as unknown as Env
    // mem-owner: unique org owner, members.email is the PRIMARY address, and a
    // live identity whose verified_email is a DIFFERENT address.
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-owner', ?1, 'owner@mumega.test', 'Owner', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    await env.DB.prepare(
      `INSERT INTO capabilities (member_id, scope_type, scope_id, capability)
       VALUES ('mem-owner', 'org', NULL, 'owner')`,
    ).run()
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-owner-real',
      verifiedEmail: 'owner@corp.test',
      memberId: 'mem-owner',
    })
    expect(linked.ok).toBe(true)
  })

  afterEach(() => harness.close())

  it('P0-1: a FRESH provider_subject presenting an owner_login_emails alias must not acquire the owner', async () => {
    await env.DB.prepare(`INSERT INTO org_settings (key, value) VALUES ('owner_login_emails', ?1)`)
      .bind(JSON.stringify(['alias@gmail.test']))
      .run()
    const id = await resolveHumanMemberId(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-attacker-never-seen',
      email: 'alias@gmail.test',
    })
    expect(id).not.toBe('mem-owner')
  })

  it('P0-2a: the primary members.email still resolves when the live identity carries a different verified_email', async () => {
    const id = await resolveHumanMemberId(env, { tenant: TENANT, email: 'owner@mumega.test' })
    expect(id).toBe('mem-owner')
  })

  it('P0-2b: SSO auto-enroll with the primary email returns the existing member, never throws UNIQUE', async () => {
    const result = await autoEnrollSsoMember(env, { email: 'owner@mumega.test', provider: 'google' })
    expect(result.ok).toBe(true)
    expect(result.memberId).toBe('mem-owner')
    expect(result.isNew).toBe(false)
  })
})
