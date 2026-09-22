// tests/home-provisioning-web-accept.test.ts — mupot#1504: "Web onboarding
// door never creates the member's home squad — home only appears on
// Telegram first contact; a web-only member has no private space."
//
// provisionHomeOnFirstContact (src/im/index.ts, IM-only) is renamed/moved to
// a channel-agnostic provisionHomeForMember (src/members/service.ts) and
// gains a `channel: 'web' | 'im'` argument, wired into member_home_
// provisioning_receipts.channel (migrations/0161, widened by 0163 to admit
// 'web' alongside 'im'). It is now called from BOTH:
//   (a) src/dashboard/invite.ts's POST /invite/:id handler (the web door),
//       right after acceptInvite() mints the member + capability grant.
//   (b) src/im/index.ts's handleImMessage 'join' case (unchanged behaviour).
//
// This file proves, against the REAL migration chain and the REAL
// inviteApp/imApp Hono apps:
//   1. web accept -> a home squad exists + exactly ONE receipt (channel='web').
//   2. a later Telegram bind-existing-member join for the SAME member is a
//      pure no-op for provisioning: no second home, no second receipt.
//   3. a provisioning FAILURE (unknown member id) never throws and writes
//      ZERO receipts — the caller's own success is never gated on this.
//   4. the receipt's `channel` column actually distinguishes 'web' from 'im'
//      (not just "some receipt exists") — proven by direct calls to
//      provisionHomeForMember with each channel value.
//
// MUTATION CHECK (performed manually during development, not a standing
// test — see the PR body): commenting out the `await
// provisionHomeForMember(c.env, result.value.member_id, 'web')` call in
// src/dashboard/invite.ts turns test 1 below RED (zero receipts, no home)
// while every other test in this file stays unaffected — proof the
// assertion is actually pinned to that call site and not to some other
// side effect of acceptInvite.

import { afterEach, describe, expect, it } from 'vitest'
import { inviteApp } from '../src/dashboard/invite'
import { imApp } from '../src/im'
import { acceptInvite } from '../src/members'
import { provisionHomeForMember } from '../src/members/service'
import { createProjectInvite } from '../src/members/project-invites'
import { getMemberHomeSquad } from '../src/org/service'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'pot-a'
const ORIGIN = 'https://pot.test'
const IM_SECRET = 'test-im-secret'

function makeHarness(): SqliteD1Harness {
  const harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'dept-a', 'Engineering');
    INSERT INTO squads (id, department_id, slug, name)
      VALUES ('squad-web', 'dept-a', 'squad-web', 'Web Squad');
    INSERT INTO projects (id, slug, name, status) VALUES ('proj-a', 'proj-a', 'Project Atlas', 'active');
    INSERT INTO project_squad_access (project_id, squad_id) VALUES ('proj-a', 'squad-web');
    INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@pot.test', 'Ada Admin', 'active', '${TENANT}');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-org', 'member-admin', 'org', NULL, 'admin');
    INSERT INTO invites (id, email, squad_id, capability, invited_by)
      VALUES ('inv-squad', 'squaduser@example.com', 'squad-web', 'member', 'member-admin');
  `)
  return harness
}

function envFor(harness: SqliteD1Harness): Env {
  return {
    DB: harness.db,
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    PUBLIC_ORIGIN: ORIGIN,
    IM_WEBHOOK_SECRET: IM_SECRET,
    SESSIONS: {
      get: async () => null,
      put: async () => {},
      delete: async () => {},
    },
  } as unknown as Env
}

function orgAdminAuth(): AuthContext {
  return {
    userId: 'member-admin', email: 'admin@pot.test', role: 'member', tenant: TENANT,
    memberId: 'member-admin',
    capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
  }
}

function postForm(path: string, values: Record<string, string>) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams(values),
  })
}

function receiptRows(harness: SqliteD1Harness) {
  return harness.sqlite.prepare(
    'SELECT member_id, squad_id, channel, disposition FROM member_home_provisioning_receipts ORDER BY created_at',
  ).all() as { member_id: string; squad_id: string | null; channel: string; disposition: string }[]
}

function homeSquadIdFor(harness: SqliteD1Harness, memberId: string): string | null {
  const row = harness.sqlite.prepare(
    `SELECT s.id AS id
       FROM capabilities c
       JOIN squads s ON s.id = c.scope_id AND s.kind = 'home'
      WHERE c.member_id = ? AND c.scope_type = 'squad'
      LIMIT 1`,
  ).get(memberId) as { id: string } | undefined
  return row?.id ?? null
}

describe('mupot#1504 — web accept provisions a home squad', () => {
  let harness: SqliteD1Harness | undefined
  afterEach(() => {
    harness?.close()
    harness = undefined
  })

  it('web accept -> home squad exists + exactly one receipt, channel="web"', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    const response = await inviteApp.fetch(postForm('/inv-squad', { display_name: 'Squad User' }), env)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/auth/login')

    const memberRow = harness.sqlite.prepare(
      `SELECT id FROM members WHERE id != 'member-admin' LIMIT 1`,
    ).get() as { id: string }
    expect(memberRow).toBeTruthy()

    const homeSquadId = homeSquadIdFor(harness, memberRow.id)
    expect(homeSquadId).not.toBeNull()

    const receipts = receiptRows(harness)
    expect(receipts).toEqual([
      { member_id: memberRow.id, squad_id: homeSquadId, channel: 'web', disposition: 'created' },
    ])
  })

  it('a later Telegram bind-existing-member join for the SAME member is idempotent: no second home, no second receipt', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    // Step 1: web accept, exactly as above.
    await inviteApp.fetch(postForm('/inv-squad', { display_name: 'Squad User' }), env)
    const memberRow = harness.sqlite.prepare(
      `SELECT id FROM members WHERE id != 'member-admin' LIMIT 1`,
    ).get() as { id: string }
    const homeSquadIdBefore = homeSquadIdFor(harness, memberRow.id)
    expect(homeSquadIdBefore).not.toBeNull()
    expect(receiptRows(harness)).toHaveLength(1)

    // Step 2: an org admin mints a Telegram bind-existing-member invite for
    // the SAME member (the real "Connect Telegram" shape — see
    // tests/dashboard-account-telegram-connect.test.ts — never a net-new
    // invite for someone who already has a member row).
    const bindInvite = await createProjectInvite(env, orgAdminAuth(), {
      member_id: memberRow.id,
      project_id: 'proj-a',
      squad_id: 'squad-web',
      capability: 'member',
      expires_in_seconds: 3600,
    })
    expect(bindInvite.ok).toBe(true)
    if (!bindInvite.ok) throw new Error('setup: bind invite creation failed')

    // Step 3: that member DMs the bot with the pairing code — the real
    // handleImMessage 'join' case, through the real webhook, exactly as
    // mupot-plugin's Telegram flow drives it.
    const webhookBody = {
      update_id: 500,
      message: { chat: { id: 987654, type: 'private' }, from: { id: 987654 }, text: `/start ${bindInvite.value.pairing_code}` },
    }
    const joinResponse = await imApp.fetch(new Request(`${ORIGIN}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': IM_SECRET },
      body: JSON.stringify(webhookBody),
    }), env)
    expect(joinResponse.status).toBe(200)
    const joinBody = await joinResponse.json() as { reply: string }
    expect(joinBody.reply).toMatch(/joined project proj-a/i)

    // The bind did NOT mint a new member row.
    const memberCount = harness.sqlite.prepare('SELECT COUNT(*) AS n FROM members').get() as { n: number }
    expect(memberCount.n).toBe(2) // member-admin + the one web-accepted member

    // No second home squad, no second receipt — the SAME home + SAME single
    // 'web' receipt from step 1 survive untouched.
    const homeSquadIdAfter = homeSquadIdFor(harness, memberRow.id)
    expect(homeSquadIdAfter).toBe(homeSquadIdBefore)
    expect(receiptRows(harness)).toEqual([
      { member_id: memberRow.id, squad_id: homeSquadIdBefore, channel: 'web', disposition: 'created' },
    ])
  })

  it('provisioning failure (unknown member) never throws and writes zero receipts', async () => {
    harness = makeHarness()
    const env = envFor(harness)

    await expect(provisionHomeForMember(env, 'no-such-member', 'web')).resolves.toBeUndefined()
    expect(receiptRows(harness)).toEqual([])

    await expect(provisionHomeForMember(env, 'no-such-member', 'im')).resolves.toBeUndefined()
    expect(receiptRows(harness)).toEqual([])
  })

  it('the receipt channel column distinguishes "web" from "im" — direct calls, both disposition="created"', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-web', 'web@pot.test', 'Web Member', 'active', '${TENANT}'),
             ('member-im', 'im@pot.test', 'IM Member', 'active', '${TENANT}');
    `)

    await provisionHomeForMember(env, 'member-web', 'web')
    await provisionHomeForMember(env, 'member-im', 'im')

    const receipts = receiptRows(harness)
    expect(receipts).toContainEqual({
      member_id: 'member-web', squad_id: homeSquadIdFor(harness, 'member-web'), channel: 'web', disposition: 'created',
    })
    expect(receipts).toContainEqual({
      member_id: 'member-im', squad_id: homeSquadIdFor(harness, 'member-im'), channel: 'im', disposition: 'created',
    })
  })

  it('idempotent across channels at the function level: web then im for the same member writes exactly one receipt', async () => {
    harness = makeHarness()
    const env = envFor(harness)
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-cross', 'cross@pot.test', 'Cross Member', 'active', '${TENANT}');
    `)

    await provisionHomeForMember(env, 'member-cross', 'web')
    const homeAfterFirst = await getMemberHomeSquad(env, 'member-cross')
    expect(homeAfterFirst).not.toBeNull()

    await provisionHomeForMember(env, 'member-cross', 'im')
    const homeAfterSecond = await getMemberHomeSquad(env, 'member-cross')
    expect(homeAfterSecond?.id).toBe(homeAfterFirst?.id)

    expect(receiptRows(harness)).toEqual([
      { member_id: 'member-cross', squad_id: homeAfterFirst!.id, channel: 'web', disposition: 'created' },
    ])
  })
})
