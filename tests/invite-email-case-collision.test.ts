// mupot#1551 (case-insensitivity gate finding raised on #1557's adversarial
// gate): `members.email`'s UNIQUE index (migrations/0002) is CASE-SENSITIVE,
// while every member lookup in this codebase matches by lower(email)
// (idx_members_email_lower, 0146; normalizeInviteEmail's own callers,
// src/auth/pending-invite-link.ts). Before this fix, inviting `ALICE@x.com`
// while `alice@x.com` already existed as a member sailed straight past the
// UNIQUE constraint at accept time and minted a SECOND member row — both
// then ambiguous to every lower(email)-keyed lookup (a real member-row
// takeover / lockout shape under Option B's login resolution).
//
// Fix (src/members/index.ts):
//   1. POST /invites normalizes the stored email via normalizeInviteEmail
//      (trim + lowercase, the SAME normalizer the auth callback uses) and
//      refuses `member_already_exists` (409) up front when an existing
//      member matches by lower(email) but NOT by the exact string — an
//      EXACT-case match is left to the checks that already own it
//      (RESERVED_INVITE_EMAIL_SQL's org-admin-bypassable refusal, or the
//      pre-existing case-sensitive UNIQUE at accept time).
//   2. acceptInvite's member INSERT is itself a guarded
//      `INSERT ... SELECT ... WHERE NOT EXISTS (lower(email) match)` — one
//      atomic statement, not a separate SELECT-then-INSERT — so even an
//      invite that predates this fix (or a genuine concurrent collision)
//      cannot mint a case-ambiguous second row. Every OTHER statement in the
//      same batch that references member.id (capabilities, member_tokens,
//      the invites.member_id stamp — all real FKs into members(id)) is
//      ALSO guarded on the member row actually existing, so a blocked
//      member insert cannot cascade into a raw FOREIGN KEY error; it comes
//      back as the same named `member_already_exists`.
//
// MUTATION LEDGER (each mutated in place, confirmed RED, restored, `git
// diff` verified clean):
//   1. Drop the creation-time case-different check
//      → RED: "create ALICE@x.com when alice@x.com exists — 409" (creation
//        would succeed with 201 instead of refusing up front).
//   2. Drop the `WHERE NOT EXISTS (...)` guard on acceptInvite's member
//      INSERT (bare `INSERT ... VALUES`)
//      → RED on BOTH: "accept — a case-different member already exists —
//        refused" and "accept — case-different member appears strictly
//        before the write lands — still refused (race)" (the guard is the
//        only thing closing this once an invite already exists for the
//        colliding email — there is no separate JS pre-check for this
//        predicate, by design).

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
    INSERT INTO squads (id, department_id, slug, name) VALUES
      ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-member-admin', 'member-admin', 'org', NULL, 'admin');
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
    userId: 'user-member-admin',
    email: 'admin@pot.test',
    role: 'member',
    createdAt: new Date().toISOString(),
  })
  return {
    ...envFor(harness),
    SESSIONS: {
      get: async (key: string) => (key === 'sess:member-admin' ? session : null),
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
        cookie: 'mupot_session=member-admin',
        Origin: ORIGIN,
      },
      body: JSON.stringify(body),
    },
    env,
  )
}

describe('mupot#1551 — invite email case-collision (gate finding on #1557)', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('create ALICE@x.com when alice@x.com already exists as a member — 409, unchanged invite table', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-alice', 'alice@x.com', 'Alice', 'active', '${TENANT}');
    `)

    const res = await postInvite(sessionEnv(harness), {
      email: 'ALICE@x.com',
      department_id: 'dept-a',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(409)
    expect((await res.json()) as { error: string }).toEqual({ error: 'member_already_exists' })

    const count = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM invites`).get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('create invite for a genuinely new email — unaffected, stored lowercased', async () => {
    harness = baseHarness()
    const res = await postInvite(sessionEnv(harness), {
      email: 'Newcomer@Example.com',
      department_id: 'dept-a',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
    const body = (await res.json()) as { invite: { email: string } }
    expect(body.invite.email).toBe('newcomer@example.com')
  })

  it('create invite for the SAME exact-case email as an existing member — governed by the existing (unchanged) checks, not this one', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-exact', 'exact@x.com', 'Exact', 'active', '${TENANT}');
    `)
    // Exact-case match — not the case-collision bug this file covers. The
    // invite is allowed to be CREATED (accept will separately refuse via the
    // pre-existing case-sensitive UNIQUE, or the guarded INSERT below).
    const res = await postInvite(sessionEnv(harness), {
      email: 'exact@x.com',
      department_id: 'dept-a',
      capability: 'member',
    })
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('accept — a case-different member already exists when the invite is redeemed — refused, claim rolled back', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, department_id, capability, invited_by)
        VALUES ('inv-case', 'bob@example.com', 'dept-a', 'member', 'member-admin');
      INSERT INTO members (id, email, display_name, status, tenant)
        VALUES ('member-bob-upper', 'BOB@example.com', 'Bob Upper', 'active', '${TENANT}');
    `)

    const result = await acceptInvite(envFor(harness), 'inv-case', 'Bob', { mintToken: false })
    expect(result).toEqual({ ok: false, error: 'member_already_exists' })

    const row = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-case'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()

    const members = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members`).get() as { n: number }
    expect(members.n).toBe(2) // member-admin + the pre-existing BOB@example.com — no third row
    const caps = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id NOT IN ('member-admin')`).get() as { n: number }
    expect(caps.n).toBe(0)
  })

  it('accept — case-different member appears strictly before the write lands — still refused (race)', async () => {
    harness = baseHarness()
    harness.sqlite.exec(`
      INSERT INTO invites (id, email, department_id, capability, invited_by)
        VALUES ('inv-race-case', 'carol@example.com', 'dept-a', 'member', 'member-admin');
    `)
    const env = envFor(harness)
    const realBatch = env.DB.batch.bind(env.DB)
    env.DB.batch = (async (statements: Parameters<typeof realBatch>[0]) => {
      // Simulate a concurrent signup landing a case-different member row in
      // the window between acceptInvite's own setup and this batch write —
      // there is no separate JS pre-check for this predicate (by design,
      // per the "no SELECT-then-INSERT" instruction), so this proves the
      // guarded INSERT itself is what catches it, not an earlier check.
      harness!.sqlite.exec(`
        INSERT INTO members (id, email, display_name, status, tenant)
          VALUES ('member-carol-upper', 'CAROL@example.com', 'Carol Upper', 'active', '${TENANT}');
      `)
      return realBatch(statements)
    }) as typeof env.DB.batch

    const result = await acceptInvite(env, 'inv-race-case', 'Carol', { mintToken: false })
    expect(result).toEqual({ ok: false, error: 'member_already_exists' })

    const row = harness.sqlite
      .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = 'inv-race-case'`)
      .get() as { accepted_at: string | null; member_id: string | null }
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()
  })
})
