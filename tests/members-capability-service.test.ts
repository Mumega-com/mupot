import { describe, expect, it } from 'vitest'
import {
  resolveActiveAgentMember,
  upsertCapabilityGrant,
} from '../src/members/service'
import type { Capability, CapabilityGrant, Env } from '../src/types'

interface StatementRecord {
  sql: string
  values: unknown[]
}

interface ServiceDbOptions {
  identityRows?: { member_id: string }[]
  existingCapability?: Capability | null
  batchResults?: { meta: { changes: number } }[]
}

function makeServiceDb(options: ServiceDbOptions = {}) {
  const statements: StatementRecord[] = []
  const batches: StatementRecord[][] = []

  const db = {
    prepare(sql: string) {
      const record: StatementRecord = { sql, values: [] }
      statements.push(record)
      return {
        bind(...values: unknown[]) {
          record.values = values
          return {
            ...record,
            async all<T>() {
              if (sql.includes('FROM member_tokens t')) {
                return { results: (options.identityRows ?? []) as T[] }
              }
              throw new Error(`unexpected all query: ${sql}`)
            },
            async first<T>() {
              if (sql.includes('SELECT capability FROM capabilities')) {
                return (options.existingCapability === undefined || options.existingCapability === null
                  ? null
                  : { capability: options.existingCapability }) as T | null
              }
              throw new Error(`unexpected first query: ${sql}`)
            },
          }
        },
      }
    },
    async batch(batch: StatementRecord[]) {
      batches.push(batch)
      return options.batchResults ?? [{ meta: { changes: 0 } }, { meta: { changes: 1 } }]
    },
  }

  return {
    env: { TENANT_SLUG: 'tenant-a', DB: db } as unknown as Env,
    statements,
    batches,
  }
}

const squadGrant: CapabilityGrant = {
  member_id: 'member-1',
  scope_type: 'squad',
  scope_id: 'squad-1',
  capability: 'member',
}

describe('resolveActiveAgentMember', () => {
  it('returns the member holding one active agent token', async () => {
    const { env } = makeServiceDb({ identityRows: [{ member_id: 'member-1' }] })

    await expect(resolveActiveAgentMember(env, 'agent-1')).resolves.toBe('member-1')
  })

  it('resolves multiple active tokens for the same member to that member', async () => {
    const { env } = makeServiceDb({ identityRows: [{ member_id: 'member-1' }] })

    await expect(resolveActiveAgentMember(env, 'agent-1')).resolves.toBe('member-1')
  })

  it('returns unminted when no active member identity exists', async () => {
    const { env } = makeServiceDb()

    await expect(resolveActiveAgentMember(env, 'agent-1')).resolves.toBe('unminted')
  })

  it('returns ambiguous when active tokens resolve to distinct members', async () => {
    const { env } = makeServiceDb({
      identityRows: [{ member_id: 'member-1' }, { member_id: 'member-2' }],
    })

    await expect(resolveActiveAgentMember(env, 'agent-1')).resolves.toBe('ambiguous')
  })

  it('uses a tenant-bound query that filters revoked tokens and inactive members', async () => {
    const { env, statements } = makeServiceDb({ identityRows: [{ member_id: 'member-1' }] })

    await resolveActiveAgentMember(env, 'agent-1')

    const query = statements.find(({ sql }) => sql.includes('FROM member_tokens t'))
    expect(query).toBeDefined()
    expect(query?.sql).toContain('t.tenant = ?')
    expect(query?.sql).toContain('t.agent_id = ?')
    expect(query?.sql).toContain('t.revoked_at IS NULL')
    expect(query?.sql).toContain('m.tenant = ?')
    expect(query?.sql).toContain("m.status = 'active'")
    expect(query?.sql).toContain('SELECT DISTINCT t.member_id')
    expect(query?.sql).toContain('ORDER BY t.member_id')
    expect(query?.sql).toContain('LIMIT 2')
    expect(query?.values).toEqual(['tenant-a', 'agent-1', 'tenant-a'])
  })
})

describe('upsertCapabilityGrant', () => {
  it('returns created and persists a missing grant with a single delete-then-insert batch', async () => {
    const { env, batches } = makeServiceDb({ existingCapability: null })

    await expect(upsertCapabilityGrant(env, squadGrant)).resolves.toEqual({
      grant: squadGrant,
      result: 'created',
    })

    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
    expect(batches[0][0].sql).toContain('DELETE FROM capabilities')
    expect(batches[0][0].values).toEqual(['member-1', 'squad', 'squad-1'])
    expect(batches[0][1].sql).toContain('INSERT INTO capabilities')
    expect(batches[0][1].values.slice(1)).toEqual([
      'member-1',
      'squad',
      'squad-1',
      'member',
    ])
  })

  it('returns updated when the existing grant has a different capability', async () => {
    const { env } = makeServiceDb({ existingCapability: 'observer' })

    await expect(upsertCapabilityGrant(env, squadGrant)).resolves.toEqual({
      grant: squadGrant,
      result: 'updated',
    })
  })

  it('returns unchanged when the existing grant has the requested capability', async () => {
    const { env } = makeServiceDb({ existingCapability: 'member' })

    await expect(upsertCapabilityGrant(env, squadGrant)).resolves.toEqual({
      grant: squadGrant,
      result: 'unchanged',
    })
  })

  it('checks the inserted grant receipt without requiring the delete to remove a row', async () => {
    const { env } = makeServiceDb({
      existingCapability: null,
      batchResults: [{ meta: { changes: 0 } }, { meta: { changes: 0 } }],
    })

    await expect(upsertCapabilityGrant(env, squadGrant)).rejects.toThrow(
      'receipt_failed: upsert_capability_grant[0]',
    )
  })
})
