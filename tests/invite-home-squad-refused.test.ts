// mupot#1551 round 2 (adversarial P1-3, PR #1559) — refuse an invite onto a
// `kind='home'` squad, both at creation (POST /invites) and at redemption
// (acceptInvite).
//
// EVERY member holds an exact-match 'admin' capability grant on their own
// home squad (createHomeForMember, src/org/service.ts) — that is what makes
// a home squad theirs at all. Before this fix, `parseInvite`'s squad branch
// (src/members/index.ts) only checked that the target squad EXISTS, never
// its `kind` — so ANY member, using nothing but the standing admin grant
// every member already has on their own home squad, could POST /invites
// {email, squad_id: <their own home squad>, capability: 'member'} and mint a
// tenant member row for an ARBITRARY email. That is the mupot#1551 squat
// primitive itself (an identity-less member row someone controls a token
// for), reachable self-service with no other capability at all.
// `createProjectInvite` (src/members/project-invites.ts) already refuses
// exactly this shape for its own door (`home_scope_not_invitable`) — this
// closes the SAME gap in the plain-invite door, with the SAME error name.
//
// MUTATION LEDGER (each mutated in place, confirmed RED, restored, `git
// diff` verified clean):
//   1. Drop the `squad.kind === 'home'` check in parseInvite
//      → RED: "creates an invite onto one's own home squad" test (now 201
//        instead of 403).
//   2. Drop the `squad?.kind === 'home'` check in acceptInvite
//      → RED: "accepts a pre-existing home-squad invite" test (a home-squad
//        invite planted directly in D1, bypassing the creation-time refusal
//        above, would still mint).

import { afterEach, describe, expect, it } from 'vitest'
import { acceptInvite, membersApp } from '../src/members'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'

function baseHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name, kind) VALUES
      ('squad-member-home', 'dept-a', 'member-home', 'Member Home', 'home'),
      ('squad-work', 'dept-a', 'squad-work', 'Work Squad', 'work');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-x', 'memberx@pot.test', 'Member X', 'active', '${TENANT}');
    -- Every member is exact-match admin on their OWN home squad —
    -- createHomeForMember's own grant, seeded directly here.
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-member-x-home', 'member-x', 'squad', 'squad-member-home', 'admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    SESSIONS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as Env
}

function sessionEnv(harness: SqliteD1Harness): Env {
  const session = JSON.stringify({
    userId: 'user-member-x',
    email: 'memberx@pot.test',
    role: 'member',
    createdAt: new Date().toISOString(),
  })
  return {
    ...envFor(harness),
    SESSIONS: {
      get: async (key: string) => (key === 'sess:member-x' ? session : null),
      put: async () => undefined,
      delete: async () => undefined,
    },
  } as unknown as Env
}

function postInvite(env: Env, body: Record<string, unknown>): Promise<Response> {
  return membersApp.request(
    '/invites',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: 'mupot_session=member-x',
        Origin: ORIGIN,
      },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe('mupot#1551 round 2 — invites onto a home squad are refused', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('creates an invite onto ONE\'S OWN home squad — refused (the squat primitive)', async () => {
    harness = baseHarness()
    const res = await postInvite(sessionEnv(harness), {
      email: 'squatted-target@example.com',
      squad_id: 'squad-member-home',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(403)
    expect((await res.json()) as { error: string }).toEqual({ error: 'home_scope_not_invitable' })
    const count = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM invites`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('creates an invite onto an ordinary WORK squad — unaffected, 201', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-member-x-work', 'member-x', 'squad', 'squad-work', 'admin');
    `)
    const res = await postInvite(sessionEnv(harness), {
      email: 'newcomer@example.com',
      squad_id: 'squad-work',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('accepts a pre-existing home-squad invite (planted directly in D1, bypassing creation) — refused', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
        VALUES ('cap-member-x-home-admin', 'member-x', 'org', NULL, 'admin');
      INSERT INTO invites (id, email, squad_id, capability, invited_by)
        VALUES ('inv-home', 'squatted-target@example.com', 'squad-member-home', 'member', 'member-x');
    `)
    const result = await acceptInvite(envFor(harness), 'inv-home', 'Squatted Target')
    expect(result).toEqual({ ok: false, error: 'home_scope_not_invitable' })
    const members = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE id != 'member-x'`).get() as { n: number }
    expect(members.n).toBe(0)
  })

  it('via the real POST /invites/:id/accept route (membersApp) — 403 body shape', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, squad_id, capability, invited_by)
        VALUES ('inv-home-http', 'squatted-target2@example.com', 'squad-member-home', 'member', 'member-x');
    `)
    const res = await membersApp.request(
      '/invites/inv-home-http/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: 'Squatted Target' }),
      },
      envFor(harness),
    )
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toEqual({ error: 'home_scope_not_invitable' })
  })
})
