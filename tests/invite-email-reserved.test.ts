// mupot#1551 slice 2 — refuse a new plain invite onto a "squatted" member row:
// zero LIVE human_login_identities (nobody has ever proven they own this
// email) AND at least one LIVE member_tokens row (someone already holds a
// bearer for it). This is the enabler mupot#1457/#1550's adversarial gate
// traced a takeover to — see RESERVED_INVITE_EMAIL_SQL's own comment in
// src/members/index.ts for the full shape and why an org-admin bypass exists.
//
// The predicate lives in ONE exported SQL fragment
// (RESERVED_INVITE_EMAIL_SQL), used verbatim by both the JS pre-check
// (isInviteEmailReserved, fails fast with a clean 409) and the creating
// INSERT's own guard (`INSERT ... SELECT ... WHERE ?=1 OR NOT EXISTS(...)`).
// The guard re-evaluates the fragment fresh, in the same statement as the
// write, so it is authoritative on its own — but the pre-check and the write
// are still two separate round trips, so the SAME race class as slice 1
// applies (something squats the row in the gap between them); see the race
// test below.
//
// MUTATION LEDGER (each mutated in place, confirmed RED, restored, `git diff`
// verified clean):
//   1. Drop the `NOT EXISTS (human_login_identities...)` conjunct
//      → RED: "member with a verified identity AND a live token — NOT
//        reserved" (a real, identity-proven member would start being
//        refused).
//   2. Drop the `EXISTS (member_tokens ... live ...)` conjunct
//      → RED: "member with zero identities and zero tokens — NOT reserved"
//        (a merely-invited, never-logged-in, never-tokened member would
//        start being refused for existing at all).
//   3. Drop the org-admin bypass in the JS pre-check
//      → RED: "org-admin creates an invite onto a squatted row — 201"
//        (an org-admin's deliberate re-invite would 409).
//   4. Drop the whole `WHERE ?=1 OR NOT EXISTS(...)` guard on the INSERT
//      (bare `INSERT ... VALUES`) → not independently observable through the
//      ordinary tests above (the JS pre-check already refuses those cases
//      before the INSERT runs) — only the RACE test below (squats the row
//      strictly AFTER the pre-check passes) isolates this line: confirmed RED
//      (201 instead of 409) with the guard removed, confirmed GREEN restored.

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
      ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('member-squad-admin', 'squad-admin@pot.test', 'Squad Admin', 'active', '${TENANT}'),
      ('member-org-admin', 'org-admin@pot.test', 'Org Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('cap-squad-admin', 'member-squad-admin', 'squad', 'squad-web', 'admin'),
      ('cap-org-admin', 'member-org-admin', 'org', NULL, 'admin');
  `)
  return harness
}

function seedSquattedMember(h: SqliteD1Harness, id: string, email: string): void {
  h.sqlite
    .prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', '${TENANT}')`,
    )
    .run(id, email, id)
  h.sqlite
    .prepare(
      `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant) VALUES (?, ?, ?, 'workspace', 'workspace', '${TENANT}')`,
    )
    .run(`tok-${id}`, id, `hash-${id}`)
}

function seedVerifiedMember(h: SqliteD1Harness, id: string, email: string, withToken: boolean): void {
  h.sqlite
    .prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', '${TENANT}')`,
    )
    .run(id, email, id)
  h.sqlite
    .prepare(
      `INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
       VALUES (?, '${TENANT}', 'google', ?, ?, ?)`,
    )
    .run(`identity-${id}`, `subject-${id}`, email, id)
  if (withToken) {
    h.sqlite
      .prepare(
        `INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant) VALUES (?, ?, ?, 'workspace', 'workspace', '${TENANT}')`,
      )
      .run(`tok-${id}`, id, `hash-${id}`)
  }
}

function seedInvitedOnlyMember(h: SqliteD1Harness, id: string, email: string): void {
  // A member with no identity AND no token at all — the ordinary "invited,
  // never redeemed / never logged in" shape. Not squatted.
  h.sqlite
    .prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', '${TENANT}')`,
    )
    .run(id, email, id)
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

function postInvite(env: Env, sessionId: string, body: Record<string, unknown>): Promise<Response> {
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

describe('mupot#1551 slice 2 — refuse an invite onto a squatted row', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('squad-admin invites onto a squatted row (identity-less, live token) → 409', async () => {
    harness = makeHarness()
    seedSquattedMember(harness, 'member-squat', 'squatted@example.com')

    const res = await postInvite(sessionEnv(harness, 'member-squad-admin', 'squad-admin@pot.test'), 'member-squad-admin', {
      email: 'squatted@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(409)
    expect((await res.json()) as { error: string }).toEqual({ error: 'invite_email_reserved' })

    const count = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM invites`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('org-admin invites onto the SAME squatted row → 201 (bypass)', async () => {
    harness = makeHarness()
    seedSquattedMember(harness, 'member-squat', 'squatted@example.com')

    const res = await postInvite(sessionEnv(harness, 'member-org-admin', 'org-admin@pot.test'), 'member-org-admin', {
      email: 'squatted@example.com',
      department_id: 'dept-a',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('member with a verified identity AND a live token — NOT reserved (201)', async () => {
    harness = makeHarness()
    seedVerifiedMember(harness, 'member-verified', 'verified@example.com', true)

    const res = await postInvite(sessionEnv(harness, 'member-squad-admin', 'squad-admin@pot.test'), 'member-squad-admin', {
      email: 'verified@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('member with zero identities and ZERO tokens (merely invited before) — NOT reserved (201)', async () => {
    harness = makeHarness()
    seedInvitedOnlyMember(harness, 'member-invited-only', 'invitedonly@example.com')

    const res = await postInvite(sessionEnv(harness, 'member-squad-admin', 'squad-admin@pot.test'), 'member-squad-admin', {
      email: 'invitedonly@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('member with a REVOKED token only (no live token) — NOT reserved (201)', async () => {
    harness = makeHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-revoked', 'revoked@example.com', 'Revoked', 'active', '${TENANT}');
      INSERT INTO member_tokens (id, member_id, token_hash, label, channel, tenant, revoked_at)
        VALUES ('tok-revoked', 'member-revoked', 'z', 'workspace', 'workspace', '${TENANT}', datetime('now'));
    `)

    const res = await postInvite(sessionEnv(harness, 'member-squad-admin', 'squad-admin@pot.test'), 'member-squad-admin', {
      email: 'revoked@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('brand-new email (no member row at all) — NOT reserved (201, unchanged)', async () => {
    harness = makeHarness()
    const res = await postInvite(sessionEnv(harness, 'member-squad-admin', 'squad-admin@pot.test'), 'member-squad-admin', {
      email: 'newcomer@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('race — email squatted strictly AFTER the JS pre-check passes', async () => {
    harness = makeHarness()
    const env = sessionEnv(harness, 'member-squad-admin', 'squad-admin@pot.test')
    const realPrepare = env.DB.prepare.bind(env.DB)
    // isInviteEmailReserved's pre-check runs first and finds nothing — THEN,
    // strictly inside the guarded INSERT's own execution, someone else's
    // squat lands. Only the write's own WHERE re-assert (not the pre-check)
    // can catch this.
    env.DB.prepare = ((sql: string) => {
      if (sql.includes('INSERT INTO invites')) {
        return {
          bind: (...args: unknown[]) => ({
            run: async () => {
              seedSquattedMember(harness!, 'member-race-squat', 'race@example.com')
              return realPrepare(sql).bind(...args).run()
            },
          }),
        }
      }
      return realPrepare(sql)
    }) as typeof env.DB.prepare

    const res = await postInvite(env, 'member-squad-admin', {
      email: 'race@example.com',
      squad_id: 'squad-web',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(409)
    expect((await res.json()) as { error: string }).toEqual({ error: 'invite_email_reserved' })

    const count = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM invites`).get() as { n: number }
    expect(count.n).toBe(0)
  })
})
