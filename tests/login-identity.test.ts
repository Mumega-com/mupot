// tests/login-identity.test.ts — human_login_identities: the tenant-local
// binding from an external verified login identity to ONE canonical member.
//
// Design invariant under test: authorization binds to (tenant, provider,
// provider_subject), NEVER to a display email, and a login can never silently
// REASSIGN an identity that already belongs to a different member — "two
// email strings happen to match" must not move standing authority (design
// doc, "Human login identity"). Real migration chain (createSqliteD1 +
// applyAllMigrations), never a hand-written schema.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import { linkLoginIdentity, resolveLoginIdentity } from '../src/auth/login-identity'

const TENANT = 'mumega'

describe('human_login_identities (D1, real migration chain)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
  })

  afterEach(() => harness.close())

  async function seedMember(id: string, email: string) {
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES (?1, ?2, ?3, ?3, 'active', datetime('now'))`,
    )
      .bind(id, TENANT, email)
      .run()
  }

  it('resolveLoginIdentity: null for an unknown join key', async () => {
    const result = await resolveLoginIdentity(env, TENANT, 'google', 'sub-1')
    expect(result).toBeNull()
  })

  it('links a new identity to a member and resolves it back', async () => {
    await seedMember('m1', 'a@x.test')
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-1',
      verifiedEmail: 'a@x.test',
      memberId: 'm1',
    })
    expect(linked.ok).toBe(true)
    if (linked.ok) {
      expect(linked.created).toBe(true)
      expect(linked.identity.member_id).toBe('m1')
    }

    const resolved = await resolveLoginIdentity(env, TENANT, 'google', 'sub-1')
    expect(resolved?.member_id).toBe('m1')
  })

  it('is idempotent for a REPEAT login by the same member — not an error', async () => {
    await seedMember('m1', 'a@x.test')
    const first = await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'sub-1', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    const second = await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'sub-1', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.created).toBe(false)
      expect(first.ok && second.identity.id).toBe(first.ok ? first.identity.id : undefined)
    }
  })

  it('REFUSES to reassign an identity already bound to a DIFFERENT member — never silently moves authority', async () => {
    await seedMember('m1', 'a@x.test')
    await seedMember('m2', 'a-alt@x.test')
    await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'sub-shared', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    const attempt = await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'sub-shared', verifiedEmail: 'a-alt@x.test', memberId: 'm2',
    })
    expect(attempt.ok).toBe(false)
    if (!attempt.ok) {
      expect(attempt.error).toBe('identity_bound_to_other_member')
      expect(attempt.identity.member_id).toBe('m1') // unchanged
    }
    // The join key still resolves to the ORIGINAL member — the attempted
    // reassignment left no trace on standing authority.
    const resolved = await resolveLoginIdentity(env, TENANT, 'google', 'sub-shared')
    expect(resolved?.member_id).toBe('m1')
  })

  it('a REVOKED identity resolves to nothing and refuses re-link rather than silently reviving', async () => {
    await seedMember('m1', 'a@x.test')
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'sub-revoked', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    expect(linked.ok).toBe(true)
    const id = linked.ok ? linked.identity.id : ''
    await env.DB.prepare('UPDATE human_login_identities SET revoked_at = datetime(\'now\') WHERE id = ?1').bind(id).run()

    expect(await resolveLoginIdentity(env, TENANT, 'google', 'sub-revoked')).toBeNull()

    const relink = await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'sub-revoked', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    expect(relink.ok).toBe(false)
    if (!relink.ok) expect(relink.error).toBe('identity_revoked')
  })

  it('is tenant-scoped — the SAME provider+subject in a different tenant is a DIFFERENT identity', async () => {
    await seedMember('m1', 'a@x.test')
    // members.email is a GLOBALLY unique column (migrations/0002_members.sql)
    // — a different tenant's member must use a DIFFERENT email string here;
    // the tenant isolation under test is on human_login_identities, not on
    // members.email.
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('m-other-tenant', 'other-tenant', 'a-other-tenant@x.test', 'a', 'active', datetime('now'))`,
    ).run()

    await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'sub-cross', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    const otherTenantLink = await linkLoginIdentity(env, {
      tenant: 'other-tenant', provider: 'google', providerSubject: 'sub-cross', verifiedEmail: 'a@x.test', memberId: 'm-other-tenant',
    })
    expect(otherTenantLink.ok).toBe(true)
    if (otherTenantLink.ok) expect(otherTenantLink.created).toBe(true)

    expect((await resolveLoginIdentity(env, TENANT, 'google', 'sub-cross'))?.member_id).toBe('m1')
    expect((await resolveLoginIdentity(env, 'other-tenant', 'google', 'sub-cross'))?.member_id).toBe('m-other-tenant')
  })

  it('distinguishes provider — the same subject string under a different provider is a DIFFERENT identity', async () => {
    await seedMember('m1', 'a@x.test')
    const google = await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'google', providerSubject: 'shared-subject', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    const bootstrap = await linkLoginIdentity(env, {
      tenant: TENANT, provider: 'bootstrap', providerSubject: 'shared-subject', verifiedEmail: 'a@x.test', memberId: 'm1',
    })
    expect(google.ok && bootstrap.ok).toBe(true)
    if (google.ok && bootstrap.ok) expect(google.identity.id).not.toBe(bootstrap.identity.id)
  })
})
