import { describe, expect, it } from 'vitest'
import {
  resolveActiveAgentMember,
  upsertCapabilityGrant,
} from '../src/members/service'
import { membersApp } from '../src/members'
import type { Capability, CapabilityGrant, Env } from '../src/types'

interface StatementRecord {
  sql: string
  values: unknown[]
}

interface ServiceDbOptions {
  identityRows?: { member_id: string }[]
  existingCapabilities?: Capability[]
  batchResults?: { meta: { changes: number }; results?: { capability: Capability }[] }[]
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
            async first<T>() {
              if (sql.includes('SELECT capability FROM capabilities')) {
                const capability = options.existingCapabilities?.[0]
                return (capability === undefined ? null : { capability }) as T | null
              }
              throw new Error(`unexpected first query: ${sql}`)
            },
            async all<T>() {
              if (sql.includes('FROM member_tokens t')) {
                return { results: (options.identityRows ?? []) as T[] }
              }
              if (sql.includes('SELECT capability FROM capabilities')) {
                return {
                  results: (options.existingCapabilities ?? []).map((capability) => ({ capability })) as T[],
                }
              }
              throw new Error(`unexpected all query: ${sql}`)
            },
          }
        },
      }
    },
    async batch(batch: StatementRecord[]) {
      batches.push(batch)
      return options.batchResults ?? [
        {
          meta: { changes: options.existingCapabilities?.length ?? 0 },
          results: (options.existingCapabilities ?? []).map((capability) => ({ capability })),
        },
        { meta: { changes: 1 }, results: [] },
      ]
    },
  }

  return {
    env: { TENANT_SLUG: 'tenant-a', DB: db } as unknown as Env,
    statements,
    batches,
  }
}

function makeGrantRouteEnv(existingCapabilities: Capability[]): Env {
  const session = JSON.stringify({
    userId: 'owner-user',
    email: 'owner@example.test',
    role: 'owner',
    createdAt: '2026-07-12T00:00:00.000Z',
  })
  const db = {
    prepare(sql: string) {
      const statement = {
        bind(..._values: unknown[]) {
          return statement
        },
        async first<T>() {
          if (sql.includes('SELECT id FROM members')) return { id: 'member-1' } as T
          if (sql.includes('SELECT capability FROM capabilities')) {
            const capability = existingCapabilities[0]
            return (capability === undefined ? null : { capability }) as T | null
          }
          throw new Error(`unexpected first query: ${sql}`)
        },
        async all<T>() {
          if (sql.includes('SELECT capability FROM capabilities')) {
            return { results: existingCapabilities.map((capability) => ({ capability })) as T[] }
          }
          throw new Error(`unexpected all query: ${sql}`)
        },
      }
      return statement
    },
    async batch(_statements: unknown[]) {
      return [
        {
          meta: { changes: existingCapabilities.length },
          results: existingCapabilities.map((capability) => ({ capability })),
        },
        { meta: { changes: 1 }, results: [] },
      ]
    },
  }

  return {
    TENANT_SLUG: 'tenant-a',
    DB: db,
    SESSIONS: {
      get: async (key: string) => (key === 'sess:owner-session' ? session : null),
      put: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as Env
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
    const { env, batches } = makeServiceDb()

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
    const { env } = makeServiceDb({ existingCapabilities: ['observer'] })

    await expect(upsertCapabilityGrant(env, squadGrant)).resolves.toEqual({
      grant: squadGrant,
      result: 'updated',
    })
  })

  it('returns unchanged when the existing grant has the requested capability', async () => {
    const { env } = makeServiceDb({ existingCapabilities: ['member'] })

    await expect(upsertCapabilityGrant(env, squadGrant)).resolves.toEqual({
      grant: squadGrant,
      result: 'unchanged',
    })
  })

  it('checks the inserted grant receipt without requiring the delete to remove a row', async () => {
    const { env } = makeServiceDb({
      batchResults: [{ meta: { changes: 0 } }, { meta: { changes: 0 } }],
    })

    await expect(upsertCapabilityGrant(env, squadGrant)).rejects.toThrow(
      'receipt_failed: upsert_capability_grant[0]',
    )
  })

  it('returns updated while consolidating duplicate org grants that include the requested capability', async () => {
    const orgGrant: CapabilityGrant = {
      member_id: 'member-1',
      scope_type: 'org',
      scope_id: null,
      capability: 'member',
    }
    const { env, batches } = makeServiceDb({
      existingCapabilities: ['member', 'observer'],
    })

    await expect(upsertCapabilityGrant(env, orgGrant)).resolves.toEqual({
      grant: orgGrant,
      result: 'updated',
    })

    expect(batches).toHaveLength(1)
    expect(batches[0][0].sql).toContain('scope_id IS NULL')
    expect(batches[0][0].sql).toContain('RETURNING capability')
    expect(batches[0][0].values).toEqual(['member-1', 'org'])
  })
})

describe('POST /members/:id/capabilities', () => {
  it('returns the shared upsert result after consolidating duplicate org grants', async () => {
    const res = await membersApp.request(
      '/members/member-1/capabilities',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'mupot_session=owner-session',
        },
        body: JSON.stringify({ scope_type: 'org', capability: 'member' }),
      },
      makeGrantRouteEnv(['member', 'observer']),
    )

    expect(res.status).toBe(201)
    await expect(res.json()).resolves.toEqual({
      grant: {
        member_id: 'member-1',
        scope_type: 'org',
        scope_id: null,
        capability: 'member',
      },
      action: 'grant',
      result: 'updated',
    })
  })
})
