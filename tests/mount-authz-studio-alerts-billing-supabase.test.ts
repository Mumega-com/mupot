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
      expect((await alertsApp.request('/webhooks/any', { method: 'DELETE' }, env)).status).toBe(401)
      expect((await alertsApp.request('/test', json({}), env)).status).toBe(401)
      const row = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'alert_webhooks'`).first()
      expect(row).toBeNull()
    })
    it('member-tier: 403 need=admin on list and create', async () => {
      const r = await alertsApp.request('/webhooks', withCookie(MEMBER), env)
      expect(r.status).toBe(403)
      expect(await r.json()).toEqual({ error: 'forbidden', need: 'admin' })
      expect((await alertsApp.request('/webhooks', json({ url: 'https://attacker.test/x' }, MEMBER), env)).status).toBe(403)
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
