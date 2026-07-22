// The email→member bridge in requireAuth: a plain Google web login (org-role
// 'member') is resolved to its members row BY VERIFIED EMAIL and given its
// fine-grained capabilities, so squad-scoped dashboard surfaces actually see it.
// These tests pin the security invariants that keep the bridge from over-granting:
// role-gated (owners never downgraded), tenant-scoped (no cross-tenant leak),
// status-active, and fail-closed on no match.
import { describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import type { Env } from '../src/types'

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

function makeEnv(seed: {
  members?: MemberRow[]
  grants?: GrantRow[]
  tenant?: string
}) {
  const members = seed.members ?? []
  const grants = seed.grants ?? []
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
            // members email→id resolution
            if (sql.includes('FROM members') && sql.includes('lower(email)')) {
              const [email, tenant] = args as [string, string]
              const m = members.find(
                (r) =>
                  r.email.toLowerCase() === email.toLowerCase() &&
                  r.tenant === tenant &&
                  r.status === 'active',
              )
              return (m ? ({ id: m.id } as unknown as T) : null)
            }
            return null as T | null
          },
          all: async <T>() => {
            // resolveCapabilities: capabilities UNION channel_capability_grants
            if (sql.includes('FROM capabilities')) {
              const [memberId] = args as [string]
              return { results: grants.filter((g) => g.member_id === memberId) as unknown as T[] }
            }
            return { results: [] as T[] }
          },
        })
        return {
          bind: (...args: unknown[]) => run(args),
        }
      },
    },
  } as unknown as Env

  const login = (userId: string, email: string | null, role: Role): string => {
    const id = `sid-${userId}`
    sessions.set(
      `sess:${id}`,
      JSON.stringify({ userId, email, role, createdAt: '2026-07-22T00:00:00Z' }),
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

  it('attaches memberId + capabilities for a member-role login with a matching member', async () => {
    const { env, login } = makeEnv({ members: [gavin], grants: [grant] })
    const { status, body } = await me(env, login('u1', 'gavin@x.test', 'member'))
    expect(status).toBe(200)
    expect(body.memberId).toBe('m-gavin')
    expect(body.channel).toBe('dashboard')
    expect(body.capabilities).toEqual([grant])
  })

  it('does NOT bind an owner (no downgrade) even with a matching lesser member row', async () => {
    const { env, login } = makeEnv({ members: [gavin], grants: [grant] })
    const { body } = await me(env, login('u1', 'gavin@x.test', 'owner'))
    // Owner keeps the pure legacy-role path — capabilities stays undefined so the
    // requireCapability owner-escape is not disabled.
    expect(body.memberId).toBeUndefined()
    expect(body.capabilities).toBeUndefined()
    expect(body.role).toBe('owner')
  })

  it('does NOT bind across tenants (no cross-tenant leak)', async () => {
    const other: MemberRow = { ...gavin, tenant: 'other-tenant' }
    const { env, login } = makeEnv({ members: [other], grants: [grant], tenant: 'local' })
    const { body } = await me(env, login('u1', 'gavin@x.test', 'member'))
    expect(body.memberId).toBeUndefined()
  })

  it('fails closed when no member row matches the email', async () => {
    const { env, login } = makeEnv({ members: [], grants: [] })
    const { body } = await me(env, login('u1', 'nobody@x.test', 'member'))
    expect(body.memberId).toBeUndefined()
    expect(body.capabilities).toBeUndefined()
  })

  it('matches case-insensitively (invited Mixed-case, Google returns lower)', async () => {
    const mixed: MemberRow = { ...gavin, email: 'Gavin@X.test' }
    const { env, login } = makeEnv({ members: [mixed], grants: [grant] })
    const { body } = await me(env, login('u1', 'gavin@x.test', 'member'))
    expect(body.memberId).toBe('m-gavin')
  })

  it('does NOT bind a suspended member', async () => {
    const suspended: MemberRow = { ...gavin, status: 'suspended' }
    const { env, login } = makeEnv({ members: [suspended], grants: [grant] })
    const { body } = await me(env, login('u1', 'gavin@x.test', 'member'))
    expect(body.memberId).toBeUndefined()
  })
})
