// mupot#1551 slice 1 — re-check the INVITER at redemption for plain invites.
//
// acceptInvite() (src/members/index.ts) used to trust `invites.invited_by`
// forever: an invite minted while its creator held admin-or-better on the
// target scope stayed redeemable at that exact capability even after the
// creator was suspended, demoted, or had the grant revoked outright — up to
// however long the invite sat unaccepted. This mirrors the re-check
// `redeemTelegramProjectInvite` already runs for the Telegram/project door
// (src/members/project-invites.ts ~L862-905): the inviter's authority is
// re-derived FRESH from D1 at the moment the invite is actually spent, using
// `currentMemberRankOnScope` (src/auth/capability.ts) — the invite's own
// scope, not the inviter's global ceiling.
//
// Both predicates below (member existence/active/tenant, and rank) are
// re-checked before the invite is ever claimed (WARN-B discipline — no
// mutation on a doomed accept), and the member-existence half is ALSO
// re-asserted inside the capabilities INSERT's own WHERE
// (INVITER_ACTIVE_MEMBER_SQL, exported from src/members/index.ts and used
// verbatim in both places) as defense-in-depth against the race between
// that pre-check and the write landing.
//
// MUTATION LEDGER (each mutated in place, confirmed RED, restored, `git
// diff` verified clean), see the end of this file for the mechanics:
//   1. Drop `status = 'active'` from INVITER_ACTIVE_MEMBER_SQL
//      → RED: "suspended inviter" test (a suspended inviter's invite would
//        redeem).
//   2. Drop the `inviterRank < capabilityRank('admin')` floor
//      → RED: "inviter holds only lead (not admin) on the scope" test — the
//        capability-ceiling check alone does not catch this (observer <=
//        lead), only the floor does.
//   3. Drop the `capabilityRank(invite.capability) > inviterRank` ceiling
//      → RED: "invite capability above inviter's current scope rank" test —
//        the floor check alone does not catch this (the inviter IS
//        admin-or-better), only the ceiling does.
//   4. Drop the capabilities INSERT's own `WHERE EXISTS (...)` re-assert
//      → RED: "race — inviter suspended between the pre-check and the
//        write" test (see the wrapped env.DB.batch below); the JS pre-check
//        cannot see a mutation that happens strictly after it ran.
// The NULL-invited_by / no-resolvable-inviter case is intentionally NOT a
// separate ledger row: `id = ?` can never match a bound SQL NULL (or a
// dangling id nothing resolves to), so INVITER_ACTIVE_MEMBER_SQL already
// refuses it with no dedicated branch to mutate — proven by its own test
// below rather than by breaking a line that does not exist.

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
      ('squad-web', 'dept-a', 'squad-web', 'Web Squad'),
      ('squad-other', 'dept-a', 'squad-other', 'Other Squad');
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

function seedMember(
  h: SqliteD1Harness,
  id: string,
  email: string,
  status: 'active' | 'suspended' = 'active',
): void {
  h.sqlite
    .prepare(
      `INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, ?, '${TENANT}')`,
    )
    .run(id, email, id, status)
}

function grant(h: SqliteD1Harness, memberId: string, scopeType: string, scopeId: string | null, capability: string): void {
  h.sqlite
    .prepare(
      `INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(`cap-${memberId}-${scopeType}-${scopeId ?? 'null'}`, memberId, scopeType, scopeId, capability)
}

function seedInvite(
  h: SqliteD1Harness,
  id: string,
  email: string,
  squadId: string | null,
  capability: string,
  invitedBy: string | null,
): void {
  h.sqlite
    .prepare(
      `INSERT INTO invites (id, email, squad_id, capability, invited_by) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, email, squadId, capability, invitedBy)
}

function inviteRow(h: SqliteD1Harness, id: string): { accepted_at: string | null; member_id: string | null } {
  return h.sqlite
    .prepare(`SELECT accepted_at, member_id FROM invites WHERE id = ?`)
    .get(id) as { accepted_at: string | null; member_id: string | null }
}

describe('mupot#1551 slice 1 — inviter re-check at redemption', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('healthy inviter (squad admin) — accept succeeds unchanged', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-ok', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-ok', 'Newcomer')
    expect(result.ok).toBe(true)
  })

  // NOTE: this exercises `membersApp` (the real, deployed Hono router for
  // this surface) rather than the top-level `app` from src/index.ts. That
  // top-level composition cannot be imported under the default Vitest Node
  // pool at all — it transitively pulls DurableObject/WorkerEntrypoint from
  // 'cloudflare:workers', a scheme only the Workers runtime provides (see
  // vitest.composition.config.ts's own header; verified here too — importing
  // it fails with "Only URLs with a scheme in: file, data, and node are
  // supported"). No test in this 300+ file suite imports it for that reason;
  // reaching it requires the separate workerd-backed composition pool, run
  // as its own CI step, not part of `npm test`.
  it('healthy inviter — 201 through the real mounted route (membersApp)', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-http', 'httpuser@example.com', 'squad-web', 'member', 'inviter')

    const res = await membersApp.request(
      '/invites/inv-http/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: 'HTTP User' }),
      },
      envFor(harness),
    )
    expect(res.status, await res.clone().text()).toBe(201)
  })

  it('suspended inviter → 409, claim rolled back', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test', 'suspended')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-suspended', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-suspended', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })

    const row = inviteRow(harness, 'inv-suspended')
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()
    const members = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members`).get() as { n: number }
    expect(members.n).toBe(1) // only the seeded inviter — no member minted
  })

  it("inviter's admin grant was revoked (no grant at all now) → 409", async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    // No capabilities row inserted at all — the grant that authorized this
    // invite at mint time has since been revoked.
    seedInvite(harness, 'inv-revoked', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-revoked', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })
  })

  it('inviter is only squad-admin on a DIFFERENT squad → 409', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'squad', 'squad-other', 'admin')
    seedInvite(harness, 'inv-wrong-squad', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-wrong-squad', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })
  })

  it('inviter holds only LEAD (below admin) on the invite scope → 409', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'squad', 'squad-web', 'lead')
    // 'observer' is below 'lead' — the capability-ceiling check alone would
    // let this through; only the admin-or-better FLOOR refuses it.
    seedInvite(harness, 'inv-lead-only', 'newcomer@example.com', 'squad-web', 'observer', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-lead-only', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })
  })

  it('invite capability above the inviter\'s CURRENT scope rank → 409', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    // Inviter is admin (not owner) on the scope today — an 'owner' invite
    // exceeds what they could grant right now, even though they clear the
    // admin-or-better floor.
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-ceiling', 'newcomer@example.com', 'squad-web', 'owner', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-ceiling', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })
  })

  it('NULL invited_by (and no minted_by_member_id) → 409', async () => {
    harness = baseHarness()
    seedInvite(harness, 'inv-null-inviter', 'newcomer@example.com', 'squad-web', 'member', null)

    const result = await acceptInvite(envFor(harness), 'inv-null-inviter', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })
  })

  it('org-admin inviter authorizes an invite on ANY squad (inheritance)', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'org', null, 'admin')
    seedInvite(harness, 'inv-org-admin', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-org-admin', 'Newcomer')
    expect(result.ok).toBe(true)
  })

  it('race — inviter suspended between the JS pre-check and the write landing', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-race', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const env = envFor(harness)
    const realBatch = env.DB.batch.bind(env.DB)
    // Simulate a concurrent suspend landing in the window between the JS
    // pre-check (already passed by the time acceptInvite calls .batch()) and
    // the capabilities INSERT's own write-time re-assert.
    env.DB.batch = (async (statements: Parameters<typeof realBatch>[0]) => {
      harness!.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'inviter'`)
      return realBatch(statements)
    }) as typeof env.DB.batch

    await expect(acceptInvite(env, 'inv-race', 'Newcomer')).rejects.toThrow(
      /receipt_failed/,
    )

    const row = inviteRow(harness, 'inv-race')
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()
    const caps = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id != 'inviter'`).get() as { n: number }
    expect(caps.n).toBe(0)
  })

  it('via the real POST /invites/:id/accept route (membersApp) — 409 body shape', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test', 'suspended')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-http-409', 'newcomer2@example.com', 'squad-web', 'member', 'inviter')

    const res = await membersApp.request(
      '/invites/inv-http-409/accept',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display_name: 'Newcomer' }),
      },
      envFor(harness),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('invite_inviter_no_longer_authorized')
  })
})
