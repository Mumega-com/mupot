// tests/members-patch-and-agent-status-archived-refusal.test.ts —
// mupot#1496 Round 2/3: an archived row (archive_row('members') /
// archive_row('agents')) must not be silently reactivated through the
// ordinary status-toggle routes while archived_at stays set — unarchive_row
// is the only door out. Pins the two guards added to src/members/index.ts's
// PATCH /members/:id and src/org/service.ts's setAgentStatus.

import { afterEach, describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import { setAgentStatus } from '../src/org/service'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'test'

function ownerEnv(db: Env['DB']): Env {
  return {
    TENANT_SLUG: TENANT,
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

describe('PATCH /members/:id refuses an archived member (mupot#1496)', () => {
  let harness: SqliteD1Harness
  afterEach(() => harness.close())

  it('409 archived, row untouched, when archived_at IS NOT NULL', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('actor-member', ?1, 'actor@example.test', 'Actor', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, archived_at, archived_reason, archived_by_member_id, created_at)
       VALUES ('archived-member', ?1, 'archived@example.test', 'Archived', 'suspended', datetime('now'), 'test', 'actor-member', datetime('now'))`,
    ).bind(TENANT).run()

    const env = ownerEnv(harness.db)
    const res = await membersApp.request(
      '/members/archived-member',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'active' }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('archived')

    const row = await harness.db.prepare('SELECT status, archived_at FROM members WHERE id = ?1')
      .bind('archived-member').first<{ status: string; archived_at: string | null }>()
    expect(row?.status).toBe('suspended') // untouched
    expect(row?.archived_at).not.toBeNull()
  })

  it('a NON-archived member can still be patched normally', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    await harness.db.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('live-member', ?1, 'live@example.test', 'Live', 'active', datetime('now'))`,
    ).bind(TENANT).run()

    const env = ownerEnv(harness.db)
    const res = await membersApp.request(
      '/members/live-member',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: 'mupot_session=owner-session' },
        body: JSON.stringify({ status: 'suspended' }),
      },
      env,
    )
    expect(res.status).toBe(200)
  })
})

describe('setAgentStatus refuses an archived agent (mupot#1496)', () => {
  let harness: SqliteD1Harness
  afterEach(() => harness.close())

  it('returns {ok:false, error:"archived"} and leaves the row untouched', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'sq1-sqd', 'Squad One');
      INSERT INTO members (id, tenant, email, display_name, status) VALUES ('actor-member', 'test', 'actor@example.test', 'Actor', 'active');
      INSERT INTO agents (id, squad_id, slug, name, status, archived_at, archived_reason, archived_by_member_id)
        VALUES ('archived-agent', 'squad-1', 'ag1', 'Agent One', 'inactive', datetime('now'), 'test', 'actor-member');
    `)
    const env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    const result = await setAgentStatus(env, 'archived-agent', 'active')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('archived')

    const row = await harness.db.prepare('SELECT status FROM agents WHERE id = ?1').bind('archived-agent')
      .first<{ status: string }>()
    expect(row?.status).toBe('inactive') // untouched
  })

  it('a non-archived agent can still have its status toggled', async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Dept One');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-1', 'dept-1', 'sq1-sqd', 'Squad One');
      INSERT INTO agents (id, squad_id, slug, name, status) VALUES ('live-agent', 'squad-1', 'ag1', 'Agent One', 'active');
    `)
    const env = { TENANT_SLUG: TENANT, DB: harness.db } as unknown as Env
    const result = await setAgentStatus(env, 'live-agent', 'paused')
    expect(result.ok).toBe(true)
    const row = await harness.db.prepare('SELECT status FROM agents WHERE id = ?1').bind('live-agent')
      .first<{ status: string }>()
    expect(row?.status).toBe('paused')
  })
})
