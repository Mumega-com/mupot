// tests/im-bot-username.test.ts — mupot#1420 incident fix: the dashboard's
// Connect Telegram deep link was deriving the bot @username from
// TELEGRAM_BOT_TOKEN via getMe — but that token authenticates the
// NOTIFICATION bridge bot (src/telegram-bridge/bus_notify.ts), never the
// DECISION-CHANNEL bot a human actually talks to. The fix replaces that
// derivation with an explicit, non-secret, owner-configured org setting
// (org_settings.im_bot_username — SETTINGS_KEYS.imBotUsername) written from
// two places (the wizard's IM step and the post-setup /admin/im-settings
// page) and read from exactly one (src/dashboard/account.ts's deep link).
//
// This file covers: the shared validator, both writers, the reader's
// defense-in-depth re-validation, and the "leave unchanged when omitted"
// semantics that the wizard's own client script depends on (its im-next
// fallback re-POSTs provider+channel WITHOUT bot_username — that must never
// clear a value the owner already saved).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard/index'
import { SETTINGS_KEYS, getSetting, isValidBotUsername } from '../src/dashboard/settings'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

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

// ── unit: the shared validator ──────────────────────────────────────────────

describe('isValidBotUsername — the ONE shape check both writers and the reader share', () => {
  it('accepts well-formed usernames at both length boundaries', () => {
    expect(isValidBotUsername('abc12')).toBe(true) // 5 chars, the floor
    expect(isValidBotUsername('a'.repeat(32))).toBe(true) // 32 chars, the ceiling
    expect(isValidBotUsername('kayhermes_mubot')).toBe(true)
  })

  it('rejects malformed shapes', () => {
    for (const bad of ['ab', 'bad name', 'bad-name', 'a'.repeat(33), '', '<script>alert(1)</script>', '@leadingAt123']) {
      expect(isValidBotUsername(bad)).toBe(false)
    }
  })

  it('rejects non-strings without throwing', () => {
    expect(isValidBotUsername(null)).toBe(false)
    expect(isValidBotUsername(undefined)).toBe(false)
    expect(isValidBotUsername(123)).toBe(false)
    expect(isValidBotUsername(['abc12'])).toBe(false)
  })
})

// ── integration: both writers + the reader, over real D1 ────────────────────

describe('org_settings.im_bot_username — wizard write, im-settings write, account.ts read (real D1)', () => {
  let harness: SqliteD1Harness

  beforeEach(() => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    harness.sqlite.exec(`
      -- Bootstrap-owner suppression (same pattern as
      -- tests/dashboard-account-telegram-connect.test.ts): upsertUserByEmail
      -- only grants role='owner' on dev-login when the users table is EMPTY
      -- at first-login time. Seeding one unrelated user first means every
      -- dev-login below gets the ordinary role='member' + email-bridged-
      -- capabilities path (isOwner/isOrgAdmin via a REAL capability grant,
      -- not the legacy-role escape), which is what these tests target.
      INSERT INTO users (id, email, role) VALUES ('user-seed', 'seed@x.test', 'member');

      INSERT INTO departments (id, slug, name) VALUES ('dept-a', 'delivery', 'Delivery');
      INSERT INTO squads (id, department_id, slug, name) VALUES ('squad-a', 'dept-a', 'alpha', 'Squad Alpha');
      INSERT INTO projects (id, slug, name, status) VALUES ('project-a', 'proj-a', 'Project A', 'active');
      INSERT INTO project_squad_access (project_id, squad_id, access_level) VALUES ('project-a', 'squad-a', 'write');

      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-owner', 'owner@x.test', 'Org Owner', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-owner-org', 'member-owner', 'org', NULL, 'owner');

      INSERT INTO members (id, email, display_name, status, tenant)
      VALUES ('member-admin', 'admin@x.test', 'Admin Operator', 'active', '${TENANT}');
      INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability)
      VALUES ('cap-admin-org', 'member-admin', 'org', NULL, 'admin');
    `)
  })

  afterEach(() => harness.close())

  // ── POST /setup/im — the wizard writer ──────────────────────────────────

  describe('POST /setup/im (wizard step 6)', () => {
    it('a valid bot_username is stored and echoed back', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup/im', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'telegram', channel: '-100123', bot_username: 'kayhermes_mubot' }),
      }, env)
      expect(res.status, await res.clone().text()).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true, bot_username: 'kayhermes_mubot' })
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('kayhermes_mubot')
    })

    it('strips a leading @ before validating/storing', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup/im', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'none', bot_username: '@kayhermes_mubot' }),
      }, env)
      expect(res.status).toBe(200)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('kayhermes_mubot')
    })

    it('a malformed bot_username is refused 400 and nothing is written', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup/im', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'none', bot_username: 'a b' }),
      }, env)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_bot_username' })
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBeNull()
    })

    it('a non-string bot_username is refused 400', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup/im', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'none', bot_username: 42 }),
      }, env)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_bot_username' })
    })

    // REGRESSION for the "leave unchanged when omitted" fix: the wizard's own
    // client script (im-next fallback) re-POSTs provider+channel WITHOUT
    // bot_username when the owner clicks Continue without re-submitting the
    // form. Treating an omitted key as "clear it" would silently wipe a
    // value the owner already saved earlier in the same session.
    it('a request that OMITS bot_username entirely leaves a previously-saved value untouched', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const headers = { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' }

      const first = await dashboardApp.request('/setup/im', {
        method: 'POST', headers,
        body: JSON.stringify({ provider: 'telegram', channel: '-100123', bot_username: 'kayhermes_mubot' }),
      }, env)
      expect(first.status).toBe(200)

      // Exactly the shape wizardScript's im-next handler sends — no key at all.
      const second = await dashboardApp.request('/setup/im', {
        method: 'POST', headers,
        body: JSON.stringify({ provider: 'telegram', channel: '-100999' }),
      }, env)
      expect(second.status, await second.clone().text()).toBe(200)
      expect(await second.json()).toMatchObject({ bot_username: 'kayhermes_mubot' })
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('kayhermes_mubot')
      // The OTHER field in the same request DID update, proving this isn't a
      // no-op write — only bot_username's omission is special-cased.
      expect(await getSetting(env, SETTINGS_KEYS.imChannel)).toBe('-100999')
    })

    it('an explicit null clears a previously-saved bot_username', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const headers = { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' }
      await dashboardApp.request('/setup/im', {
        method: 'POST', headers,
        body: JSON.stringify({ provider: 'telegram', channel: '-100123', bot_username: 'kayhermes_mubot' }),
      }, env)
      const cleared = await dashboardApp.request('/setup/im', {
        method: 'POST', headers,
        body: JSON.stringify({ provider: 'telegram', channel: '-100123', bot_username: null }),
      }, env)
      expect(cleared.status).toBe(200)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('')
    })

    it('an explicit empty string clears a previously-saved bot_username', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const headers = { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' }
      await dashboardApp.request('/setup/im', {
        method: 'POST', headers,
        body: JSON.stringify({ provider: 'telegram', channel: '-100123', bot_username: 'kayhermes_mubot' }),
      }, env)
      const cleared = await dashboardApp.request('/setup/im', {
        method: 'POST', headers,
        body: JSON.stringify({ provider: 'telegram', channel: '-100123', bot_username: '' }),
      }, env)
      expect(cleared.status).toBe(200)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('')
    })

    it('bot_username is accepted for provider "none" too — an owner may preconfigure it before picking telegram', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup/im', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'none', bot_username: 'kayhermes_mubot' }),
      }, env)
      expect(res.status).toBe(200)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('kayhermes_mubot')
    })

    it('a non-owner is refused 403 and nothing is written', async () => {
      const env = makeEnv('seed@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup/im', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'none', bot_username: 'kayhermes_mubot' }),
      }, env)
      expect(res.status).toBe(403)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBeNull()
    })

    it('is sealed (409) once onboarding is complete, bot_username included', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('onboarding_complete', 'true');`)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup/im', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'none', bot_username: 'kayhermes_mubot' }),
      }, env)
      expect(res.status).toBe(409)
    })
  })

  // ── GET /setup — prefill + done summary render the configured value ────────

  describe('GET /setup renders im_bot_username', () => {
    it('prefills the input with a previously-saved value while onboarding is in progress', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('im_bot_username', 'kayhermes_mubot');`)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup', { headers: { cookie: `mupot_session=${cookie}` } }, env)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('value="kayhermes_mubot"')
    })

    it('the done-summary shows the configured decision bot once onboarding is complete', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`
        INSERT INTO org_settings (key, value) VALUES ('onboarding_complete', 'true');
        INSERT INTO org_settings (key, value) VALUES ('im_bot_username', 'kayhermes_mubot');
      `)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup', { headers: { cookie: `mupot_session=${cookie}` } }, env)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('@kayhermes_mubot')
      expect(body).toContain('/admin/im-settings')
    })

    it('the done-summary shows "not set" when never configured', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('onboarding_complete', 'true');`)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/setup', { headers: { cookie: `mupot_session=${cookie}` } }, env)
      const body = await res.text()
      expect(body).toContain('not set')
    })
  })

  // ── /admin/im-settings — the post-setup writer ───────────────────────────

  describe('/admin/im-settings (post-setup edit surface)', () => {
    it('GET renders the current value for an owner', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('im_bot_username', 'kayhermes_mubot');`)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', { headers: { cookie: `mupot_session=${cookie}` } }, env)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('kayhermes_mubot')
      // Next-step affordance: the owner's only job here is to point members at
      // /account, so the page must hand them there once a value is set.
      expect(body).toContain('id="im-settings-next-step" href="/account"')
    })

    it('GET renders an honest "Not set" empty state when unconfigured', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', { headers: { cookie: `mupot_session=${cookie}` } }, env)
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('Not set')
      // No next-step button before a value exists: sending someone to /account
      // with no bot configured yields a pairing-code-only page.
      expect(body).not.toContain('id="im-settings-next-step" href="/account"')
    })

    it('GET refuses a non-owner with an honest 403 explain page (not a crash)', async () => {
      const env = makeEnv('admin@x.test') // legacy admin role — NOT owner
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', { headers: { cookie: `mupot_session=${cookie}` } }, env)
      expect(res.status).toBe(403)
      const body = await res.text()
      expect(body).toContain('Owner only')
    })

    it('POST as owner writes a valid username, reachable works even AFTER onboarding is complete (unlike /setup/im)', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('onboarding_complete', 'true');`)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ bot_username: 'kayhermes_mubot' }),
      }, env)
      expect(res.status, await res.clone().text()).toBe(200)
      expect(await res.json()).toEqual({ ok: true, bot_username: 'kayhermes_mubot' })
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('kayhermes_mubot')
    })

    it('POST as a non-owner (org admin, not owner) is refused 403 and writes nothing', async () => {
      const env = makeEnv('admin@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ bot_username: 'kayhermes_mubot' }),
      }, env)
      expect(res.status).toBe(403)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBeNull()
    })

    it('POST with a malformed username is refused 400 and nothing changes', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('im_bot_username', 'kayhermes_mubot');`)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ bot_username: '<script>alert(1)</script>' }),
      }, env)
      expect(res.status).toBe(400)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('kayhermes_mubot') // unchanged
    })

    it('POST with an empty string is a deliberate clear (not an error)', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('im_bot_username', 'kayhermes_mubot');`)
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ bot_username: '' }),
      }, env)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, bot_username: null })
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('')
    })

    it('POST strips a leading @', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ bot_username: '@kayhermes_mubot' }),
      }, env)
      expect(res.status).toBe(200)
      expect(await getSetting(env, SETTINGS_KEYS.imBotUsername)).toBe('kayhermes_mubot')
    })

    it('POST with a missing/non-string bot_username field is refused 400', async () => {
      const env = makeEnv('owner@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const res = await dashboardApp.request('/admin/im-settings', {
        method: 'POST',
        headers: { cookie: `mupot_session=${cookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }, env)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_bot_username' })
    })
  })

  // ── account.ts's reader — the deep link this whole fix is about ─────────

  describe('src/dashboard/account.ts — Connect Telegram deep link reads im_bot_username, never TELEGRAM_BOT_TOKEN', () => {
    async function connectPage(env: Env, cookie: string) {
      const res = await dashboardApp.request('/account', { headers: { cookie: `mupot_session=${cookie}` } }, env)
      expect(res.status).toBe(200)
      return res.text()
    }

    it('renders the configured decision-bot username on the Connect button, with no TELEGRAM_BOT_TOKEN set at all', async () => {
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('im_bot_username', 'kayhermes_mubot');`)
      const env = makeEnv('admin@x.test')
      env.DB = harness.db
      // Deliberately absent — proves the deep link no longer depends on the
      // notification bridge's secret at all (the mupot#1420 incident's cause).
      expect((env as unknown as { TELEGRAM_BOT_TOKEN?: string }).TELEGRAM_BOT_TOKEN).toBeUndefined()
      const cookie = await devLogin(env)
      const body = await connectPage(env, cookie)
      expect(body).toContain('data-bot-username="kayhermes_mubot"')
    })

    it('renders an empty data-bot-username (honest fallback) when unconfigured — never a fabricated link', async () => {
      const env = makeEnv('admin@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const body = await connectPage(env, cookie)
      expect(body).toContain('data-bot-username=""')
    })

    // Proves TELEGRAM_BOT_TOKEN can never leak into this page's link even if
    // it happens to look like a valid Telegram username shape — the
    // notification bridge secret is never read by account.ts at all anymore.
    it('setting TELEGRAM_BOT_TOKEN alone (no im_bot_username) still renders the honest empty fallback', async () => {
      const env = makeEnv('admin@x.test')
      env.DB = harness.db
      ;(env as unknown as { TELEGRAM_BOT_TOKEN: string }).TELEGRAM_BOT_TOKEN = 'Sos_mumega_bot_token'
      const cookie = await devLogin(env)
      const body = await connectPage(env, cookie)
      expect(body).toContain('data-bot-username=""')
      expect(body).not.toContain('Sos_mumega_bot')
    })

    // Mutation target: removing the read-side isValidBotUsername re-check
    // would let a value written outside the app's own validated writers
    // (direct D1 edit, a future third writer) straight into the deep link.
    it('a malformed value already sitting in org_settings (bypassing both writers) is filtered on read, not rendered', async () => {
      harness.sqlite.exec(`INSERT INTO org_settings (key, value) VALUES ('im_bot_username', '<script>alert(1)</script>');`)
      const env = makeEnv('admin@x.test')
      env.DB = harness.db
      const cookie = await devLogin(env)
      const body = await connectPage(env, cookie)
      expect(body).toContain('data-bot-username=""')
      expect(body).not.toContain('<script>alert(1)</script>')
    })
  })
})
