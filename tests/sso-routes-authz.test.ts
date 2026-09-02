// P0 regression (2026-09-02): /api/auth/sso/* was mounted with no middleware and no
// inline check. Unauthenticated callers could read/write sso_config (default_role
// 'admin' included) and auto-enroll an ACTIVE member carrying an org capability
// for any email. Live in production from #1231 (2026-08-26) until this fix.
//
// These tests drive ssoApp through its real middleware chain with a real SQLite
// D1 and the full migration set. Session identity comes from the same cookie/KV
// path production uses, not from a pre-set auth variable.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ssoApp } from '../src/auth/sso-routes'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'

const TENANT = 'local'

function session(role: 'owner' | 'admin' | 'member', email: string): string {
  return JSON.stringify({ userId: `u-${role}`, email, role, createdAt: '2026-09-01T00:00:00.000Z' })
}

describe('SSO routes require an authenticated org principal (P0)', () => {
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
    // A real member-tier human so the member session resolves to fine-grained
    // capabilities (org:member) and cannot ride the legacy owner/admin escape.
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

  const json = (body: unknown, cookie?: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })

  it('unauthenticated: every route is 401 and nothing is written', async () => {
    expect((await ssoApp.request('/config', {}, env)).status).toBe(401)
    expect((await ssoApp.request('/config', json({ default_role: 'admin', enabled: true }), env)).status).toBe(401)
    expect((await ssoApp.request('/validate', json({ email: 'x@y.test' }), env)).status).toBe(401)
    expect((await ssoApp.request('/enroll', json({ email: 'attacker@gmail.test' }), env)).status).toBe(401)

    const cfg = await env.DB.prepare(`SELECT value FROM org_settings WHERE key = 'sso_config'`).first()
    expect(cfg).toBeNull()
    const rows = await env.DB.prepare(`SELECT count(*) AS n FROM members WHERE email = 'attacker@gmail.test'`).first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('member-tier: config write and enroll are 403; validate is allowed', async () => {
    const c = 'mupot_session=member-s'
    expect((await ssoApp.request('/config', {}, env)).status).toBe(401)
    const cfgW = await ssoApp.request('/config', json({ default_role: 'admin' }, c), env)
    expect(cfgW.status).toBe(403)
    expect(await cfgW.json()).toEqual({ error: 'forbidden', need: 'admin' })
    const enroll = await ssoApp.request('/enroll', json({ email: 'attacker@gmail.test' }, c), env)
    expect(enroll.status).toBe(403)
    const val = await ssoApp.request('/validate', json({ email: 'x@y.test' }, c), env)
    expect(val.status).toBe(200)

    const rows = await env.DB.prepare(`SELECT count(*) AS n FROM members WHERE email = 'attacker@gmail.test'`).first<{ n: number }>()
    expect(rows?.n).toBe(0)
  })

  it('owner: config read/write and enroll work through the same middleware chain', async () => {
    const c = 'mupot_session=owner-s'
    const read = await ssoApp.request('/config', { headers: { cookie: c } }, env)
    expect(read.status).toBe(200)
    const write = await ssoApp.request('/config', json({ enabled: true, allowed_domains: ['local.test'] }, c), env)
    expect(write.status).toBe(200)
    const enroll = await ssoApp.request('/enroll', json({ email: 'new@local.test', provider: 'google' }, c), env)
    expect(enroll.status).toBe(200)
    const body = await enroll.json<{ ok: boolean; member: { isNew: boolean; role: string } }>()
    expect(body.ok).toBe(true)
    expect(body.member.isNew).toBe(true)
    expect(body.member.role).toBe('member')
  })
})
