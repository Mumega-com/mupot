// The email→member bridge in requireAuth: a plain Google web login (org-role
// 'member') is resolved to its members row BY VERIFIED EMAIL and given its
// fine-grained capabilities, so squad-scoped dashboard surfaces actually see it.
// These tests pin the security invariants that keep the bridge from over-granting:
// role-gated (owners never downgraded), tenant-scoped (no cross-tenant leak),
// status-active, and fail-closed on no match.
//
// mupot#1551 round 3 (adversarial gate on PR #1560): this file's "legitimate
// member" fixtures used to rely on loadAuthFromCookie's OLD lenient
// email-only fallback, which mupot#1551 closed (P1-a) — a login-time denial
// must also close every READ-time fallback that could reach the same row by
// a weaker key. Per the ruling, these fixtures are rewritten on purpose: a
// legitimate member now presents a REAL login identity (seeded
// human_login_identities row) rather than being found by email alone, and a
// new test at the bottom pins the DENIED shape the old fallback would have
// silently granted — an identity-less row already held by a live bearer.
import { describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { holdsCapabilityFloor, isOrgAdmin } from '../src/auth/capability'
import type { AuthContext, Env } from '../src/types'

type Role = 'owner' | 'admin' | 'member'
interface MemberRow {
  id: string
  email: string
  tenant: string
  status: 'active' | 'suspended'
}
interface GrantRow {
  member_id: string
  scope_type: string
  scope_id: string | null
  capability: string
}
interface IdentityRow {
  id: string
  tenant: string
  provider: string
  provider_subject: string
  verified_email: string | null
  member_id: string
}
interface BearerRow {
  member_id: string
  agent_id: string | null
  label: string
  channel: string
}

function makeEnv(seed: {
  members?: MemberRow[]
  grants?: GrantRow[]
  identities?: IdentityRow[]
  bearers?: BearerRow[]
  tenant?: string
}) {
  const members = seed.members ?? []
  const grants = seed.grants ?? []
  const identities = seed.identities ?? []
  const bearers = seed.bearers ?? []
  const sessions = new Map<string, string>()

  const env = {
    TENANT_SLUG: seed.tenant ?? 'local',
    SESSIONS: {
      get: async (key: string) => sessions.get(key) ?? null,
      put: async (key: string, value: string) => void sessions.set(key, value),
      delete: async (key: string) => void sessions.delete(key),
    },
    DB: {
      prepare(sql: string) {
        const run = (args: unknown[]) => ({
          first: async <T>() => {
            // resolveLoginIdentity (registerWebSession step 1: the real join
            // key, checked BEFORE any email match).
            if (sql.includes('FROM human_login_identities') && sql.includes('provider_subject')) {
              const [tenant, provider, subject] = args as [string, string, string]
              const ident = identities.find(
                (i) => i.tenant === tenant && i.provider === provider && i.provider_subject === subject,
              )
              return (ident
                ? ({
                    id: ident.id,
                    tenant: ident.tenant,
                    provider: ident.provider,
                    provider_subject: ident.provider_subject,
                    verified_email: ident.verified_email,
                    member_id: ident.member_id,
                    linked_by_member_id: null,
                    created_at: '2026-01-01T00:00:00.000Z',
                    revoked_at: null,
                  } as unknown as T)
                : null)
            }
            // decideIdentitylessAttach step 2: any live identity for a
            // CANDIDATE member (no join key match above — used only on the
            // identity-less-attach path).
            if (sql.includes('FROM human_login_identities') && sql.includes('AS present')) {
              const [, memberId] = args as [string, string]
              return identities.some((i) => i.member_id === memberId) ? ({ present: 1 } as unknown as T) : null
            }
            // decideIdentitylessAttach step 3: any live UNBOUND bearer for a
            // candidate member, admin/dashboard + directory exempted.
            if (sql.includes('FROM member_tokens t')) {
              const [, memberId, exemptLabel, exemptChannel, exemptDirectory] = args as [
                string,
                string,
                string,
                string,
                string,
              ]
              const blocking = bearers.some(
                (b) =>
                  b.member_id === memberId &&
                  b.agent_id === null &&
                  !(b.label === exemptLabel && b.channel === exemptChannel) &&
                  b.channel !== exemptDirectory,
              )
              return blocking ? ({ present: 1 } as unknown as T) : null
            }
            // members email→id resolution (F1's status-only probe, and the
            // pre-mupot#1551 email lookup no code path here still uses for a
            // WRITE — retained for F1).
            if (sql.includes('FROM members') && sql.includes('lower(email)')) {
              const [email, tenant] = args as [string, string]
              const m = members.find(
                (r) =>
                  r.email.toLowerCase() === email.toLowerCase() &&
                  r.tenant === tenant &&
                  r.status === 'active',
              )
              return (m ? ({ id: m.id, status: m.status } as unknown as T) : null)
            }
            return null as T | null
          },
          all: async <T>() => {
            // resolveCapabilities: capabilities UNION channel_capability_grants
            if (sql.includes('FROM capabilities')) {
              const [memberId] = args as [string]
              return { results: grants.filter((g) => g.member_id === memberId) as unknown as T[] }
            }
            // decideIdentitylessAttach's own candidate lookup — no LIMIT, so
            // an ambiguous match is visible as length > 1.
            if (sql.includes('FROM members') && sql.includes('telegram_chat_id')) {
              const [email, tenant] = args as [string, string]
              const matches = members.filter(
                (r) => r.email.toLowerCase() === email.toLowerCase() && r.tenant === tenant,
              )
              return {
                results: matches.map((m) => ({ id: m.id, status: m.status, telegram_chat_id: null })) as unknown as T[],
              }
            }
            return { results: [] as T[] }
          },
          // The only writes this file's fixtures ever legitimately reach are
          // registerWebSession's own (a possible verified_email refresh
          // UPDATE, and createWebSession's INSERT into web_sessions) — this
          // mock does not model web_sessions state at all (nothing here reads
          // it back; registerWebSession now hands its resolved memberId back
          // directly, mupot#1551 round 2), so any write is a structural no-op
          // that must not throw.
          run: async () => ({ success: true, meta: { changes: 1 } }),
        })
        return {
          bind: (...args: unknown[]) => run(args),
        }
      },
    },
  } as unknown as Env

  const login = (
    userId: string,
    email: string | null,
    role: Role,
    loginIdentity?: { provider: string; subject: string },
  ): string => {
    const id = `sid-${userId}`
    sessions.set(
      `sess:${id}`,
      JSON.stringify({
        userId,
        email,
        role,
        createdAt: '2026-07-22T00:00:00Z',
        ...(loginIdentity ? { loginIdentity } : {}),
      }),
    )
    return id
  }

  return { env, login }
}

async function me(env: Env, sid: string) {
  const res = await authApp.request('/me', { headers: { cookie: `mupot_session=${sid}` } }, env)
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('email→member bridge (requireAuth)', () => {
  const grant: GrantRow = {
    member_id: 'm-gavin',
    scope_type: 'squad',
    scope_id: 'squad-gavin',
    capability: 'observer',
  }
  const gavin: MemberRow = { id: 'm-gavin', email: 'gavin@x.test', tenant: 'local', status: 'active' }
  const gavinIdentity: IdentityRow = {
    id: 'ident-gavin',
    tenant: 'local',
    provider: 'google',
    provider_subject: 'sub-gavin',
    verified_email: 'gavin@x.test',
    member_id: 'm-gavin',
  }

  it('attaches memberId + capabilities for a member-role login with a matching member', async () => {
    const { env, login } = makeEnv({ members: [gavin], grants: [grant], identities: [gavinIdentity] })
    const { status, body } = await me(
      env,
      login('u1', 'gavin@x.test', 'member', { provider: 'google', subject: 'sub-gavin' }),
    )
    expect(status).toBe(200)
    expect(body.memberId).toBe('m-gavin')
    expect(body.channel).toBe('dashboard')
    expect(body.capabilities).toEqual([grant])
  })

  // mumega-com#1218. This test previously asserted BOTH `memberId` and `capabilities`
  // were undefined for an owner — conflating IDENTITY with AUTHORITY exactly as the code
  // did, and thereby pinning the defect: an owner with no memberId reaches
  // loadEnrollView, which returns `agents: []`, and the seat picker is empty. Owners
  // could not enrol any agent seat.
  //
  // The memberId half was the bug. The capabilities half is the real invariant and is
  // asserted harder below, including the consequence rather than only the input.
  it('binds an owner IDENTITY (memberId) but never its AUTHORITY (capabilities)', async () => {
    const { env, login } = makeEnv({ members: [gavin], grants: [grant], identities: [gavinIdentity] })
    const { body } = await me(
      env,
      login('u1', 'gavin@x.test', 'owner', { provider: 'google', subject: 'sub-gavin' }),
    )

    // identity — this is what unblocks /enroll
    expect(body.memberId).toBe('m-gavin')
    expect(body.role).toBe('owner')

    // authority — MUST stay undefined. resolveCapabilities would return the lesser
    // squad-observer grant above; assigning it defines auth.capabilities and disables
    // the legacy-role escape in holdsCapabilityFloor (src/auth/capability.ts:181),
    // downgrading the owner.
    expect(body.capabilities).toBeUndefined()
  })

  // The CONSEQUENCE, not just the input. Asserting `capabilities === undefined` only
  // pins the shape; this pins what that shape is FOR. If a future change assigns
  // capabilities to an owner, the line above goes red — and so does this, which says
  // why it matters.
  it('an owner still clears an admin floor after the identity bind', async () => {
    const { env, login } = makeEnv({ members: [gavin], grants: [grant], identities: [gavinIdentity] })
    const { body } = await me(
      env,
      login('u1', 'gavin@x.test', 'owner', { provider: 'google', subject: 'sub-gavin' }),
    )

    const auth = {
      role: body.role,
      memberId: body.memberId,
      capabilities: body.capabilities,
    } as unknown as AuthContext

    expect(holdsCapabilityFloor(auth, 'admin')).toBe(true)
    expect(isOrgAdmin(auth)).toBe(true)
  })

  it('an ADMIN is bound the same way — identity yes, authority no', async () => {
    const { env, login } = makeEnv({ members: [gavin], grants: [grant], identities: [gavinIdentity] })
    const { body } = await me(
      env,
      login('u1', 'gavin@x.test', 'admin', { provider: 'google', subject: 'sub-gavin' }),
    )
    expect(body.memberId).toBe('m-gavin')
    expect(body.capabilities).toBeUndefined()
  })

  it('does NOT bind across tenants (no cross-tenant leak)', async () => {
    const other: MemberRow = { ...gavin, tenant: 'other-tenant' }
    const otherIdentity: IdentityRow = { ...gavinIdentity, tenant: 'other-tenant' }
    const { env, login } = makeEnv({
      members: [other],
      grants: [grant],
      identities: [otherIdentity],
      tenant: 'local',
    })
    const { body } = await me(
      env,
      login('u1', 'gavin@x.test', 'member', { provider: 'google', subject: 'sub-gavin' }),
    )
    expect(body.memberId).toBeUndefined()
  })

  it('fails closed when no member row matches the email', async () => {
    const { env, login } = makeEnv({ members: [], grants: [] })
    const { body } = await me(env, login('u1', 'nobody@x.test', 'member'))
    expect(body.memberId).toBeUndefined()
    expect(body.capabilities).toBeUndefined()
  })

  it('matches via a linked identity regardless of the member row\'s original email casing', async () => {
    const mixed: MemberRow = { ...gavin, email: 'Gavin@X.test' }
    const mixedIdentity: IdentityRow = { ...gavinIdentity, verified_email: 'gavin@x.test' }
    const { env, login } = makeEnv({ members: [mixed], grants: [grant], identities: [mixedIdentity] })
    const { body } = await me(
      env,
      login('u1', 'gavin@x.test', 'member', { provider: 'google', subject: 'sub-gavin' }),
    )
    expect(body.memberId).toBe('m-gavin')
  })

  it('does NOT bind a suspended member', async () => {
    const suspended: MemberRow = { ...gavin, status: 'suspended' }
    const { env, login } = makeEnv({ members: [suspended], grants: [grant] })
    const { body } = await me(env, login('u1', 'gavin@x.test', 'member'))
    expect(body.memberId).toBeUndefined()
  })

  // mupot#1551 round 3: the shape the OLD lenient email-only fallback would
  // have silently granted — an identity-less row already held by a live
  // bearer (the legacy public-accept squat). A real login for the SAME
  // email must be refused, not silently attached to the squatted row.
  it('a squatted identity-less row (live workspace bearer, no linked identity) is DENIED — never bound by email alone', async () => {
    const squatted: MemberRow = { id: 'm-sq', email: 'ceo@x.test', tenant: 'local', status: 'active' }
    const squatterBearer: BearerRow = {
      member_id: 'm-sq',
      agent_id: null,
      label: 'workspace',
      channel: 'workspace',
    }
    const { env, login } = makeEnv({ members: [squatted], bearers: [squatterBearer] })
    const { body } = await me(
      env,
      login('u1', 'ceo@x.test', 'member', { provider: 'google', subject: 'sub-ceo' }),
    )
    expect(body.memberId).toBeUndefined()
    expect(body.memberId).not.toBe('m-sq')
  })
})
