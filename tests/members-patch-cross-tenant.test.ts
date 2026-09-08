// #1330 F2 — Kasra-review BLOCK: PATCH /members/:id (and its supporting GET)
// ran `UPDATE members SET status = ? WHERE id = ?` / `SELECT ... WHERE id = ?`
// with NO tenant predicate, while the sibling web_sessions UPDATE in the same
// batch IS tenant-scoped. An org admin authenticated against tenant A could
// suspend or reactivate — or simply read — a member belonging to tenant B by
// guessing/enumerating its id. This pins both the refusal AND that the
// victim's row is left completely unchanged (not just a status-code check).
import { afterEach, describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

describe('PATCH/GET /members/:id — tenant isolation (#1330 F2)', () => {
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

  it('an admin of tenant A cannot suspend a member of tenant B by id', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('victim-member', 'tenant-b', 'victim@example.test', 'Victim', 'active', ?1)`,
    ).bind(now).run()

    const envA = ownerEnv('tenant-a', harness.db)

    const res = await membersApp.request(
      '/members/victim-member',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'suspended' }),
      },
      envA,
    )
    // Refused: no row in tenant-a matched the id, so this is member_not_found —
    // it must NOT be treated as success.
    expect(res.status).toBe(404)

    const victim = await harness.db.prepare(
      'SELECT status FROM members WHERE id = ?1',
    ).bind('victim-member').first<{ status: string }>()
    expect(victim?.status).toBe('active') // UNCHANGED — assert the row, not just the status code.
  })

  it('an admin of tenant A cannot reactivate a suspended member of tenant B by id', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('victim-member-2', 'tenant-b', 'victim2@example.test', 'Victim2', 'suspended', ?1)`,
    ).bind(now).run()

    const envA = ownerEnv('tenant-a', harness.db)

    const res = await membersApp.request(
      '/members/victim-member-2',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'active' }),
      },
      envA,
    )
    expect(res.status).toBe(404)

    const victim = await harness.db.prepare(
      'SELECT status FROM members WHERE id = ?1',
    ).bind('victim-member-2').first<{ status: string }>()
    expect(victim?.status).toBe('suspended') // UNCHANGED
  })

  it('GET /members/:id cannot read a member belonging to a different tenant', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('victim-member-3', 'tenant-b', 'victim3@example.test', 'Victim3', 'active', ?1)`,
    ).bind(now).run()

    const envA = ownerEnv('tenant-a', harness.db)
    const res = await membersApp.request(
      '/members/victim-member-3',
      { headers: { cookie: 'mupot_session=owner-session' } },
      envA,
    )
    expect(res.status).toBe(404)
  })

  it('same-tenant suspend still works (control, guards against an over-broad tenant scope)', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const now = '2026-09-05T00:00:00.000Z'
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('local-member', 'tenant-a', 'local@example.test', 'Local', 'active', ?1)`,
    ).bind(now).run()

    const envA = ownerEnv('tenant-a', harness.db)
    const res = await membersApp.request(
      '/members/local-member',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'suspended' }),
      },
      envA,
    )
    expect(res.status).toBe(200)
    const member = await harness.db.prepare(
      'SELECT status FROM members WHERE id = ?1',
    ).bind('local-member').first<{ status: string }>()
    expect(member?.status).toBe('suspended')
  })
})
