import { describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import type { Env } from '../src/types'

function makeEnv(): Env {
  const session = JSON.stringify({
    userId: 'owner-user',
    email: 'owner@example.test',
    role: 'owner',
    createdAt: '2026-07-10T00:00:00.000Z',
  })

  const db = {
    prepare(sql: string) {
      const statement = {
        bind(..._values: unknown[]) {
          return statement
        },
        async first<T>() {
          if (sql.includes('FROM invites')) {
            return {
              id: 'invite-1',
              email: 'operator@example.test',
              department_id: null,
              capability: 'admin',
              invited_by: 'owner-user',
              accepted_at: null,
              created_at: '2026-07-10T00:00:00.000Z',
            } as T
          }
          if (sql.includes('SELECT id, status FROM members')) return { id: 'member-1', status: 'active' } as T
          throw new Error(`unexpected first query: ${sql}`)
        },
        async run() {
          if (sql.includes('UPDATE invites SET accepted_at')) return { meta: { changes: 1 } }
          if (sql.includes('INSERT INTO member_tokens')) return { meta: { changes: 1 } }
          throw new Error(`unexpected run query: ${sql}`)
        },
      }
      return statement
    },
    async batch(_statements: unknown[]) {
      return [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }]
    },
  }

  return {
    TENANT_SLUG: 'test-tenant',
    DB: db,
    SESSIONS: {
      get: async (key: string) => (key === 'sess:owner-session' ? session : null),
      put: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as Env
}

function expectSensitiveTokenHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
}

describe('member token responses', () => {
  it('prevents caching or referrer leakage when an invite is redeemed', async () => {
    const res = await membersApp.request(
      '/invites/invite-1/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: 'Operator' }),
      },
      makeEnv(),
    )

    expect(res.status).toBe(201)
    expectSensitiveTokenHeaders(res)
    expect(((await res.json()) as { token: { raw: string } }).token.raw).toMatch(/^mupot_/)
  })

  it('prevents caching or referrer leakage when an administrator mints a token', async () => {
    const res = await membersApp.request(
      '/members/member-1/tokens',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'mupot_session=owner-session',
        },
        body: JSON.stringify({ label: 'host', channel: 'workspace' }),
      },
      makeEnv(),
    )

    expect(res.status).toBe(201)
    expectSensitiveTokenHeaders(res)
    expect(((await res.json()) as { token: { raw: string } }).token.raw).toMatch(/^mupot_/)
  })
})
