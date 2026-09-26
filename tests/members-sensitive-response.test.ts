import { describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import { dashboardApp } from '../src/dashboard'
import { assertNoRawToken } from './helpers/assert-no-raw-token'
import type { Env } from '../src/types'

function makeEnv(options: {
  publicOrigin?: string
  writes?: string[]
} = {}): Env {
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
          if (sql.includes('SELECT status FROM members') && sql.includes('lower(email)')) {
            return { status: 'active' } as T
          }
          if (sql.includes('FROM invites')) {
            return {
              id: 'invite-1',
              email: 'operator@example.test',
              department_id: null,
              project_id: null,
              squad_id: null,
              pairing_hash: null,
              pairing_expires_at: null,
              capability: 'admin',
              invited_by: 'owner-user',
              accepted_at: null,
              created_at: '2026-07-10T00:00:00.000Z',
            } as T
          }
          if (sql.includes('SELECT id, status FROM members')) return { id: 'member-1', status: 'active' } as T
          if (sql.includes('SELECT id, display_name FROM members')) {
            return { id: 'member-1', display_name: 'Operator' } as T
          }
          // #1457 (round 1 + round 2): acceptInvite's own existing-member
          // resolution (src/members/index.ts) — matched on
          // 'human_login_identities' (unique to this query in this mock's
          // universe), a narrower signal than the generic 'FROM members' +
          // 'lower(email)' catch-all below, which would otherwise wrongly
          // match this query too and hand back that fixture's `{email:null}`
          // shape (no `status`/`tenant`), making this test's brand-new
          // invite email look like a member belonging to a foreign/
          // undefined tenant. This test's invite email
          // ('operator@example.test') is brand new — no existing member —
          // so the fresh-mint path this test exercises stays reachable.
          if (sql.includes('human_login_identities') && sql.includes('FROM members')) {
            return null
          }
          // mupot#1411 P0-A round 4 (kasra-review, 2026-09-15):
          // targetMaxRankAcrossScopes now also folds in the target's
          // role-plane rank via targetLegacyRoleRank, bridged by email
          // (members.email -> users.role) — a new `.first()` this stub must
          // declare. `email: null` = "no bridge, no role-plane standing",
          // matching this test's [] capability-grants fixture (target holds
          // nothing anywhere; its subject is response headers, not authz).
          if (sql.includes('FROM members') && sql.includes('lower(email)')) return { email: null } as T
          throw new Error(`unexpected first query: ${sql}`)
        },
        // mupot#1411 P0-1 (kasra-review, 2026-09-15): the mint route's
        // targetRankCeiling now consults the TARGET's standing across EVERY
        // scope (targetMaxRankAcrossScopes, via the SAME resolveCapabilities
        // query every capability check reuses), not one (scope_type,
        // scope_id) row via `.first()` — so the ceiling's own lookup is now
        // an `.all()` call. This stub is an exact-sequence allowlist, so the
        // new query shape has to be declared here or every mint 500s.
        //
        // Returning [] = "target holds no grant anywhere", which is the
        // right fixture for THIS test: its subject is caching/referrer
        // headers on a successful mint, not authorization. The ceiling
        // itself is covered against the real migration chain in
        // tests/members-agent-capability-route.test.ts.
        async all<T>() {
          if (sql.includes('SELECT member_id, scope_type, scope_id, capability') && sql.includes('FROM capabilities')) {
            return { results: [] as T[] }
          }
          throw new Error(`unexpected all query: ${sql}`)
        },
        async run() {
          if (sql.includes('UPDATE invites SET accepted_at')) return { meta: { changes: 1 } }
          if (sql.includes('INSERT INTO member_tokens')) {
            options.writes?.push(sql)
            return { meta: { changes: 1 } }
          }
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
    BRAND: 'Test',
    OAUTH_PROVIDER: 'google',
    PUBLIC_ORIGIN: options.publicOrigin,
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
    // mupot#1436 round 2 P1-C: this is the JSON path, which DOES hand the raw
    // token back on purpose — assert it appears in the body EXACTLY ONCE and
    // nowhere else (no header leak, e.g. a stray debug `X-Mupot-Token`).
    await assertNoRawToken(res, undefined, { allowedInBody: 1 })
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

  it('pins every rendered endpoint despite a malicious request host', async () => {
    const writes: string[] = []
    const res = await dashboardApp.fetch(
      new Request('https://evil.example/members/member-1/tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'mupot_session=owner-session',
          origin: 'https://evil.example',
        },
        body: new URLSearchParams({ label: 'host', channel: 'workspace' }),
      }),
      makeEnv({ publicOrigin: 'https://pot.example', writes }),
    )

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('https://pot.example/mcp')
    expect(body).not.toContain('evil.example')
    expect(writes).toHaveLength(1)
  })

  it('fails before minting when PUBLIC_ORIGIN is absent', async () => {
    const writes: string[] = []
    const res = await dashboardApp.fetch(
      new Request('https://evil.example/members/member-1/tokens', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'mupot_session=owner-session',
          origin: 'https://evil.example',
        },
        body: new URLSearchParams({ label: 'host', channel: 'workspace' }),
      }),
      makeEnv({ writes }),
    )

    expect(res.status).toBe(503)
    expect(await res.text()).toContain('public origin')
    expect(writes).toEqual([])
  })
})
