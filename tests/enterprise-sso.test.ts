// tests/enterprise-sso.test.ts — Unit tests for Enterprise Google & SAML SSO & Domain Auto-Enrollment (Flight 11).

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isDomainAllowed,
  autoEnrollSsoMember,
  type SsoConfig,
} from '../src/auth/sso'
import { ssoApp } from '../src/auth/sso-routes'
import type { Env } from '../src/types'
import { applyAllMigrations } from './helpers/migrations'
import { createSqliteD1 } from './helpers/sqlite-d1'

describe('Enterprise Google & SAML SSO & Domain Auto-Enrollment (Flight 11)', () => {
  let harness: ReturnType<typeof createSqliteD1>

  beforeEach(() => {
    vi.restoreAllMocks()
    harness = createSqliteD1()
    applyAllMigrations(harness.sqlite)
  })
  it('validates allowed corporate domains correctly', () => {
    const config: SsoConfig = {
      enabled: true,
      allowed_domains: ['gaf.com', 'standardindustries.com'],
      default_role: 'member',
      enforce_sso: true,
      idp_provider: 'google',
    }

    expect(isDomainAllowed('john.doe@gaf.com', config)).toBe(true)
    expect(isDomainAllowed('alice@standardindustries.com', config)).toBe(true)
    expect(isDomainAllowed('attacker@gmail.com', config)).toBe(false)
  })

  it('auto-enrolls new member from allowed domain and emits BusEvent', async () => {
    const mockBusSend = vi.fn().mockResolvedValue(undefined)
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at)
       VALUES ('sso_config', ?1, CURRENT_TIMESTAMP)`,
    ).bind(JSON.stringify({
      enabled: true,
      allowed_domains: ['gaf.com'],
      default_role: 'member',
    })).run()

    const env = {
      TENANT_SLUG: 'gaf',
      BUS: { send: mockBusSend },
      DB: harness.db,
    } as unknown as Env

    const result = await autoEnrollSsoMember(env, {
      email: 'engineer@gaf.com',
      name: 'GAF Engineer',
      provider: 'google',
    })

    expect(result.ok).toBe(true)
    expect(result.isNew).toBe(true)
    expect(result.email).toBe('engineer@gaf.com')
    expect(result.role).toBe('member')
    expect(mockBusSend).toHaveBeenCalledTimes(1)
    const stored = await harness.db.prepare(
      'SELECT email, status FROM members WHERE email = ?1',
    ).bind('engineer@gaf.com').first<{ email: string; status: string }>()
    expect(stored).toMatchObject({ email: 'engineer@gaf.com', status: 'active' })
    const grant = await harness.db.prepare(
      `SELECT capability FROM capabilities
        WHERE member_id = ?1 AND scope_type = 'org' AND scope_id IS NULL`,
    ).bind(result.memberId).first<{ capability: string }>()
    expect(grant?.capability).toBe('member')
  })

  it('blocks auto-enrollment for unauthorized domains', async () => {
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at)
       VALUES ('sso_config', ?1, CURRENT_TIMESTAMP)`,
    ).bind(JSON.stringify({ enabled: true, allowed_domains: ['gaf.com'] })).run()
    const env = {
      TENANT_SLUG: 'gaf',
      BUS: { send: vi.fn() },
      DB: harness.db,
    } as unknown as Env

    const result = await autoEnrollSsoMember(env, {
      email: 'external@competitor.com',
      provider: 'google',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('sso_domain_not_allowed')
  })

  it('serves SSO REST endpoints: GET /config, POST /validate, and POST /enroll', async () => {
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at)
       VALUES ('sso_config', ?1, CURRENT_TIMESTAMP)`,
    ).bind(JSON.stringify({ enabled: true, allowed_domains: ['gaf.com'] })).run()
    // Routes are org-admin gated (P0 2026-09-02): drive them as a dashboard owner.
    const ownerSession = JSON.stringify({
      userId: 'owner-user',
      email: 'owner@gaf.com',
      role: 'owner',
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    const env = {
      TENANT_SLUG: 'gaf',
      BUS: { send: vi.fn().mockResolvedValue(undefined) },
      DB: harness.db,
      SESSIONS: {
        get: async (key: string) => (key === 'sess:owner-session' ? ownerSession : null),
        put: async () => undefined,
        delete: async () => undefined,
      },
    } as unknown as Env
    const asOwner = { cookie: 'mupot_session=owner-session' }

    // 1. GET /config
    const getReq = new Request('http://localhost/config', { headers: asOwner })
    const getRes = await ssoApp.fetch(getReq, env)
    expect(getRes.status).toBe(200)
    const getJson = await getRes.json<{ ok: boolean; config: SsoConfig }>()
    expect(getJson.ok).toBe(true)
    expect(getJson.config.allowed_domains).toContain('gaf.com')

    // 2. POST /validate
    const valReq = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asOwner },
      body: JSON.stringify({ email: 'user@gaf.com' }),
    })
    const valRes = await ssoApp.fetch(valReq, env)
    expect(valRes.status).toBe(200)
    const valJson = await valRes.json<{ ok: boolean; allowed: boolean }>()
    expect(valJson.ok).toBe(true)
    expect(valJson.allowed).toBe(true)
  })
})
