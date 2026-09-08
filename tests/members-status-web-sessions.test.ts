import { afterEach, describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import { createWebSession, loadWebSession } from '../src/auth/web-sessions'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

describe('PATCH /members/:id web-session liveness', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness.close())

  it('revokes live web sessions when suspending a member', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-1', 'tenant-a', 'member@example.test', 'Member', 'active', ?1)`,
    ).bind(now).run()
    await harness.db.prepare(
      `INSERT INTO human_login_identities
         (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
       VALUES ('identity-1', 'tenant-a', 'google', 'subject-1', 'member@example.test', 'member-1', ?1)`,
    ).bind(now).run()
    await createWebSession(
      { TENANT_SLUG: 'tenant-a', DB: harness.db } as unknown as Env,
      'raw-member-session',
      { tenant: 'tenant-a', memberId: 'member-1', loginIdentityId: 'identity-1' },
      Date.parse(now),
    )

    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: harness.db,
      SESSIONS: {
        get: async (key: string) => (
          key === 'sess:owner-session'
            ? JSON.stringify({
                userId: 'owner-user',
                email: 'owner@example.test',
                role: 'owner',
                createdAt: now,
              })
            : null
        ),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env

    const res = await membersApp.request(
      '/members/member-1',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: 'mupot_session=owner-session',
        },
        body: JSON.stringify({ status: 'suspended' }),
      },
      env,
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      member_id: 'member-1',
      status: 'suspended',
      sessions_revoked: 1,
    })
    await expect(loadWebSession(env, 'tenant-a', 'raw-member-session')).resolves.toEqual({
      ok: false,
      reason: 'revoked',
    })
  })

  it('still suspends the member when web_sessions is not migrated yet', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec('DROP TABLE web_sessions')
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('member-1', 'tenant-a', 'member@example.test', 'Member', 'active', ?1)`,
    ).bind(now).run()

    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: harness.db,
      SESSIONS: {
        get: async (key: string) => (
          key === 'sess:owner-session'
            ? JSON.stringify({
                userId: 'owner-user',
                email: 'owner@example.test',
                role: 'owner',
                createdAt: now,
              })
            : null
        ),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env

    const res = await membersApp.request(
      '/members/member-1',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: 'mupot_session=owner-session',
        },
        body: JSON.stringify({ status: 'suspended' }),
      },
      env,
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      member_id: 'member-1',
      status: 'suspended',
      sessions_revoked: 0,
    })
    const member = await env.DB.prepare(
      'SELECT status FROM members WHERE id = ?1',
    ).bind('member-1').first<{ status: string }>()
    expect(member?.status).toBe('suspended')
  })
})

// #1330 F-C — the catch-fallback rung (degraded-schema branch, web_sessions
// missing) had its own `UPDATE members ... AND tenant = ?3` bound copy of the
// F2 fix, silently reverted independent of the batch path. 11/11 tests stayed
// green with it reverted because no existing test drove a CROSS-TENANT
// suspend down the degraded-schema branch specifically. This pins that rung.
describe('PATCH /members/:id catch-fallback tenant scoping (#1330 F-C)', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness.close())

  it('cannot cross-tenant-suspend via the degraded-schema (missing web_sessions) fallback', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec('DROP TABLE web_sessions')
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('victim-degraded', 'tenant-b', 'victim@example.test', 'Victim', 'active', ?1)`,
    ).bind(now).run()

    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: harness.db,
      SESSIONS: {
        get: async (key: string) => (
          key === 'sess:owner-session'
            ? JSON.stringify({
                userId: 'owner-user',
                email: 'owner@example.test',
                role: 'owner',
                createdAt: now,
              })
            : null
        ),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env

    const res = await membersApp.request(
      '/members/victim-degraded',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'suspended' }),
      },
      env,
    )
    expect(res.status).toBe(404)
    const row = await harness.db.prepare(
      'SELECT status FROM members WHERE id = ?1',
    ).bind('victim-degraded').first<{ status: string }>()
    expect(row?.status).toBe('active')
  })
})

// #1330 gate-followup (kasra-code, 2026-09-05) — the catch-fallback rung
// (src/members/index.ts:497, degraded-schema / missing web_sessions branch)
// was pinned above only for the NEGATIVE cross-tenant case. No test proved
// the POSITIVE side: a legacy `tenant IS NULL` row actually gets adopted and
// suspended via this exact fallback rung. Fixture forces the branch the same
// way as the test above it (DROP TABLE web_sessions).
describe('PATCH /members/:id catch-fallback legacy tenant IS NULL adoption (#1330 F-C positive)', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness.close())

  it('adopts and suspends a legacy tenant-IS-NULL row via the degraded-schema fallback', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec('DROP TABLE web_sessions')
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('legacy-member', NULL, 'legacy@example.test', 'Legacy', 'active', ?1)`,
    ).bind(now).run()

    const env = {
      TENANT_SLUG: 'tenant-a',
      DB: harness.db,
      SESSIONS: {
        get: async (key: string) => (
          key === 'sess:owner-session'
            ? JSON.stringify({
                userId: 'owner-user',
                email: 'owner@example.test',
                role: 'owner',
                createdAt: now,
              })
            : null
        ),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env

    const res = await membersApp.request(
      '/members/legacy-member',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'suspended' }),
      },
      env,
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      member_id: 'legacy-member',
      status: 'suspended',
      sessions_revoked: 0,
    })
    const row = await harness.db.prepare(
      'SELECT status, tenant FROM members WHERE id = ?1',
    ).bind('legacy-member').first<{ status: string; tenant: string | null }>()
    expect(row?.status).toBe('suspended')
    expect(row?.tenant).toBe('tenant-a')
  })
})
