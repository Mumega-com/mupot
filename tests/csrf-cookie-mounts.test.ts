// CSRF class regression (2026-09-02). Adversarial pass on #1269 executed a cross-origin
// text/plain POST carrying a victim ORG OWNER cookie against membersApp and received
// 201 {grant: org/owner}. Eleven cookie-authenticated top-level mounts shared the shape:
// requireAuth is cookie-only, SameSite=Lax is site-scoped to mumega.com (a sibling
// *.mupot.mumega.com origin is same-site), text/plain is a CORS-simple type (no
// preflight), and c.req.json() parses regardless of Content-Type.
//
// Each mount: a cross-origin text/plain mutation with a valid owner cookie must be 403
// BEFORE any handler runs; the same request same-origin must get PAST csrf (any status
// but 403). The two assertions are load-bearing as a pair — csrf() runs before the
// authenticator, so a lone 403 would also be produced by a garbage cookie.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { membersApp } from '../src/members/index'
import { orgApp } from '../src/org/index'
import { channelsAdminApp } from '../src/channels/admin'
import { potsApp } from '../src/pots/routes'
import { routerApp } from '../src/router/routes'
import { resellerApp } from '../src/reseller/routes'
import { ssoApp } from '../src/auth/sso-routes'
import { busApp } from '../src/bus/index'
import { studioApp } from '../src/dashboard/studio'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'
const OWNER = 'mupot_session=owner-s'
const EVIL = 'https://evil.mupot.mumega.com'
const SAME = 'http://localhost'

type Case = { name: string; app: { request: (p: string, i: RequestInit, e: Env) => Promise<Response> }; path: string; body: unknown; method?: string }
const CASES: Case[] = [
  { name: 'members: grant capability', app: membersApp, path: '/members/mem-attacker/capabilities', body: { action: 'grant', scope_type: 'org', capability: 'owner' } },
  { name: 'members: mint token', app: membersApp, path: '/members/mem-attacker/tokens', body: { channel: 'workspace' } },
  { name: 'org: create department', app: orgApp, path: '/departments', body: { name: 'evil' } },
  { name: 'channels: create binding', app: channelsAdminApp, path: '/bindings', body: { platform: 'discord', external_id: 'x', target: 'y' } },
  { name: 'channels: link code (no cap gate)', app: channelsAdminApp, path: '/link-codes', body: {} },
  { name: 'pots: provision', app: potsApp, path: '/', body: { slug: 'evil' } },
  { name: 'router: tick', app: routerApp, path: '/tick', body: {} },
  { name: 'reseller: create', app: resellerApp, path: '/', body: {} },
  { name: 'sso: config write', app: ssoApp, path: '/config', body: { default_role: 'admin' } },
  { name: 'sso: enroll', app: ssoApp, path: '/enroll', body: { email: 'attacker@evil.test' } },
  { name: 'bus: emit', app: busApp, path: '/emit', body: { type: 'x' } },
  { name: 'studio: chat', app: studioApp, path: '/chat', body: { message: 'hi' } },
  { name: 'studio: dispatch', app: studioApp, path: '/dispatch', body: {} },
]

describe('CSRF on cookie-authenticated top-level mounts', () => {
  let harness: SqliteD1Harness
  let env: Env

  beforeEach(async () => {
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
    const owner = JSON.stringify({ userId: 'u-owner', email: 'owner@local.test', role: 'owner', createdAt: '2026-09-01T00:00:00.000Z' })
    env = {
      TENANT_SLUG: TENANT,
      DB: harness.db,
      BUS: { send: vi.fn().mockResolvedValue(undefined), emit: vi.fn().mockResolvedValue(undefined) },
      SESSIONS: { get: async (k: string) => (k === 'sess:owner-s' ? owner : null), put: async () => undefined, delete: async () => undefined },
    } as unknown as Env
    await env.DB.prepare(
      `INSERT INTO members (id, tenant, email, display_name, status, created_at)
       VALUES ('mem-attacker', ?1, 'attacker@evil.test', 'Attacker', 'active', datetime('now'))`,
    ).bind(TENANT).run()
  })
  afterEach(() => harness.close())

  for (const tc of CASES) {
    it(`${tc.name}: cross-origin text/plain with owner cookie → 403; same-origin gets past csrf`, async () => {
      const cross = await tc.app.request(tc.path, {
        method: tc.method ?? 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8', origin: EVIL, 'sec-fetch-site': 'cross-site', cookie: OWNER },
        body: JSON.stringify(tc.body),
      }, env)
      expect(cross.status, `${tc.name} cross-origin`).toBe(403)

      const same = await tc.app.request(tc.path, {
        method: tc.method ?? 'POST',
        headers: { 'content-type': 'application/json', origin: SAME, cookie: OWNER },
        body: JSON.stringify(tc.body),
      }, env)
      expect(same.status, `${tc.name} same-origin must not be a csrf 403`).not.toBe(403)
    })
  }

  it('members: the org-owner grant the arm executed is now refused and the capabilities table stays empty', async () => {
    const r = await membersApp.request('/members/mem-attacker/capabilities', {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8', origin: EVIL, cookie: OWNER },
      body: JSON.stringify({ action: 'grant', scope_type: 'org', capability: 'owner' }),
    }, env)
    expect(r.status).toBe(403)
    const n = await env.DB.prepare(`SELECT count(*) AS n FROM capabilities WHERE member_id = 'mem-attacker'`).first<{ n: number }>()
    expect(n?.n).toBe(0)
  })

  it('members: public invite redemption is NOT behind csrf (token-authenticated, CLI-redeemable)', async () => {
    const r = await membersApp.request('/invites/nope/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=bogus',
    }, env)
    expect(r.status).not.toBe(403)
  })
})
