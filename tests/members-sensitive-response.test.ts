import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { authApp } from '../src/auth'
import { dashboardApp } from '../src/dashboard'
import { membersApp } from '../src/members'
import { assertNoRawToken } from './helpers/assert-no-raw-token'
import { applyAllMigrations } from './helpers/migrations'
import { PRESENCE_ENV, seedPasskey, throughGate } from './helpers/presence'
import { createSqliteD1, type SqliteD1Harness } from './helpers/sqlite-d1'
import type { Env } from '../src/types'

const TENANT = 'test-tenant'
const ORIGIN = 'https://pot.example'
let harness: SqliteD1Harness

function sessions() {
  const values = new Map<string, string>()
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => { values.set(key, value) },
    delete: async (key: string) => { values.delete(key) },
  }
}

function envFor(publicOrigin: string | undefined = ORIGIN): Env {
  return {
    DB: harness.db, TENANT_SLUG: TENANT, BRAND: 'Test',
    LOCAL_TEST_AUTH: '1', LOCAL_TEST_AUTH_EMAIL: 'owner@example.test', SESSIONS: sessions(),
    OAUTH_KV: { get: async () => null, put: async () => undefined },
    VEC: { query: async () => ({ matches: [] }) }, BUS: { send: async () => {} },
    BLOBS: {}, AI: {}, AGENT: {}, SQUAD: {}, ...PRESENCE_ENV, PUBLIC_ORIGIN: publicOrigin,
  } as unknown as Env
}

async function login(env: Env): Promise<string> {
  const response = await authApp.request('/dev-login', {}, env)
  expect(response.status).toBe(302)
  const cookie = /mupot_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1]
  if (!cookie) throw new Error('no authenticated browser session')
  return `mupot_session=${cookie}`
}

function tokenCount(memberId?: string): number {
  const sql = memberId ? 'SELECT COUNT(*) AS n FROM member_tokens WHERE member_id = ?' : 'SELECT COUNT(*) AS n FROM member_tokens'
  const row = memberId ? harness.sqlite.prepare(sql).get(memberId) : harness.sqlite.prepare(sql).get()
  return Number((row as { n: number }).n)
}

function expectSensitiveTokenHeaders(res: Response) {
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('referrer-policy')).toBe('no-referrer')
}

beforeEach(() => {
  harness = createSqliteD1()
  applyAllMigrations(harness.sqlite)
  harness.sqlite.exec(`
    INSERT INTO departments (id, slug, name) VALUES ('dept-1', 'dept', 'Department');
    INSERT INTO members (id, email, display_name, status, tenant) VALUES
      ('owner-member', 'owner@example.test', 'Owner', 'active', '${TENANT}'),
      ('member-1', 'operator@example.test', 'Operator', 'active', '${TENANT}');
    INSERT INTO users (id, email, role) VALUES ('owner-user', 'owner@example.test', 'owner');
    INSERT INTO capabilities (id, member_id, scope_type, scope_id, capability) VALUES
      ('owner-dept-admin', 'owner-member', 'department', 'dept-1', 'admin');
    INSERT INTO human_login_identities (id, tenant, provider, provider_subject, verified_email, member_id)
      VALUES ('identity-owner', '${TENANT}', 'local-test', 'owner@example.test', 'owner@example.test', 'owner-member');
    INSERT INTO invites (id, email, department_id, capability, invited_by)
      VALUES ('invite-1', 'new-operator@example.test', 'dept-1', 'member', 'owner-member');
  `)
  seedPasskey(harness.sqlite, TENANT, 'owner-member')
})

afterEach(() => harness.close())

describe('member token responses', () => {
  it('mints no bearer when a public invite is redeemed', async () => {
    const res = await membersApp.request('/invites/invite-1/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: 'New Operator' }),
    }, envFor())
    expect(res.status, await res.clone().text()).toBe(201)
    expectSensitiveTokenHeaders(res)
    await assertNoRawToken(res)
    const body = await res.json() as { member_id: string; token: unknown; next: string }
    expect(body.token).toBeNull()
    expect(body.next).toBe('sign_in')
    expect(tokenCount(body.member_id)).toBe(0)
  })

  it('prevents caching or referrer leakage when an administrator mints a token', async () => {
    const env = envFor()
    const cookie = await login(env)
    const res = await throughGate(harness.sqlite, TENANT, (qs) => membersApp.request(`/members/member-1/tokens${qs ? `?${qs}` : ''}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ label: 'host', channel: 'workspace' }),
    }, env))
    expect(res.status, await res.clone().text()).toBe(201)
    expectSensitiveTokenHeaders(res)
    expect(((await res.json()) as { token: { raw: string } }).token.raw).toMatch(/^mupot_/)
    expect(tokenCount('member-1')).toBe(1)
  })

  it('pins rendered endpoints despite a malicious request host', async () => {
    const env = envFor(ORIGIN)
    const cookie = await login(env)
    const res = await throughGate(harness.sqlite, TENANT, (qs) => dashboardApp.fetch(new Request(`https://evil.example/members/member-1/tokens${qs ? `?${qs}` : ''}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://evil.example' },
      body: new URLSearchParams({ label: 'host', channel: 'workspace' }),
    }), env))
    expect(res.status, await res.clone().text()).toBe(200)
    const body = await res.text()
    expect(body).toContain('https://pot.example/mcp')
    expect(body).not.toContain('evil.example')
    expect(tokenCount('member-1')).toBe(1)
  })

  it('fails before minting when PUBLIC_ORIGIN is absent', async () => {
    const env = envFor('')
    const cookie = await login(env)
    const res = await throughGate(harness.sqlite, TENANT, (qs) => dashboardApp.fetch(new Request(`https://evil.example/members/member-1/tokens${qs ? `?${qs}` : ''}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, origin: 'https://evil.example' },
      body: new URLSearchParams({ label: 'host', channel: 'workspace' }),
    }), env))
    expect(res.status, await res.clone().text()).toBe(503)
    expect(await res.text()).toContain('public origin')
    expect(tokenCount('member-1')).toBe(0)
  })
})
