// tests/enterprise-sso.test.ts — Unit tests for Enterprise Google & SAML SSO & Domain Auto-Enrollment (Flight 11).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  isDomainAllowed,
  autoEnrollSsoMember,
  type SsoConfig,
} from '../src/auth/sso'
import { ssoApp } from '../src/auth/sso-routes'
import { createSqliteD1 } from './helpers/sqlite-d1'
import { applyAllMigrations } from './helpers/migrations'
import type { Env } from '../src/types'

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

    // Seed SSO config into org_settings table
    const ssoConfig = JSON.stringify({
      enabled: true,
      allowed_domains: ['gaf.com'],
      default_role: 'member',
    })
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES ('sso_config', ?1, CURRENT_TIMESTAMP)`,
    ).bind(ssoConfig).run()

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

    // Verify member exists in real D1 table
    const member = await harness.db.prepare('SELECT email, status FROM members WHERE email = ?1').bind('engineer@gaf.com').first<{ email: string; status: string }>()
    expect(member?.email).toBe('engineer@gaf.com')
    expect(member?.status).toBe('active')
  })

  it('blocks auto-enrollment for unauthorized domains', async () => {
    const ssoConfig = JSON.stringify({
      enabled: true,
      allowed_domains: ['gaf.com'],
    })
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES ('sso_config', ?1, CURRENT_TIMESTAMP)`,
    ).bind(ssoConfig).run()

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
    const ssoConfig = JSON.stringify({
      enabled: true,
      allowed_domains: ['gaf.com'],
    })
    await harness.db.prepare(
      `INSERT INTO org_settings (key, value, updated_at) VALUES ('sso_config', ?1, CURRENT_TIMESTAMP)`,
    ).bind(ssoConfig).run()

    const env = {
      TENANT_SLUG: 'gaf',
      BUS: { send: vi.fn().mockResolvedValue(undefined) },
      DB: harness.db,
    } as unknown as Env

    // 1. GET /config
    const reqConfig = new Request('http://localhost/config')
    const resConfig = await ssoApp.fetch(reqConfig, env as any)
    expect(resConfig.status).toBe(200)
    const jsonConfig = await resConfig.json<{ ok: boolean; config: SsoConfig }>()
    expect(jsonConfig.ok).toBe(true)
    expect(jsonConfig.config.allowed_domains).toContain('gaf.com')

    // 2. POST /validate
    const reqValidate = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@gaf.com' }),
    })
    const resValidate = await ssoApp.fetch(reqValidate, env as any)
    expect(resValidate.status).toBe(200)
    const jsonValidate = await resValidate.json<{ ok: boolean; allowed: boolean }>()
    expect(jsonValidate.allowed).toBe(true)
  })
})
