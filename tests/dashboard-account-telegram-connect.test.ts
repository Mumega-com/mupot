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
import { resolveCapabilities } from '../src/auth/capability'
import { dashboardApp } from '../src/dashboard/index'
import { membersApp } from '../src/members'
import {
  capabilityAtRank,
  loadConnectableSquads,
  loadSelfMember,
  telegramDeviceSectionBody,
  telegramSectionBody,
} from '../src/dashboard/account'
import { createProjectInvite, redeemTelegramProjectInvite } from '../src/members/project-invites'
import { readableProjectIdSet } from '../src/projects/access'
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

// mupot#1551 round 3: dev-login always supplies a real join key
// (provider='local-test', subject=email) to registerWebSession, which now
// runs the SAME exclusive-control predicate a Google login does. Per
// Athena's ruling B3, a bound Telegram chat is control of the row — so a
// FIRST login for a member whose Telegram is already bound (via the
// invite/redeem flow, in these fixtures) is correctly refused UNLESS that
// member already has a live login identity of their own to resolve through
// (step 1, before the Telegram check is ever consulted). Seed one here for
// every fixture that means "this is the member's own, already-established
// account" — never for the fixture meant to prove the denial.
function seedDevLoginIdentity(harness: SqliteD1Harness, memberId: string, email: string): void {
  harness.sqlite
    .prepare(
      `INSERT INTO human_login_identities
         (id, tenant, provider, provider_subject, verified_email, member_id, created_at)
       VALUES (?, ?, 'local-test', ?, ?, ?, datetime('now'))`,
    )
    .run(`ident-${memberId}`, TENANT, email, email, memberId)
}

// Execute the rendered account scripts against a small DOM boundary. Fetch is
// supplied as a response fixture; all copy and branch selection run as shipped.
function accountBrowser(body: string, response: Record<string, unknown>, status = 200) {
  class Element {
    textContent = ''
    innerHTML = ''
    hidden = true
    disabled = false
    className = ''
    href = ''
    target = ''
    rel = ''
    children: Element[] = []
    click?: () => Promise<void>
    constructor(readonly attributes: Record<string, string> = {}) {}
    getAttribute(name: string) { return this.attributes[name] ?? null }
    appendChild(child: Element) { this.children.push(child) }
    addEventListener(_event: string, listener: () => Promise<void>) { this.click = listener }
  }
  const elements = new Map<string, Element>()
  // Split our own rendered page into markup and inline script bodies (test harness, not a sanitizer).
  const markup: string[] = []
  const scripts: string[] = []
  const lower = body.toLowerCase()
  let at = 0
  for (;;) {
    const open = lower.indexOf('<script', at)
    if (open === -1) { markup.push(body.slice(at)); break }
    markup.push(body.slice(at, open))
    const openEnd = lower.indexOf('>', open)
    const close = lower.indexOf('</script', openEnd)
    if (openEnd === -1 || close === -1) throw new Error('unterminated script in rendered page')
    scripts.push(body.slice(openEnd + 1, close))
    at = lower.indexOf('>', close) + 1
  }
  for (const tag of markup.join('').matchAll(/<[^>]+\sid="([^"]+)"[^>]*>/g)) {
    const attributes = Object.fromEntries([...tag[0].matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
    elements.set(tag[1], new Element(attributes))
  }
  const events: string[] = []
  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    createElement: () => new Element(),
  }
  const window = {
    confirm: () => true,
    alert: (message: string) => { events.push(message) },
    location: { reload: () => { events.push('reload') }, assign: (url: string) => { events.push(url) } },
  }
  const fetch = async () => ({ ok: status >= 200 && status < 300, status, json: async () => response })
  for (const script of scripts) {
    new Function('document', 'fetch', 'window', script)(document, fetch, window)
  }
  return {
    element: (id: string) => {
      const element = elements.get(id)
      if (!element) throw new Error(`Missing element ${id}`)
      return element
    },
    events,
  }
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

      -- org-scope 'lead' (rank 3) — one rank BELOW the mint floor (admin,
      -- rank 4). Pins MEMBER_BIND_MINT_FLOOR exactly at 'admin': mutating it
      -- to 'lead' (rank 3) would incorrectly let this member pass.
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-lead', 'lead@x.test', 'Lead Member', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-lead-org', 'member-lead', 'org', NULL, 'lead');
    `)
  })

  afterEach(() => harness.close())

  async function connectBody(botUsername?: string) {
    // One scope keeps the rendered fixed-scope field available to the browser.
    harness.sqlite.exec("UPDATE projects SET status = 'archived' WHERE id = 'project-b'")
    if (botUsername !== undefined) {
      harness.sqlite.prepare("INSERT INTO org_settings (key, value) VALUES ('im_bot_username', ?)").run(botUsername)
    }
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    return String(await telegramSectionBody(env, {
      userId: 'admin-user', email: 'admin@x.test', role: 'admin', tenant: TENANT, memberId: 'member-admin',
    }))
  }

  it.each([undefined, 'Decision_bot', 'bad/name'])('code creation explains the pending connection and reload, username=%s', async (username) => {
    const body = await connectBody(username)
    expect(body).toContain('Connect your Telegram to approve through chat.')
    expect(body).not.toContain('and be notified through chat')
    const browser = accountBrowser(body, { pairing_code: 'test-code', invite: { pairing_expires_at: '2026-10-29' } }, 201)
    await browser.element('tg-connect').click!()
    const result = browser.element('tg-result')
    expect(result.hidden).toBe(false)
    expect(result.children.map((p) => p.textContent)).toContain(
      'This code is not a connection yet. Telegram connects when the decision bot' +
      (username === 'Decision_bot' ? ' @Decision_bot' : '') + ' replies to /start. Then reload this page.',
    )
    expect(result.children.map((p) => p.textContent)).toContain('Pairing code: test-code')
    expect(result.children.map((p) => p.textContent)).toContain('Expires 2026-10-29')
    if (username === 'Decision_bot') {
      expect(result.children.find((p) => p.href)?.href).toBe('https://t.me/Decision_bot?start=test-code')
    } else {
      expect(result.children.some((p) => p.href)).toBe(false)
      expect(result.children.map((p) => p.textContent)).toContain('Message the decision bot and send: /start test-code')
      expect(result.children.map((p) => p.textContent)).toContain('Ask your owner to set the decision bot username so this page can link you straight there.')
    }
    expect(browser.events).toEqual([])
  })

  it.each([
    ['forbidden', "You don't have a squad you can connect through yet. Ask an org admin to add you to a project squad."],
    ['cannot_grant_above_own_rank', "You don't have a squad you can connect through yet. Ask an org admin to add you to a project squad."],
    ['member_not_active', 'Your account is not active. Ask an admin to activate it.'],
    ...['project_not_active', 'archived_project', 'squad_archived', 'project_not_found', 'project_squad_not_linked'].map((code) =>
      [code, "That project can't take new connections. Pick another, or ask an admin."]),
    ['pairing_code_collision', 'Try again.'],
    ...['home_scope_not_invitable', 'member_not_found', 'member_missing_email', 'invalid_expiry', 'invalid_capability',
      'invalid_or_expired_pairing_code', 'ambiguous_pairing_code', 'unexpected', ''].map((code) =>
      [code, 'Could not connect. Try again, or ask an admin.']),
  ])('connect refusal %s shows a plain next step without an enum', async (error, sentence) => {
    const browser = accountBrowser(await connectBody(), { error }, 403)
    await browser.element('tg-connect').click!()
    expect(browser.element('tg-status').textContent).toBe(sentence)
    expect(browser.element('tg-connect').disabled).toBe(false)
    expect(browser.events).toEqual([])
  })

  it('connect keeps the existing reauthentication redirect', async () => {
    const browser = accountBrowser(await connectBody(), { error: 'reauth_required' }, 403)
    await browser.element('tg-connect').click!()
    expect(browser.events).toEqual(['/auth/reauth?return=%2Faccount'])
  })

  it('disconnect success tells the member phone setup was removed before reloading', async () => {
    harness.sqlite.exec("UPDATE members SET telegram_chat_id = '555000111' WHERE id = 'member-admin'")
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    const body = String(await telegramSectionBody(env, {
      userId: 'admin-user', email: 'admin@x.test', role: 'admin', tenant: TENANT, memberId: 'member-admin',
    }))
    const browser = accountBrowser(body, { telegram_unbound: true })
    await browser.element('tg-disconnect').click!()
    expect(browser.events).toEqual(['Telegram disconnected. Phone setup (Mini App devices) was removed too.', 'reload'])
  })

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

  // Mom-walk D3 (supersedes "ask an admin"): below the org-admin floor a member connects THEIR OWN Telegram through the
  // squads they hold; with no squad they get an honest explain state.
  it('a plain member (squad-a member grant, no org-scope grant) now sees the Connect form for THEIR squad only, at observer', async () => {
    const env = makeEnv('plain@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="tg-connect"')
    expect(body).toContain('data-member-id="member-plain"')
    expect(body).toContain('Project A / Squad Alpha')
    expect(body).not.toContain('Squad Bravo') // no standing there
    expect(body).toContain('data-capability="observer"')
    expect(body).not.toContain('Ask an org admin to send you')
  })

  it('a member whose only squad has no project link sees an explain state, not a button wired to a guaranteed refusal', async () => {
    harness.sqlite.exec(`
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-c', 'dept-a', 'charlie', 'Squad Charlie');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('member-nobody', 'nobody@x.test', 'Nobody', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('cap-nobody-c', 'member-nobody', 'squad', 'squad-c', 'member');
    `)
    const env = makeEnv('nobody@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('id="tg-connect"')
    expect(body).toContain('Ask an org admin to add you to a project squad')
  })

  it('an org-scope LEAD member (one rank below the mint floor) self-connects at observer, never at lead (the floor still stops any other target)', async () => {
    const env = makeEnv('lead@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('id="tg-connect"')
    expect(body).toContain('data-capability="observer"')
    expect(body).not.toContain('data-capability="lead"')
  })

  it('a member with an already-bound Telegram identity sees Connected + Disconnect, never the Connect form', async () => {
    harness.sqlite.exec(`
      UPDATE members SET telegram_chat_id = '555000111', telegram_bound_at = '2026-09-15T00:00:00000000Z'
       WHERE id = 'member-bound';
    `)
    seedDevLoginIdentity(harness, 'member-bound', 'bound@x.test')
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

  // mupot#1551 round 3: the shape Athena's ruling B3 exists to refuse — an
  // IDENTITY-LESS member row (no linked human_login_identities) that already
  // holds a bound Telegram chat. A first web login for that email must be
  // denied, not silently attach (and then render "Connected" as if the web
  // login itself were the one who bound it). Deliberately NOT seeding
  // seedDevLoginIdentity here — that omission is the point of this test.
  it('an IDENTITY-LESS member with a bound Telegram chat is DENIED a first web login — never silently attached', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant, telegram_chat_id, telegram_bound_at)
      VALUES ('member-tg-only', 'tgonly@x.test', 'Telegram Only', 'active', '${TENANT}', '555000999', '2026-09-15T00:00:00000000Z');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-tg-only-org', 'member-tg-only', 'org', NULL, 'admin');
    `)
    const env = makeEnv('tgonly@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)

    // No human_login_identities row exists for this join key, and the
    // Telegram bind refuses the identity-less bootstrap attach — the login
    // itself still succeeds (KV-only session, best-effort) but never bridges
    // to member-tg-only's capabilities, so the SAME pre-existing
    // zero-capability-drive-by floor that blocks 'nobody@x.test' above also
    // blocks this request before /account ever renders: the org 'admin'
    // grant this row actually holds is never reachable through it.
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).not.toContain('data-member="member-tg-only"')
    expect(body).not.toContain('id="tg-disconnect"')

    const identityCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS n FROM human_login_identities WHERE member_id = 'member-tg-only'`)
      .get() as { n: number }
    expect(identityCount.n).toBe(0)
  })

  // mupot#1425 round 3 (Athena): telegram_origin_bind_receipts (0155) was
  // write-only — a first-bind-by-origin (src/im/origin-verdict.ts) landed a
  // real credential with no reader anywhere. loadLatestOriginBindReceipt
  // (src/dashboard/account.ts) now surfaces it on the SAME page that already
  // shows "Telegram is connected", so a silent bind is visible to the member
  // it happened to.
  it('a member bound via harness-attested origin sees WHICH agent bound them and from which message, on the same Connected view', async () => {
    harness.sqlite.exec(`
      UPDATE members SET telegram_chat_id = '555000111', telegram_bound_at = '2026-09-15T00:00:00000000Z'
       WHERE id = 'member-bound';
      INSERT INTO agents (id, squad_id, slug, name, role, model, status)
        VALUES ('agent-kayhermes-bound', 'squad-a', 'kayhermes', 'KayHermes', 'member', 'test', 'active');
      INSERT INTO telegram_origin_bind_receipts (id, tenant, member_id, agent_id, chat_id, message_id, created_at)
        VALUES ('receipt-1', '${TENANT}', 'member-bound', 'agent-kayhermes-bound', '555000111', '9001', '2026-09-15T00:00:00000000Z');
    `)
    seedDevLoginIdentity(harness, 'member-bound', 'bound@x.test')
    const env = makeEnv('bound@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Bound via agent KayHermes')
    expect(body).toContain('9001')
  })

  it('a member bound WITHOUT any origin receipt (the ordinary invite/button path) shows no origin-bind line at all', async () => {
    harness.sqlite.exec(`
      UPDATE members SET telegram_chat_id = '555000222', telegram_bound_at = '2026-09-15T00:00:00000000Z'
       WHERE id = 'member-bound';
    `)
    seedDevLoginIdentity(harness, 'member-bound', 'bound@x.test')
    const env = makeEnv('bound@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Connected')
    expect(body).not.toContain('Bound via agent')
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

    // This admin's Telegram is now bound (via the redeem above) BEFORE their
    // first web login — realistic (they connected via Telegram first), and
    // per Athena's ruling B3 a Telegram binding is control, so their own
    // first web login must resolve via a real identity, never by email
    // alone. Seeded here rather than earlier so the sequence stays honest:
    // Telegram bind happens first, THEN the admin's own web identity link.
    seedDevLoginIdentity(harness, 'member-admin', 'admin@x.test')

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
    // A Mini App device (secure moments W4) is bound to the Telegram account this member was linked to.
    harness.sqlite.prepare(
      `INSERT INTO tg_miniapp_devices (id, tenant, member_id, telegram_user_id, login_identity_id, enrolment_token_id, secret_sha256, created_at, confirmed_at)
       VALUES ('dev-1', ?, 'member-admin', '9500001', 'ident-member-admin', 'tok-1', ?, datetime('now'), datetime('now'))`,
    ).run(TENANT, 'a'.repeat(64))
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

    // Unlinking Telegram ends the phone bound to it, and says why.
    expect(harness.sqlite.prepare("SELECT revoked_reason FROM tg_miniapp_devices WHERE id = 'dev-1' AND revoked_at IS NOT NULL").get()).toEqual({ revoked_reason: 'telegram_unbound' })
    const row = harness.sqlite.prepare(
      `SELECT telegram_chat_id, telegram_bound_at FROM members WHERE id = 'member-admin'`,
    ).get() as { telegram_chat_id: string | null; telegram_bound_at: string | null }
    expect(row).toEqual({ telegram_chat_id: null, telegram_bound_at: null })

    const unboundRes = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, dashEnv)
    const unboundBody = await unboundRes.text()
    expect(unboundBody).toContain('Not connected')
    expect(unboundBody).not.toContain('id="tg-disconnect"')
  })

  // ── kasra-review AMBER P1 (2026-09-16): the offboarding chain, not the
  //    render. Proves the capped-at-admin fix actually closes the
  //    uncontainable-principal defect, against the REAL routes an
  //    offboarding admin would use — not merely that the page suggests
  //    'admin'. ──────────────────────────────────────────────────────────

  it('offboarding chain: mint at the (now-capped) admin capability -> redeem -> revoke org standing -> a DIFFERENT org admin still gets 200 on unbind, capability-revoke, and suspend', async () => {
    harness.sqlite.exec(`
      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-offboarder', 'offboarder@x.test', 'Offboarder Admin', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-offboarder-org', 'member-offboarder', 'org', NULL, 'admin');
    `)

    const bindAuth: AuthContext = {
      userId: 'admin-user',
      email: 'admin@x.test',
      role: 'member',
      tenant: TENANT,
      memberId: 'member-admin',
      capabilities: [{ member_id: 'member-admin', scope_type: 'org', scope_id: null, capability: 'admin' }],
    }
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env

    // Mint at 'admin' — exactly what loadConnectableSquads now suggests post-
    // fix (capped at MEMBER_BIND_MINT_FLOOR, never 'owner'), NOT a value this
    // test hand-picks to dodge the defect.
    const created = await createProjectInvite(env, bindAuth, {
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
      VALUES (?, 'update-offboard-1', 'tg-offboard-1', ?, 'processing', datetime('now'))
    `).run(TENANT, VALID_REQUEST_DIGEST)

    const redeemed = await redeemTelegramProjectInvite(env, {
      pairing_code: created.value.pairing_code,
      telegram_user_id: 'tg-offboard-1',
      display_name: 'Admin Operator',
      update_id: 'update-offboard-1',
      request_digest: VALID_REQUEST_DIGEST,
    })
    expect(redeemed.ok).toBe(true)
    if (!redeemed.ok) return
    expect(redeemed.value.capability).toBe('admin') // never 'owner' — the fix under test

    const dashEnv = makeEnv('offboarder@x.test')
    dashEnv.DB = harness.db
    const cookie = await devLogin(dashEnv)
    const authHeaders = { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' }

    // Step: revoke member-admin's ORG standing (the precondition the P1
    // finding hinges on — their remaining rank is now ONLY the redeemed
    // squad-scope 'admin' row).
    const revokeOrg = await membersApp.request('/members/member-admin/capabilities', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'revoke', scope_type: 'org', scope_id: null }),
    }, dashEnv)
    expect(revokeOrg.status, await revokeOrg.clone().text()).toBe(200)

    // member-admin's ONLY remaining standing anywhere is squad-a 'admin'
    // (rank 4) — confirm the fixture actually reached the hard case before
    // asserting the routes below succeed against it.
    const remaining = harness.sqlite.prepare(
      `SELECT scope_type, scope_id, capability FROM capabilities WHERE member_id = 'member-admin'`,
    ).all() as { scope_type: string; scope_id: string | null; capability: string }[]
    expect(remaining).toEqual([{ scope_type: 'squad', scope_id: 'squad-a', capability: 'admin' }])

    // Unbind Telegram (member-offboarder is a MERE org admin, rank 4 — target
    // is also rank 4; 4 is not > 4, so the ceiling passes). This is the exact
    // action a P0-class "uncontainable principal" would 403 on if the
    // suggested capability had ever reached 'owner'.
    const unbind = await membersApp.request(
      '/members/member-admin/telegram',
      { method: 'DELETE', headers: authHeaders },
      dashEnv,
    )
    expect(unbind.status, await unbind.clone().text()).toBe(200)

    // Revoke the squad capability itself.
    const revokeSquad = await membersApp.request('/members/member-admin/capabilities', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ action: 'revoke', scope_type: 'squad', scope_id: 'squad-a' }),
    }, dashEnv)
    expect(revokeSquad.status, await revokeSquad.clone().text()).toBe(200)
    expect(await revokeSquad.json()).toEqual({ member_id: 'member-admin', action: 'revoke', removed: 1 })

    // Suspend last.
    const suspend = await membersApp.request(`/members/member-admin`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'suspended' }),
    }, dashEnv)
    expect(suspend.status, await suspend.clone().text()).toBe(200)
  })

  it('the real member invite route requires step-up for self-connect, then accepts the fresh dashboard cookie', async () => {
    const env = makeEnv('plain@x.test')
    env.DB = harness.db
    const cookie = await devLogin(env)
    const post = () => membersApp.request('/invites', {
      method: 'POST', headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
      body: JSON.stringify({ member_id: 'member-plain', project_id: 'project-a', squad_id: 'squad-a', capability: 'observer', expires_in_seconds: 3600 }),
    }, env)
    const stale = await post()
    expect(stale.status).toBe(403)
    expect(await stale.json()).toEqual({ error: 'reauth_required' })
    harness.sqlite.exec("UPDATE web_sessions SET recent_reauth_at = datetime('now') WHERE member_id = 'member-plain'")
    const fresh = await post()
    expect(fresh.status, await fresh.clone().text()).toBe(201)
    expect(harness.sqlite.prepare("SELECT member_id, capability FROM invites WHERE member_id = 'member-plain'").get()).toEqual({ member_id: 'member-plain', capability: 'observer' })
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

  it('loadConnectableSquads NEVER suggests owner, even for a genuine org OWNER with an explicit squad-owner grant (kasra-review AMBER P1)', async () => {
    // Both squadRank AND orgRank are 5 here — the pre-fix Math.min(squadRank,
    // orgRank) would have suggested 'owner'. A redeemed 'owner' squad row
    // survives independent of this member's later org-role/standing, so the
    // page must cap the suggestion at 'admin' unconditionally (see
    // MEMBER_BIND_MINT_FLOOR's docstring in project-invites.ts).
    harness.sqlite.exec(`
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-squad-a-owner-2', 'member-admin', 'squad', 'squad-a', 'owner');
    `)
    const env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    const auth: AuthContext = {
      userId: 'owner-user',
      email: 'admin@x.test',
      role: 'owner', // legacy-role escape: actorRankOnScopeFor floors at RANK.owner=5
      tenant: TENANT,
      memberId: 'member-admin',
    }
    const squads = await loadConnectableSquads(env, auth, 5 /* owner */)
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

  describe('Telegram device section (secure moments W4)', () => {
    const flagged = (extra: Record<string, string> = {}): Env => ({
      DB: harness.db, TENANT_SLUG: TENANT, SECURE_MOMENTS: '1', SECURE_MOMENTS_HOST: 'secure.example.test',
      TELEGRAM_MINIAPP: '1', TELEGRAM_MINIAPP_BOT_ID: '123456789', TELEGRAM_MINIAPP_BOT_TOKEN: '123456789:AAEhqMY-dedicated-test-token', ...extra,
    }) as unknown as Env
    const admin: AuthContext = { userId: 'admin-user', email: 'admin@x.test', role: 'member', tenant: TENANT, memberId: 'member-admin' }

    it('renders nothing while the channel is off or misconfigured, and for a caller with no member', async () => {
      expect(await telegramDeviceSectionBody(flagged({ TELEGRAM_MINIAPP: '' }), admin)).toBeNull()
      expect(await telegramDeviceSectionBody(flagged({ TELEGRAM_MINIAPP_BOT_TOKEN: '' }), admin)).toBeNull()
      expect(await telegramDeviceSectionBody(flagged(), { userId: 'x', email: null, role: 'member', tenant: TENANT })).toBeNull()
    })
    it('lists the member\'s own active devices with a Remove button each, and a Set up this phone button that sends (no URL)', async () => {
      harness.sqlite.exec(`
        INSERT INTO tg_miniapp_devices (id, tenant, member_id, telegram_user_id, login_identity_id, enrolment_token_id, secret_sha256, created_at, confirmed_at)
        VALUES ('dev-mine', '${TENANT}', 'member-admin', '9500001', 'x', 't1', '${'a'.repeat(64)}', datetime('now'), datetime('now')),
               ('dev-theirs', '${TENANT}', 'member-plain', '9500002', 'x', 't2', '${'b'.repeat(64)}', datetime('now'), datetime('now')),
               ('dev-gone', '${TENANT}', 'member-admin', '9500001', 'x', 't3', '${'c'.repeat(64)}', datetime('now'), datetime('now'));
        UPDATE tg_miniapp_devices SET revoked_at = datetime('now') WHERE id = 'dev-gone';`)
      const html = String(await telegramDeviceSectionBody(flagged(), admin))
      expect(html).toContain('data-tgd-revoke="dev-mine"')
      expect(html).not.toContain('dev-theirs')
      expect(html).not.toContain('dev-gone')
      expect(html).toContain('id="tgd-add"')
      expect(html).toContain('Set up this phone')
      expect(html).toContain('/account/telegram-device/enrol')
      expect(html).not.toMatch(/\/m\/tg\/enrol|secure\.example\.test/) // the page never learns a link
    })
    it.each([
      [{ sent: true }, 200, 'Sent. Open the new message from the phone-setup bot in Telegram on your phone and tap the button (it is valid for 10 minutes).'],
      [{ error: 'chat_unreachable' }, 502, 'Telegram would not deliver it: open the phone-setup bot in Telegram and press Start once, then try again.'],
    ] as const)('phone setup response %j names the correct bot', async (response, status, sentence) => {
      const body = String(await telegramDeviceSectionBody(flagged(), admin))
      const browser = accountBrowser(body, response, status)
      await browser.element('tgd-add').click!()
      expect(browser.element('tgd-status').textContent).toBe(sentence)
      expect(browser.element('tgd-add').disabled).toBe(false)
    })
    it('an empty list says so', async () => {
      expect(String(await telegramDeviceSectionBody(flagged(), admin))).toContain('No phone set up')
    })
  })
})

// Mom-walk D3 — the SERVICE path under the page: createProjectInvite / redeemTelegramProjectInvite for a member below the floor.
describe('self-service Telegram connect (mom-walk D3): createProjectInvite below the org-admin floor', () => {
  let harness: SqliteD1Harness
  let env: Env
  const asMember = (memberId: string, caps: Array<{ scope_type: 'org' | 'squad'; scope_id: string | null; capability: 'observer' | 'member' | 'lead' | 'admin' }>, extra: Record<string, unknown> = {}): AuthContext => ({
    userId: memberId, email: `${memberId}@x.test`, role: 'member', tenant: TENANT, memberId,
    channel: 'dashboard', webSessionIdHash: `session-${memberId}`, webSessionMemberId: memberId,
    capabilities: caps.map((c) => ({ member_id: memberId, ...c })), ...extra,
  } as AuthContext)
  const invite = (auth: AuthContext, over: Partial<Parameters<typeof createProjectInvite>[2]> = {}) =>
    createProjectInvite(env, auth, { member_id: auth.memberId ?? 'x', project_id: 'project-a', squad_id: 'squad-a', capability: 'observer', expires_in_seconds: 3600, ...over })

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    env = { DB: harness.db, TENANT_SLUG: TENANT } as Env
    harness.sqlite.exec(`
      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Squad Alpha');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-b', 'dept-a', 'bravo', 'Squad Bravo');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'proj-a', 'Project A', 'active');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-b', 'proj-b', 'Project B', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-b', 'squad-b', 'write');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m-mom', 'mom@x.test', 'Mom', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-mom', 'm-mom', 'squad', 'squad-a', 'member');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m-other', 'other@x.test', 'Other', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-other', 'm-other', 'squad', 'squad-a', 'member');
      INSERT INTO members (id, email, display_name, status, tenant) VALUES ('m-admin', 'admin@x.test', 'Admin', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-admin', 'm-admin', 'org', NULL, 'admin');
    `)
    for (const memberId of ['m-mom', 'm-other', 'm-admin']) {
      seedDevLoginIdentity(harness, memberId, `${memberId}@x.test`)
      harness.sqlite.prepare(`INSERT INTO web_sessions (id_hash, tenant, member_id, login_identity_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, recent_reauth_at)
        VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now', '+1 day'), datetime('now', '+7 days'), datetime('now'))`)
        .run(`session-${memberId}`, TENANT, memberId, `ident-${memberId}`)
    }
  })
  afterEach(() => harness.close())

  const MOM = [{ scope_type: 'squad' as const, scope_id: 'squad-a', capability: 'member' as const }]

  it('an ordinary member can mint their OWN pairing link, redeem it from Telegram, and is bound', async () => {
    const created = await invite(asMember('m-mom', MOM))
    expect(created.ok, JSON.stringify(created)).toBe(true)
    if (!created.ok) return
    harness.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at) VALUES (?, 'u-mom', 'tg-mom', ?, 'processing', datetime('now'))`).run(TENANT, VALID_REQUEST_DIGEST)
    const redeemed = await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: 'tg-mom', display_name: 'Mom', update_id: 'u-mom', request_digest: VALID_REQUEST_DIGEST })
    expect(redeemed).toEqual({ ok: true, value: { member_id: 'm-mom', project_id: 'project-a', squad_id: 'squad-a', capability: 'observer' } })
    expect((harness.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id = 'm-mom'").get() as { telegram_chat_id: string }).telegram_chat_id).toBe('tg-mom')
    // Nothing was granted beyond what she held: still exactly her one 'member' squad-a row.
    expect(harness.sqlite.prepare("SELECT scope_id, capability FROM capabilities WHERE member_id = 'm-mom'").all()).toEqual([{ scope_id: 'squad-a', capability: 'member' }])
  })

  it('cannot target ANOTHER member (the org-admin floor still applies)', async () => {
    expect(await invite(asMember('m-mom', MOM), { member_id: 'm-other' })).toEqual({ ok: false, error: 'forbidden' })
    expect(await invite(asMember('m-mom', MOM), { member_id: 'm-admin' })).toEqual({ ok: false, error: 'forbidden' })
    expect((harness.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get() as { n: number }).n).toBe(0)
  })

  it.each([
    ['org', null, 'revoked'],
    ['org', null, 'expired'],
    ['department', 'dept-a', 'revoked'],
    ['department', 'dept-a', 'expired'],
  ] as const)('self-connect preserves inherited %s standing (%s) when later %s', async (scope, scopeId, end) => {
    harness.sqlite.prepare("UPDATE capabilities SET scope_type = ?, scope_id = ?, expires_at = datetime('now', '+1 day') WHERE id = 'c-mom'")
      .run(scope, scopeId)
    const freshAuth = async () => ({ ...asMember('m-mom', []), capabilities: await resolveCapabilities(env, 'm-mom') })
    expect(await readableProjectIdSet(env, await freshAuth(), ['project-a'])).toEqual(new Set(['project-a']))
    const created = await invite(await freshAuth())
    if (!created.ok) throw new Error(JSON.stringify(created))
    const before = harness.sqlite.prepare("SELECT * FROM capabilities WHERE member_id = 'm-mom'").all()
    harness.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at) VALUES (?, 'u-inherited', 'tg-mom', ?, 'processing', datetime('now'))`).run(TENANT, VALID_REQUEST_DIGEST)

    const redeemed = await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: 'tg-mom', display_name: 'Mom', update_id: 'u-inherited', request_digest: VALID_REQUEST_DIGEST })
    expect(redeemed.ok, JSON.stringify(redeemed)).toBe(true)
    expect(harness.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id = 'm-mom'").get()).toEqual({ telegram_chat_id: 'tg-mom' })
    expect(harness.sqlite.prepare("SELECT state, response_text FROM telegram_webhook_receipts WHERE update_id = 'u-inherited'").get())
      .toEqual({ state: 'completed', response_text: JSON.stringify(redeemed.ok ? redeemed.value : null) })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id)).toMatchObject({ accepted_at: expect.any(String) })
    expect(harness.sqlite.prepare("SELECT * FROM capabilities WHERE member_id = 'm-mom'").all()).toEqual(before)

    if (end === 'revoked') harness.sqlite.exec("DELETE FROM capabilities WHERE id = 'c-mom'")
    else harness.sqlite.exec("UPDATE capabilities SET expires_at = datetime('now', '-1 day') WHERE id = 'c-mom'")
    expect(await readableProjectIdSet(env, await freshAuth(), ['project-a'])).toEqual(new Set())
  })

  it.each(['+1 day', '-1 day'])('self-connect leaves an existing direct grant and its %s horizon unchanged', async (horizon) => {
    harness.sqlite.prepare("UPDATE capabilities SET capability = 'observer', expires_at = datetime('now', ?) WHERE id = 'c-mom'").run(horizon)
    harness.sqlite.exec("INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES ('c-mom-dept', 'm-mom', 'department', 'dept-a', 'member')")
    const auth = { ...asMember('m-mom', []), capabilities: await resolveCapabilities(env, 'm-mom') }
    const created = await invite(auth)
    if (!created.ok) throw new Error(JSON.stringify(created))
    const before = harness.sqlite.prepare("SELECT * FROM capabilities WHERE member_id = 'm-mom' ORDER BY id").all()
    harness.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at) VALUES (?, 'u-direct', 'tg-mom', ?, 'processing', datetime('now'))`).run(TENANT, VALID_REQUEST_DIGEST)
    const redeemed = await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: 'tg-mom', display_name: 'Mom', update_id: 'u-direct', request_digest: VALID_REQUEST_DIGEST })
    expect(redeemed.ok, JSON.stringify(redeemed)).toBe(true)
    expect(harness.sqlite.prepare("SELECT * FROM capabilities WHERE member_id = 'm-mom' ORDER BY id").all()).toEqual(before)
    harness.sqlite.exec("DELETE FROM capabilities WHERE id = 'c-mom-dept'; UPDATE capabilities SET expires_at = datetime('now', '-1 day') WHERE id = 'c-mom'")
    const afterAuth = { ...asMember('m-mom', []), capabilities: await resolveCapabilities(env, 'm-mom') }
    expect(await readableProjectIdSet(env, afterAuth, ['project-a'])).toEqual(new Set())
  })

  it('an admin self-bind above observer still needs current org-admin standing at redemption', async () => {
    const created = await invite(asMember('m-admin', [{ scope_type: 'org', scope_id: null, capability: 'admin' }]), { capability: 'admin' })
    if (!created.ok) throw new Error(JSON.stringify(created))
    harness.sqlite.exec("UPDATE capabilities SET scope_type = 'department', scope_id = 'dept-a' WHERE id = 'c-admin'")
    harness.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at) VALUES (?, 'u-admin', 'tg-admin', ?, 'processing', datetime('now'))`).run(TENANT, VALID_REQUEST_DIGEST)
    const before = harness.sqlite.prepare("SELECT * FROM capabilities WHERE member_id = 'm-admin'").all()
    const redeemed = await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: 'tg-admin', display_name: 'Admin', update_id: 'u-admin', request_digest: VALID_REQUEST_DIGEST })
    expect(redeemed).toEqual({ ok: false, error: 'invite_minter_authority_lost' })
    expect(harness.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id = 'm-admin'").get()).toEqual({ telegram_chat_id: null })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id)).toEqual({ accepted_at: null })
    expect(harness.sqlite.prepare("SELECT state FROM telegram_webhook_receipts WHERE update_id = 'u-admin'").get()).toEqual({ state: 'processing' })
    expect(harness.sqlite.prepare("SELECT * FROM capabilities WHERE member_id = 'm-admin'").all()).toEqual(before)
  })

  it('the rank ceiling is unchanged: cannot request above their OWN standing on that squad, nor on a squad they have no standing on', async () => {
    // Self-service is capped at 'observer' (the bind needs no authority; a redeemed higher row would outlive an inherited grant).
    expect(await invite(asMember('m-mom', MOM), { capability: 'member' })).toEqual({ ok: false, error: 'cannot_grant_above_own_rank' })
    expect(await invite(asMember('m-mom', MOM), { capability: 'lead' })).toEqual({ ok: false, error: 'cannot_grant_above_own_rank' })
    expect(await invite(asMember('m-mom', MOM), { capability: 'admin' })).toEqual({ ok: false, error: 'cannot_grant_above_own_rank' })
    expect(await invite(asMember('m-mom', MOM), { project_id: 'project-b', squad_id: 'squad-b' })).toEqual({ ok: false, error: 'forbidden' })
    expect((await invite(asMember('m-mom', MOM))).ok).toBe(true)
  })

  it('an ORG-scope lead grant does not raise the self-service cap above observer', async () => {
    // org 'lead' (rank 3, below the floor) bubbles down to every squad, but the self-service request is still capped at observer.
    const orgLead = asMember('m-mom', [{ scope_type: 'org', scope_id: null, capability: 'lead' }])
    expect(await invite(orgLead, { capability: 'lead' })).toEqual({ ok: false, error: 'cannot_grant_above_own_rank' })
    expect((await invite(orgLead)).ok).toBe(true)
  })

  it('an agent-bound token (whose memberId is whoever minted it), a seat session and an attached chat get no self-service', async () => {
    expect(await invite(asMember('m-mom', MOM, { boundAgentId: 'some-agent' }))).toEqual({ ok: false, error: 'forbidden' })
    const seat = { seatId: 's', label: 'l', harnessId: 'h', grantTokenId: 'g', humanMemberId: 'm-mom', source: 'handle', attached: { attachmentId: 'a', admissionId: 'ad', agentId: 'some-agent', seatAgentId: 'sa', ceiling: 'member' } }
    expect(await invite(asMember('m-mom', MOM, { seatBinding: seat }))).toEqual({ ok: false, error: 'forbidden' })
  })

  it('a suspended member cannot self-connect (member_not_active), and a squad outside any linked project edge is refused', async () => {
    harness.sqlite.exec("UPDATE members SET status = 'suspended' WHERE id = 'm-mom'")
    expect(await invite(asMember('m-mom', MOM))).toEqual({ ok: false, error: 'forbidden' })
    expect(await invite(asMember('m-other', [{ scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }]), { project_id: 'project-b', squad_id: 'squad-a' }))
      .toEqual({ ok: false, error: 'project_squad_not_linked' })
  })

  it('redemption re-checks the standing: a self-minted invite whose squad grant was revoked in between fails (invite_minter_authority_lost)', async () => {
    const created = await invite(asMember('m-mom', MOM))
    expect(created.ok).toBe(true)
    if (!created.ok) return
    harness.sqlite.exec("DELETE FROM capabilities WHERE member_id = 'm-mom'")
    harness.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at) VALUES (?, 'u-mom2', 'tg-mom', ?, 'processing', datetime('now'))`).run(TENANT, VALID_REQUEST_DIGEST)
    const redeemed = await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: 'tg-mom', display_name: 'Mom', update_id: 'u-mom2', request_digest: VALID_REQUEST_DIGEST })
    expect(redeemed).toMatchObject({ ok: false, error: 'invite_minter_authority_lost' })
    expect((harness.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id = 'm-mom'").get() as { telegram_chat_id: string | null }).telegram_chat_id).toBeNull()
  })

  it('redemption by a DIFFERENT Telegram account cannot hijack: the chat to member fence (one chat, one member) still holds', async () => {
    const mom = await invite(asMember('m-mom', MOM))
    if (!mom.ok) throw new Error('mint failed')
    const other = await invite(asMember('m-other', [{ scope_type: 'squad', scope_id: 'squad-a', capability: 'member' }]))
    if (!other.ok) throw new Error('mint failed')
    for (const [u, tg, code] of [['u-1', 'tg-shared', mom.value.pairing_code], ['u-2', 'tg-shared', other.value.pairing_code]] as const) {
      harness.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at) VALUES (?, ?, ?, ?, 'processing', datetime('now'))`).run(TENANT, u, tg, VALID_REQUEST_DIGEST)
      await redeemTelegramProjectInvite(env, { pairing_code: code, telegram_user_id: tg, display_name: 'x', update_id: u, request_digest: VALID_REQUEST_DIGEST })
    }
    const bound = harness.sqlite.prepare("SELECT id FROM members WHERE telegram_chat_id = 'tg-shared'").all()
    expect(bound).toHaveLength(1)
  })

  it('an org admin is unaffected: still mints for themselves at admin and for another member', async () => {
    const admin = asMember('m-admin', [{ scope_type: 'org', scope_id: null, capability: 'admin' }])
    expect((await invite(admin, { capability: 'admin' })).ok).toBe(true)
    expect((await invite(admin, { member_id: 'm-mom', capability: 'member' })).ok).toBe(true)
  })
  it('member bearers and harness grants cannot self-mint, including workspace auth with web-session-looking fields', async () => {
    for (const extra of [
      { channel: 'workspace', webSessionIdHash: undefined, webSessionMemberId: undefined },
      { channel: 'workspace' },
      { channel: 'dashboard', webSessionIdHash: undefined },
      { channel: 'dashboard', webSessionIdHash: 'unknown-session' },
    ]) expect(await invite(asMember('m-mom', MOM, extra))).toEqual({ ok: false, error: 'forbidden' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get()).toEqual({ n: 0 })
  })

  it('a stale or revoked dashboard session cannot self-mint', async () => {
    harness.sqlite.exec("UPDATE web_sessions SET recent_reauth_at = datetime('now', '-1 day')")
    expect(await invite(asMember('m-mom', MOM))).toEqual({ ok: false, error: 'reauth_required' })
    harness.sqlite.exec("UPDATE web_sessions SET recent_reauth_at = datetime('now'), revoked_at = datetime('now')")
    expect(await invite(asMember('m-mom', MOM))).toEqual({ ok: false, error: 'forbidden' })
  })

  it('a lower-ranked target still needs org-admin standing (M1)', async () => {
    harness.sqlite.exec("UPDATE capabilities SET capability = 'observer' WHERE id = 'c-other'")
    const minter = asMember('m-mom', [{ scope_type: 'squad', scope_id: 'squad-a', capability: 'admin' }])
    expect(await invite(minter, { member_id: 'm-other' })).toEqual({ ok: false, error: 'forbidden' })
    expect(harness.sqlite.prepare('SELECT COUNT(*) AS n FROM invites').get()).toEqual({ n: 0 })
  })

  it('a demoted ex-admin cannot redeem an observer bind for another member (M7)', async () => {
    const minter = asMember('m-admin', [{ scope_type: 'org', scope_id: null, capability: 'admin' }])
    const created = await invite(minter, { member_id: 'm-other' })
    if (!created.ok) throw new Error(JSON.stringify(created))
    harness.sqlite.exec("UPDATE capabilities SET scope_type = 'squad', scope_id = 'squad-a' WHERE id = 'c-admin'")
    harness.sqlite.prepare(`INSERT INTO telegram_webhook_receipts (tenant, update_id, telegram_user_id, request_digest, state, created_at) VALUES (?, 'u-other', 'tg-other', ?, 'processing', datetime('now'))`).run(TENANT, VALID_REQUEST_DIGEST)
    const before = harness.sqlite.prepare('SELECT * FROM capabilities ORDER BY id').all()
    expect(await redeemTelegramProjectInvite(env, { pairing_code: created.value.pairing_code, telegram_user_id: 'tg-other', display_name: 'Other', update_id: 'u-other', request_digest: VALID_REQUEST_DIGEST }))
      .toEqual({ ok: false, error: 'invite_minter_authority_lost' })
    expect(harness.sqlite.prepare("SELECT telegram_chat_id FROM members WHERE id = 'm-other'").get()).toEqual({ telegram_chat_id: null })
    expect(harness.sqlite.prepare('SELECT accepted_at FROM invites WHERE id = ?').get(created.value.invite.id)).toEqual({ accepted_at: null })
    expect(harness.sqlite.prepare("SELECT state FROM telegram_webhook_receipts WHERE update_id = 'u-other'").get()).toEqual({ state: 'processing' })
    expect(harness.sqlite.prepare('SELECT * FROM capabilities ORDER BY id').all()).toEqual(before)
  })

  it('home squads are omitted and a member with only a home project sees an explanation', async () => {
    harness.sqlite.exec("UPDATE squads SET kind = 'home' WHERE id = 'squad-a'")
    const auth = asMember('m-mom', MOM)
    expect(await loadConnectableSquads(env, auth, 0, true)).toEqual([])
    const body = String(await telegramSectionBody(env, auth))
    expect(body).toContain('Telegram not connected')
    expect(body).not.toContain('id="tg-connect"')
  })

})

