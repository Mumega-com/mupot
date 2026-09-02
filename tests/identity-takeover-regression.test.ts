// Adversarial regression for the P0 found on 199ffe4b (Kasra, 2026-09-02).
//
// The resolver's docstring says the verified_email fallback applies "when
// provider/subject absent". The code ran it unconditionally, so a login with a
// BRAND-NEW provider_subject whose reported email collided with an existing
// identity's verified_email resolved to that identity's member — and
// registerWebSession then PERSISTED the binding, making the takeover permanent.
//
// Why 6953 green missed it: every prior test reuses the same subject the
// identity was linked under, so they only ever exercise step 1. These tests
// were written against the VULNERABLE head, before seeing any fix, and must be
// red there and green after. A test authored after the patch inherits the
// patch's blind spot.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkLoginIdentity } from '../src/auth/login-identity'
import { resolveHumanMemberId } from '../src/members/resolve-human-member'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

describe('identity takeover regression (P0, 199ffe4b)', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    // mem-victim: holds standing authority AND a live identity.
    // mem-fresh:  an ordinary human with no identity yet (bootstrap must survive).
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-victim', ?1, 'owner@mumega.test', 'Victim', 'active', datetime('now')),
              ('mem-fresh',  ?1, 'fresh@mumega.test', 'Fresh',  'active', datetime('now'))`,
    ).bind(TENANT).run()
    const linked = await linkLoginIdentity(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-victim',
      verifiedEmail: 'victim@corp.test',
      memberId: 'mem-victim',
    })
    expect(linked.ok).toBe(true)
  })

  afterEach(() => harness.close())

  // THE P0 ITSELF. A never-seen subject reporting the victim's verified_email.
  // Reachable via IdP mailbox recycling, or the mumega handoff path where
  // provider_subject IS the email string — there the join key and the collision
  // key are the same value.
  it('a FRESH provider_subject must not acquire a member via a colliding verified_email', async () => {
    const id = await resolveHumanMemberId(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-attacker-never-seen',
      email: 'victim@corp.test',
    })
    expect(id).not.toBe('mem-victim')
  })

  // THE SAME TAKEOVER ONE HOP DOWN. Gating step 2 alone is not enough: step 3
  // bootstraps on members.email, and a member who ALREADY HAS a live identity
  // must not be reachable that way either.
  it('members.email bootstrap must not reach a member who already has a live identity', async () => {
    const id = await resolveHumanMemberId(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-attacker-never-seen',
      email: 'owner@mumega.test',
    })
    expect(id).not.toBe('mem-victim')
  })

  // Same collision with NO subject presented at all — the one case the
  // verified_email fallback legitimately exists for. Still allowed.
  it('email-only (no subject) still resolves through the live identity', async () => {
    const id = await resolveHumanMemberId(env, { tenant: TENANT, email: 'victim@corp.test' })
    expect(id).toBe('mem-victim')
  })

  // The fix must not close the door on ordinary onboarding: a human with no
  // identity yet, bootstrapping by their own members.email.
  it('a member with no live identity still bootstraps by email', async () => {
    const id = await resolveHumanMemberId(env, {
      tenant: TENANT,
      provider: 'google',
      providerSubject: 'sub-brand-new',
      email: 'fresh@mumega.test',
    })
    expect(id).toBe('mem-fresh')
  })
})
