// #1330 F-B — GET /members (and its dashboard/keys.ts siblings) ran an
// unscoped `SELECT ... FROM members ORDER BY ...` six lines above the by-id
// GET that F2 already scoped: full cross-tenant enumeration, no id guessing
// required. This pins that the list only returns rows belonging to the
// caller's tenant (plus legacy tenant IS NULL rows, matching the F-A
// adoption-on-write fix).
import { afterEach, describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

describe('GET /members — tenant isolation (#1330 F-B)', () => {
  let harness: SqliteD1Harness

  afterEach(() => harness.close())

  function ownerEnv(tenant: string, db: Env['DB']): Env {
    return {
      TENANT_SLUG: tenant,
      DB: db,
      SESSIONS: {
        get: async (key: string) =>
          key === 'sess:owner-session'
            ? JSON.stringify({
                userId: 'owner-user',
                email: 'owner@example.test',
                role: 'owner',
                createdAt: '2026-09-05T00:00:00.000Z',
              })
            : null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env
  }

  it('does not list another tenant\'s members', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('local-member', 'tenant-a', 'local@example.test', 'Local', 'active', ?1)`,
    ).bind(now).run()
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('foreign-member', 'tenant-b', 'foreign@example.test', 'Foreign', 'active', ?1)`,
    ).bind(now).run()

    const envA = ownerEnv('tenant-a', harness.db)
    const res = await membersApp.request(
      '/members',
      { headers: { cookie: 'mupot_session=owner-session' } },
      envA,
    )
    expect(res.status).toBe(200)
    const body = await res.json<{ members: Array<{ id: string }> }>()
    const ids = body.members.map((m) => m.id)
    expect(ids).toContain('local-member')
    expect(ids).not.toContain('foreign-member')
  })
})
