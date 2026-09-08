// #1330 F-A — Kasra re-gate: migration 0040 adds members.tenant NULLABLE with no
// in-migration backfill (deliberate — a literal slug must not be baked into a
// fork). The only backfill is lazy and app-level (reportFleetAgents /
// getAgentView), so a legacy member row can sit with tenant IS NULL
// indefinitely until something else touches it. The F2 tenant predicate
// (`AND tenant = ?3`) made PATCH /members/:id silently miss these rows: a
// suspend against a tenant=NULL row returned 404 member_not_found and left
// the row ACTIVE — a failure-to-revoke, which is exactly the class #1318
// exists to close.
//
// Fix: match `(tenant = ?3 OR tenant IS NULL)` on every status write AND
// adopt the row by setting tenant = ?3 in the same statement — the same
// lazy backfill reportFleetAgents/getAgentView already perform, so the row
// is repaired on first touch instead of staying invisible forever.
import { afterEach, describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

describe('PATCH /members/:id — legacy tenant IS NULL rows (#1330 F-A)', () => {
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

  it('suspend succeeds against a tenant=NULL member, sets status AND adopts the tenant', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('legacy-member', NULL, 'legacy@example.test', 'Legacy', 'active', ?1)`,
    ).bind(now).run()

    const env = ownerEnv('tenant-a', harness.db)
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

    const row = await harness.db.prepare(
      'SELECT status, tenant FROM members WHERE id = ?1',
    ).bind('legacy-member').first<{ status: string; tenant: string | null }>()
    expect(row?.status).toBe('suspended')
    expect(row?.tenant).toBe('tenant-a')
  })

  it('reactivate succeeds against a tenant=NULL suspended member and adopts the tenant', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('legacy-member-2', NULL, 'legacy2@example.test', 'Legacy2', 'suspended', ?1)`,
    ).bind(now).run()

    const env = ownerEnv('tenant-a', harness.db)
    const res = await membersApp.request(
      '/members/legacy-member-2',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'active' }),
      },
      env,
    )
    expect(res.status).toBe(200)

    const row = await harness.db.prepare(
      'SELECT status, tenant FROM members WHERE id = ?1',
    ).bind('legacy-member-2').first<{ status: string; tenant: string | null }>()
    expect(row?.status).toBe('active')
    expect(row?.tenant).toBe('tenant-a')
  })

  it('a tenant=NULL row does NOT let a different tenant adopt a row already owned by a real tenant', async () => {
    // Control: tenant IS NULL matching must not become a wildcard once a row
    // already belongs to tenant-b — this only pins that the OR-NULL clause
    // doesn't regress the F2 cross-tenant refusal.
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('victim-member', 'tenant-b', 'victim@example.test', 'Victim', 'active', ?1)`,
    ).bind(now).run()

    const env = ownerEnv('tenant-a', harness.db)
    const res = await membersApp.request(
      '/members/victim-member',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'suspended' }),
      },
      env,
    )
    expect(res.status).toBe(404)
    const row = await harness.db.prepare(
      'SELECT status, tenant FROM members WHERE id = ?1',
    ).bind('victim-member').first<{ status: string; tenant: string | null }>()
    expect(row?.status).toBe('active')
    expect(row?.tenant).toBe('tenant-b')
  })

  // #1330 gate-followup (kasra-code, 2026-09-05) — GET /members/:id was strict
  // `tenant = ?2` while GET /members (list) and PATCH both match
  // `(tenant = ?N OR tenant IS NULL)`. A legacy row was listed but 404'd on
  // direct read: incoherent. Fixed to match the OR-NULL form too.
  it('GET /members/:id matches a legacy tenant=NULL row, consistent with the list endpoint', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('legacy-read', NULL, 'legacy-read@example.test', 'Legacy Read', 'active', ?1)`,
    ).bind(now).run()

    const env = ownerEnv('tenant-a', harness.db)
    const res = await membersApp.request(
      '/members/legacy-read',
      { method: 'GET', headers: { cookie: 'mupot_session=owner-session' } },
      env,
    )
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      member: expect.objectContaining({ id: 'legacy-read' }),
    })
  })

  it('GET /members/:id still refuses a different tenant\'s row', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('victim-read', 'tenant-b', 'victim-read@example.test', 'Victim Read', 'active', ?1)`,
    ).bind(now).run()

    const env = ownerEnv('tenant-a', harness.db)
    const res = await membersApp.request(
      '/members/victim-read',
      { method: 'GET', headers: { cookie: 'mupot_session=owner-session' } },
      env,
    )
    expect(res.status).toBe(404)
  })
})
