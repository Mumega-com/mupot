// P0/P1 regression (2026-09-02): four apps mounted in src/index.ts with no
// middleware and no inline authorization:
//   /api/studio/database/*  — anonymous arbitrary Supabase read/write/delete
//   /api/alerts/*           — anonymous webhook-sink hijack / delete / URL leak
//   /api/billing/status|checkout|portal — anonymous tier leak + Stripe portal URL
//   /webhooks/supabase      — secret check skipped entirely when the secret is unset
// Found by the adversarial sweep that followed #1267; each verified live by
// read-only GET. These tests drive the real cookie → KV → D1 member →
// capabilities chain on a real SQLite D1 with all migrations.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { studioDataApp } from '../src/dashboard/studio-data-api'
import { alertsApp } from '../src/alerts/routes'
import { billingRoutesApp } from '../src/billing/routes'
import { supabaseWebhookApp } from '../src/connectors/supabase-webhook'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const OWNER = 'mupot_session=owner-s'
const MEMBER = 'mupot_session=member-s'

function session(role: 'owner' | 'member', email: string): string {
  return JSON.stringify({ userId: `u-${role}`, email, role, createdAt: '2026-09-01T00:00:00.000Z' })
}

const json = (body: unknown, cookie?: string, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
})
const withCookie = (cookie: string, method = 'GET') => ({ method, headers: { cookie } })

describe('mount authz: studio-data, alerts, billing, supabase webhook', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const sessions: Record<string, string> = {
      'sess:owner-s': session('owner', 'owner@local.test'),
      'sess:member-s': session('member', 'plain@local.test'),
    }
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: vi.fn().mockResolvedValue(undefined) },
      SESSIONS: {
        get: async (key: string) => sessions[key] ?? null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-plain', ?1, 'plain@local.test', 'Plain', 'active', datetime('now'))`,
    ).bind(TENANT).run()
    await env.DB.prepare(
      `INSERT INTO capabilities (member_id, scope_type, scope_id, capability)
       VALUES ('mem-plain', 'org', NULL, 'member')`,
    ).run()
  })

  afterEach(() => harness.close())

  describe('/api/studio/database', () => {
    it('unauthenticated: 401 on tables, query, mutate — never a handler 404', async () => {
      expect((await studioDataApp.request('/tables', {}, env)).status).toBe(401)
      expect((await studioDataApp.request('/query?table=x', {}, env)).status).toBe(401)
      expect((await studioDataApp.request('/mutate', json({ table: 'x', action: 'delete', match: {} }), env)).status).toBe(401)
    })
    it('member-tier: 403 with need=admin on all three', async () => {
      const r = await studioDataApp.request('/tables', withCookie(MEMBER), env)
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ error: 'forbidden', need: 'admin' })
      expect((await studioDataApp.request('/query?table=x', withCookie(MEMBER), env)).status).toBe(403)
      expect((await studioDataApp.request('/mutate', json({ table: 'x', action: 'delete', match: {} }, MEMBER), env)).status).toBe(403)
    })
    it('owner: passes the gate and reaches the handler (404 no connector on this pot)', async () => {
      const r = await studioDataApp.request('/tables', withCookie(OWNER), env)
      expect(r.status).toBe(404)
      expect(await r.json()).toEqual({ ok: false, error: 'no_active_supabase_connector' })
    })
  })

  describe('/api/alerts', () => {
    it('unauthenticated: 401 on list, create, delete, test — and no sink is written', async () => {
      expect((await alertsApp.request('/webhooks', {}, env)).status).toBe(401)
      expect((await alertsApp.request('/webhooks', json({ url: 'https://attacker.test/x' }), env)).status).toBe(401)
      // csrf() runs before requireAuth: a DELETE with no content-type is treated as form-like
      // and gets 403 there; send JSON so the assertion reaches the auth gate.
      expect((await alertsApp.request('/webhooks/any', { method: 'DELETE', headers: { 'content-type': 'application/json' } }, env)).status).toBe(401)
      expect((await alertsApp.request('/test', json({}), env)).status).toBe(401)
      const row = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'alert_webhooks'`).first()
      expect(row).toBeNull()
    })
    it('member-tier: 403 need=admin on list, create, delete and test — every route, not just the first two', async () => {
      const r = await alertsApp.request('/webhooks', withCookie(MEMBER), env)
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ error: 'forbidden', need: 'admin' })
      expect((await alertsApp.request('/webhooks', json({ url: 'https://attacker.test/x' }, MEMBER), env)).status).toBe(403)
      expect((await alertsApp.request('/webhooks/any', withCookie(MEMBER, 'DELETE'), env)).status).toBe(403)
      expect((await alertsApp.request('/test', json({}, MEMBER), env)).status).toBe(403)
    })
    it('owner: list works through the chain', async () => {
      const r = await alertsApp.request('/webhooks', withCookie(OWNER), env)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true, webhooks: [] })
    })
  })

  describe('/api/billing', () => {
    it('unauthenticated: 401 on status, checkout, portal', async () => {
      expect((await billingRoutesApp.request('/status', {}, env)).status).toBe(401)
      expect((await billingRoutesApp.request('/checkout', json({ tier: 'pro' }), env)).status).toBe(401)
      expect((await billingRoutesApp.request('/portal', json({}), env)).status).toBe(401)
    })
    it('member-tier: status 200, checkout and portal 403 need=admin', async () => {
      expect((await billingRoutesApp.request('/status', withCookie(MEMBER), env)).status).toBe(200)
      const p = await billingRoutesApp.request('/portal', json({}, MEMBER), env)
      expect(p.status).toBe(403)
      expect(await p.json()).toEqual({ error: 'forbidden', need: 'admin' })
      expect((await billingRoutesApp.request('/checkout', json({ tier: 'pro' }, MEMBER), env)).status).toBe(403)
    })
    it('owner: portal passes the gate and reaches the handler (404 no customer on this pot)', async () => {
      const r = await billingRoutesApp.request('/portal', json({}, OWNER), env)
      expect(r.status).toBe(404)
      expect(((await r.json()) as { error: string }).error).toBe('no_active_stripe_customer')
    })
    it('Stripe webhook stays reachable without a session (signature-verified path)', async () => {
      const r = await billingRoutesApp.request('/webhook', { method: 'POST', body: '{}' }, env)
      expect(r.status).not.toBe(401)
      expect(r.status).not.toBe(403)
    })
  })

  describe('/webhooks/supabase', () => {
    const payload = { type: 'INSERT', table: 'contacts', record: { id: 1 } }
    it('secret UNSET: 503 not_configured, nothing emitted (was fail-open)', async () => {
      const r = await supabaseWebhookApp.request('/supabase', json(payload), env)
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ ok: false, error: 'not_configured' })
      expect((env as unknown as { BUS: { send: ReturnType<typeof vi.fn> } }).BUS.send).not.toHaveBeenCalled()
    })
    it('secret SET, header missing or wrong: 401', async () => {
      const e2 = { ...env, SUPABASE_WEBHOOK_SECRET: 'sekrit' } as unknown as Env
      expect((await supabaseWebhookApp.request('/supabase', json(payload), e2)).status).toBe(401)
      const wrong = await supabaseWebhookApp.request('/supabase', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-supabase-webhook-secret': 'nope' },
        body: JSON.stringify(payload),
      }, e2)
      expect(wrong.status).toBe(401)
    })
    it('secret SET and correct: accepted', async () => {
      const e2 = { ...env, SUPABASE_WEBHOOK_SECRET: 'sekrit' } as unknown as Env
      const ok = await supabaseWebhookApp.request('/supabase', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-supabase-webhook-secret': 'sekrit' },
        body: JSON.stringify(payload),
      }, e2)
      expect(ok.status).toBe(200)
    })
  })
})

// ── Hotfix 3 (2026-09-02, adversarial pass on 7c5063c5) ─────────────────────
// F1 Stripe webhook was `if (secret) verify` — unset secret skipped verification;
//    prod had STRIPE_WEBHOOK_SECRET unset, so a forged checkout.session.completed
//    upgraded the pot to the top tier and pinned it. Now 503 when unset.
// F2 The newly cookie-authenticated mutations sit on top-level mounts and did not
//    inherit dashboardApp's csrf(); SameSite=Lax is site-scoped and does not stop a
//    sibling *.mupot.mumega.com origin. text/plain defeats CORS preflight.
// F3 /status member gate had no fixture below member tier (vacuous under deletion).
// F4 owner fixture only exercised the legacy-role escape, never a real org owner
//    shaped role:'member' + capabilities org→owner.
describe('hotfix 3: Stripe fail-closed, CSRF on cookie mutations, tier fixtures', () => {
  let harness: SqliteD1Harness
  let env: Env
  const OBSERVER = 'mupot_session=observer-s'
  const REALOWNER = 'mupot_session=realowner-s'

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const sessions: Record<string, string> = {
      'sess:owner-s': session('owner', 'owner@local.test'),
      'sess:member-s': session('member', 'plain@local.test'),
      'sess:observer-s': session('member', 'watch@local.test'),
      'sess:realowner-s': session('member', 'boss@local.test'),
    }
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: vi.fn().mockResolvedValue(undefined) },
      SESSIONS: {
        get: async (key: string) => sessions[key] ?? null,
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at) VALUES
       ('mem-plain', ?1, 'plain@local.test', 'Plain', 'active', datetime('now')),
       ('mem-watch', ?1, 'watch@local.test', 'Watch', 'active', datetime('now')),
       ('mem-boss',  ?1, 'boss@local.test',  'Boss',  'active', datetime('now'))`,
    ).bind(TENANT).run()
    await env.DB.prepare(
      `INSERT INTO capabilities (member_id, scope_type, scope_id, capability) VALUES
       ('mem-plain', 'org', NULL, 'member'),
       ('mem-watch', 'org', NULL, 'observer'),
       ('mem-boss',  'org', NULL, 'owner')`,
    ).run()
  })
  afterEach(() => harness.close())

  const forged = JSON.stringify({
    id: 'evt_forged', type: 'checkout.session.completed', created: 4102444800,
    data: { object: { metadata: { tenant_slug: TENANT, tier: 'scale' }, customer: 'cus_x', subscription: 'sub_x' } },
  })

  it('F1: Stripe webhook with secret UNSET → 503 not_configured, no billing_state written', async () => {
    for (const path of ['/webhook']) {
      const r = await billingRoutesApp.request(path, { method: 'POST', body: forged, headers: { 'content-type': 'application/json' } }, env)
      expect(r.status).toBe(503)
      expect(await r.json()).toEqual({ error: 'not_configured' })
    }
    const row = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'billing_state'`).first()
    expect(row).toBeNull()
  })

  it('F1: Stripe webhook with secret SET and no/invalid signature → 401, nothing written', async () => {
    const e2 = { ...env, STRIPE_WEBHOOK_SECRET: 'whsec_test' } as unknown as Env
    const r = await billingRoutesApp.request('/webhook', { method: 'POST', body: forged, headers: { 'content-type': 'application/json' } }, e2)
    expect(r.status).toBe(401)
    const bad = await billingRoutesApp.request('/webhook', { method: 'POST', body: forged, headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' } }, e2)
    expect(bad.status).toBe(401)
    const row = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'billing_state'`).first()
    expect(row).toBeNull()
  })

  it('F1: csrf() does NOT sit on /webhook (Stripe sends no Origin; signature is the auth)', async () => {
    const r = await billingRoutesApp.request('/webhook', { method: 'POST', body: forged, headers: { 'content-type': 'text/plain', origin: 'https://evil.mupot.mumega.com' } }, env)
    expect(r.status).toBe(503) // reaches the handler's own fail-closed branch, not a csrf 403
  })

  it('F2: cross-origin text/plain POST with a victim owner cookie is 403 on alerts create, studio mutate, billing portal/checkout', async () => {
    const evil = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'text/plain', origin: 'https://evil.mupot.mumega.com', cookie: OWNER }, body: JSON.stringify(body) })
    expect((await alertsApp.request('/webhooks', evil({ url: 'https://attacker.test/exfil', channel_type: 'slack' }), env)).status).toBe(403)
    expect((await alertsApp.request('/test', evil({}), env)).status).toBe(403)
    expect((await studioDataApp.request('/mutate', evil({ table: 'x', action: 'delete', match: {} }), env)).status).toBe(403)
    expect((await billingRoutesApp.request('/portal', evil({}), env)).status).toBe(403)
    expect((await billingRoutesApp.request('/checkout', evil({ tier: 'pro' }), env)).status).toBe(403)
    const sinks = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'alert_webhooks'`).first()
    expect(sinks).toBeNull()
  })

  it('F2: same-origin owner POST still works (csrf allows matching Origin)', async () => {
    const r = await alertsApp.request('/webhooks', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', cookie: OWNER }, body: JSON.stringify({ url: 'https://hooks.example.test/ok', channel_type: 'slack' }) }, env)
    expect(r.status).toBe(200)
  })

  it('F3: an org OBSERVER is refused on billing /status (403 need=member) — the member gate is not vacuous', async () => {
    const r = await billingRoutesApp.request('/status', withCookie(OBSERVER), env)
    expect(r.status).toBe(403)
    expect(await r.json()).toEqual({ error: 'forbidden', need: 'member' })
    expect((await billingRoutesApp.request('/status', withCookie(MEMBER), env)).status).toBe(200)
  })

  it('F4: a REAL org owner (role member + capabilities org→owner) passes the admin gates through the capabilities plane', async () => {
    const list = await alertsApp.request('/webhooks', withCookie(REALOWNER), env)
    expect(list.status).toBe(200)
    const tables = await studioDataApp.request('/tables', withCookie(REALOWNER), env)
    expect(tables.status).toBe(404) // past the gate, handler 404 (no connector)
    const portal = await billingRoutesApp.request('/portal', json({}, REALOWNER), env)
    expect(portal.status).toBe(404) // past the gate, handler 404 (no customer)
  })
})
