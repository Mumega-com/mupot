import { describe, it, expect } from 'vitest'
import { loadApprovals, resultPreview } from '../src/dashboard/approvals'
import type { Env, AuthContext } from '../src/types'

// ── D1 mock: records sql + binds, returns canned rows ────────────────────────

interface PreparedCall {
  sql: string
  binds: unknown[]
}

function makeEnv(rows: unknown[] = []) {
  const calls: PreparedCall[] = []
  const env = {
    TENANT_SLUG: 'test-tenant',
    DB: {
      prepare(sql: string) {
        const call: PreparedCall = { sql, binds: [] }
        calls.push(call)
        const stmt = {
          bind(...args: unknown[]) {
            call.binds = args
            return stmt
          },
          async all() {
            return { results: rows }
          },
        }
        return stmt
      },
    },
  } as unknown as Env
  return { env, calls }
}

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    tenant: 'test-tenant',
    role: 'member',
    userId: 'agent-1',
    memberId: undefined,
    ...over,
  } as AuthContext
}

// ── loadApprovals ─────────────────────────────────────────────────────────────

describe('loadApprovals', () => {
  it('owner sees every review task (no gate_grants filter)', async () => {
    const rows = [{ id: 't1' }, { id: 't2' }]
    const { env, calls } = makeEnv(rows)
    const out = await loadApprovals(env, auth({ role: 'owner' }))
    expect(out).toHaveLength(2)
    expect(calls[0].sql).toContain("t.status = 'review'")
    expect(calls[0].sql).not.toContain('gate_grants')
  })

  it('admin gets the same unfiltered query', async () => {
    const { env, calls } = makeEnv([])
    await loadApprovals(env, auth({ role: 'admin' }))
    expect(calls[0].sql).not.toContain('gate_grants')
  })

  it('member is filtered through gate_grants with member principal', async () => {
    const { env, calls } = makeEnv([{ id: 't1' }])
    const out = await loadApprovals(env, auth({ role: 'member', memberId: 'm-9', userId: 'u-9' }))
    expect(out).toHaveLength(1)
    expect(calls[0].sql).toContain('gate_grants')
    expect(calls[0].sql).toContain('t.gate_owner IS NOT NULL')
    expect(calls[0].binds).toEqual(['member', 'm-9'])
  })

  it('agent token (no memberId) checks agent principal via userId', async () => {
    const { env, calls } = makeEnv([])
    await loadApprovals(env, auth({ role: 'member', memberId: undefined, userId: 'agent-7' }))
    expect(calls[0].binds).toEqual(['agent', 'agent-7'])
  })

  it('no principal id → empty list, no query', async () => {
    const { env, calls } = makeEnv([{ id: 'should-not-appear' }])
    const out = await loadApprovals(env, auth({ role: 'member', memberId: undefined, userId: undefined }))
    expect(out).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

// ── resultPreview ─────────────────────────────────────────────────────────────

describe('resultPreview', () => {
  it('null result → null', () => {
    expect(resultPreview({ result: null })).toBeNull()
  })

  it('short result passes through trimmed', () => {
    expect(resultPreview({ result: '  done deal  ' })).toBe('done deal')
  })

  it('long result truncates with ellipsis at the cap', () => {
    const long = 'x'.repeat(700)
    const out = resultPreview({ result: long }, 600)
    expect(out!.length).toBeLessThanOrEqual(601)
    expect(out!.endsWith('…')).toBe(true)
  })
})
