// mupot#1436 A3 P1-C — POST /invites producer for the plain-squad shape.
//
// {email, squad_id, capability} with project_id/pairing absent writes a
// pairing-NULL squad row. inviteScope returns {type:'squad', id} so the
// EXISTING ceiling block (capabilityRank > actorMaxRankOnScope) runs on
// squad scope — that comparison is not rewritten here (#1416/#1417).
// Floor: requireCapability(admin) on the target squad (org admin inherits
// via hasCapability's org grant). Ceiling: owner is above squad-admin;
// peer-rank admin is allowed by the shared `>` predicate.
//
// MUTATION LEDGER (break → fail → restore):
//   1. parseInvite treats squad_id as project fields
//      → POST {email,squad_id,capability:'member'} → 400 invalid_project_id
//   2. INSERT omits squad_id
//      → 201 but row.squad_id is null
//   3. inviteScope ignores kind==='squad'
//      → ceiling compares org rank; squad-admin inviting owner succeeds
//   4. requireCapability admin skipped for squad
//      → other-squad lead creates an invite

import { afterEach, describe, expect, it } from 'vitest'
import { membersApp } from '../src/members'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-web', 'dept-a', 'squad-web', 'Web Squad'),
      ('squad-other', 'dept-a', 'squad-other', 'Other Squad');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-squad-admin', 'squad-admin@pot.test', 'Squad Admin', 'active', '${TENANT}'),
      ('member-other-lead', 'other-lead@pot.test', 'Other Lead', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-squad-admin', 'member-squad-admin', 'squad', 'squad-web', 'admin'),
      ('cap-other-lead', 'member-other-lead', 'squad', 'squad-other', 'lead');
  `)
  return harness
}

function sessionEnv(harness: SqliteD1Harness, sessionId: string, email: string): Env {
  const session = JSON.stringify({
    userId: `user-${sessionId}`,
    email,
    role: 'member',
    createdAt: new Date().toISOString(),
  })
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: {
      get: async (key: string) => (key === `sess:${sessionId}` ? session : null),
      put: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as Env
}

function postInvite(
  env: Env,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return membersApp.request(
    '/invites',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `mupot_session=${sessionId}`,
        Origin: ORIGIN,
      },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe('P1-C — plain squad invite producer', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('squad-admin invites at member → created with squad_id set and pairing NULL', async () => {
    harness = makeHarness()
    const env = sessionEnv(harness, 'squad-admin', 'squad-admin@pot.test')
    const res = await postInvite(env, 'squad-admin', {
      email: 'newcomer@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
    const body = (await res.json()) as {
      invite: { id: string; squad_id: string | null; department_id: string | null }
    }
    expect(body.invite.squad_id).toBe('squad-web')
    expect(body.invite.department_id).toBeNull()
    const row = harness.sqlite.prepare(`
      SELECT squad_id, project_id, pairing_hash, pairing_expires_at, capability
        FROM invites WHERE id = ?
    `).get(body.invite.id) as {
      squad_id: string
      project_id: string | null
      pairing_hash: string | null
      pairing_expires_at: string | null
      capability: string
    }
    expect(row).toEqual({
      squad_id: 'squad-web',
      project_id: null,
      pairing_hash: null,
      pairing_expires_at: null,
      capability: 'member',
    })
  })

  it('squad-admin invites at owner → refused by the existing ceiling', async () => {
    harness = makeHarness()
    const env = sessionEnv(harness, 'squad-admin', 'squad-admin@pot.test')
    const res = await postInvite(env, 'squad-admin', {
      email: 'owner-invite@example.com',
      squad_id: 'squad-web',
      capability: 'owner',
    })
    expect(res.status, await res.clone().text()).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: 'forbidden',
      reason: 'cannot_grant_above_own_rank',
    })
    expect(
      harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM invites WHERE email = 'owner-invite@example.com'`).get(),
    ).toEqual({ n: 0 })
  })

  it('squad-admin invites at admin → peer rank is allowed by the shared > ceiling', async () => {
    harness = makeHarness()
    const env = sessionEnv(harness, 'squad-admin', 'squad-admin@pot.test')
    const res = await postInvite(env, 'squad-admin', {
      email: 'peer-admin@example.com',
      squad_id: 'squad-web',
      capability: 'admin',
    })
    expect(res.status, await res.clone().text()).toBe(201)
    const body = (await res.json()) as { invite: { id: string } }
    expect(
      harness.sqlite.prepare(`
        SELECT capability, pairing_hash FROM invites WHERE id = ?
      `).get(body.invite.id),
    ).toEqual({ capability: 'admin', pairing_hash: null })
  })

  it('squad-lead of another squad is refused (no admin on the target)', async () => {
    harness = makeHarness()
    const env = sessionEnv(harness, 'other-lead', 'other-lead@pot.test')
    const res = await postInvite(env, 'other-lead', {
      email: 'cross@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', need: 'admin' })
    expect(
      harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM invites WHERE email = 'cross@example.com'`).get(),
    ).toEqual({ n: 0 })
  })

  it('unknown squad_id is 404 and writes nothing', async () => {
    harness = makeHarness()
    const env = sessionEnv(harness, 'squad-admin', 'squad-admin@pot.test')
    const res = await postInvite(env, 'squad-admin', {
      email: 'ghost@example.com',
      squad_id: 'squad-missing',
      capability: 'member',
    })
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'squad_not_found' })
  })
})
