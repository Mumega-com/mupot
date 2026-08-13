import { describe, it, expect } from 'vitest'
import { bearerToken, resolveMemberByToken } from '../src/auth/member-bearer'
import type { Env } from '../src/types'

describe('bearerToken', () => {
  it('parses a Bearer header', () => expect(bearerToken('Bearer abc123')).toBe('abc123'))
  it('case-insensitive scheme', () => expect(bearerToken('bearer xyz')).toBe('xyz'))
  it('null on missing header', () => expect(bearerToken(undefined)).toBeNull())
  it('null on non-bearer scheme', () => expect(bearerToken('Basic abc')).toBeNull())
  it('null on empty token', () => expect(bearerToken('Bearer    ')).toBeNull())
})

// Records EVERY query, not just the most recent one.
//
// It used to keep only the last `prepare()`, which was fine while the lookup was the
// only statement resolveMemberByToken issued. Migration 0099 added a best-effort
// `last_used_at` write after a successful auth, so "the last SQL" became the UPDATE and
// the tenant-binding assertion below started reading the wrong statement — a green-to-red
// flip with no production defect behind it. Collecting all queries makes each assertion
// name the statement it means, so adding another one can never silently retarget it.
//
// `.run()` is deliberately present here: the real touchTokenLastUsed calls it, and a
// mock lacking it would exercise only the swallowed-error path — hiding whether the
// stamp is tenant-scoped. That is the shape of bug this repo has been bitten by before
// (mupot#684: the mock validated assumptions rather than behaviour).
interface SeenQuery { sql: string; binds: unknown[] }

function makeEnv(
  row: Record<string, unknown> | null,
  seen: { queries: SeenQuery[]; sql?: string; binds?: unknown[] } = { queries: [] },
  opts: { failWrites?: boolean } = {},
): Env {
  return {
    TENANT_SLUG: 'digid',
    DB: {
      prepare(sql: string) {
        return {
          bind: (...args: unknown[]) => {
            const q: SeenQuery = { sql, binds: args }
            seen.queries.push(q)
            // Back-compat with the single-statement assertions above.
            seen.sql = sql
            seen.binds = args
            return {
              first: async () => row,
              run: async () => {
                if (opts.failWrites) throw new Error('D1 write failed')
                return { success: true }
              },
            }
          },
        }
      },
    },
  } as unknown as Env
}

/** The bearer lookup specifically — never whatever statement happened to run last. */
const lookupOf = (seen: { queries: SeenQuery[] }): SeenQuery | undefined =>
  seen.queries.find((q) => q.sql.includes('FROM member_tokens t'))

describe('resolveMemberByToken', () => {
  it('null on null token (no DB hit needed)', async () => {
    expect(await resolveMemberByToken(makeEnv(null), null)).toBeNull()
  })
  it('null when token has no live row', async () => {
    expect(await resolveMemberByToken(makeEnv(null), 'sk-x')).toBeNull()
  })
  it('null when the member is not active (suspended member, inert token)', async () => {
    const env = makeEnv({ member_id: 'm1', display_name: 'A', email: null, status: 'suspended' })
    expect(await resolveMemberByToken(env, 'sk-x')).toBeNull()
  })
  it('resolves an active member to its identity (unbound token → boundAgentId null)', async () => {
    const env = makeEnv({ member_id: 'm1', display_name: 'Kasra', email: 'k@x', status: 'active' })
    expect(await resolveMemberByToken(env, 'sk-x')).toEqual({
      memberId: 'm1',
      displayName: 'Kasra',
      email: 'k@x',
      boundAgentId: null,
    })
  })
  it('returns boundAgentId for an agent-scoped token (the weld)', async () => {
    const env = makeEnv({ member_id: 'm1', display_name: 'content-writer', email: null, status: 'active', bound_agent_id: 'agent-7' })
    expect(await resolveMemberByToken(env, 'sk-x')).toEqual({
      memberId: 'm1',
      displayName: 'content-writer',
      email: null,
      boundAgentId: 'agent-7',
    })
  })
  it('binds member token auth to the current tenant', async () => {
    const seen = { queries: [] as SeenQuery[] }
    const env = makeEnv({ member_id: 'm1', display_name: 'Kasra', email: 'k@x', status: 'active' }, seen)

    await resolveMemberByToken(env, 'sk-x')

    const lookup = lookupOf(seen)
    expect(lookup).toBeDefined()
    expect(lookup!.sql).toContain('t.tenant = ?2')
    expect(lookup!.sql).toContain('m.tenant = ?2')
    expect(lookup!.binds[1]).toBe('digid')
  })

  // ── migration 0099 ───────────────────────────────────────────────────────────
  it('enforces expiry in the lookup, not as a follow-up check', async () => {
    // A separate post-query branch could be reordered, short-circuited, or made into an
    // "expired" oracle. Expiry belongs in the same predicate as revocation.
    const seen = { queries: [] as SeenQuery[] }
    const env = makeEnv({ member_id: 'm1', display_name: 'K', email: null, status: 'active' }, seen)
    await resolveMemberByToken(env, 'sk-x')

    const lookup = lookupOf(seen)!
    expect(lookup.sql).toContain('t.revoked_at IS NULL')
    expect(lookup.sql).toContain('expires_at')
    expect(lookup.sql).toContain('julianday')
  })

  it('scopes the last_used_at write to the tenant', async () => {
    // The usage stamp is a WRITE keyed by token_hash. Unscoped, it would let one
    // tenant's request touch a row belonging to another whose hash collided or was
    // known — a cross-tenant write on the credential table.
    const seen = { queries: [] as SeenQuery[] }
    const env = makeEnv({ member_id: 'm1', display_name: 'K', email: null, status: 'active' }, seen)
    await resolveMemberByToken(env, 'sk-x')

    const stamp = seen.queries.find((q) => q.sql.includes('last_used_at'))
    expect(stamp).toBeDefined()
    expect(stamp!.sql).toContain('tenant = ?3')
    expect(stamp!.binds[2]).toBe('digid')
  })

  it('a failed last_used_at write does NOT fail the authentication', async () => {
    // The contract: usage telemetry degrades a future cleanup decision; failing the
    // request degrades a live agent right now. Auth must survive the stamp failing.
    const seen = { queries: [] as SeenQuery[] }
    const env = makeEnv(
      { member_id: 'm1', display_name: 'K', email: 'k@x', status: 'active' },
      seen,
      { failWrites: true },
    )
    await expect(resolveMemberByToken(env, 'sk-x')).resolves.toEqual({
      memberId: 'm1',
      displayName: 'K',
      email: 'k@x',
      boundAgentId: null,
    })
  })
})
