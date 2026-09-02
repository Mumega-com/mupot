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
})
