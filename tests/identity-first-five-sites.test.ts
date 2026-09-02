// Athena 2026-09-02: identity-first must hold at every human→member site.
// The interaction that exact-head gating cannot catch: identity bound to A,
// email matches B → both registerWebSession and the cookie bridge resolve to A.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { resolveHumanMemberId } from '../src/members/resolve-human-member'
import { resolveVerifiedHumanMemberId } from '../src/members/human-identity'
import { autoEnrollSsoMember } from '../src/auth/sso'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

describe('identity-first at all five sites (interaction)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-hadi', ?1, 'owner@mumega.test', 'Hadi', 'active', datetime('now')),
              ('mem-login', ?1, 'hadi@digid.ca', 'Login', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-hadi',
      verifiedEmail: 'hadi@digid.ca',
      memberId: 'mem-hadi',
    })
    expect(linked.ok).toBe(true)
  })

  afterEach(() => harness.close())

  it('shared resolver: provider+subject bound to A, email matches B → A', async () => {
    const id = await resolveHumanMemberId(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-hadi',
      email: 'hadi@digid.ca',
    })
    expect(id).toBe('mem-hadi')
  })

  it('shared resolver: email-only still uses live identity, not members.email', async () => {
    const id = await resolveHumanMemberId(env, {
      tenant: TENANT,
      email: 'hadi@digid.ca',
    })
    expect(id).toBe('mem-hadi')
  })

  it('human-identity wrapper (site 5) consults identity first', async () => {
    const id = await resolveVerifiedHumanMemberId(env, 'hadi@digid.ca', {
      provider: 'google',
      subject: 'sub-hadi',
    })
    expect(id).toBe('mem-hadi')
  })

  it('SSO auto-enroll (site 3) does not create a third row and returns A', async () => {
    const result = await autoEnrollSsoMember(env, {
      email: 'hadi@digid.ca',
      name: 'Hadi',
      provider: 'google',
    })
    expect(result.ok).toBe(true)
    expect(result.memberId).toBe('mem-hadi')
    expect(result.isNew).toBe(false)
  })
})
