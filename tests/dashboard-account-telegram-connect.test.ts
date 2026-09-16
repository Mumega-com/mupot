// tests/dashboard-account-telegram-connect.test.ts — mupot#1412: the
// dashboard's "My Account" page (src/dashboard/account.ts), the last blocker
// of the Telegram decision pilot. Exercises the REAL dashboardApp (server
// render) + membersApp (the existing invite/unbind routes it calls into) on
// the real migration chain, exactly like tests/elevation-dashboard.test.ts
// exercises src/dashboard/elevation.ts.
//
// This file does NOT re-test createProjectInvite/redeemTelegramProjectInvite/
// the unbind route's own authorization rules — mupot#1407/#1411 already
// cover those exhaustively (tests/telegram-project-onboarding.test.ts,
// tests/telegram-unbind-receipts-immutable.test.ts). It tests what this page
// adds: the RENDERING (every reachable state renders something honest, never
// a crash or a button wired to a guaranteed-403) and the read-only
// loadConnectableSquads helper.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { membersApp } from '../src/members'
import {
  capabilityAtRank,
  loadConnectableSquads,
  loadSelfMember,
  telegramSectionBody,
} from '../src/dashboard/account'
import { createProjectInvite, redeemTelegramProjectInvite } from '../src/members/project-invites'
import type { AuthContext, Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const VALID_REQUEST_DIGEST = 'c'.repeat(64)

function kv() {
  const store = new Map<string, string>()
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  }
}

function makeEnv(email: string): Env {
  return {
    TENANT_SLUG: TENANT,
    BRAND: 'Test Pot',
    LOCAL_TEST_AUTH: '1',
    LOCAL_TEST_AUTH_EMAIL: email,
    SESSIONS: kv(),
  } as unknown as Env
}

function cookieFrom(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? ''
  const match = /mupot_session=([^;]+)/.exec(setCookie)
  if (!match) throw new Error('no session cookie in response')
  return match[1]
}

async function devLogin(env: Env): Promise<string> {
  const res = await authApp.request('/dev-login', {}, env)
  expect(res.status).toBe(302)
  return cookieFrom(res)
}

describe('dashboard My Account — Telegram connect/disconnect (integration through dashboardApp, real D1)', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      -- Bootstrap-owner suppression: upsertUserByEmail (src/auth/index.ts)
      -- only grants role='owner' on dev-login when the users table is EMPTY
      -- at first-login time. Seeding one unrelated user first means every
      -- dev-login below gets the ordinary role='member' + email-bridged
      -- capabilities path this page actually targets, not an accidental
      -- bootstrap-owner escape hatch.
      INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');

      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Squad Alpha');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-a', 'bravo', 'Squad Bravo');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'proj-a', 'Project A', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-b', 'proj-b', 'Project B', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-archived', 'proj-arch', 'Archived Project', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-b', 'squad-b', 'write');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-archived', 'squad-a', 'write');
      UPDATE projects SET status = 'archived' WHERE id = 'project-archived';

      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@x.test', 'Admin Operator', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-org', 'member-admin', 'org', NULL, 'admin');

      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-plain', 'plain@x.test', 'Plain Member', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-plain-squad', 'member-plain', 'squad', 'squad-a', 'member');

      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-bound', 'bound@x.test', 'Bound Member', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-bound-org', 'member-bound', 'org', NULL, 'admin');
    `)
  })

  afterEach(() => harness.close())

  // ── GET /account — real HTTP round trip through dashboardApp ─────────────

  it('an unauthenticated request to GET /account is redirected to login, never rendered', async () => {
    const env = makeEnv('admin@x.test')
    env.DB = harness.db
    const res = await dashboardApp.request('/account', {}, env)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/auth/login')
  })

  it('an org-admin member sees the Connect form with a project/squad picker (multiple eligible squads)', async () => {
    const env = makeEnv('admin@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Not connected')
    expect(body).toContain('id="tg-connect"')
    expect(body).toContain('data-member-id="member-admin"')
    // Both active, linked squads show up; the archived project's squad link never does.
    expect(body).toContain('Project A / Squad Alpha')
    expect(body).toContain('Project B / Squad Bravo')
    expect(body).not.toContain('Archived Project')
  })

  it('an org-admin sees a "no active project" explain state when nothing is eligible, not the Connect form', async () => {
    harness.sqlite.exec(`UPDATE projects SET status = 'archived' WHERE status = 'active';`)
    const env = makeEnv('admin@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('id="tg-connect"')
    expect(body).toContain('No active project is linked to a squad yet')
  })

  it('a plain member (no org-scope grant) sees the "ask an admin" explain state, not a button wired to a guaranteed refusal', async () => {
    const env = makeEnv('plain@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('id="tg-connect"')
    expect(body).toContain('org-admin standing')
    expect(body).toContain('Ask an org admin')
  })

  it('a member with an already-bound Telegram identity sees Connected + Disconnect, never the Connect form', async () => {
    harness.sqlite.exec(`
      UPDATE members SET telegram_chat_id = '555000111', telegram_bound_at = '2026-09-15T00:00:00000000Z'
       WHERE id = 'member-bound';
    `)
    const env = makeEnv('bound@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Connected')
    expect(body).toContain('id="tg-disconnect"')
    expect(body).toContain('data-member="member-bound"')
    expect(body).not.toContain('id="tg-connect"')
  })

  it('a member with zero capability anywhere never reaches /account — the pre-existing dashboard-wide floor gate refuses first', async () => {
    const env = makeEnv('nobody@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(403)
  })

  it('never crashes for a legacy owner/admin login with no bridged member row (the account.ts branch this page reserves for it)', async () => {
    // A member with ZERO capability anywhere never reaches this page at all —
    // dashboardApp's own outer floor gate (holdsCapabilityFloor) 403s first,
    // which is correct, pre-existing behaviour (FLIGHT-001 F2), not something
    // this page needs to handle. The `!auth.memberId` branch in
    // telegramSectionBody is reserved for the other way a login can lack a
    // memberId: a legacy owner/admin role (which bypasses the floor via
    // isOrgAdmin, independent of any member row) whose email never bridged to
    // one — constructed here directly, since dev-login's own bootstrap-owner
    // path is suppressed by the seeded user above.
    harness.sqlite.exec(`
      INSERT INTO users (id, email, role) VALUES ('user-legacy-admin', 'legacy-admin@x.test', 'admin');
    `)
    const env = makeEnv('legacy-admin@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('No member profile linked')
  })

  // ── real Connect -> redeem -> Disconnect round trip, through the EXISTING
  //    routes account.ts's client script calls (POST /invites, DELETE .../telegram) ──

  it('an org-admin can connect their own Telegram end to end: mint via the existing invite route, redeem, see Connected, then self-disconnect', async () => {
    const auth: AuthContext = {
      userId: 'admin-user',
      email: 'admin@x.test',
      role: 'member',
      tenant: TENANT,
      memberId: 'member-admin',
      capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env

    // Exactly what account.ts's connectScript() POSTs (member_id = the
    // viewer's OWN server-rendered id — never client-suppliable).
    const created = await createProjectInvite(env, auth, {
      member_id: 'member-admin',
      project_id: 'project-a',
      squad_id: 'squad-a',
      capability: 'admin',
      expires_in_seconds: 86400,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    harness.sqlite.prepare(`
      INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at)
      VALUES (?, 'update-connect-1', 'tg-admin-1', ?, 'processing', datetime('now'))
    `).run(TENANT, VALID_REQUEST_DIGEST)

    const redeemed = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: 'tg-admin-1',
      display_name: 'Admin Operator',
      update_id: 'update-connect-1',
      request_digest: VALID_REQUEST_DIGEST,
    })
    expect(redeemed).toEqual({
      ok: true,
      value: { member_id: 'member-admin', project_id: 'project-a', squad_id: 'squad-a', capability: 'admin' },
    })

    const dashEnv = makeEnv('admin@x.test')
    dashEnv.DB = harness.db
    const cookie = await devLogin(dashEnv)
    const boundRes = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, dashEnv)
    const boundBody = await boundRes.text()
    expect(boundBody).toContain('Connected')
    expect(boundBody).toContain('id="tg-disconnect"')

    // Exactly what account.ts's disconnectScript() calls — self-unbind, no
    // rank required (requireAdminOrSelfForTelegramUnbind, src/members/index.ts).
    // membersApp is mounted at /api/members in production (src/index.ts); this
    // test exercises it directly (same SESSIONS KV + cookie as the dashboard
    // request above) rather than through the top-level app, mirroring how
    // tests/telegram-project-onboarding.test.ts already exercises membersApp.
    const unbindRes = await membersApp.request(
      '/members/member-admin/telegram',
      // The exact headers account.ts's disconnectScript() sends (content-type
      // json sidesteps hono/csrf's CORS-simple-content-type check — see that
      // function's comment).
      { method: 'DELETE', headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' } },
      dashEnv,
    )
    expect(unbindRes.status, await unbindRes.clone().text()).toBe(200)
    const unbindBody = await unbindRes.json() as { member_id: string; telegram_unbound: boolean }
    expect(unbindBody).toEqual({ member_id: 'member-admin', telegram_unbound: true })

    const row = harness.sqlite.prepare(
      `SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id = 'member-admin'`,
    ).get() as { telegram_chat_id: string | null; telegram_bound_at: string | null }
    expect(row).toEqual({ telegram_chat_id: null, telegram_bound_at: null })

    const unboundRes = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, dashEnv)
    const unboundBody = await unboundRes.text()
    expect(unboundBody).toContain('Not connected')
    expect(unboundBody).not.toContain('id="tg-disconnect"')
  })

  // ── loadConnectableSquads / loadSelfMember — the one new read this page adds ──

  it('loadConnectableSquads lists only active projects with a linked squad, each capped at the caller org rank', async () => {
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    const auth: AuthContext = {
      userId: 'admin-user',
      email: 'admin@x.test',
      role: 'member',
      tenant: TENANT,
      memberId: 'member-admin',
      capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const squads = await loadConnectableSquads(env, auth, 4 /* admin */)
    expect(squads.map((s) => s.project_id).sort()).toEqual(['project-a', 'project-b'])
    for (const s of squads) expect(s.capability).toBe('admin')
  })

  it('loadConnectableSquads caps at the LOWER of squad rank and org rank — never lets a higher squad-specific grant escape the org-rank ceiling', async () => {
    // member-admin holds org 'admin' (rank 4) AND an explicit squad 'owner'
    // (rank 5) grant on squad-a — a real, if unusual, shape. The suggested
    // capability must be the MIN of the two (admin), never 'owner': a
    // suggested 'owner' would violate createProjectInvite's own ceiling
    // (capability > actor's org rank -> cannot_grant_above_own_rank) the
    // instant this page's own hidden field reached that route.
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-squad-a-owner', 'member-admin', 'squad', 'squad-a', 'owner');
    `)
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    const auth: AuthContext = {
      userId: 'admin-user',
      email: 'admin@x.test',
      role: 'member',
      tenant: TENANT,
      memberId: 'member-admin',
      capabilities: [
        { member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' },
        { member_id: 'member-admin', scope_type: 'squad', scope_id: 'squad-a', capability: 'owner' },
      ],
    }
    const squads = await loadConnectableSquads(env, auth, 4 /* admin */)
    const squadA = squads.find((s) => s.squad_id === 'squad-a')
    expect(squadA?.capability).toBe('admin')
  })

  it('capabilityAtRank maps every ladder boundary exactly (owner=5..observer=1, and below)', () => {
    expect(capabilityAtRank(5)).toBe('owner')
    expect(capabilityAtRank(6)).toBe('owner')
    expect(capabilityAtRank(4)).toBe('admin')
    expect(capabilityAtRank(3)).toBe('lead')
    expect(capabilityAtRank(2)).toBe('member')
    expect(capabilityAtRank(1)).toBe('observer')
    expect(capabilityAtRank(0)).toBe('observer')
  })

  it('loadSelfMember returns null for a nonexistent member and the row for a real one', async () => {
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    expect(await loadSelfMember(env, 'does-not-exist')).toBeNull()
    const row = await loadSelfMember(env, 'member-admin')
    expect(row?.id).toBe('member-admin')
  })

  it('a suspended member (row exists, status != active) renders the account-not-active explain state, not the Connect form', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-suspended', 'suspended@x.test', 'Suspended Member', 'suspended', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-suspended-org', 'member-suspended', 'org', NULL, 'admin');
    `)
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    const auth: AuthContext = {
      userId: 'suspended-user', email: 'suspended@x.test', role: 'member', tenant: TENANT, memberId: 'member-suspended',
      capabilities: [{ member_id: 'member-suspended', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const rendered = String(await telegramSectionBody(env, auth))
    expect(rendered).toContain('Account not active')
    expect(rendered).not.toContain('id="tg-connect"')
  })

  it('a memberId that resolves to no row (e.g. a deleted/cross-tenant member) renders the account-not-active explain state, not a crash', async () => {
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    const auth: AuthContext = {
      userId: 'ghost-user', email: 'ghost@x.test', role: 'member', tenant: TENANT, memberId: 'member-does-not-exist',
    }
    const body = await telegramSectionBody(env, auth)
    const rendered = String(body)
    expect(rendered).toContain('Account not active')
    expect(rendered).not.toContain('id="tg-connect"')
    expect(rendered).not.toContain('id="tg-disconnect"')
  })

  it('telegramSectionBody never throws for any of the reachable states', async () => {
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    const noMember: AuthContext = { userId: 'x', email: null, role: 'member', tenant: TENANT }
    await expect(telegramSectionBody(env, noMember)).resolves.toBeDefined()

    const plain: AuthContext = {
      userId: 'plain-user', email: 'plain@x.test', role: 'member', tenant: TENANT, memberId: 'member-plain',
      capabilities: [{ member_id: 'member-plain', scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }],
    }
    await expect(telegramSectionBody(env, plain)).resolves.toBeDefined()
  })
})
