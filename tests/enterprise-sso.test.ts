// tests/enterprise-sso.test.ts — Unit tests for Enterprise Google & SAML SSO & Domain Auto-Enrollment (Flight 11).

import { describe, expect, it, vi } from 'vitest'
import {
  isDomainAllowed,
  autoEnrollSsoMember,
  type SsoConfig,
} from '../src/auth/sso'
import { ssoApp } from '../src/auth/sso-routes'

describe('Enterprise Google & SAML SSO & Domain Auto-Enrollment (Flight 11)', () => {
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
    let storedMembers: any[] = []

    const mockEnv = {
      TENANT_SLUG: 'gaf',
      BUS: { send: mockBusSend },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn((...args: any[]) => ({
            first: vi.fn().mockImplementation(async () => {
              if (sql.includes('org_settings')) {
                return {
                  value: JSON.stringify({
                    enabled: true,
                    allowed_domains: ['gaf.com'],
                    default_role: 'member',
                  }),
                }
              }
              if (sql.includes('SELECT id, role, status FROM members')) {
                return null // New member
              }
              return null
            }),
            run: vi.fn().mockImplementation(async () => {
              if (sql.includes('INSERT INTO members')) {
                storedMembers.push({ id: args[0], email: args[2], role: args[3] })
              }
              return { meta: { changes: 1 } }
            }),
          })),
        })),
      },
    }

    const result = await autoEnrollSsoMember(mockEnv as any, {
      email: 'engineer@gaf.com',
      name: 'GAF Engineer',
      provider: 'google',
    })

    expect(result.ok).toBe(true)
    expect(result.isNew).toBe(true)
    expect(result.email).toBe('engineer@gaf.com')
    expect(result.role).toBe('member')
    expect(storedMembers.length).toBe(1)
    expect(mockBusSend).toHaveBeenCalledTimes(1)
  })

  it('blocks auto-enrollment for unauthorized domains', async () => {
    const mockEnv = {
      TENANT_SLUG: 'gaf',
      BUS: { send: vi.fn() },
      DB: {
        prepare: vi.fn((sql: string) => ({
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({
              value: JSON.stringify({
                enabled: true,
                allowed_domains: ['gaf.com'],
              }),
            }),
          })),
        })),
      },
    }

    const result = await autoEnrollSsoMember(mockEnv as any, {
      email: 'external@competitor.com',
      provider: 'google',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('sso_domain_not_allowed')
  })

  it('serves SSO REST endpoints: GET /config, POST /validate, and POST /enroll', async () => {
    const mockEnv = {
      TENANT_SLUG: 'gaf',
      BUS: { send: vi.fn() },
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn().mockResolvedValue({
              value: JSON.stringify({
                enabled: true,
                allowed_domains: ['gaf.com'],
              }),
            }),
            run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          })),
        })),
      },
    }

    // 1. GET /config
    const getReq = new Request('http://localhost/config')
    const getRes = await ssoApp.fetch(getReq, mockEnv as any)
    expect(getRes.status).toBe(200)
    const getJson = await getRes.json<{ ok: boolean; config: SsoConfig }>()
    expect(getJson.ok).toBe(true)
    expect(getJson.config.allowed_domains).toContain('gaf.com')

    // 2. POST /validate
    const valReq = new Request('http://localhost/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@gaf.com' }),
    })
    const valRes = await ssoApp.fetch(valReq, mockEnv as any)
    expect(valRes.status).toBe(200)
    const valJson = await valRes.json<{ ok: boolean; allowed: boolean }>()
    expect(valJson.ok).toBe(true)
    expect(valJson.allowed).toBe(true)
  })
})
