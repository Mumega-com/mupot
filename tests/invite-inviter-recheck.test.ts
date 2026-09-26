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
// mutation on a doomed accept). `requiredRank = max(admin, invite.capability)`
// folds the "admin-or-better floor" and "within the invite's own capability
// ceiling" checks into ONE comparison (RANK is a total order, so whichever
// of the two is higher is the real bar) — computed once and reused as both
// the JS comparison and the bound SQL parameter below, so the two can never
// disagree on what the bar is.
//
// mupot#1551 round 2 (Athena BLOCK, P0 on PR #1559): the JS pre-check above
// was the ONLY place the RANK half was checked — the write-time re-assert
// only re-checked the inviter's ACTIVITY (INVITER_ACTIVE_MEMBER_SQL), not
// their current rank. Repro: delete the inviter's capability grant strictly
// between the JS check and the batch write → the grant landed anyway.
// Closed with `currentMemberRankAtLeastSql` (src/auth/capability.ts) — the
// SQL mirror of `currentMemberRankOnScope`, sharing `RANK_SQL_CASE`'s ladder
// mapping — embedded in BOTH the member INSERT's and the capabilities
// INSERT's own WHERE (see the member INSERT's own P0-addendum comment for
// why it needed the SAME guard: without it, a revoked inviter still let the
// member row mint while only the capability grant was refused, orphaning a
// capability-less member).
//
// MUTATION LEDGER (each mutated in place, confirmed RED, restored, `git
// diff` verified clean), see the end of this file for the mechanics:
//   1. Drop `status = 'active'` from INVITER_ACTIVE_MEMBER_SQL
//      → RED: "suspended inviter" test (a suspended inviter's invite would
//        redeem).
//   2. Drop the `inviterRank < requiredRank` JS comparison entirely
//      → NOT independently red — round 2's SQL-side rank re-assert (below)
//        now enforces the identical bar at write time on every accept, JS
//        check present or not. Genuinely redundant defense-in-depth now,
//        same honest non-claim as the NULL-invited_by case below; the JS
//        check stays for its fail-fast value (no wasted claim on a doomed
//        accept), not because it is the only thing enforcing the bar.
//   3. Drop `currentMemberRankAtLeastSql`'s clause from the CAPABILITIES
//      INSERT's own WHERE → RED on all three race tests below (suspend /
//      revoke / demote between the JS check and the write): the grant
//      lands. Drop it from the MEMBER INSERT's WHERE instead (leaving the
//      capabilities copy intact) → ALSO red, but differently: verified by
//      hand (not asserted in the committed tests) that the member row
//      lands anyway (count 1, orphaned, no capability row alongside it)
//      and the call throws an uncaught `receipt_failed` instead of
//      resolving — the three race tests below expect a clean resolved
//      `{ok:false}` with zero orphaned rows, so a promise rejection where
//      one was not expected already fails them. Both copies are
//      independently load-bearing.
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

  it('M9 (survivor pin): inviter row belongs to ANOTHER tenant → 409, even with a valid grant', async () => {
    harness = baseHarness()
    // Same id/email/grant shape as a healthy inviter, but tenant is a
    // DIFFERENT, non-NULL value — INVITER_ACTIVE_MEMBER_SQL's tenant clause
    // (src/members/index.ts) must refuse this, not just NULL-tenant legacy
    // rows. A cross-tenant member row existing at all is itself unusual
    // (members.email is globally unique, not tenant-scoped — mupot#1457's
    // own finding), so this pins the clause against a real, if rare, shape.
    harness.sqlite
      .prepare(
        `INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', 'other-tenant')`,
      )
      .run('inviter', 'inviter@pot.test', 'inviter')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-foreign-tenant', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-foreign-tenant', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })
  })

  it('NULL-tenant inviter (legacy, pre-tenant-column row) is treated as THIS tenant — 201 unchanged', async () => {
    harness = baseHarness()
    harness.sqlite
      .prepare(
        `INSERT INTO members (id, email, display_name, status, tenant) VALUES (?, ?, ?, 'active', NULL)`,
      )
      .run('inviter', 'inviter@pot.test', 'inviter')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-null-tenant', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const result = await acceptInvite(envFor(harness), 'inv-null-tenant', 'Newcomer')
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
    // the write-time re-assert. Round 2: BOTH the member INSERT and the
    // capabilities INSERT now re-assert inviter-active — a 0-row failure on
    // the member statement (index 0, checked first) is what the caller
    // actually sees, disambiguated in the catch block to the correct named
    // error rather than a generic member_already_exists or a raw throw.
    env.DB.batch = (async (statements: Parameters<typeof realBatch>[0]) => {
      harness!.sqlite.exec(`UPDATE members SET status = 'suspended' WHERE id = 'inviter'`)
      return realBatch(statements)
    }) as typeof env.DB.batch

    const result = await acceptInvite(env, 'inv-race', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })

    const row = inviteRow(harness, 'inv-race')
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()
    const caps = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM capabilities WHERE member_id != 'inviter'`).get() as { n: number }
    expect(caps.n).toBe(0)
    // Round 2 P0 addendum: no ORPHANED member row either — before round 2,
    // only the capabilities INSERT re-asserted inviter-active, so this exact
    // race left a capability-less member row behind (D1's .batch() does not
    // roll back statement 1 because statement 2 wrote 0 rows).
    const members = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE id != 'inviter'`).get() as { n: number }
    expect(members.n).toBe(0)
  })

  it('P0 (round 2, Athena BLOCK) — race: inviter STAYS active but their scope grant is REVOKED between the JS check and the write — refused, rolled back, no orphan', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-race-revoke', 'newcomer@example.com', 'squad-web', 'member', 'inviter')

    const env = envFor(harness)
    const realBatch = env.DB.batch.bind(env.DB)
    // The inviter is untouched (still active) — only their GRANT disappears,
    // strictly after the JS pre-check (currentMemberRankOnScope) already
    // read it as sufficient, strictly before the write-time re-assert runs.
    // Before round 2's fix, nothing at write time asked "is the inviter
    // STILL admin-or-better on this scope" — only whether they were still
    // an active member row — so this exact race landed the grant.
    // currentMemberRankAtLeastSql closes it, on BOTH the member and
    // capabilities INSERTs (see the member INSERT's own P0-addendum
    // comment — capabilities-only would have orphaned a capability-less
    // member row here).
    env.DB.batch = (async (statements: Parameters<typeof realBatch>[0]) => {
      harness!.sqlite.exec(`DELETE FROM capabilities WHERE member_id = 'inviter'`)
      return realBatch(statements)
    }) as typeof env.DB.batch

    const result = await acceptInvite(env, 'inv-race-revoke', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })

    const row = inviteRow(harness, 'inv-race-revoke')
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()
    const members = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE id != 'inviter'`).get() as { n: number }
    expect(members.n).toBe(0)
  })

  it('P0 (round 2) — race: inviter stays active and a grant survives, but it is now BELOW the invite capability — refused, no orphan', async () => {
    harness = baseHarness()
    seedMember(harness, 'inviter', 'inviter@pot.test')
    grant(harness, 'inviter', 'squad', 'squad-web', 'admin')
    seedInvite(harness, 'inv-race-demote', 'newcomer@example.com', 'squad-web', 'owner', 'inviter')
    // NOTE: 'owner' invite capability requires inviter rank >= owner (5).
    // Seed the inviter at 'owner' so the JS pre-check passes, then demote to
    // 'admin' (4) mid-batch — still admin-or-better in the abstract, but now
    // BELOW what this specific invite's capability requires.
    harness.sqlite.exec(`UPDATE capabilities SET capability = 'owner' WHERE member_id = 'inviter'`)

    const env = envFor(harness)
    const realBatch = env.DB.batch.bind(env.DB)
    env.DB.batch = (async (statements: Parameters<typeof realBatch>[0]) => {
      harness!.sqlite.exec(`UPDATE capabilities SET capability = 'admin' WHERE member_id = 'inviter'`)
      return realBatch(statements)
    }) as typeof env.DB.batch

    const result = await acceptInvite(env, 'inv-race-demote', 'Newcomer')
    expect(result).toEqual({ ok: false, error: 'invite_inviter_no_longer_authorized' })

    const row = inviteRow(harness, 'inv-race-demote')
    expect(row.accepted_at).toBeNull()
    expect(row.member_id).toBeNull()
    const members = harness.sqlite.prepare(`SELECT COUNT(*) AS n FROM members WHERE id != 'inviter'`).get() as { n: number }
    expect(members.n).toBe(0)
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
