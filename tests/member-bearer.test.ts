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

function makeEnv(row: Record<string, unknown> | null, seen: { sql?: string; binds?: unknown[] } = {}): Env {
  return {
    TENANT_SLUG: 'digid',
    DB: {
      prepare(sql: string) {
        seen.sql = sql
        return { bind: (...args: unknown[]) => ({ first: async () => {
          seen.binds = args
          if (row?.bound_agent_id && row.bound_agent_status !== 'active') return null
          return row
        } }) }
      },
    },
  } as unknown as Env
}

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
    const env = makeEnv({ member_id: 'm1', display_name: 'content-writer', email: null, status: 'active', bound_agent_id: 'agent-7', bound_agent_status: 'active' })
    expect(await resolveMemberByToken(env, 'sk-x')).toEqual({
      memberId: 'm1',
      displayName: 'content-writer',
      email: null,
      boundAgentId: 'agent-7',
    })
  })
  it('rejects a welded token when its agent is missing', async () => {
    const env = makeEnv({ member_id: 'm1', display_name: 'worker', email: null, status: 'active', bound_agent_id: 'agent-missing', bound_agent_status: null })
    expect(await resolveMemberByToken(env, 'sk-x')).toBeNull()
  })
  it('rejects a welded token when its agent is paused', async () => {
    const env = makeEnv({ member_id: 'm1', display_name: 'worker', email: null, status: 'active', bound_agent_id: 'agent-paused', bound_agent_status: 'paused' })
    expect(await resolveMemberByToken(env, 'sk-x')).toBeNull()
  })
  it('binds member token auth to the current tenant', async () => {
    const seen: { sql?: string; binds?: unknown[] } = {}
    const env = makeEnv({ member_id: 'm1', display_name: 'Kasra', email: 'k@x', status: 'active' }, seen)

    await resolveMemberByToken(env, 'sk-x')

    expect(seen.sql).toContain('t.tenant = ?2')
    expect(seen.sql).toContain('m.tenant = ?2')
    expect(seen.sql).toContain('LEFT JOIN agents')
    expect(seen.sql).toContain("a.status = 'active'")
    expect(seen.binds?.[1]).toBe('digid')
  })
})
